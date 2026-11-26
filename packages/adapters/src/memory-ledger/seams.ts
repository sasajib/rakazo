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
import { parseStandingOrders, STANDING_ORDERS_PATH } from "../memory/standing-orders.js";
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
import { fold, overlap, sameText } from "./text.js";
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
    ? createOpenAiMemoryModel(endpoint, {
        timeoutMs: config.model.timeoutMs,
        maxTokens: config.model.maxTokens,
      })
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
          budgetMs: fast ? Math.min(config.packBudgetMs, 400) : config.packBudgetMs,
          coreMaxBytes: config.coreMaxBytes,
          packMaxBytes: fast ? Math.min(config.packMaxBytes, 1500) : config.packMaxBytes,
        },
      ),
      (fast ? Math.min(config.packBudgetMs, 400) : config.packBudgetMs) + 1_500,
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

/** The Space owner's standing rule texts (STANDING.md), for the writer's duplicate check. */
async function loadStandingRules(
  prisma: PrismaClient,
  spaceId: string,
  userId: string,
): Promise<string[]> {
  const doc = await prisma.memoryDocument
    .findFirst({
      where: { spaceId, userId, scope: "user", path: STANDING_ORDERS_PATH },
      select: { content: true },
    })
    .catch(() => null);
  if (!doc?.content || doc.content.startsWith("rkz1:")) return [];
  return parseStandingOrders(doc.content)
    .filter((entry) => entry.kind === "rule")
    .map((entry) => entry.text);
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
    const model = await memoryModel(deps, job.userId, config);
    const result = await learnFromMessages(
      {
        store,
        model,
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
        standingRules: await loadStandingRules(deps.prisma, job.spaceId, job.userId),
      },
    );
    // A configured model that gave no usable answer is retried by the catch-up pass (up to 3
    // attempts) instead of being recorded as "nothing to learn".
    const modelMissed = model !== undefined && !result.usedModel;
    await store.finishJob(
      job.spaceId,
      job.runId,
      modelMissed ? "failed" : "done",
      modelMissed ? "memory model gave no usable answer" : undefined,
    );
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

type RememberOperation = {
  action: "add" | "replace" | "remove";
  content?: string | undefined;
  old_text?: string | undefined;
};

/**
 * How close `old_text` must be to a ledger fact before a bot's edit is applied to it. High on
 * purpose: "reports as PDF" must never match "reports as Word documents" (they share most words).
 */
const EDIT_MATCH = 0.75;

const describe = (fact: Fact) => ({ text: fact.text, status: fact.status });

function editScore(oldText: string, fact: Fact): number {
  if (sameText(oldText, fact.text)) return 1;
  const wanted = fold(oldText);
  const own = fold(fact.text);
  if (wanted.length >= 12 && (own.includes(wanted) || wanted.includes(own))) return 0.95;
  return overlap(oldText, fact.text);
}

/**
 * The ledger fact a bot's `old_text` names: the best match among live and retired facts, so an
 * edit naming an already-replaced fact is never applied to its live successor.
 */
async function factNamedBy(
  store: LedgerStore,
  spaceId: string,
  oldText: string,
): Promise<{ fact: Fact; live: boolean } | undefined> {
  const wanted = oldText.trim();
  if (!wanted) return undefined;
  const [live, retired] = await Promise.all([
    store.findLive(spaceId, { texts: [wanted] }, 20),
    store.findRetired(spaceId, wanted, 20).catch(() => [] as Fact[]),
  ]);
  let best: { fact: Fact; live: boolean; score: number } | undefined;
  for (const [facts, isLive] of [
    [live, true],
    [retired, false],
  ] as const)
    for (const fact of facts) {
      const score = editScore(wanted, fact);
      if (!best || score > best.score || (score === best.score && isLive && !best.live))
        best = { fact, live: isLive, score };
    }
  return best && best.score >= EDIT_MATCH ? { fact: best.fact, live: best.live } : undefined;
}

/**
 * The other side of an open conflict with `fact` (an unresolved `contradicts` link), if any.
 * Both sides are disputed until the owner picks one.
 */
async function openRival(
  store: LedgerStore,
  spaceId: string,
  fact: Fact,
): Promise<{ rival: Fact; linkId: string; rivalIsNewer: boolean } | undefined> {
  const links = (await store.linksOf(spaceId, [fact.id], ["contradicts"])).filter(
    (link) => !link.resolvedAt,
  );
  for (const link of links) {
    const otherId = link.fromId === fact.id ? link.toId : link.fromId;
    const [rival] = await store.getFacts(spaceId, [otherId]);
    if (rival && rival.status === "disputed")
      return { rival, linkId: link.id, rivalIsNewer: link.fromId === otherId };
  }
  return undefined;
}

/** The owner settled a conflict: `winner` holds, `loser` is retired. */
async function settleConflict(
  store: LedgerStore,
  spaceId: string,
  winner: Fact,
  loser: Fact,
  linkId: string,
  winnerIsNewer: boolean,
  now: Date,
): Promise<void> {
  await store.updateFact(spaceId, winner.id, {
    status: "confirmed",
    ...(winnerIsNewer ? { supersedesId: loser.id } : {}),
  });
  await store.updateFact(spaceId, loser.id, {
    status: winnerIsNewer ? "superseded" : "retracted",
    validTo: now,
  });
  if (winnerIsNewer)
    await store.addLink({ spaceId, fromId: winner.id, toId: loser.id, kind: "supersedes" });
  await store.updateLink(spaceId, linkId, {
    resolvedAt: now,
    resolution: winnerIsNewer ? "use_new" : "keep_old",
  });
}

/**
 * A bot's remember call. Facts the owner states go through the writer (quote gate and all);
 * a replace or remove that names a ledger fact is applied to that fact, so a correction never
 * leaves the old fact live. Returns the tool result; undefined means "not handled" and the
 * caller keeps the bot's own MEMORY.md behaviour (working notes that are not ledger facts).
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
  const store = createSqlLedgerStore(deps.prisma);
  const now = new Date();

  // Resolve which operations name ledger facts. Anything that names none stays a bot note.
  const named = await bestEffort(
    "memory ledger edit lookup",
    Promise.all(
      operations.map((operation) =>
        operation.action === "add" || !operation.old_text
          ? Promise.resolve(undefined)
          : factNamedBy(store, run.spaceId, operation.old_text),
      ),
    ),
  );
  if (!named) return undefined;
  const targets = named.map((hit) => (hit?.live ? hit.fact : undefined));
  const retired = named.map((hit) => (hit && !hit.live ? hit.fact : undefined));
  const ledgerOps = operations.filter(
    (operation, index) => operation.action === "add" || named[index] !== undefined,
  );
  if (!ledgerOps.length) return undefined;
  const alreadyRetired = retired.filter((fact): fact is Fact => fact !== undefined);
  const notFound = operations
    .filter((operation, index) => operation.action !== "add" && !named[index])
    .map((operation) => operation.old_text ?? "");

  // An edit naming one side of an open conflict is the owner's answer to it (the bot asked, the
  // owner chose): settle it here, instead of disputing again and asking a second time.
  const settled: Array<{ winner: Fact; loser: Fact }> = [];
  const handled = new Set<number>();
  for (const [index, operation] of operations.entries()) {
    const target = targets[index];
    if (!target || target.status !== "disputed" || operation.action === "add") continue;
    const open = await openRival(store, run.spaceId, target);
    if (!open) continue;
    if (operation.action === "replace") {
      const wanted = operation.content?.trim() ?? "";
      // The replacement must be the rival, not a third version.
      if (!wanted || editScore(wanted, open.rival) < 0.3) continue;
      await settleConflict(
        store,
        run.spaceId,
        open.rival,
        target,
        open.linkId,
        open.rivalIsNewer,
        now,
      );
      settled.push({ winner: open.rival, loser: target });
    } else {
      await settleConflict(
        store,
        run.spaceId,
        open.rival,
        target,
        open.linkId,
        open.rivalIsNewer,
        now,
      );
      settled.push({ winner: open.rival, loser: target });
    }
    handled.add(index);
  }

  const removed: Fact[] = [];
  const replaced: Array<{ old: Fact; new?: Fact | undefined }> = [];
  const conflicted: Fact[] = [];
  const hints: string[] = [];
  operations.forEach((operation, index) => {
    if (handled.has(index)) return;
    const target = targets[index];
    if (operation.action === "add" && operation.content?.trim())
      hints.push(operation.content.trim());
    if (operation.action === "replace" && target && operation.content?.trim())
      hints.push(`Correction of "${target.text}": ${operation.content.trim()}`);
  });

  for (const [index, operation] of operations.entries()) {
    const target = targets[index];
    if (handled.has(index) || operation.action !== "remove" || !target) continue;
    await store.updateFact(run.spaceId, target.id, { status: "retracted", validTo: now });
    removed.push(target);
  }

  let result: LearnResult | undefined;
  if (hints.length) {
    result = await bestEffort(
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
              store,
              model: await memoryModel(deps, run.userId, config),
              embedder: embedder(config),
              config,
              // A conflict with a confirmed fact can only be settled by the owner's answer to a
              // card; without one it stayed disputed for good.
              postCard: (card) =>
                postCard(deps, { ...card, nonce: `memory-ledger:remember:${run.runId}` }),
            },
            {
              spaceId: run.spaceId,
              userId: run.userId,
              threadId: run.threadId,
              runId: run.runId,
              botId: run.botId,
              botName: run.botName,
              messages,
              standingRules: await loadStandingRules(deps.prisma, run.spaceId, run.userId),
              hint: hints.join("\n"),
              ask: true,
            },
          );
        })(),
        REMEMBER_BUDGET_MS,
        undefined,
      ),
    );
    if (result) logLearned(run.runId, result, 0);
  }

  // A replace the writer did not already supersede: retire the named fact now that a new one
  // from the owner's words exists, or keep it and say so when nothing new passed the checks.
  const fresh = result ? [...result.saved, ...result.reinforced] : [];
  for (const [index, operation] of operations.entries()) {
    const target = targets[index];
    if (handled.has(index) || operation.action !== "replace" || !target) continue;
    if (result?.superseded.some((fact) => fact.id === target.id)) {
      replaced.push({ old: target, new: fresh[0] });
      continue;
    }
    // The owner confirmed the old fact: the writer kept both as disputed and asked. Never
    // override that here.
    if (result?.disputed.some((fact) => fact.id === target.id)) {
      conflicted.push(target);
      continue;
    }
    const successor = fresh.find((fact) => fact.id !== target.id);
    if (successor) {
      await store.updateFact(run.spaceId, target.id, { status: "superseded", validTo: now });
      await store.updateFact(run.spaceId, successor.id, { supersedesId: target.id });
      await store.addLink({
        spaceId: run.spaceId,
        fromId: successor.id,
        toId: target.id,
        kind: "supersedes",
      });
      replaced.push({ old: target, new: successor });
    } else {
      replaced.push({ old: target });
    }
  }

  const keptReplaces = replaced.filter((entry) => !entry.new);
  const superseded = [
    ...(result?.superseded ?? []).filter(
      (fact) => !replaced.some((entry) => entry.old.id === fact.id),
    ),
  ];
  const nothing =
    !fresh.length && !removed.length && !settled.length && !replaced.some((entry) => entry.new);
  if (nothing && !keptReplaces.length && !alreadyRetired.length) {
    if (operations.every((operation) => operation.action === "add")) return undefined;
  }
  const lines: string[] = [];
  if (fresh.length)
    lines.push(`Saved to shared memory: ${fresh.map((f) => `"${f.text}"`).join("; ")}.`);
  for (const entry of replaced)
    if (entry.new)
      lines.push(
        `Replaced "${entry.old.text}" with "${entry.new.text}". The old fact is no longer used.`,
      );
  for (const fact of superseded) lines.push(`"${fact.text}" was replaced by the new fact.`);
  for (const fact of removed) lines.push(`Removed "${fact.text}" from shared memory.`);
  for (const entry of settled)
    lines.push(
      `Settled the conflict as the owner chose: "${entry.winner.text}" now holds; "${entry.loser.text}" is no longer used.`,
    );
  for (const fact of alreadyRetired)
    lines.push(`"${fact.text}" is already out of use (${fact.status}); nothing more to do.`);
  for (const entry of keptReplaces)
    lines.push(
      `Did NOT change "${entry.old.text}": the new version could not be matched to the owner's own words. Ask the owner to state the correction plainly, or tell them it is unchanged.`,
    );
  for (const text of notFound)
    lines.push(`No shared-memory fact matches "${text.slice(0, 120)}"; that edit was not applied.`);
  for (const fact of conflicted)
    lines.push(
      `Did NOT replace "${fact.text}": the owner confirmed it earlier. Both versions are kept as disputed and a card asks the owner which is right; tell them so.`,
    );
  if (result?.disputed.length && !conflicted.length)
    lines.push(
      `Conflict with a confirmed fact: both kept as disputed, the owner is asked on a card: ${result.disputed.map((f) => `"${f.text}"`).join("; ")}.`,
    );
  return {
    ok: !keptReplaces.length,
    savedTo: "shared memory ledger",
    facts: fresh.map(describe),
    replaced: replaced
      .filter((entry) => entry.new)
      .map((entry) => ({ old: entry.old.text, new: entry.new!.text })),
    superseded: superseded.map(describe),
    removed: removed.map(describe),
    alreadyOutOfUse: alreadyRetired.map(describe),
    unchanged: keptReplaces.map((entry) => entry.old.text),
    disputed: conflicted.map(describe),
    settled: settled.map((entry) => ({ holds: entry.winner.text, dropped: entry.loser.text })),
    summary: lines.join(" "),
    note: "Report exactly what summary says. Shared memory is the Space's; every bot sees it. Superseded facts are already out of use: never tell the owner you could not remove them.",
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
