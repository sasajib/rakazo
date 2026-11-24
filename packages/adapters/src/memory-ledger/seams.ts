/**
 * The ledger's entry points, one per upstream seam. Each is a no-op unless MEMORY_LEDGER is on,
 * and none can fail or slow a run: every path catches, and the prompt path has a deadline.
 *
 * - withLedgerMemory: the durable-memory prompt (run assembly) gains the core block + work pack.
 * - scheduleLedgerLearning: the run-finished hook queues the writer for owner-started runs.
 * - rememberViaLedger / recallViaLedger: the remember and recall_memory tool handlers.
 */
import type { SecretStore } from "@rakazo/adapter-kit";
import { isCallClientNonce } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { createThreadMessage, runAsTenant, storedMessageBlocks } from "@rakazo/db";
import { bestEffort, getLogger } from "@rakazo/logging";
import type { LedgerConfig } from "./config.js";
import { ledgerConfig } from "./config.js";
import { resolveModelEndpoint } from "./connection.js";
import type { Embedder } from "./embeddings.js";
import { createEmbedder } from "./embeddings.js";
import type { MemoryModel } from "./model.js";
import { createOpenAiMemoryModel } from "./model.js";
import { assemblePack, within } from "./pack.js";
import type { LedgerJob, LedgerStore } from "./store.js";
import { createSqlLedgerStore } from "./store.js";
import type { Fact, OwnerMessage } from "./types.js";
import type { LearnResult } from "./writer.js";
import { learnFromMessages } from "./writer.js";

type Deps = {
  prisma: PrismaClient;
  secretStore: Pick<SecretStore, "load">;
  events?: { notify(threadId: string, seq: number): Promise<void> };
};

/** Owner messages the writer reads: this run's plus this many before them. */
const CONTEXT_MESSAGES = 10;
/** Messages at most one writer call reads in total. */
const MAX_MESSAGES = 24;
/** Pending writer runs older than this are picked up by the next run in the Space. */
const CATCH_UP_AFTER_MS = 10 * 60_000;
const REMEMBER_BUDGET_MS = 20_000;

let embedderFor: { url: string | undefined; embedder: Embedder | undefined } | undefined;
function embedder(config: LedgerConfig): Embedder | undefined {
  if (!embedderFor || embedderFor.url !== config.embeddings.url)
    embedderFor = { url: config.embeddings.url, embedder: createEmbedder(config.embeddings) };
  return embedderFor.embedder;
}

async function memoryModel(
  deps: Deps,
  userId: string,
  config: LedgerConfig,
): Promise<MemoryModel | undefined> {
  const endpoint = await resolveModelEndpoint(deps, userId, config.model);
  return endpoint
    ? createOpenAiMemoryModel(endpoint, { timeoutMs: config.model.timeoutMs })
    : undefined;
}

// --- Seam 1: the durable-memory prompt ------------------------------------------------------

export interface LedgerPromptInput {
  spaceId: string;
  trigger: string;
  /** The task text the pack is searched with. */
  query: string;
  /** The run's source message nonce: a call turn gets the small pack. */
  sourceClientNonce?: string | null | undefined;
}

/** Talk-lane runs and voice turns must answer fast: the core block and a few facts. */
export function isFastRun(trigger: string, sourceClientNonce?: string | null): boolean {
  return trigger === "talk" || isCallClientNonce(sourceClientNonce ?? null);
}

/**
 * The memory prompt with the ledger's block placed after the standing orders and before durable
 * memory: binding rules first, then the owner's facts, then the bots' own notes. Off, empty or
 * slow, the ledger adds nothing and the memory prompt is returned unchanged.
 */
export async function withLedgerMemory(
  deps: Pick<Deps, "prisma">,
  input: LedgerPromptInput,
  durable: Promise<string | undefined>,
  env: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
  const config = ledgerConfig(env);
  if (!config.enabled) return durable;
  const [memory, ledger] = await Promise.all([durable, ledgerPromptBlock(deps, input, config)]);
  return placeLedgerBlock(memory, ledger);
}

const STANDING_CLOSE = "</standing_orders>";

/** Standing orders (when present) stay first; the ledger block goes right after them. */
export function placeLedgerBlock(
  memory: string | undefined,
  ledger: string | undefined,
): string | undefined {
  if (!ledger) return memory;
  if (!memory) return ledger;
  const end = memory.indexOf(STANDING_CLOSE);
  if (end < 0) return `${ledger}\n\n${memory}`;
  const cut = end + STANDING_CLOSE.length;
  const rest = memory.slice(cut).replace(/^\s+/, "");
  return [memory.slice(0, cut), ledger, rest].filter(Boolean).join("\n\n");
}

export async function ledgerPromptBlock(
  deps: Pick<Deps, "prisma">,
  input: LedgerPromptInput,
  config: LedgerConfig,
  store: LedgerStore = createSqlLedgerStore(deps.prisma),
): Promise<string | undefined> {
  const started = Date.now();
  const fast = isFastRun(input.trigger, input.sourceClientNonce);
  const pack = await bestEffort(
    "memory ledger pack",
    // Core facts have their own 1 s cap inside; this outer cap only stops a stuck pool checkout.
    within(
      assemblePack(
        { store, embedder: embedder(config) },
        {
          spaceId: input.spaceId,
          query: input.query,
          limit: fast ? config.fastPackLimit : config.packLimit,
          budgetMs: config.packBudgetMs,
          coreMaxBytes: config.coreMaxBytes,
          packMaxBytes: fast ? Math.min(config.packMaxBytes, 1500) : config.packMaxBytes,
        },
      ),
      config.packBudgetMs + 1_500,
      undefined,
    ),
  );
  getLogger().info("memory.ledger.pack", {
    "memory.ledger.core": pack?.core.length ?? 0,
    "memory.ledger.relevant": pack?.relevant.length ?? 0,
    "memory.ledger.linked": pack?.linked.length ?? 0,
    "memory.ledger.search": pack?.search ?? "failed",
    "memory.ledger.fast": fast,
    "memory.ledger.bytes": pack?.text ? Buffer.byteLength(pack.text) : 0,
    "memory.ledger.ms": Date.now() - started,
  });
  return pack?.text;
}

// --- Owner messages ------------------------------------------------------------------------

function textOf(blocks: ReadonlyArray<{ kind: string; text?: unknown }>): string | undefined {
  // A webhook prompt, an email or a channel message is not the owner's own words.
  if (blocks.some((block) => block.kind === "delivery" || block.kind === "channel_message"))
    return undefined;
  const text = blocks
    .filter((block) => block.kind === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim();
  return text || undefined;
}

/**
 * The run person's own messages in this thread, oldest first: the run's source message and what
 * they sent after it are `current`, the ten before are context. Bot replies, tool output,
 * deliveries and other members' messages are never read.
 */
export async function loadOwnerMessages(
  prisma: Pick<PrismaClient, "message">,
  input: { threadId: string; userId: string; sourceMessageId: string },
): Promise<OwnerMessage[]> {
  const source = await prisma.message.findFirst({
    where: { id: input.sourceMessageId, threadId: input.threadId },
    select: { seq: true },
  });
  if (!source) return [];
  const rows = await prisma.message.findMany({
    where: { threadId: input.threadId, role: "user", authorUserId: input.userId },
    orderBy: { seq: "desc" },
    take: MAX_MESSAGES,
    select: { id: true, seq: true, blocks: true, createdAt: true },
  });
  const current = rows.filter((row) => row.seq >= source.seq);
  const earlier = rows.filter((row) => row.seq < source.seq).slice(0, CONTEXT_MESSAGES);
  return [...earlier.reverse(), ...current.reverse()].flatMap((row) => {
    const text = textOf(storedMessageBlocks(row) as Array<{ kind: string; text?: unknown }>);
    return text ? [{ id: row.id, text, at: row.createdAt, current: row.seq >= source.seq }] : [];
  });
}

// --- Seam 2: the run-finished hook ---------------------------------------------------------

export interface FinishedRun {
  runId: string;
  spaceId: string;
  userId: string;
  threadId: string;
  botId: string;
  botName: string | null;
  trigger: string;
  sourceMessageId: string | null;
  ownerStartedRun: boolean;
  messagingChannelRun: boolean;
}

const LEARNING_TRIGGERS = new Set(["user", "follow_up", "talk"]);

/** Owner-started chat runs with a message of the owner's own; never routines or channels. */
export function learnsFrom(run: FinishedRun): boolean {
  return (
    run.ownerStartedRun &&
    !run.messagingChannelRun &&
    Boolean(run.sourceMessageId) &&
    LEARNING_TRIGGERS.has(run.trigger)
  );
}

/**
 * Queues the writer for a finished run and returns at once. The writer runs in this process in
 * the run's tenant context; a run whose writer never finished (process exit) stays `pending` and
 * the next learning run in the Space picks it up.
 */
export function scheduleLedgerLearning(
  deps: Deps,
  run: FinishedRun,
  env: Record<string, string | undefined> = process.env,
): void {
  const config = ledgerConfig(env);
  if (!config.enabled || !learnsFrom(run)) return;
  void runAsTenant({ spaceId: run.spaceId, userId: run.userId }, async () => {
    const store = createSqlLedgerStore(deps.prisma);
    await store.claimJob({
      runId: run.runId,
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      userId: run.userId,
    });
    await runLedgerJob(
      deps,
      store,
      config,
      { ...run, attempts: 0 },
      run.sourceMessageId!,
      run.botName,
    );
    for (const stale of await store.staleJobs(run.spaceId, CATCH_UP_AFTER_MS, 2)) {
      if (stale.userId !== run.userId) continue;
      const row = await deps.prisma.run.findFirst({
        where: { id: stale.runId },
        select: { sourceMessageId: true, bot: { select: { name: true } } },
      });
      if (!row?.sourceMessageId) {
        await store.finishJob(run.spaceId, stale.runId, "failed", "source message gone");
        continue;
      }
      await runLedgerJob(deps, store, config, stale, row.sourceMessageId, row.bot?.name ?? null);
    }
  }).catch((error) => getLogger().error("memory.ledger.schedule_failed", error));
}

async function runLedgerJob(
  deps: Deps,
  store: LedgerStore,
  config: LedgerConfig,
  job: LedgerJob,
  sourceMessageId: string,
  botName: string | null,
): Promise<LearnResult | undefined> {
  if (!(await store.startJob(job.spaceId, job.runId))) return undefined;
  const started = Date.now();
  try {
    const messages = await loadOwnerMessages(deps.prisma, {
      threadId: job.threadId,
      userId: job.userId,
      sourceMessageId,
    });
    const result = await learnFromMessages(
      {
        store,
        model: await memoryModel(deps, job.userId, config),
        embedder: embedder(config),
        config,
        postCard: (card) => postCard(deps, { ...card, nonce: `memory-ledger:${job.runId}` }),
      },
      {
        spaceId: job.spaceId,
        userId: job.userId,
        threadId: job.threadId,
        runId: job.runId,
        botId: job.botId,
        botName,
        messages,
      },
    );
    await store.finishJob(job.spaceId, job.runId, "done");
    logLearned(job.runId, result, Date.now() - started);
    return result;
  } catch (error) {
    await store
      .finishJob(job.spaceId, job.runId, "failed", error instanceof Error ? error.message : "error")
      .catch(() => undefined);
    getLogger().error("memory.ledger.learn_failed", error, { "run.id": job.runId });
    return undefined;
  }
}

function logLearned(runId: string, result: LearnResult, ms: number) {
  getLogger().info("memory.ledger.learned", {
    "run.id": runId,
    "memory.ledger.saved": result.saved.length,
    "memory.ledger.reinforced": result.reinforced.length,
    "memory.ledger.superseded": result.superseded.length,
    "memory.ledger.disputed": result.disputed.length,
    "memory.ledger.rejected": JSON.stringify(result.rejected),
    "memory.ledger.asked": result.asked,
    "memory.ledger.resolved": result.resolved,
    "memory.ledger.used_model": result.usedModel,
    "memory.ledger.ms": ms,
  });
}

/** The card: one ordinary bot message in the thread. The run is already over; nothing waits. */
async function postCard(
  deps: Deps,
  input: { threadId: string; botId: string | null; text: string; nonce: string },
): Promise<string | undefined> {
  try {
    const message = await createThreadMessage(deps.prisma, {
      threadId: input.threadId,
      role: "bot",
      ...(input.botId ? { botId: input.botId } : {}),
      blocks: [{ kind: "text", text: input.text }],
      clientNonce: input.nonce,
    });
    await deps.events?.notify(input.threadId, message.seq).catch(() => undefined);
    return message.id;
  } catch (error) {
    getLogger().warn("memory.ledger.card_failed", {
      "error.type": error instanceof Error ? error.name : "unknown",
    });
    return undefined;
  }
}

// --- Seam 3: the remember and recall_memory tools -------------------------------------------

export interface ToolRun {
  runId: string;
  spaceId: string;
  userId: string;
  threadId: string;
  botId: string;
  botName: string | null;
  sourceMessageId: string | null;
  ownerStartedRun: boolean;
  messagingChannelRun: boolean;
}

type RememberOperation = { action: "add" | "replace" | "remove"; content?: string | undefined };

/**
 * A bot's remember call asks the writer to learn from the owner's message instead of writing
 * memory text itself. Returns the tool result when the ledger kept something; undefined means
 * "not handled" and the caller keeps the bot's own MEMORY.md behaviour (working notes, edits,
 * or text that is not the owner's own words).
 */
export async function rememberViaLedger(
  deps: Deps,
  run: ToolRun,
  operations: readonly RememberOperation[],
  env: Record<string, string | undefined> = process.env,
): Promise<Record<string, unknown> | undefined> {
  const config = ledgerConfig(env);
  if (!config.enabled || run.messagingChannelRun || !run.ownerStartedRun || !run.sourceMessageId)
    return undefined;
  if (operations.some((operation) => operation.action !== "add")) return undefined;
  const hint = operations
    .map((operation) => operation.content?.trim() ?? "")
    .filter(Boolean)
    .join("\n");
  if (!hint) return undefined;
  const result = await bestEffort(
    "memory ledger remember",
    within(
      (async () => {
        const messages = await loadOwnerMessages(deps.prisma, {
          threadId: run.threadId,
          userId: run.userId,
          sourceMessageId: run.sourceMessageId!,
        });
        return learnFromMessages(
          {
            store: createSqlLedgerStore(deps.prisma),
            model: await memoryModel(deps, run.userId, config),
            embedder: embedder(config),
            config,
          },
          {
            spaceId: run.spaceId,
            userId: run.userId,
            threadId: run.threadId,
            runId: run.runId,
            botId: run.botId,
            botName: run.botName,
            messages,
            hint,
            ask: false,
          },
        );
      })(),
      REMEMBER_BUDGET_MS,
      undefined,
    ),
  );
  if (!result) return undefined;
  logLearned(run.runId, result, 0);
  const kept = [...result.saved, ...result.reinforced];
  if (!kept.length) return undefined;
  return {
    ok: true,
    savedTo: "shared memory ledger",
    facts: kept.map((fact) => ({ text: fact.text, status: fact.status })),
    note: "Saved from the owner's own words; every bot in this Space will see it. Use remember only for facts the owner told you; your own working notes still go to your memory document.",
  };
}

/** recall_memory over the ledger: facts matching the query, with their dates and status. */
export async function recallViaLedger(
  deps: Pick<Deps, "prisma">,
  input: { spaceId: string; query: string; limit?: number },
  env: Record<string, string | undefined> = process.env,
): Promise<Array<Record<string, unknown>> | undefined> {
  const config = ledgerConfig(env);
  if (!config.enabled) return undefined;
  const pack = await bestEffort(
    "memory ledger recall",
    assemblePack(
      { store: createSqlLedgerStore(deps.prisma), embedder: embedder(config) },
      {
        spaceId: input.spaceId,
        query: input.query,
        limit: input.limit ?? 10,
        budgetMs: 3_000,
        coreMaxBytes: 0,
        packMaxBytes: 0,
      },
    ),
  );
  if (!pack) return undefined;
  return pack.relevant.map((fact: Fact) => ({
    fact: fact.text,
    area: fact.area,
    status: fact.status,
    said: fact.validFrom.toISOString().slice(0, 10),
    quote: fact.quote,
    ...(pack.linked.includes(fact.id) ? { linked: true } : {}),
  }));
}
