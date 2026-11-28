import { continuationPrompt, needsContinuation, PAUSED_FOR_PERSON_EVENT_TYPES } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import type { RunContext } from "../assembly/run-context.js";
import { delegationOriginId } from "../lifecycle/run-origin.js";
import { wakeRun } from "../wakeups/wake-run.js";
import { noteAutoContinuation } from "./run-audit.js";

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
  const facts = {
    trigger: run.trigger,
    request,
    toolCallCount: reply.toolCalls.length,
    replyText,
    taskPrompt: task?.prompt ?? null,
    status: "completed",
  };
  if (!needsContinuation(facts)) return;
  // Read only when the rule would fire. A run that stopped for the person (takeover, question,
  // approval) acted, even when the pause was not a tool call (the scripted runtime) or the
  // resumed attempt started without the paused attempt's steps. Continuing it asked for the same
  // takeover a second time, right after the person had finished it.
  const pausedForPerson =
    (await deps.prisma.event.count({
      where: { runId: run.id, type: { in: [...PAUSED_FOR_PERSON_EVENT_TYPES] } },
    })) > 0;
  if (!needsContinuation({ ...facts, pausedForPerson })) return;
  // Fork (1.33): the continuation names the conversation it works for, so a helper it starts is
  // authorized like one of the run it continues (see delegationOriginId).
  const originRunId = await delegationOriginId(deps.prisma, { ...run, id: run.id });
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
        ...(originRunId ? { delegatedFromRunId: originRunId } : {}),
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
