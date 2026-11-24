import type { AdapterContext, SandboxProvider } from "@rakazo/adapter-kit";
import { deadlineSignal } from "@rakazo/core";
import type { PrismaClient, ShellJob } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { toComputerRef } from "../computers/screens/computer-support.js";
import { killShellJobProcesses } from "./shell-job-computer.js";
import { shellJobLogFields } from "./shell-job-poll.js";

export interface ShellJobStopDeps {
  prisma: PrismaClient;
  sandbox: Pick<SandboxProvider, "execute">;
}

export type ShellJobStopReason = "job_stop" | "thread_stop";

/**
 * Stop one running job: mark it, kill its processes, and settle it as killed with nothing to wake.
 * A job stopped by the bot or the owner reports nothing (DS-Bot's rule). When the computer cannot
 * be reached now, the mark stays and the next poll kills it.
 */
export async function stopShellJob(
  deps: ShellJobStopDeps,
  job: ShellJob,
  reason: ShellJobStopReason,
): Promise<"stopped" | "requested" | "not_running"> {
  const marked = await deps.prisma.shellJob.updateMany({
    where: { id: job.id, status: "running" },
    data: { cancelRequested: true },
  });
  if (!marked.count) return "not_running";
  const computer = await deps.prisma.computer.findUnique({
    where: { id: job.computerId },
    select: { homeKey: true, kind: true, providerRef: true },
  });
  const context: AdapterContext = {
    operationId: `shell-job-stop:${job.id}`,
    traceId: `shell-job-stop:${job.id}`,
    spaceId: job.spaceId,
    userId: job.userId,
    botId: job.botId,
    signal: deadlineSignal(30_000),
  };
  const killed = computer?.providerRef
    ? await killShellJobProcesses(
        deps.sandbox,
        toComputerRef(computer),
        job.computerId,
        job.id,
        context,
      )
    : false;
  getLogger().info("shell_job.stopped", {
    ...shellJobLogFields(job),
    "shell_job.reason": reason,
    "shell_job.killed": killed,
  });
  if (!killed) return "requested";
  const now = new Date();
  await deps.prisma.shellJob.updateMany({
    where: { id: job.id, status: "running" },
    data: {
      status: "killed",
      finishedAt: now,
      returnedAt: now,
      deliveredAs: "none",
      nextPollAt: null,
    },
  });
  return "stopped";
}

/**
 * The owner's Stop on a thread stops its background jobs too: "stop everything". A run that just
 * ends never does; its jobs keep running and report back.
 */
export async function stopThreadShellJobs(
  deps: ShellJobStopDeps,
  threadId: string,
): Promise<number> {
  const running = await deps.prisma.shellJob.findMany({
    where: { threadId, status: "running" },
  });
  const outcomes = await Promise.all(
    running.map((job) => stopShellJob(deps, job, "thread_stop").catch(() => "requested" as const)),
  );
  return outcomes.filter((outcome) => outcome !== "not_running").length;
}
