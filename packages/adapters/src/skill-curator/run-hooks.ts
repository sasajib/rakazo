/**
 * Fork: RunContext adapters for the skill curator's seams, so each upstream file gains one call.
 */
import type { RunContext } from "../runs/assembly/run-context.js";
import { curatorEnabled } from "./config.js";
import { toolOutline } from "./outline.js";
import { scheduleSkillCuration } from "./seams.js";

/** Run-finished hook: queue the curator for this run; returns at once and never throws. */
export function curateAfterRun(ctx: RunContext): void {
  if (!curatorEnabled()) return;
  try {
    const { run, bot } = ctx;
    scheduleSkillCuration(
      ctx.deps,
      {
        runId: ctx.runId,
        spaceId: run.spaceId,
        userId: run.userId,
        threadId: ctx.source.conversationThreadId ?? run.threadId,
        botId: bot.id,
        botName: bot.name ?? null,
        trigger: run.trigger,
        sourceMessageId: run.sourceMessageId ?? null,
        ownerStartedRun: ctx.source.ownerStartedRun,
        messagingChannelRun: ctx.source.messagingChannelRun,
      },
      toolOutline(ctx.state.reply),
    );
  } catch {
    // The run is finished; learning is best effort.
  }
}
