import { randomUUID } from "node:crypto";
import type { ComputerRef } from "@rakazo/adapter-kit";
import { shellJobPollJob } from "@rakazo/adapter-kit";
import { redactSecrets } from "@rakazo/core";
import { bestEffort, getLogger } from "@rakazo/logging";
import { redactShellStreams } from "../computers/sandbox/agent-environment.js";
import { sandboxKindCapabilities } from "../computers/sandbox/sandbox-kind-capabilities.js";
import type { observeShellCommand } from "../computers/sandbox/shell-command-stream.js";
import type { RunContext } from "../runs/assembly/run-context.js";
import { jobLimitNote, jobPromotedNotice } from "./shell-job.prompt.js";
import { probeShellJob } from "./shell-job-computer.js";
import { finishShellJob, shellJobLogFields } from "./shell-job-poll.js";
import type { ShellJobConfig } from "./shell-job-rules.js";
import {
  commandPreview,
  foregroundWaitMs,
  pollIntervalMs,
  shellJobConfig,
  shellJobEligibility,
  shellJobMarkerId,
} from "./shell-job-rules.js";
import { shellJobDisplayDir, startArgv } from "./shell-job-scripts.js";

type Observed = Awaited<ReturnType<typeof observeShellCommand>>;

/** Returned by `settle` when the computer could not start the job: run the command as before. */
export const SHELL_JOB_FALLBACK = Symbol("shell-job-fallback");

export interface ShellJobIo {
  finish: (result: unknown) => Promise<unknown>;
  /** The Activity view's final entry for the command. */
  record: (exitCode: number | null, output: string) => Promise<void>;
  /** The streams as the Activity view shows them (already redacted). */
  output: (snapshot: { stdout: string; stderr: string }) => string;
}

export interface PreparedShellJob {
  jobId: string;
  argv: string[];
  execTimeoutMs: number;
  settle: (observed: Observed, io: ShellJobIo) => Promise<unknown>;
}

/** Computer kinds whose provider cancels a run's work itself (desktop is excluded below too). */
const OWN_RUN_CANCEL_KINDS: ReadonlySet<string> = new Set(["wuying", "desktop"]);

/** Whether this computer runs `shell` through the Linux launcher, where jobs can live. */
export function linuxJobComputer(
  ctx: Pick<RunContext, "computer" | "deps">,
  computer: Pick<ComputerRef, "kind">,
  config: { allowFake?: boolean } = {},
): boolean {
  if (ctx.computer.hostEnvironment) return false;
  // The run's sandbox is a routing wrapper that always exposes cancelRunWork, so the providers that
  // cancel run work their own way (and could take a detached job with it) are named by kind.
  if (OWN_RUN_CANCEL_KINDS.has(computer.kind)) return false;
  const capabilities = sandboxKindCapabilities(computer.kind);
  if (capabilities.nativeShell || capabilities.runsOnUserMachine) return false;
  if (computer.kind === "none" || computer.kind === "desktop") return false;
  if (computer.kind === "fake") return Boolean(config.allowFake);
  return true;
}

/**
 * Decide whether a `shell` call runs as a background job and, if so, record the job and return the
 * exec that starts it plus how to read the outcome. Undefined: run the command as before. `{note}`:
 * as before, and tell the model why it did not become a job (a limit).
 */
export async function prepareShellJob(
  ctx: RunContext,
  input: {
    command: string;
    cwd: string | undefined;
    background: boolean;
    computer: ComputerRef;
    config?: ShellJobConfig;
  },
): Promise<PreparedShellJob | { note: string } | undefined> {
  const config = input.config ?? shellJobConfig();
  const linux = linuxJobComputer(ctx, input.computer, {
    allowFake: process.env.SHELL_JOBS_ON_FAKE_COMPUTERS === "1",
  });
  if (!config.enabled || !linux || !input.command.trim()) return undefined;
  try {
    return await recordShellJob(ctx, input, config, linux);
  } catch (error) {
    // A job is an improvement, never a requirement: without its row the command runs as before.
    getLogger().warn("shell_job.unavailable", {
      "run.id": ctx.runId,
      error: error instanceof Error ? error.message.slice(0, 200) : "job could not be recorded",
    });
    return undefined;
  }
}

async function recordShellJob(
  ctx: RunContext,
  input: { command: string; cwd: string | undefined; background: boolean; computer: ComputerRef },
  config: ShellJobConfig,
  linux: boolean,
): Promise<PreparedShellJob | { note: string } | undefined> {
  const { prisma } = ctx.deps;
  const [runningForBot, runningForSpace] = await Promise.all([
    prisma.shellJob.count({ where: { botId: ctx.bot.id, status: "running" } }),
    prisma.shellJob.count({ where: { spaceId: ctx.run.spaceId, status: "running" } }),
  ]);
  const eligibility = shellJobEligibility({
    config,
    trigger: ctx.run.trigger,
    linuxComputer: linux,
    runningForBot,
    runningForSpace,
  });
  if (!eligibility.job) {
    if (eligibility.reason === "bot_limit" || eligibility.reason === "space_limit") {
      getLogger().info("shell_job.refused", {
        "bot.id": ctx.bot.id,
        "run.id": ctx.runId,
        "shell_job.reason": eligibility.reason,
      });
      return {
        note: jobLimitNote(
          eligibility.reason === "bot_limit" ? config.perBot : config.perSpace,
          eligibility.reason === "bot_limit" ? "bot" : "space",
        ),
      };
    }
    return undefined;
  }
  const waitMs = foregroundWaitMs(config, input.background);
  const now = new Date();
  const id = randomUUID().replaceAll("-", "");
  const job = await prisma.shellJob.create({
    data: {
      id,
      spaceId: ctx.run.spaceId,
      botId: ctx.bot.id,
      threadId: ctx.thread.id,
      userId: ctx.run.userId,
      originRunId: ctx.runId,
      computerId: ctx.computer.stored.id,
      commandPreview: commandPreview(redactSecrets(input.command, ctx.secrets)),
      cwd: input.cwd ? redactSecrets(input.cwd, ctx.secrets) : null,
      jobDir: shellJobDisplayDir(id),
      deadlineAt: new Date(now.getTime() + config.maxMs),
      // The first poll comes after the foreground wait. If the run dies during it (a stop, a
      // crash), that poll still finds the job; if the job ends inside the wait it is already
      // returned and the poll does nothing.
      nextPollAt: new Date(now.getTime() + waitMs + pollIntervalMs(0)),
    },
  });
  // A lost enqueue is found again by the reconciler sweep (reconcileShellJobs).
  await ctx.deps.jobs
    .enqueue(shellJobPollJob(job.id, job.nextPollAt ?? undefined))
    .catch((error: unknown) =>
      getLogger().warn("shell_job.poll_enqueue_failed", {
        ...shellJobLogFields(job),
        error: error instanceof Error ? error.message.slice(0, 200) : "enqueue failed",
      }),
    );
  getLogger().info("shell_job.started", {
    ...shellJobLogFields(job),
    "shell_job.background": input.background,
    "shell_job.wait_ms": waitMs,
    "computer.id": job.computerId,
  });
  const startedAt = Date.now();
  return {
    jobId: job.id,
    argv: startArgv({
      computerId: job.computerId,
      markerId: shellJobMarkerId(job.id),
      uuid: randomUUID(),
      jobId: job.id,
      limitSeconds: config.maxMs / 1000,
      command: input.command,
      waitMs,
    }),
    execTimeoutMs: waitMs + 30_000,
    settle: async (observed, io) => {
      if (observed.completion) void bestEffort("shell job follow", observed.completion);
      const started = observed.completion !== undefined || observed.result.code === 0;
      if (!started) {
        // No setsid, no writable home: this computer cannot hold a job. Run it the old way.
        await prisma.shellJob.updateMany({
          where: { id: job.id, status: "running" },
          data: {
            status: "lost",
            finishedAt: new Date(),
            returnedAt: new Date(),
            deliveredAs: "none",
            nextPollAt: null,
          },
        });
        getLogger().warn("shell_job.start_failed", {
          ...shellJobLogFields(job),
          "shell_job.exit_code": observed.result.code ?? undefined,
        });
        return SHELL_JOB_FALLBACK;
      }
      const probe = await probeShellJob(
        ctx.deps.sandbox,
        input.computer,
        job.id,
        ctx.context,
      ).catch(() => undefined);
      const waited = Date.now() - startedAt;
      if (probe && probe.exitCode !== null) {
        const finished = await finishShellJob(prisma, job.id, {
          status: probe.exitCode === 0 ? "completed" : "failed",
          exitCode: probe.exitCode,
          finishedAt: new Date(),
        });
        const claimed = finished
          ? await prisma.shellJob.updateMany({
              where: { id: job.id, returnedAt: null },
              data: { returnedAt: new Date(), deliveredAs: "foreground", nextPollAt: null },
            })
          : { count: 0 };
        if (claimed.count === 1) {
          // A command that ended inside the wait reads exactly as it did before jobs existed.
          const streams = observed.completion
            ? redactShellStreams(probe, ctx.secrets)
            : { stdout: observed.result.stdout, stderr: observed.result.stderr };
          getLogger().info("shell_job.finished", {
            ...shellJobLogFields(job),
            "shell_job.status": probe.exitCode === 0 ? "completed" : "failed",
            "shell_job.exit_code": probe.exitCode,
            "shell_job.duration_ms": waited,
            "shell_job.delivered_as": "foreground",
          });
          await io.record(probe.exitCode, io.output(streams));
          return io.finish({ ...streams, code: probe.exitCode });
        }
      }
      const notice = jobPromotedNotice({
        jobId: job.id,
        waitedMs: input.background ? 0 : waited,
        logDir: shellJobDisplayDir(job.id),
      });
      getLogger().info("shell_job.promoted", {
        ...shellJobLogFields(job),
        "shell_job.waited_ms": waited,
        "shell_job.background": input.background,
      });
      const output = io.output(observed.result);
      await io.record(
        null,
        `${output}${output && !output.endsWith("\n") ? "\n" : ""}[background job ${job.id}]`,
      );
      return io.finish({
        stdout: observed.result.stdout,
        stderr: observed.result.stderr,
        code: null,
        running: true,
        job_id: job.id,
        notice,
      });
    },
  };
}
