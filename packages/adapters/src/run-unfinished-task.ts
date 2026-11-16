import { continuationPrompt, needsContinuation } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { noteAutoContinuation } from "./run-audit.js";
import type { RunContext } from "./run-context.js";
import { wakeRun } from "./wake-run.js";

/**
 * The deterministic part of "it will do the work": a person's run that announced work and used no
 * tool is continued once, automatically. No model is asked whether the work happened — the rule
 * reads the trigger, the tool count and the person's own words.
 */
export async function continueUnfinishedTask(ctx: RunContext): Promise<void> {
  const { deps, run, task } = ctx;
  const { reply } = ctx.state;
  const request = ctx.task.prompt ?? "";
  const replyText = reply.assembled || reply.assistantTurnText || "";
  if (
    !needsContinuation({
      trigger: run.trigger,
      request,
      toolCallCount: reply.toolCalls.length,
      replyText,
      taskPrompt: task?.prompt ?? null,
      status: "completed",
    })
  ) {
    return;
  }
  const created = await deps.prisma.$transaction(async (tx) => {
    const nextTask = await tx.task.create({
      data: {
        spaceId: run.spaceId,
        botId: run.botId,
        threadId: run.threadId,
        userId: run.userId,
        prompt: continuationPrompt(request),
        status: "queued",
      },
    });
    return tx.run.create({
      data: {
        spaceId: run.spaceId,
        botId: run.botId,
        threadId: run.threadId,
        taskId: nextTask.id,
        userId: run.userId,
        status: "queued",
        trigger: "follow_up",
      },
      select: { id: true },
    });
  });
  noteAutoContinuation(run.id);
  getLogger().warn("run continued: it announced work and used no tool", {
    "run.id": run.id,
    "run.continuation": created.id,
  });
  await wakeRun(deps.jobs, created.id);
}
