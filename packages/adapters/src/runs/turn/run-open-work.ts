/**
 * Fork (FORK.md 1.33, A3/A4): continue a run's open work, and tell the owner when it stalls.
 *
 * Runs after a run completed. The rule itself is core's `decideOpenWork`; this file gathers the
 * facts (the agent's open items for this chat, its last words, everything that would wake it
 * anyway), starts the continuation run, and posts the one stalled notice.
 */
import type { MessageBlock } from "@rakazo/contracts";
import type { OpenWorkDecision, OpenWorkItem, OpenWorkWakers } from "@rakazo/core";
import {
  ACTIVE_RUN_STATUSES,
  BACKGROUND_HELPER_TRIGGER,
  decideOpenWork,
  declaresFurtherWork,
  displayName,
  escapePromptData,
  isNeedsPersonBlock,
  isOpenNeedsPersonBlock,
  ONCE_ROUTINE_CRON,
  OPEN_WORK_JUDGE_INSTRUCTIONS,
  OPEN_WORK_NONCE_PREFIX,
  openWorkContinuationPrompt,
  pendingWakers,
  promisedWork,
  replyClosing,
  runIsFollowedForOpenWork,
  stalledNotice,
} from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  storedMessageBlocks,
  THREAD_LOCK_TRANSACTION_OPTIONS,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import * as z from "zod";
import { ledgerConfig } from "../../memory-ledger/config.js";
import type { FetchLike } from "../../memory-ledger/embeddings.js";
import { chatWithBudget, envModelEndpoint } from "../../memory-ledger/model.js";
import { parseModelJson } from "../../models/model-json.js";
import type { ContinuityConfig } from "../../tasks/continuity-config.js";
import { continuityConfig } from "../../tasks/continuity-config.js";
import type { RunContext } from "../assembly/run-context.js";
import type { ExecutorDeps } from "../executor/executor-deps.js";
import { notifyRun } from "../lifecycle/run-notifications.js";
import { delegationOriginId } from "../lifecycle/run-origin.js";
import { wakeRun } from "../wakeups/wake-run.js";
import { noteAutoContinuation } from "./run-audit.js";

type Deps = Pick<ExecutorDeps, "prisma" | "jobs" | "events" | "notifications">;

/** A result that ended this long ago and was not handed back is not coming by itself. */
const HAND_BACK_WINDOW_MS = 30 * 60_000;
/** With no message of a person in the chat, a card older than this belongs to other work. */
const CARD_WINDOW_MS = 24 * 60 * 60_000;

/** The finished run, as the rule needs it. */
export interface EndedRun {
  id: string;
  spaceId: string;
  botId: string;
  threadId: string;
  userId: string;
  trigger: string;
  clientNonce?: string | null;
  delegatedFromRunId?: string | null;
  sourceMessageId?: string | null;
  routineId?: string | null;
  startedAt?: Date | null;
  createdAt: Date;
}

const TERMINAL = ["completed", "failed", "cancelled"];

/** Everything that would bring the agent back to this chat without the platform's help. */
export async function loadOpenWorkWakers(
  prisma: PrismaClient,
  run: Pick<EndedRun, "id" | "spaceId" | "botId" | "threadId">,
  /** When the task began: the person's last own message in this chat. */
  taskStart: Date | null,
  now: Date = new Date(),
): Promise<OpenWorkWakers> {
  const recently = new Date(now.getTime() - HAND_BACK_WINDOW_MS);
  const [helpers, queuedHelpers, runs, jobs, schedules, cardRows, requests] = await Promise.all([
    prisma.run.count({
      where: {
        botId: run.botId,
        trigger: BACKGROUND_HELPER_TRIGGER,
        sourceMessage: { threadId: run.threadId },
        OR: [
          { status: { in: [...ACTIVE_RUN_STATUSES] } },
          // Ended, and its result is still to be handed back (the reconciler does it).
          { status: { in: TERMINAL }, botOutcomeReturnedAt: null, completedAt: { gte: recently } },
        ],
      },
    }),
    prisma.queuedHelper.count({
      where: { botId: run.botId, threadId: run.threadId, status: "queued" },
    }),
    prisma.run.count({
      where: {
        botId: run.botId,
        threadId: run.threadId,
        id: { not: run.id },
        status: { in: [...ACTIVE_RUN_STATUSES] },
      },
    }),
    prisma.shellJob.count({
      where: {
        botId: run.botId,
        threadId: run.threadId,
        OR: [{ status: "running" }, { returnedAt: null, finishedAt: { gte: recently } }],
      },
    }),
    // A one-time schedule the agent set for itself (its own follow-up) that is still due.
    prisma.routine.count({
      where: {
        botId: run.botId,
        active: true,
        nextRunAt: { not: null },
        crons: { has: ONCE_ROUTINE_CRON },
        OR: [{ threadId: run.threadId }, { threadId: null }],
      },
    }),
    // Cards of this task only: one left unanswered by older work must not hold this work up.
    prisma.message.findMany({
      where: {
        threadId: run.threadId,
        botId: run.botId,
        role: "bot",
        createdAt: { gte: taskStart ?? new Date(now.getTime() - CARD_WINDOW_MS) },
      },
      orderBy: { seq: "desc" },
      take: 60,
      select: { id: true, blocks: true },
    }),
    openRequestsOf(prisma, run, recently),
  ]);
  const cards = cardRows.filter((row) =>
    storedMessageBlocks(row).some(
      (block: MessageBlock) => isNeedsPersonBlock(block) && isOpenNeedsPersonBlock(block),
    ),
  ).length;
  return { helpers, queuedHelpers, runs, jobs, schedules, cards, requests };
}

/** Requests this agent sent to other agents whose outcome has not come back to it yet. */
async function openRequestsOf(
  prisma: PrismaClient,
  run: Pick<EndedRun, "spaceId" | "botId">,
  recently: Date,
): Promise<number> {
  const rows = await prisma.run.findMany({
    where: {
      spaceId: run.spaceId,
      trigger: "bot_message",
      botId: { not: run.botId },
      botOutcomeReturnedAt: null,
      OR: [
        { status: { in: [...ACTIVE_RUN_STATUSES] } },
        { status: { in: ["completed", "failed"] }, completedAt: { gte: recently } },
      ],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 40,
    select: { sourceMessage: { select: { id: true, blocks: true } } },
  });
  return rows.filter(
    (row) =>
      row.sourceMessage &&
      (storedMessageBlocks(row.sourceMessage) as Array<Record<string, unknown>>).some(
        (block) => block.kind === "bot_message_received" && block.fromBotId === run.botId,
      ),
  ).length;
}

const JudgeAnswer = z.object({ more_work: z.boolean() });

/**
 * Settle an unclear closing with the small model the memory ledger uses. Any failure, a missing
 * endpoint or the timeout answers "none": an unclear promise never starts a run by itself.
 */
export async function judgeOpenWorkPromise(
  reply: string,
  config: Pick<ContinuityConfig, "judge" | "judgeTimeoutMs">,
  options: { fetchImpl?: FetchLike; env?: Record<string, string | undefined> } = {},
): Promise<"promise" | "none"> {
  if (!config.judge) return "none";
  const model = ledgerConfig(options.env ?? process.env).model;
  const endpoint = envModelEndpoint(model);
  if (!endpoint) return "none";
  try {
    const answer = await chatWithBudget({
      fetchImpl: options.fetchImpl ?? (fetch as unknown as FetchLike),
      url: `${endpoint.baseUrl.replace(/\/+$/, "")}/chat/completions`,
      endpoint,
      messages: [
        { role: "system", content: OPEN_WORK_JUDGE_INSTRUCTIONS },
        { role: "user", content: JSON.stringify({ closing_lines: replyClosing(reply) }) },
      ],
      maxTokens: 4_000,
      timeoutMs: config.judgeTimeoutMs,
      budgetMs: config.judgeTimeoutMs,
      retries: 0,
      retryEvent: "run.open_work_judge_retry",
    });
    if (!answer.ok || typeof answer.content !== "string") return "none";
    return parseModelJson(answer.content, JudgeAnswer)?.more_work === true ? "promise" : "none";
  } catch (error) {
    getLogger().info("run.open_work_judge_unavailable", { error: String(error) });
    return "none";
  }
}

/** The agent's items for this chat, and the stall this chat was last told about. */
async function loadItems(prisma: PrismaClient, run: EndedRun) {
  const since = run.startedAt ?? run.createdAt;
  const [rows, state] = await Promise.all([
    prisma.scratchpadItem.findMany({
      where: { spaceId: run.spaceId, botId: run.botId, threadId: run.threadId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, title: true, notes: true, status: true, updatedAt: true },
    }),
    prisma.openWorkState.findUnique({
      where: { threadId_botId: { threadId: run.threadId, botId: run.botId } },
    }),
  ]);
  const touched = rows.filter((row) => row.updatedAt >= since);
  // After a stall the owner was told about, the same untouched items start nothing again: only
  // the agent moving one of them (any add, change or close since) brings the list back to life.
  const stalledAt = state?.stalledAt ?? null;
  const live = !stalledAt || rows.some((row) => row.updatedAt > stalledAt);
  return {
    open: live ? rows.filter((row) => row.status === "open") : [],
    touchedInRun: touched.length,
    parkedInRun: touched.filter((row) => row.status === "parked"),
    stalledAt,
    live,
  };
}

/** When the task began (the person's last own message here) and the continuations since. */
async function taskSoFar(prisma: PrismaClient, run: EndedRun) {
  const last = await prisma.run.findFirst({
    where: { threadId: run.threadId, trigger: "user" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { createdAt: true },
  });
  const continuations = await prisma.run.count({
    where: {
      threadId: run.threadId,
      botId: run.botId,
      clientNonce: { startsWith: OPEN_WORK_NONCE_PREFIX },
      ...(last ? { createdAt: { gte: last.createdAt } } : {}),
    },
  });
  return { start: last?.createdAt ?? null, continuations };
}

export interface OpenWorkOutcome {
  decision: OpenWorkDecision;
  continuationRunId?: string;
  noticeMessageId?: string;
}

/**
 * Decide and act for one finished run. `replyText` and `toolCallCount` come from the turn; every
 * other fact is read here, after the run was finalized.
 */
export async function followOpenWork(
  deps: Deps,
  input: {
    run: EndedRun;
    botName: string;
    replyText: string;
    toolCallCount: number;
    config?: ContinuityConfig;
    judge?: (reply: string) => Promise<"promise" | "none">;
    decide?: typeof decideOpenWork;
  },
): Promise<OpenWorkOutcome> {
  const config = input.config ?? continuityConfig();
  const { run } = input;
  const none = (reason: string): OpenWorkOutcome => ({ decision: { action: "none", reason } });
  if (!config.continueOpenWork) return none("disabled");
  if (!runIsFollowedForOpenWork(run.trigger)) return none("trigger");
  const current = await deps.prisma.run.findUnique({
    where: { id: run.id },
    select: { status: true },
  });
  if (current?.status !== "completed") return none("not_completed");

  const task = await taskSoFar(deps.prisma, run);
  const soFar = task.continuations;
  const [items, wakers] = await Promise.all([
    loadItems(deps.prisma, run),
    loadOpenWorkWakers(deps.prisma, run, task.start),
  ]);
  const isContinuation = (run.clientNonce ?? "").startsWith(OPEN_WORK_NONCE_PREFIX);
  // The model is asked only when its answer could matter: nothing will wake the agent, and no
  // kept item already says work is open.
  let promise: "promise" | "none" = "none";
  if (pendingWakers(wakers).length === 0 && items.open.length === 0) {
    const read = declaresFurtherWork(input.replyText);
    promise =
      read === "unclear"
        ? await (input.judge ?? ((reply) => judgeOpenWorkPromise(reply, config)))(input.replyText)
        : read;
  }
  const decision = (input.decide ?? decideOpenWork)({
    enabled: true,
    status: "completed",
    trigger: run.trigger,
    replyText: input.replyText,
    toolCallCount: input.toolCallCount,
    openItems: items.open,
    itemsTouchedInRun: items.touchedInRun,
    parkedInRun: items.parkedInRun,
    promise,
    isContinuation,
    continuationsSoFar: soFar,
    maxContinuations: config.maxContinuations,
    wakers,
  });
  const promised = promise === "promise" ? promisedWork(input.replyText) : "";
  const log = {
    "run.id": run.id,
    "run.trigger": run.trigger,
    "bot.id": run.botId,
    "thread.id": run.threadId,
    "open_work.items": items.open.length,
    "open_work.promise": promise,
    "open_work.continuations": soFar,
  };

  if (decision.action === "continue") {
    const continuationRunId = await startContinuation(deps, run, {
      basis: decision.basis,
      items: items.open,
      promised,
      attempt: soFar + 1,
      maxContinuations: config.maxContinuations,
    });
    if (!continuationRunId) return none("already_continued");
    noteAutoContinuation(run.id);
    getLogger().info("run.open_work_continued", {
      ...log,
      "open_work.basis": decision.basis,
      "run.continuation": continuationRunId,
    });
    return { decision, continuationRunId };
  }
  if (decision.action === "stalled") {
    getLogger().warn("run.open_work_stalled", {
      ...log,
      "open_work.reason": decision.reason,
      "open_work.open": decision.openCount,
    });
    if (!config.stalledNotice) return { decision };
    const noticeMessageId = await tellOwnerOnce(deps, run, {
      botName: input.botName,
      reason: decision.reason,
      items: decision.reason === "blocked" ? items.parkedInRun : items.open,
      promised,
      knownStallAt: items.live ? null : items.stalledAt,
    });
    return noticeMessageId ? { decision, noticeMessageId } : { decision };
  }
  if (decision.reason !== "no_open_work" && decision.reason !== "trigger")
    getLogger().info("run.open_work_left", { ...log, "open_work.why": decision.reason });
  return { decision };
}

/** One continuation per finished run: the nonce makes a second attempt a no-op. */
async function startContinuation(
  deps: Deps,
  run: EndedRun,
  brief: {
    basis: "items" | "promise";
    items: readonly OpenWorkItem[];
    promised: string;
    attempt: number;
    maxContinuations: number;
  },
): Promise<string | null> {
  const clientNonce = `${OPEN_WORK_NONCE_PREFIX}${run.id}`;
  // The conversation that authorized the work, so helpers this continuation starts are its too.
  const originRunId = await delegationOriginId(deps.prisma, {
    id: run.id,
    botId: run.botId,
    spaceId: run.spaceId,
    userId: run.userId,
    trigger: run.trigger,
    delegatedFromRunId: run.delegatedFromRunId ?? null,
    sourceMessageId: run.sourceMessageId ?? null,
  });
  const created = await deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
    if (
      await tx.run.findFirst({ where: { spaceId: run.spaceId, clientNonce }, select: { id: true } })
    )
      return null;
    // A message or a result that arrived meanwhile wakes the agent by itself.
    const waking = await tx.run.count({
      where: {
        botId: run.botId,
        threadId: run.threadId,
        id: { not: run.id },
        status: { in: [...ACTIVE_RUN_STATUSES] },
      },
    });
    if (waking > 0) return null;
    const task = await tx.task.create({
      data: {
        spaceId: run.spaceId,
        botId: run.botId,
        threadId: run.threadId,
        userId: run.userId,
        prompt: openWorkContinuationPrompt({ ...brief, escape: escapePromptData }),
        status: "queued",
      },
    });
    const next = await tx.run.create({
      data: {
        spaceId: run.spaceId,
        botId: run.botId,
        threadId: run.threadId,
        taskId: task.id,
        userId: run.userId,
        status: "queued",
        trigger: "follow_up",
        clientNonce,
        ...(originRunId ? { delegatedFromRunId: originRunId } : {}),
      },
      select: { id: true },
    });
    await tx.openWorkState.upsert({
      where: { threadId_botId: { threadId: run.threadId, botId: run.botId } },
      create: {
        spaceId: run.spaceId,
        botId: run.botId,
        threadId: run.threadId,
        continuations: 1,
        lastContinuationRunId: next.id,
      },
      update: {
        continuations: { increment: 1 },
        lastContinuationRunId: next.id,
        // Work is moving again: a later stall is news.
        stalledAt: null,
        stalledReason: null,
        openCount: 0,
      },
    });
    return next.id;
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  if (created) await wakeRun(deps.jobs, created);
  return created;
}

/**
 * The stalled notice, once: a line in the chat and the normal notification. A stall this chat
 * was already told about (same untouched items) is not told again.
 */
async function tellOwnerOnce(
  deps: Deps,
  run: EndedRun,
  input: {
    botName: string;
    reason: "limit" | "no_progress" | "blocked";
    items: ReadonlyArray<OpenWorkItem & { notes?: string }>;
    promised: string;
    knownStallAt: Date | null;
  },
): Promise<string | null> {
  if (input.knownStallAt) return null;
  const notice = stalledNotice({
    botName: displayName(input.botName, "Bot"),
    reason: input.reason,
    items: input.items,
    promised: input.promised,
  });
  const blocks: MessageBlock[] = [{ kind: "meta", text: notice.chat }];
  const posted = await deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
    const state = await tx.openWorkState.findUnique({
      where: { threadId_botId: { threadId: run.threadId, botId: run.botId } },
      select: { stalledAt: true, stalledRunId: true },
    });
    // Claimed once per finished run, whoever gets here first.
    if (state?.stalledRunId === run.id) return null;
    const message = await createThreadMessageInTransaction(tx, {
      threadId: run.threadId,
      role: "system",
      blocks,
      botId: run.botId,
      markUnread: true,
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "system", blocks },
    });
    const stalled = {
      stalledAt: new Date(),
      stalledReason: input.reason,
      stalledRunId: run.id,
      openCount: input.items.length || 1,
      noticeMessageId: message.id,
    };
    await tx.openWorkState.upsert({
      where: { threadId_botId: { threadId: run.threadId, botId: run.botId } },
      create: { spaceId: run.spaceId, botId: run.botId, threadId: run.threadId, ...stalled },
      update: stalled,
    });
    return { messageId: message.id, eventSeq: event.seq };
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  if (!posted) return null;
  await deps.events.notify(run.threadId, posted.eventSeq);
  await notifyRun(deps as ExecutorDeps, run, {
    kind: "completion",
    title: notice.title,
    body: notice.body,
    botId: run.botId,
    threadId: run.threadId,
    messageId: posted.messageId,
  }).catch((error) => getLogger().error("stalled notification", error));
  return posted.messageId;
}

/** The turn's seam: called after a run completed. Never throws into the run. */
export async function continueOpenWork(ctx: RunContext): Promise<void> {
  const { reply } = ctx.state;
  await followOpenWork(ctx.deps, {
    run: { ...ctx.run, id: ctx.runId },
    botName: ctx.bot.name,
    replyText: reply.assembled || reply.assistantTurnText || "",
    toolCallCount: reply.toolCalls.length,
  });
}

/**
 * Stop means stop (fork 1.33): the chat's open items start nothing by themselves after the person
 * pressed Stop, until the agent moves one of them again, which it does when given new work.
 * Runs in the caller's transaction, with the chat locked.
 */
export async function disarmOpenWorkInTransaction(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; threadId: string; botIds: readonly string[] },
): Promise<void> {
  const stalled = { stalledAt: new Date(), stalledReason: "stopped", stalledRunId: null };
  for (const botId of input.botIds) {
    const open = await tx.scratchpadItem.count({
      where: { spaceId: input.spaceId, botId, threadId: input.threadId, status: "open" },
    });
    if (open === 0) continue;
    await tx.openWorkState.upsert({
      where: { threadId_botId: { threadId: input.threadId, botId } },
      create: {
        spaceId: input.spaceId,
        botId,
        threadId: input.threadId,
        openCount: open,
        ...stalled,
      },
      update: { openCount: open, ...stalled },
    });
  }
}
