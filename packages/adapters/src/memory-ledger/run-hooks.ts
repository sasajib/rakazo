/**
 * RunContext adapters for the seams, so each upstream file gains one call and one import.
 */
import type { RunContext } from "../runs/assembly/run-context.js";
import { ledgerEnabled } from "./config.js";
import type { FinishedRun, ToolRun } from "./seams.js";
import { recallViaLedger, rememberViaLedger, scheduleLedgerLearning } from "./seams.js";

export function runFacts(ctx: RunContext): FinishedRun & ToolRun {
  const { run, bot } = ctx;
  return {
    runId: ctx.runId,
    spaceId: run.spaceId,
    userId: run.userId,
    threadId: ctx.source.conversationThreadId ?? run.threadId,
    botId: bot.id,
    botName: bot.name ?? null,
    trigger: run.trigger,
    sourceMessageId: run.sourceMessageId ?? null,
    // Not `meetingChat`: upstream sets it for every owner's one-to-one bot chat (the chat a meeting
    // transcript can be shared into), so excluding it turned learning off in exactly those chats.
    ownerStartedRun: ctx.source.ownerStartedRun,
    messagingChannelRun: ctx.source.messagingChannelRun,
  };
}

/** Run-finished hook: queue the writer; returns at once and never throws. */
export function learnAfterRun(ctx: RunContext): void {
  if (!ledgerEnabled()) return;
  try {
    scheduleLedgerLearning(ctx.deps, runFacts(ctx));
  } catch {
    // The run is finished; learning is best effort.
  }
}

/** remember tool: the ledger's result, or undefined to keep the bot's MEMORY.md behaviour. */
export async function rememberToolViaLedger(
  ctx: RunContext,
  operations: ReadonlyArray<{ action: "add" | "replace" | "remove"; content?: string | undefined }>,
): Promise<Record<string, unknown> | undefined> {
  if (!ledgerEnabled()) return undefined;
  // Text another source steered into this run is not the owner's request to remember.
  if (await ctx.trust.receivedOutsideMessage().catch(() => true)) return undefined;
  return rememberViaLedger(ctx.deps, runFacts(ctx), operations);
}

/** recall_memory: ledger facts for the query, or undefined when the ledger is off. */
export function recallToolViaLedger(
  ctx: RunContext,
  query: string,
): Promise<Array<Record<string, unknown>> | undefined> {
  if (!ledgerEnabled()) return Promise.resolve(undefined);
  return recallViaLedger(ctx.deps, { spaceId: ctx.run.spaceId, query });
}
