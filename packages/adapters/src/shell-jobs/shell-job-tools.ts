import { deadlineSignal } from "@rakazo/core";
import type { ShellJob } from "@rakazo/db";
import { redactShellStreams } from "../computers/sandbox/agent-environment.js";
import { toComputerRef } from "../computers/screens/computer-support.js";
import type { RunContext } from "../runs/assembly/run-context.js";
import type { ToolHandlers } from "../runs/tools/run-tool-gate.js";
import { probeShellJob } from "./shell-job-computer.js";
import { headAndTail, isShellJobId } from "./shell-job-rules.js";
import { stopShellJob } from "./shell-job-stop.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const STATUS_TAIL_BYTES = 4_000;
const DEFAULT_OUTPUT_BYTES = 16_000;
const MAX_OUTPUT_BYTES = 64_000;
const NOT_FOUND = { error: "No background job of this bot has that id. Call job_list." };

function describe(job: ShellJob) {
  return {
    job_id: job.id,
    status: job.status,
    command: job.commandPreview,
    started_at: job.startedAt.toISOString(),
    ...(job.finishedAt ? { finished_at: job.finishedAt.toISOString() } : {}),
    ...(job.exitCode !== null ? { exit_code: job.exitCode } : {}),
    ...(job.status === "running" ? { deadline_at: job.deadlineAt.toISOString() } : {}),
    ...(job.cancelRequested && job.status === "running" ? { stopping: true } : {}),
    output: `${job.jobDir}/out`,
  };
}

async function ownJob(ctx: RunContext, raw: unknown): Promise<ShellJob | null> {
  if (!isShellJobId(raw)) return null;
  return ctx.deps.prisma.shellJob.findFirst({
    where: { id: raw, botId: ctx.bot.id, spaceId: ctx.run.spaceId },
  });
}

/** Reads the end of a job's output on its computer, redacted with the run's secrets. */
async function readTail(ctx: RunContext, job: ShellJob, bytes: number) {
  const computer = await ctx.deps.prisma.computer.findUnique({
    where: { id: job.computerId },
    select: { homeKey: true, kind: true, providerRef: true },
  });
  if (!computer?.providerRef) return { unavailable: "The job's computer is not available." };
  try {
    const probe = await probeShellJob(
      ctx.deps.sandbox,
      toComputerRef(computer),
      job.id,
      { ...ctx.context, signal: deadlineSignal(20_000, ctx.context.signal) },
      { stdout: bytes, stderr: Math.max(1_000, Math.floor(bytes / 4)) },
    );
    if (!probe.present) return { unavailable: "The job's output is gone from the computer." };
    const safe = redactShellStreams(probe, ctx.secrets);
    return {
      stdout: headAndTail(safe.stdout, bytes),
      stderr: headAndTail(safe.stderr, bytes),
    };
  } catch {
    return { unavailable: "The job's computer could not be read just now." };
  }
}

/** Run-tool handlers for job_list, job_status, job_output and job_stop. */
export const shellJobToolHandlers: ToolHandlers = {
  async job_list(ctx, call) {
    const jobs = await ctx.deps.prisma.shellJob.findMany({
      where: {
        botId: ctx.bot.id,
        spaceId: ctx.run.spaceId,
        OR: [{ status: "running" }, { finishedAt: { gte: new Date(Date.now() - DAY_MS) } }],
      },
      orderBy: { startedAt: "desc" },
      take: 20,
    });
    return call.finish({ jobs: jobs.map(describe) });
  },
  async job_status(ctx, call) {
    const job = await ownJob(ctx, call.args.job_id);
    if (!job) return call.finish(NOT_FOUND);
    return call.finish({ ...describe(job), ...(await readTail(ctx, job, STATUS_TAIL_BYTES)) });
  },
  async job_output(ctx, call) {
    const job = await ownJob(ctx, call.args.job_id);
    if (!job) return call.finish(NOT_FOUND);
    const requested = Number(call.args.tail_bytes ?? DEFAULT_OUTPUT_BYTES);
    const bytes = Number.isFinite(requested)
      ? Math.min(MAX_OUTPUT_BYTES, Math.max(1, Math.floor(requested)))
      : DEFAULT_OUTPUT_BYTES;
    return call.finish({
      job_id: job.id,
      status: job.status,
      ...(await readTail(ctx, job, bytes)),
    });
  },
  async job_stop(ctx, call) {
    const job = await ownJob(ctx, call.args.job_id);
    if (!job) return call.finish(NOT_FOUND);
    if (job.status !== "running")
      return call.finish({ job_id: job.id, status: job.status, stopped: false });
    const outcome = await stopShellJob(
      { prisma: ctx.deps.prisma, sandbox: ctx.deps.sandbox },
      job,
      "job_stop",
    );
    return call.finish({
      job_id: job.id,
      stopped: outcome !== "not_running",
      ...(outcome === "requested"
        ? { note: "Stop requested; the job ends at its next check." }
        : {}),
    });
  },
};
