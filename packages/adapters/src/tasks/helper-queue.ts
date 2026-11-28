/**
 * Fork (FORK.md 1.33, A2): helpers that wait for a free slot.
 *
 * An agent may ask for more helpers than run at once. The call beyond the cap is accepted: its
 * card goes into the chat as queued, a row remembers it, and the platform starts it when a slot
 * frees (a helper's result going back, the reconciler's tick). No model turn is needed, so a job
 * of many parts moves on while nobody is talking to the agent.
 */
import type { MessageBlock } from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  BACKGROUND_HELPER_TRIGGER,
  STOPPED_HELPER_RESULT,
} from "@rakazo/core";
import type { Prisma } from "@rakazo/db";
import {
  appendEventInTransaction,
  changeMessageBlocks,
  createThreadMessageInTransaction,
  storedMessageBlocks,
  THREAD_LOCK_TRANSACTION_OPTIONS,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "../runs/executor/executor-deps.js";
import { wakeRun } from "../runs/wakeups/wake-run.js";
import { MAX_PARALLEL_SUBAGENTS } from "../runtime/pi/tools/pi-runtime-subagent.js";
import { QUEUED_HELPER_PROGRESS } from "./background-helpers.prompt.js";
import type { ContinuityConfig } from "./continuity-config.js";

type HelperBlock = Extract<MessageBlock, { kind: "subagent" }>;
type QueueDeps = Pick<ExecutorDeps, "prisma"> & {
  events: Pick<ExecutorDeps["events"], "notify">;
  jobs?: ExecutorDeps["jobs"];
};

export const QUEUED_HELPER_STATUSES = ["queued", "started", "cancelled"] as const;

/** Whether an agent with `waiting` queued helpers may queue one more. */
export function helperQueueHasRoom(
  waiting: number,
  config: Pick<ContinuityConfig, "helperQueueMax">,
): boolean {
  return waiting < config.helperQueueMax;
}

/**
 * Queue one helper inside the caller's transaction (the chat and the agent are already locked).
 * Its card is posted now, so the person sees the work was accepted; its own thread and task are
 * made now too, so the brief is stored like every other task's.
 */
export async function queueHelperInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    spaceId: string;
    botId: string;
    threadId: string;
    userId: string;
    originRunId: string;
    clientNonce: string;
    card: HelperBlock;
    prompt: string;
    modelProvider: string;
    modelId: string;
    sourceMessageIds: string[];
  },
  config: Pick<ContinuityConfig, "helperQueueMax">,
): Promise<"queue_full" | { queued: true; eventSeq: number }> {
  const waiting = await tx.queuedHelper.count({
    where: { botId: input.botId, status: "queued" },
  });
  if (!helperQueueHasRoom(waiting, config)) return "queue_full";
  const card: HelperBlock = { ...input.card, status: "running", progress: QUEUED_HELPER_PROGRESS };
  const message = await createThreadMessageInTransaction(tx, {
    threadId: input.threadId,
    role: "bot",
    blocks: [card],
    botId: input.botId,
    markUnread: false,
  });
  const event = await appendEventInTransaction(tx, {
    spaceId: input.spaceId,
    threadId: input.threadId,
    botId: input.botId,
    type: "thread.message.created",
    payload: { messageId: message.id, role: "bot", blocks: [card] },
  });
  const helperThread = await tx.thread.create({
    data: { spaceId: input.spaceId, userId: input.userId, helperBotId: input.botId },
    select: { id: true },
  });
  const task = await tx.task.create({
    data: {
      spaceId: input.spaceId,
      botId: input.botId,
      threadId: helperThread.id,
      userId: input.userId,
      prompt: input.prompt,
      status: "queued",
    },
  });
  await tx.queuedHelper.create({
    data: {
      spaceId: input.spaceId,
      botId: input.botId,
      threadId: input.threadId,
      userId: input.userId,
      originRunId: input.originRunId,
      cardMessageId: message.id,
      clientNonce: input.clientNonce,
      helperThreadId: helperThread.id,
      taskId: task.id,
      modelProvider: input.modelProvider || null,
      modelId: input.modelId || null,
      sourceMessageIds: input.sourceMessageIds,
    },
  });
  return { queued: true, eventSeq: event.seq };
}

/** Rewrite a queued helper's card and say so in the chat's event log. */
async function changeQueuedCard(
  tx: Prisma.TransactionClient,
  row: { spaceId: string; botId: string; threadId: string; cardMessageId: string },
  change: (card: HelperBlock) => HelperBlock,
): Promise<number | null> {
  const message = await tx.message.findFirst({
    where: { id: row.cardMessageId, threadId: row.threadId },
    select: { id: true, blocks: true },
  });
  if (!message) return null;
  const next = changeMessageBlocks(message, (block) =>
    block.kind === "subagent" && block.status === "running" ? change(block) : block,
  );
  if (!next) return null;
  await tx.message.update({ where: { id: message.id }, data: { blocks: next.stored } });
  const event = await appendEventInTransaction(tx, {
    spaceId: row.spaceId,
    threadId: row.threadId,
    botId: row.botId,
    type: "thread.message.updated",
    payload: { messageId: message.id, role: "bot", blocks: next.blocks },
  });
  return event.seq;
}

/**
 * Stop's part for helpers that never started, in the caller's transaction (the chat is locked):
 * the rows are cancelled and their cards settle as stopped, like a stopped helper's.
 * `cardMessageId` stops only the helper behind that card.
 */
export async function cancelQueuedHelpersInTransaction(
  tx: Prisma.TransactionClient,
  where: { threadId: string; cardMessageId?: string | undefined },
): Promise<{ cancelled: number; eventSeq: number | null }> {
  const rows = await tx.queuedHelper.findMany({
    where: {
      threadId: where.threadId,
      status: "queued",
      ...(where.cardMessageId ? { cardMessageId: where.cardMessageId } : {}),
    },
    select: { id: true, spaceId: true, botId: true, threadId: true, cardMessageId: true },
  });
  let eventSeq: number | null = null;
  let cancelled = 0;
  for (const row of rows) {
    const claimed = await tx.queuedHelper.updateMany({
      where: { id: row.id, status: "queued" },
      data: { status: "cancelled" },
    });
    if (claimed.count !== 1) continue;
    cancelled += 1;
    const seq = await changeQueuedCard(tx, row, (card) => ({
      ...card,
      status: "failed",
      progress: undefined,
      result: STOPPED_HELPER_RESULT,
    }));
    if (seq !== null) eventSeq = seq;
  }
  return { cancelled, eventSeq };
}

/**
 * Start the agent's queued helpers while it has free slots, oldest first. Safe to call from
 * anywhere, any number of times: each start claims its row under the agent's lock, and a start
 * that loses the race does nothing. Returns how many helpers it started.
 */
export async function startQueuedHelpers(deps: QueueDeps, botId: string): Promise<number> {
  let startedCount = 0;
  // One more than the cap: a pass that starts nothing ends the loop anyway.
  for (let pass = 0; pass <= MAX_PARALLEL_SUBAGENTS; pass++) {
    const next = await deps.prisma.queuedHelper.findFirst({
      where: { botId, status: "queued" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, threadId: true, thread: { select: { groupId: true } } },
    });
    if (!next) break;
    const committed = await deps.prisma.$transaction(async (tx) => {
      // Same lock order as a direct start: group, chat, agent.
      if (next.thread.groupId)
        await tx.$queryRaw`SELECT id FROM chat_groups WHERE id = ${next.thread.groupId} FOR NO KEY UPDATE`;
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${next.threadId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM bots WHERE id = ${botId} FOR UPDATE`;
      const row = await tx.queuedHelper.findFirst({ where: { id: next.id, status: "queued" } });
      if (!row) return "retry" as const;
      const running = await tx.run.count({
        where: {
          botId,
          trigger: BACKGROUND_HELPER_TRIGGER,
          status: { in: [...ACTIVE_RUN_STATUSES] },
        },
      });
      if (running >= MAX_PARALLEL_SUBAGENTS) return "full" as const;
      const [bot, task] = await Promise.all([
        tx.bot.findFirst({
          where: { id: botId, spaceId: row.spaceId, archivedAt: null },
          select: { id: true },
        }),
        tx.task.findFirst({
          where: { id: row.taskId, threadId: row.helperThreadId },
          select: { id: true },
        }),
      ]);
      if (!bot || !task) {
        // The agent was archived, or its unused helper threads were cleared: nothing to start.
        await tx.queuedHelper.update({ where: { id: row.id }, data: { status: "cancelled" } });
        const seq = await changeQueuedCard(tx, row, (card) => ({
          ...card,
          status: "failed",
          progress: undefined,
          result: STOPPED_HELPER_RESULT,
        }));
        return { eventSeq: seq, threadId: row.threadId, helperRunId: null };
      }
      const helperRun = await tx.run.create({
        data: {
          spaceId: row.spaceId,
          botId,
          threadId: row.helperThreadId,
          taskId: row.taskId,
          userId: row.userId,
          status: "queued",
          trigger: BACKGROUND_HELPER_TRIGGER,
          sourceMessageId: row.cardMessageId,
          delegatedFromRunId: row.originRunId,
          clientNonce: row.clientNonce,
          ...(row.modelProvider && row.modelId
            ? { modelProvider: row.modelProvider, modelId: row.modelId, modelPinned: true }
            : {}),
        },
        select: { id: true },
      });
      // The person's files, as a direct start hands them over (see startBackgroundHelper).
      const sources = row.sourceMessageIds.length
        ? await tx.message.findMany({
            where: { id: { in: row.sourceMessageIds }, threadId: row.threadId, role: "user" },
            select: { id: true, blocks: true },
            orderBy: { seq: "asc" },
          })
        : [];
      const attachments = sources.flatMap((source) =>
        storedMessageBlocks(source).filter(
          (block) => block.kind === "file" || block.kind === "image",
        ),
      );
      if (attachments.length) {
        const input = await createThreadMessageInTransaction(tx, {
          threadId: row.helperThreadId,
          role: "user",
          authorUserId: row.userId,
          botId,
          runId: helperRun.id,
          blocks: attachments,
          markUnread: false,
        });
        await appendEventInTransaction(tx, {
          spaceId: row.spaceId,
          threadId: row.helperThreadId,
          botId,
          runId: helperRun.id,
          type: "thread.message.created",
          payload: { messageId: input.id, role: "user", blocks: attachments },
        });
      }
      await tx.queuedHelper.update({
        where: { id: row.id },
        data: { status: "started", helperRunId: helperRun.id },
      });
      const seq = await changeQueuedCard(tx, row, (card) => ({ ...card, progress: undefined }));
      return { eventSeq: seq, threadId: row.threadId, helperRunId: helperRun.id };
    }, THREAD_LOCK_TRANSACTION_OPTIONS);
    if (committed === "full") break;
    if (committed === "retry") continue;
    if (committed.eventSeq !== null)
      await deps.events.notify(committed.threadId, committed.eventSeq);
    if (!committed.helperRunId) continue;
    startedCount += 1;
    getLogger().info("helper.queue_started", {
      "bot.id": botId,
      "thread.id": committed.threadId,
      "run.id": committed.helperRunId,
    });
    // Without a queue at hand (the stop path) the reconciler wakes the queued run.
    if (deps.jobs) await wakeRun(deps.jobs, committed.helperRunId);
  }
  return startedCount;
}

/** The reconciler's safety net: every agent with a helper waiting gets its free slots filled. */
export async function startAllQueuedHelpers(deps: QueueDeps, limit = 50): Promise<number> {
  const waiting = await deps.prisma.queuedHelper.findMany({
    where: { status: "queued" },
    distinct: ["botId"],
    orderBy: [{ createdAt: "asc" }],
    take: limit,
    select: { botId: true },
  });
  let started = 0;
  for (const { botId } of waiting) started += await startQueuedHelpers(deps, botId);
  return started;
}
