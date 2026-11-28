import { continuationPrompt } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { continuityConfig } from "../../tasks/continuity-config.js";
import type { RunContext } from "../assembly/run-context.js";
import { delegationOriginId } from "../lifecycle/run-origin.js";
import { wakeRun } from "../wakeups/wake-run.js";
import { noteAutoContinuation } from "./run-audit.js";
import { ANNOUNCED_WORK_LOG, announcedWorkOnly, olderRuleDecidesAlone } from "./run-open-work.js";

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
  // Fork (L5): with both rules on, this one is a fact of the open-work decision (run-open-work.ts)
  // and starts nothing here. It decides alone only when one of the two is switched off.
  const config = continuityConfig();
  if (!olderRuleDecidesAlone(config)) return;
  // A run that stopped for the person (takeover, question, approval) acted, even when the pause
  // was not a tool call (the scripted runtime) or the resumed attempt started without the paused
  // attempt's steps. Continuing it asked for the same takeover a second time.
  const announced = await announcedWorkOnly(deps.prisma, {
    runId: run.id,
    trigger: run.trigger,
    request,
    toolCallCount: reply.toolCalls.length,
    replyText,
    taskPrompt: task?.prompt ?? null,
    replyCompletes: config.onePath,
  });
  if (!announced) return;
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
  getLogger().warn(ANNOUNCED_WORK_LOG, {
    "run.id": run.id,
    "run.continuation": created.id,
  });
  await wakeRun(deps.jobs, created.id);
}
