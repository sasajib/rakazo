import type { BotMessageIntent, MessageBlock } from "@rakazo/contracts";
import {
  BOT_MESSAGE_MAX_LENGTH,
  BOT_MESSAGE_TOO_LONG,
  botMessageContext,
  botMessageHopExhausted,
  botMessageWaitingText,
  buildBotMessageWakePrompt,
  callIdFromClientNonce,
  clampBotMessage,
  nextBotMessageHop,
  resolveBotAddress,
  retry,
  sanitizeMessagingLabel,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  isUniqueViolation,
  spaceTakesWork,
  storedMessageBlocks,
  THREAD_LOCK_TRANSACTION_OPTIONS,
  withTransactionRetry,
} from "@rakazo/db";
import { bestEffort, getLogger } from "@rakazo/logging";
import { runLeaseFor } from "../runs/assembly/run-messages.js";
import type { ExecutorDeps } from "../runs/executor/executor-deps.js";
import { normalizeLane } from "../runs/lifecycle/run-gate.js";
import { wakeRun } from "../runs/wakeups/wake-run.js";
import { describeQueueItem, findQueuedDuplicate, loadBotQueue } from "./bot-queue.js";
import type { SupersededRequest } from "./bot-supersede.js";
import {
  cancelReplacedRequest,
  findReplaceableRequest,
  finishReplacedRequest,
  replacesPreface,
} from "./bot-supersede.js";

/**
 * The hop the current run sits at, read back from the message that woke this
 * bot. A run a person started carries no bot message, so it starts at 0.
 */
export async function currentBotMessageHop(
  prisma: PrismaClient,
  sourceMessageId: string | null | undefined,
): Promise<number> {
  if (!sourceMessageId) return 0;
  const source = await prisma.message.findUnique({
    where: { id: sourceMessageId },
    select: { blocks: true },
  });
  const blocks = source ? storedMessageBlocks({ id: sourceMessageId, blocks: source.blocks }) : [];
  return botMessageContext(blocks)?.hop ?? 0;
}

export async function loadBotMessageContext(
  prisma: PrismaClient,
  sourceMessageId: string | null | undefined,
) {
  if (!sourceMessageId) return undefined;
  const source = await prisma.message.findUnique({
    where: { id: sourceMessageId },
    select: { blocks: true, replyTo: { select: { id: true, blocks: true } } },
  });
  const context = botMessageContext(
    source ? storedMessageBlocks({ id: sourceMessageId, blocks: source.blocks }) : [],
  );
  if (!context) return undefined;
  const replyBlocks = source?.replyTo ? storedMessageBlocks(source.replyTo) : [];
  const repliesToRequest =
    (context.intent === "result" || context.intent === "status" || context.intent === "fyi") &&
    replyBlocks.some(
      (block) =>
        block.kind === "bot_message_sent" &&
        block.toBotId === context.fromBotId &&
        (block.intent === undefined || block.intent === "request" || block.intent === "question"),
    );
  return { ...context, repliesToRequest };
}

/** Bots named in a resolution error; a large Space must not turn one tool result into a wall. */
const REACHABLE_BOTS_MAX = 12;

/**
 * What a failed lookup could have used instead. The candidates are already loaded for the
 * lookup, and a bare "no bot found" leaves a weaker model retrying the same name or reporting
 * the tool broken. Bots without a chat cannot be delivered to, and a bot cannot message
 * itself, so neither is offered.
 */
export function unresolvedBotError(
  candidates: readonly { id: string; name: string; thread: unknown }[],
  senderId: string,
): string {
  const reachable = candidates.filter((bot) => bot.id !== senderId && bot.thread);
  if (reachable.length === 0) {
    return "no bot found with that id or name. No other bot in this space has a chat to message";
  }
  const listed = reachable
    .slice(0, REACHABLE_BOTS_MAX)
    .map((bot) => `${sanitizeMessagingLabel(bot.name)} (${bot.id})`);
  const hidden = reachable.length - listed.length;
  return `no bot found with that id or name. Bots reachable from this space (use bot_id): ${listed.join("; ")}${
    hidden > 0 ? `; and ${hidden} more` : ""
  }`;
}

const LIVE_CALL_WINDOW_MS = 5 * 60_000;

/**
 * A call has no row of its own: it is the "call:<id>:" nonce on its messages, ended by a call_end
 * run. A call counts as live while its latest message is recent and no call_end followed it.
 */
export async function threadHasLiveCall(
  prisma: Pick<ExecutorDeps["prisma"], "message" | "run">,
  threadId: string,
  now = new Date(),
): Promise<boolean> {
  try {
    const last = await prisma.message.findFirst({
      where: {
        threadId,
        clientNonce: { startsWith: "call:" },
        createdAt: { gt: new Date(now.getTime() - LIVE_CALL_WINDOW_MS) },
      },
      orderBy: { createdAt: "desc" },
      select: { clientNonce: true },
    });
    const callId = callIdFromClientNonce(last?.clientNonce);
    if (!callId) return false;
    const ended = await prisma.run.findFirst({
      where: { threadId, trigger: "call_end", clientNonce: { startsWith: `call:${callId}:` } },
      select: { id: true },
    });
    return !ended;
  } catch {
    return false;
  }
}

export async function messageBot(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs" | "runLease"> &
    Partial<Pick<ExecutorDeps, "sandbox">>,
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
    sourceMessageId?: string | null;
  },
  sender: { id: string; name: string },
  input: {
    bot_id?: string;
    confirm_name?: string;
    message: string;
    intent?: BotMessageIntent;
    /** Work lane (a site or topic): one active request per lane; none = the conversation. */
    lane?: string | null;
    /** Send even when the same request is already open in the recipient's queue. */
    force?: boolean;
    /**
     * Fork: an earlier request of this bot to the same recipient that this one corrects (its
     * request id, an id prefix of 6+ characters, or "latest"). It is cancelled, or stopped when it
     * is already working, and this one starts at once in its place.
     */
    replaces?: string;
    deliveryKey?: string;
    /** Attachments filed under the recipient's chat, shown there and copied to its computer. */
    files?: Array<Extract<MessageBlock, { kind: "image" | "file" }>>;
  },
  /** `ended` or `waiting` sends a return to the requester from a run that is no longer running. */
  options?: { returnFrom?: "ended" | "waiting"; forceUnread?: boolean },
) {
  const message = String(input.message ?? "").trim();
  if (!message) return { ok: false as const, error: "message is required" };
  if (message.length > BOT_MESSAGE_MAX_LENGTH) {
    return { ok: false as const, error: BOT_MESSAGE_TOO_LONG };
  }

  const sourceContext = await loadBotMessageContext(deps.prisma, run.sourceMessageId);
  const intent = input.intent ?? "request";
  const hop = nextBotMessageHop(sourceContext?.hop);

  const candidates = await deps.prisma.bot.findMany({
    where: { spaceId: run.spaceId, archivedAt: null },
    select: { id: true, name: true, thread: { select: { id: true } } },
  });
  const target = resolveBotAddress(candidates, {
    botId: input.bot_id,
    name: input.confirm_name,
  });
  if (!target) {
    return { ok: false as const, error: unresolvedBotError(candidates, sender.id) };
  }
  if (target.id === sender.id) return { ok: false as const, error: "a bot cannot message itself" };
  if (!target.thread)
    return { ok: false as const, error: `${target.name} has no chat to deliver to` };
  const returnFrom = options?.returnFrom;
  const returnsToSender =
    returnFrom !== undefined &&
    (intent === "result" || intent === "status") &&
    (sourceContext?.intent === undefined ||
      sourceContext.intent === "request" ||
      sourceContext.intent === "question") &&
    sourceContext?.fromBotId === target.id;
  if (botMessageHopExhausted(hop) && !returnsToSender) {
    return {
      ok: false as const,
      error:
        "bot-to-bot message limit reached for this chain; report back to the user instead of messaging another bot",
    };
  }

  const targetThreadId = target.thread.id;

  // A tool call can be re-executed after a lease expiry, so a delivery has to be
  // replayable: without this the recipient is messaged twice and woken twice.
  const deliveryKey = input.deliveryKey ? `bot-message:${input.deliveryKey}` : undefined;
  const replayed = () =>
    ({
      ok: true as const,
      botId: target.id,
      name: target.name,
      delivered: message,
      replayed: true as const,
      note: `Already sent to ${target.name} in this turn; it was not sent again.`,
    }) as const;

  const onCall = await threadHasLiveCall(deps.prisma, targetThreadId);
  const files = input.files ?? [];
  const replacesRef = String(input.replaces ?? "").trim();
  let superseded: SupersededRequest | undefined;

  let committed:
    | {
        ok: true;
        runId: string;
        targetEventSeq: number;
        senderEventSeq: number;
        delivered: string;
      }
    | {
        ok: false;
        error: string;
      }
    | {
        ok: true;
        replayed: true;
      }
    | {
        ok: true;
        duplicate: true;
        of: string;
      };
  try {
    committed = await withTransactionRetry(() =>
      deps.prisma.$transaction(async (tx) => {
        superseded = undefined;
        if (!(await spaceTakesWork(tx, run.spaceId)))
          return { ok: false as const, error: "this Space is being deleted" };
        for (const threadId of [run.threadId, targetThreadId].sort()) {
          await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
        }
        // Claim the delivery key inside the transaction so a concurrent retry
        // either sees the winner or loses on the unique (threadId, clientNonce).
        if (deliveryKey) {
          const already = await tx.message.findUnique({
            where: { threadId_clientNonce: { threadId: targetThreadId, clientNonce: deliveryKey } },
            select: { id: true },
          });
          if (already) return { ok: true as const, replayed: true as const };
        }

        // The recipient's queue, read under the target thread's lock: concurrent sends of the same
        // request see each other, so a request that is already open is not queued twice.
        if (!input.force && !replacesRef) {
          const queue = await loadBotQueue(tx, { botId: target.id, now: new Date() });
          const same = findQueuedDuplicate(message, queue, normalizeLane(input.lane));
          if (same)
            return { ok: true as const, duplicate: true as const, of: describeQueueItem(same) };
        }

        const senderStillRunning = await tx.run.findFirst({
          where: {
            id: run.id,
            spaceId: run.spaceId,
            threadId: run.threadId,
            botId: run.botId,
            userId: run.userId,
            status:
              returnFrom === "ended"
                ? { in: ["completed", "failed", "cancelled"] }
                : returnFrom === "waiting"
                  ? "waiting_input"
                  : "running",
          },
          select: { id: true },
        });
        if (!senderStillRunning)
          return { ok: false as const, error: "source run is no longer active" };

        // Re-read the target inside the transaction: it can be archived between
        // resolving it above and committing here.
        const stillAddressable = await tx.bot.findFirst({
          where: {
            id: target.id,
            spaceId: run.spaceId,
            archivedAt: null,
          },
          select: { id: true },
        });
        if (!stillAddressable)
          return { ok: false as const, error: `${target.name} is no longer available` };

        // Fork: a correction replaces the request it corrects, under the same lock, after every check
        // that can still refuse the send (an early return commits the transaction).
        let text = message;
        if (replacesRef) {
          const found = await findReplaceableRequest(tx, {
            targetBotId: target.id,
            senderId: sender.id,
            ref: replacesRef,
          });
          if (!found.ok) return { ok: false as const, error: found.error };
          superseded = await cancelReplacedRequest(tx, {
            spaceId: run.spaceId,
            targetThreadId,
            targetBotId: target.id,
            run: found.run,
            summary: found.summary,
          });
          if (!superseded)
            return {
              ok: false as const,
              error:
                "Not replaced: that request has just finished. Send the correction as a new request.",
            };
          text = `${replacesPreface(superseded)}\n\n${message}`;
        }
        const wakePrompt = buildBotMessageWakePrompt({ from: sender, text, intent, onCall });
        const outboundBlock: MessageBlock = {
          kind: "bot_message_sent",
          toBotId: target.id,
          toBotName: target.name,
          text,
          intent,
        };

        // Echo into the sender's chat in the same transaction so a failed notify
        // cannot leave one side delivered and the other blank.
        const outbound = await createThreadMessageInTransaction(tx, {
          threadId: run.threadId,
          role: "bot",
          blocks: [outboundBlock],
          botId: run.botId,
          runId: run.id,
          markUnread: options?.forceUnread === true,
          allowCancelledRun: returnFrom === "ended",
          lease: runLeaseFor(deps, run.id),
        });
        const inboundBlock: MessageBlock = {
          kind: "bot_message_received",
          fromBotId: sender.id,
          fromBotName: sender.name,
          text,
          hop,
          intent,
          returnToMessageId: outbound.id,
        };
        const inbound = await createThreadMessageInTransaction(tx, {
          threadId: targetThreadId,
          role: "user",
          blocks: [inboundBlock, ...files],
          replyToMessageId:
            sourceContext?.fromBotId === target.id && intent !== "fyi"
              ? sourceContext.returnToMessageId
              : undefined,
          clientNonce: deliveryKey,
          markUnread: options?.forceUnread === true,
        });
        const task = await tx.task.create({
          data: {
            spaceId: run.spaceId,
            botId: target.id,
            threadId: targetThreadId,
            userId: run.userId,
            prompt: wakePrompt,
            status: "queued",
          },
        });
        const nextRun = await tx.run.create({
          data: {
            spaceId: run.spaceId,
            botId: target.id,
            threadId: targetThreadId,
            taskId: task.id,
            userId: run.userId,
            status: "queued",
            trigger: "bot_message",
            lane: normalizeLane(input.lane),
            sourceMessageId: inbound.id,
          },
          select: { id: true },
        });
        await tx.message.update({ where: { id: inbound.id }, data: { runId: nextRun.id } });
        const inboundEvent = await appendEventInTransaction(tx, {
          spaceId: run.spaceId,
          threadId: targetThreadId,
          botId: target.id,
          type: "thread.message.created",
          runId: nextRun.id,
          payload: { messageId: inbound.id, role: "user", blocks: [inboundBlock, ...files] },
        });
        const outboundEvent = await appendEventInTransaction(tx, {
          spaceId: run.spaceId,
          threadId: run.threadId,
          botId: run.botId,
          type: "thread.message.created",
          runId: run.id,
          allowCancelledRun: returnFrom === "ended",
          lease: runLeaseFor(deps, run.id),
          payload: { messageId: outbound.id, role: "bot", blocks: [outboundBlock] },
        });
        return {
          ok: true as const,
          runId: nextRun.id,
          targetEventSeq: inboundEvent.seq,
          senderEventSeq: outboundEvent.seq,
          delivered: text,
        };
      }, THREAD_LOCK_TRANSACTION_OPTIONS),
    );
  } catch (error) {
    // Two concurrent retries can both miss the in-transaction lookup; the
    // loser hits the unique key. Treat that as a successful replay.
    if (deliveryKey && isUniqueViolation(error)) {
      const winner = await deps.prisma.message.findUnique({
        where: { threadId_clientNonce: { threadId: targetThreadId, clientNonce: deliveryKey } },
        select: { id: true },
      });
      if (winner) return replayed();
    }
    throw error;
  }
  if ("replayed" in committed) return replayed();
  if ("duplicate" in committed) {
    return {
      ok: true as const,
      botId: target.id,
      name: target.name,
      delivered: message,
      duplicate: true as const,
      note: `Not sent: ${target.name} already has this request (${committed.of}). Do not send it again. Look at the queue with bot_queue; add force:true only if it is genuinely new work.`,
    } as const;
  }
  if (!committed.ok) return committed;

  await deps.events.notify(targetThreadId, committed.targetEventSeq);
  await deps.events.notify(run.threadId, committed.senderEventSeq);
  if (superseded) {
    await finishReplacedRequest(deps, run, superseded);
    getLogger().info("bot_message.superseded", {
      "run.id": run.id,
      "bot_message.replaced_run": superseded.runId,
      "bot_message.replaced_was_running": superseded.wasRunning,
      "bot_message.replaced_age_s": superseded.ageSeconds,
      "bot_message.new_run": committed.runId,
      "bot.id": target.id,
    });
  }
  await wakeRun(deps.jobs, committed.runId);
  return {
    ok: true as const,
    botId: target.id,
    name: target.name,
    delivered: committed.delivered,
    requestId: committed.runId,
    ...(superseded
      ? { replaced: { requestId: superseded.runId, stopped: superseded.wasRunning } }
      : {}),
    note: superseded
      ? `Sent to ${target.name}; it replaces request ${superseded.runId.slice(0, 8)}, which was ${superseded.wasRunning ? "stopped" : "cancelled"}. The correction starts now. A reply wakes you later as a new message.`
      : `Sent to ${target.name} (request id ${committed.runId}; to correct it later, send message_bot with replaces set to that id). Delivery is async; a reply wakes you later as a new message. Continue independent work; send another update later only if it adds something new.`,
  };
}

type DelegatedRun = {
  id: string;
  spaceId: string;
  threadId: string;
  botId: string;
  userId: string;
  sourceMessageId?: string | null;
};

/** The bot that handed this run its request or question, while it can still take a reply. */
async function requesterBotId(
  prisma: PrismaClient,
  run: DelegatedRun,
): Promise<string | undefined> {
  const source = await loadBotMessageContext(prisma, run.sourceMessageId);
  if (!source) return undefined;
  const sourceIntent = source.intent ?? "request";
  if (sourceIntent !== "request" && sourceIntent !== "question") return undefined;
  // messageBot reaches only active bots of this space, so an archived or deleted
  // requester can never take the reply.
  const requester = await prisma.bot.findFirst({
    where: { id: source.fromBotId, spaceId: run.spaceId, archivedAt: null },
    select: { id: true },
  });
  return requester?.id;
}

/** Return a delegated run's terminal outcome unless it already sent one explicitly. */
export async function returnBotMessageOutcome(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs">,
  run: DelegatedRun,
  sender: { id: string; name: string },
  text: string,
  intent: "result" | "status" = "result",
  options?: { forceUnread?: boolean },
) {
  const requesterId = await requesterBotId(deps.prisma, run);
  if (!requesterId) {
    await markBotOutcomeReturned(deps.prisma, run.id);
    // Handled: nothing to deliver. Return true so callers do not release a reservation.
    return true;
  }
  const sent = await deps.prisma.message.findMany({
    where: { threadId: run.threadId, runId: run.id },
    select: { id: true, blocks: true },
  });
  // Only an explicit result counts as a terminal outcome. Interim message_bot
  // status updates must not suppress the automatic final return.
  const alreadyReturned = sent.some((message) =>
    storedMessageBlocks(message).some(
      (block) =>
        block.kind === "bot_message_sent" &&
        block.toBotId === requesterId &&
        block.intent === "result",
    ),
  );
  if (alreadyReturned) {
    await markBotOutcomeReturned(deps.prisma, run.id);
    return true;
  }
  const outcome = await messageBot(
    deps,
    run,
    sender,
    {
      bot_id: requesterId,
      message: clampBotMessage(text),
      intent,
      // One key per run so status vs result (executor vs reconciler) cannot double-deliver.
      deliveryKey: `auto-outcome:${run.id}`,
    },
    { returnFrom: "ended", forceUnread: options?.forceUnread },
  );
  if (outcome.ok) await markBotOutcomeReturned(deps.prisma, run.id);
  return outcome.ok;
}

/**
 * Tell the requester a delegated run is waiting on the user, so it can say so instead of
 * hearing nothing until the user answers. `waitId` is the paused attempt: one notice per wait.
 */
export async function reportBotMessageWait(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs" | "runLease">,
  run: DelegatedRun & { trigger: string },
  sender: { id: string; name: string },
  ask: string,
  waitId: string,
) {
  if (run.trigger !== "bot_message") return;
  // The delivery key makes a repeat a replay, so any failure is worth another try.
  await bestEffort(
    "bot message wait notice",
    retry(() => sendWaitNotice(deps, run, sender, ask, waitId), {
      attempts: 3,
      retryable: () => true,
    }),
  );
}

async function sendWaitNotice(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs" | "runLease">,
  run: DelegatedRun,
  sender: { id: string; name: string },
  ask: string,
  waitId: string,
) {
  const requesterId = await requesterBotId(deps.prisma, run);
  if (!requesterId) return;
  const sent = await messageBot(
    deps,
    run,
    sender,
    {
      bot_id: requesterId,
      message: clampBotMessage(botMessageWaitingText(ask)),
      intent: "status",
      deliveryKey: `waiting:${waitId}`,
    },
    { returnFrom: "waiting", forceUnread: true },
  );
  if (!sent.ok) getLogger().warn("bot message wait notice not sent", { error: sent.error });
}

async function markBotOutcomeReturned(prisma: PrismaClient, runId: string) {
  await prisma.run.updateMany({
    where: {
      id: runId,
      status: { in: ["completed", "failed", "cancelled"] },
      botOutcomeReturnedAt: null,
    },
    data: { botOutcomeReturnedAt: new Date() },
  });
}
