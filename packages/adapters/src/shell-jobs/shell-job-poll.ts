import type {
  AdapterContext,
  ComputerRef,
  JobPublisher,
  SandboxProvider,
  SecretStore,
} from "@rakazo/adapter-kit";
import { shellJobPollJob } from "@rakazo/adapter-kit";
import { deadlineSignal, redactSecrets } from "@rakazo/core";
import type { PrismaClient, ShellJob, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  THREAD_LOCK_TRANSACTION_OPTIONS,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { redactShellStreams } from "../computers/sandbox/agent-environment.js";
import { toComputerRef } from "../computers/screens/computer-support.js";
import { threadHasLiveCall } from "../messaging/bot-messages.js";
import { wakeRun } from "../runs/wakeups/wake-run.js";
import { shellCommandEnvironment } from "../secrets/bot-secrets.js";
import type { ShellJobResultText } from "./shell-job.prompt.js";
import { jobBudgetNotice, jobResultBlock, jobResultPrompt } from "./shell-job.prompt.js";
import { killShellJobProcesses, probeShellJob } from "./shell-job-computer.js";
import type { ShellJobConfig, ShellJobStep, ShellJobTerminalStatus } from "./shell-job-rules.js";
import {
  headAndTail,
  JOB_RESULT_TRIGGER,
  nextShellJobStep,
  pollFailureStep,
  routeShellJobResult,
  runMayStartShellJobs,
  shellJobConfig,
} from "./shell-job-rules.js";

export interface ShellJobDeps {
  prisma: PrismaClient;
  sandbox: Pick<SandboxProvider, "execute">;
  jobs: Pick<JobPublisher, "enqueue">;
  events: Pick<ThreadEvents, "notify">;
  /** Loads the bot's command variables so their values are redacted from the output. */
  secretStore?: Pick<SecretStore, "load">;
  config?: ShellJobConfig;
  now?: () => Date;
}

const RESULT_CHARS = 12_000;

function jobContext(job: ShellJob, signal?: AbortSignal): AdapterContext {
  return {
    operationId: `shell-job:${job.id}`,
    traceId: `shell-job:${job.id}`,
    spaceId: job.spaceId,
    userId: job.userId,
    botId: job.botId,
    signal: signal ?? deadlineSignal(60_000),
  };
}

export function shellJobLogFields(
  job: Pick<ShellJob, "id" | "botId" | "threadId" | "originRunId">,
) {
  return {
    "shell_job.id": job.id,
    "bot.id": job.botId,
    "thread.id": job.threadId,
    "run.id": job.originRunId,
  };
}

async function computerFor(
  prisma: PrismaClient,
  computerId: string,
): Promise<{ ref: ComputerRef; state: string } | null> {
  const computer = await prisma.computer.findUnique({
    where: { id: computerId },
    select: { homeKey: true, kind: true, providerRef: true, state: true },
  });
  if (!computer?.providerRef) return null;
  return { ref: toComputerRef(computer), state: computer.state };
}

/** Values to hide from a job's output: the bot's command variables, as the shell tool hides them. */
async function outputRedactions(deps: ShellJobDeps, job: ShellJob): Promise<string[] | null> {
  if (!deps.secretStore) return [];
  const values: string[] = [];
  try {
    await shellCommandEnvironment({
      prisma: deps.prisma,
      secretStore: deps.secretStore as SecretStore,
      scope: { spaceId: job.spaceId, userId: job.userId, botId: job.botId },
      registerRedactions: (found) => values.push(...found),
      keyOutage: "throw",
    });
    return values;
  } catch {
    // Without the values the output cannot be shown safely; the bot can read it with job_output.
    return null;
  }
}

/** The finished job's result text, read from the computer and redacted. */
export async function readShellJobResult(
  deps: ShellJobDeps,
  job: ShellJob,
  options: { secrets?: string[]; probe?: { stdout: string; stderr: string } } = {},
): Promise<ShellJobResultText> {
  const finishedAt = job.finishedAt ?? new Date();
  const base = {
    jobId: job.id,
    command: job.commandPreview,
    status: job.status as ShellJobTerminalStatus,
    exitCode: job.exitCode,
    durationMs: Math.max(0, finishedAt.getTime() - job.startedAt.getTime()),
  };
  let streams = options.probe;
  if (!streams && job.status !== "lost") {
    const computer = await computerFor(deps.prisma, job.computerId).catch(() => null);
    if (computer) {
      streams = await probeShellJob(deps.sandbox, computer.ref, job.id, jobContext(job)).catch(
        () => undefined,
      );
    }
  }
  if (!streams) return { ...base, stdout: "", stderr: "" };
  const secrets = options.secrets ?? (await outputRedactions(deps, job));
  if (secrets === null) {
    return {
      ...base,
      stdout:
        "(output withheld: its secrets could not be loaded to hide them; read it with job_output)",
      stderr: "",
    };
  }
  const safe = redactShellStreams(streams, secrets);
  return {
    ...base,
    stdout: headAndTail(safe.stdout, RESULT_CHARS),
    stderr: headAndTail(safe.stderr, Math.floor(RESULT_CHARS / 3)),
  };
}

/** Schedule the next poll of a job, in the row (for the sweep) and in the queue. */
async function schedulePoll(deps: ShellJobDeps, job: ShellJob, inMs: number, data: object = {}) {
  const now = deps.now?.() ?? new Date();
  const nextPollAt = new Date(now.getTime() + inMs);
  const saved = await deps.prisma.shellJob.updateMany({
    where: { id: job.id, returnedAt: null },
    data: { ...data, nextPollAt },
  });
  if (saved.count) await deps.jobs.enqueue(shellJobPollJob(job.id, nextPollAt));
}

/**
 * One poll of one job (the `shell_job.poll` handler). Reads the job on its computer, moves its
 * state machine one step, and once it ended hands its result back exactly once.
 */
export async function pollShellJob(deps: ShellJobDeps, payload: { jobId: string }): Promise<void> {
  const job = await deps.prisma.shellJob.findUnique({ where: { id: payload.jobId } });
  if (!job || job.returnedAt) return;
  const now = deps.now?.() ?? new Date();
  if (job.status !== "running") {
    await deliverShellJobResult(deps, job);
    return;
  }
  const bot = await deps.prisma.bot.findFirst({
    where: { id: job.botId, archivedAt: null },
    select: { id: true },
  });
  const computer = bot ? await computerFor(deps.prisma, job.computerId) : null;
  let step: ShellJobStep;
  let streams: { stdout: string; stderr: string } | undefined;
  if (!bot || !computer) {
    // Archived bot, or a computer that was deleted or rebuilt without a machine: nothing to read.
    step = { kind: "finish", status: "lost", exitCode: null };
  } else {
    try {
      if (computer.state !== "running") throw new Error(`computer is ${computer.state}`);
      const probe = await probeShellJob(deps.sandbox, computer.ref, job.id, jobContext(job));
      streams = probe;
      step = nextShellJobStep({
        probe,
        cancelRequested: job.cancelRequested,
        deadlineAt: job.deadlineAt,
        now,
        startedAt: job.startedAt,
      });
    } catch (error) {
      getLogger().warn("shell_job.poll_failed", {
        ...shellJobLogFields(job),
        "shell_job.poll_errors": job.pollErrors + 1,
        error: error instanceof Error ? error.message.slice(0, 200) : "poll failed",
      });
      step = pollFailureStep(job.pollErrors);
      if (step.kind === "wait") {
        await schedulePoll(deps, job, step.nextPollInMs, { pollErrors: { increment: 1 } });
        return;
      }
    }
  }
  if (step.kind === "wait") {
    await schedulePoll(deps, job, step.nextPollInMs, { pollErrors: 0 });
    return;
  }
  let status: ShellJobTerminalStatus;
  let exitCode: number | null;
  if (step.kind === "kill") {
    if (computer) {
      await killShellJobProcesses(
        deps.sandbox,
        computer.ref,
        job.computerId,
        job.id,
        jobContext(job),
      );
    }
    status = step.status;
    exitCode = null;
  } else {
    status = step.status;
    exitCode = step.exitCode;
  }
  const finished = await finishShellJob(deps.prisma, job.id, { status, exitCode, finishedAt: now });
  if (!finished) return;
  getLogger().info("shell_job.finished", {
    ...shellJobLogFields(finished),
    "shell_job.status": status,
    "shell_job.exit_code": exitCode ?? undefined,
    "shell_job.duration_ms": now.getTime() - finished.startedAt.getTime(),
  });
  await deliverShellJobResult(deps, finished, step.kind === "finish" ? streams : undefined);
}

/** Move a running job to its end state. Only one caller wins; the others get null. */
export async function finishShellJob(
  prisma: PrismaClient,
  jobId: string,
  input: { status: ShellJobTerminalStatus; exitCode: number | null; finishedAt: Date },
): Promise<ShellJob | null> {
  const updated = await prisma.shellJob.updateMany({
    where: { id: jobId, status: "running" },
    data: { status: input.status, exitCode: input.exitCode, finishedAt: input.finishedAt },
  });
  if (!updated.count) return null;
  return prisma.shellJob.findUnique({ where: { id: jobId } });
}

/** The conversation run the result would wake: copied from the job's origin run. */
async function originRunFields(prisma: PrismaClient, job: ShellJob) {
  const origin = await prisma.run.findUnique({
    where: { id: job.originRunId },
    select: { lane: true },
  });
  return { lane: origin?.lane ?? null };
}

/**
 * Hand a finished job's result back once. Decided with the thread locked (same lock order as
 * returnHelperOutcome and the cloud-agent wake: thread first). The claim is the `returnedAt`
 * update guarded by `returnedAt IS NULL`, so two pollers, or a poller and the run's own steering
 * claim, can never both deliver it.
 */
export async function deliverShellJobResult(
  deps: ShellJobDeps,
  job: ShellJob,
  streams?: { stdout: string; stderr: string },
): Promise<void> {
  if (job.returnedAt || job.status === "running") return;
  const config = deps.config ?? shellJobConfig();
  const now = deps.now?.() ?? new Date();
  // Output is read before the lock: it is an exec on the computer, never held under a row lock.
  const result =
    job.status === "killed"
      ? null
      : await readShellJobResult(deps, job, streams ? { probe: streams } : {});
  const liveCall =
    job.status === "killed" ? false : await threadHasLiveCall(deps.prisma, job.threadId);
  const origin = await originRunFields(deps.prisma, job);
  const committed = await deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${job.threadId} FOR UPDATE`;
    const current = await tx.shellJob.findUnique({ where: { id: job.id } });
    if (!current || current.returnedAt || current.status === "running") return null;
    const [thread, bot, member] = await Promise.all([
      tx.thread.findUnique({ where: { id: job.threadId }, select: { id: true } }),
      tx.bot.findFirst({ where: { id: job.botId, archivedAt: null }, select: { id: true } }),
      tx.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: job.spaceId, userId: job.userId } },
        select: { id: true },
      }),
    ]);
    const working = await tx.run.findMany({
      where: { threadId: job.threadId, botId: job.botId, status: "running" },
      select: { trigger: true },
    });
    const queued = await tx.run.findFirst({
      where: {
        threadId: job.threadId,
        botId: job.botId,
        trigger: JOB_RESULT_TRIGGER,
        status: "queued",
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, taskId: true },
    });
    const lastOwnerMessage = await tx.message.findFirst({
      where: { threadId: job.threadId, role: "user" },
      orderBy: { seq: "desc" },
      select: { createdAt: true },
    });
    const wakesSinceOwnerMessage = await tx.run.count({
      where: {
        threadId: job.threadId,
        botId: job.botId,
        trigger: JOB_RESULT_TRIGGER,
        ...(lastOwnerMessage ? { createdAt: { gt: lastOwnerMessage.createdAt } } : {}),
      },
    });
    const route = routeShellJobResult({
      status: current.status as ShellJobTerminalStatus,
      detached: !thread || !bot || !member,
      workingRunInThread: working.some((run) => runMayStartShellJobs(run.trigger)),
      finishedAt: current.finishedAt ?? now,
      now,
      queuedJobResultRunId: queued?.taskId ? queued.id : null,
      wakesSinceOwnerMessage,
      maxWakesInARow: config.maxWakesInARow,
    });
    if (route.kind === "defer") return { route };
    const claim = async (deliveredAs: string, wakeRunId?: string) => {
      const claimed = await tx.shellJob.updateMany({
        where: { id: job.id, returnedAt: null },
        data: {
          returnedAt: now,
          deliveredAs,
          nextPollAt: null,
          ...(wakeRunId ? { wakeRunId } : {}),
        },
      });
      return claimed.count === 1;
    };
    if (route.kind === "none") {
      return (await claim("none")) ? { route } : null;
    }
    if (!result) return null;
    if (route.kind === "coalesce" && queued?.taskId) {
      // Locks the queued run's row: a worker leasing it now waits for this commit, and one that
      // already leased it changed its status, so the prompt is only extended while nobody read it.
      const still = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM runs WHERE id = ${queued.id} AND status = 'queued' FOR UPDATE`;
      if (still.length === 1) {
        const task = await tx.task.findUnique({
          where: { id: queued.taskId },
          select: { prompt: true },
        });
        if (task && (await claim("wake", queued.id))) {
          await tx.task.update({
            where: { id: queued.taskId },
            data: {
              prompt: `${task.prompt}\n\nAnother background job finished:\n${jobResultBlock(result)}`,
            },
          });
          return { route, wakeRunId: queued.id };
        }
      }
    }
    // A queued wake that started meanwhile cannot take this result: it needs a wake of its own.
    if (route.kind === "budget" || wakesSinceOwnerMessage >= config.maxWakesInARow) {
      if (!(await claim("budget"))) return null;
      const blocks = [
        {
          kind: "text" as const,
          text: jobBudgetNotice(
            job.id,
            current.status as ShellJobTerminalStatus,
            config.maxWakesInARow,
          ),
        },
      ];
      const message = await createThreadMessageInTransaction(tx, {
        threadId: job.threadId,
        botId: job.botId,
        role: "bot",
        blocks,
        clientNonce: `shell-job-budget:${job.id}`,
      });
      const event = await appendEventInTransaction(tx, {
        spaceId: job.spaceId,
        threadId: job.threadId,
        botId: job.botId,
        type: "thread.message.created",
        payload: { messageId: message.id, role: "bot", blocks },
      });
      return { route: { kind: "budget" as const }, eventSeq: event.seq };
    }
    // A fresh wake: like the helper and cloud-agent wakes, a Task and a queued run in one step.
    const task = await tx.task.create({
      data: {
        spaceId: job.spaceId,
        botId: job.botId,
        threadId: job.threadId,
        userId: job.userId,
        prompt: jobResultPrompt([result], { liveCall }),
        status: "queued",
      },
    });
    const run = await tx.run.create({
      data: {
        spaceId: job.spaceId,
        botId: job.botId,
        threadId: job.threadId,
        userId: job.userId,
        taskId: task.id,
        status: "queued",
        trigger: JOB_RESULT_TRIGGER,
        clientNonce: `shell-job-result:${job.id}`,
        ...(origin.lane ? { lane: origin.lane } : {}),
      },
      select: { id: true },
    });
    if (!(await claim("wake", run.id))) throw new Error("shell job result was claimed twice");
    return { route: { kind: "wake" as const }, wakeRunId: run.id };
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  if (!committed) return;
  if (committed.route.kind === "defer") {
    await schedulePoll(deps, job, committed.route.retryInMs);
    return;
  }
  getLogger().info("shell_job.delivered", {
    ...shellJobLogFields(job),
    "shell_job.status": job.status,
    "shell_job.delivered_as": committed.route.kind,
    ...("wakeRunId" in committed && committed.wakeRunId
      ? { "shell_job.wake_run_id": committed.wakeRunId }
      : {}),
  });
  if (committed.route.kind === "budget") {
    getLogger().warn("shell_job.wake_budget_exhausted", {
      ...shellJobLogFields(job),
      "shell_job.max_wakes": config.maxWakesInARow,
    });
  }
  if ("eventSeq" in committed && committed.eventSeq !== undefined) {
    await deps.events.notify(job.threadId, committed.eventSeq);
  }
  if ("wakeRunId" in committed && committed.wakeRunId && committed.route.kind === "wake") {
    await wakeRun(deps.jobs, committed.wakeRunId);
  }
}

/**
 * Housekeeping: a job whose poll was lost (a queue outage at the wrong moment) gets a new one. Rides
 * the job reconciler beside the cloud-agent sweep; the queue's replace key keeps it to one poll.
 */
export async function reconcileShellJobs(
  deps: Pick<ShellJobDeps, "prisma" | "jobs">,
): Promise<void> {
  const stale = new Date(Date.now() - 2 * 60_000);
  const due = await deps.prisma.shellJob.findMany({
    where: { returnedAt: null, nextPollAt: { lte: stale } },
    orderBy: [{ nextPollAt: "asc" }, { id: "asc" }],
    take: 100,
    select: { id: true },
  });
  for (const job of due) await deps.jobs.enqueue(shellJobPollJob(job.id));
}

/** The bot's own steering claim at a turn boundary: results of jobs that ended while it works. */
export async function claimFinishedShellJobs(
  deps: ShellJobDeps,
  input: {
    runId: string;
    trigger: string;
    threadId: string;
    botId: string;
    secrets: readonly string[];
  },
): Promise<ShellJobResultText[]> {
  if (!runMayStartShellJobs(input.trigger)) return [];
  const now = deps.now?.() ?? new Date();
  const ended = await deps.prisma.shellJob.findMany({
    where: {
      threadId: input.threadId,
      botId: input.botId,
      returnedAt: null,
      status: { in: ["completed", "failed", "timed_out", "lost"] },
    },
    orderBy: { finishedAt: "asc" },
    take: 4,
  });
  const results: ShellJobResultText[] = [];
  for (const job of ended) {
    const claimed = await deps.prisma.shellJob.updateMany({
      where: { id: job.id, returnedAt: null },
      data: { returnedAt: now, deliveredAs: "steered", nextPollAt: null },
    });
    if (claimed.count !== 1) continue;
    getLogger().info("shell_job.delivered", {
      ...shellJobLogFields(job),
      "shell_job.status": job.status,
      "shell_job.delivered_as": "steered",
      "shell_job.into_run_id": input.runId,
    });
    const result = await readShellJobResult(deps, job, { secrets: [...input.secrets] });
    results.push({ ...result, command: redactSecrets(result.command, [...input.secrets]) });
  }
  return results;
}
