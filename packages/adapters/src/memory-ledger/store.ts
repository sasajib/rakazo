import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { contentWords, overlap, stem, textKey } from "./text.js";
import type { Fact, FactLink, FactStatus, LinkKind, NewFact } from "./types.js";
import { LIVE_FACT_STATUSES } from "./types.js";

export type FactPatch = Partial<
  Pick<
    Fact,
    | "status"
    | "confidence"
    | "mentions"
    | "sourceMessageIds"
    | "validTo"
    | "askedAt"
    | "askedThreadId"
    | "askedMessageId"
    | "supersedesId"
  >
>;
export type LinkPatch = Partial<
  Pick<FactLink, "askedAt" | "askedThreadId" | "askedMessageId" | "resolvedAt" | "resolution">
>;
export type NewLink = Pick<FactLink, "spaceId" | "fromId" | "toId" | "kind"> & {
  score?: number | null;
};

export interface LedgerJob {
  runId: string;
  spaceId: string;
  threadId: string;
  botId: string | null;
  userId: string;
  attempts: number;
  /** When the run finished and the job was recorded: where the run's own messages end. */
  createdAt?: Date | undefined;
}

/** Attempts a job gets before it stays failed. */
export const MAX_JOB_ATTEMPTS = 3;
/** A write transaction may hold the Space's writer lock this long. */
const WRITE_TRANSACTION_OPTIONS = { maxWait: 15_000, timeout: 60_000 };

/**
 * Where the ledger lives. One implementation runs raw SQL against Postgres (pgvector + full
 * text); tests use the in-memory one beside it. Every method is scoped to one Space.
 */
export interface LedgerStore {
  /** Live facts with one of these subjects or ids, or whose text shares words with one of `texts`. */
  findLive(
    spaceId: string,
    query: { subjects?: string[]; ids?: string[]; texts?: string[] },
    limit?: number,
  ): Promise<Fact[]>;
  /** Facts no longer in use (superseded or retracted) whose text shares words with `text`. */
  findRetired(spaceId: string, text: string, limit?: number): Promise<Fact[]>;
  /** Live fact ids ranked by full-text match, best first. */
  searchText(spaceId: string, query: string, limit: number): Promise<string[]>;
  /** Live fact ids ranked by cosine similarity, best first. */
  searchVector(
    spaceId: string,
    vector: readonly number[],
    limit: number,
  ): Promise<Array<{ id: string; similarity: number }>>;
  getFacts(spaceId: string, ids: readonly string[]): Promise<Fact[]>;
  /** Confirmed and disputed facts about the owner, their preferences and people; newest first. */
  coreFacts(spaceId: string, limit: number): Promise<Fact[]>;
  insertFact(fact: NewFact, embedding?: readonly number[]): Promise<Fact>;
  /**
   * Inserts the fact unless a live fact of the Space already says the same words (the database
   * enforces it, so two writers at once cannot both insert); then that fact is returned.
   */
  insertFactOnce(
    fact: NewFact,
    embedding?: readonly number[],
  ): Promise<{ fact: Fact; inserted: boolean }>;
  updateFact(spaceId: string, id: string, patch: FactPatch): Promise<void>;
  setEmbedding(spaceId: string, id: string, vector: readonly number[]): Promise<void>;
  missingEmbeddings(spaceId: string, limit: number): Promise<Fact[]>;
  /** Adds the link unless the same one exists; returns the stored link. */
  addLink(link: NewLink): Promise<FactLink | undefined>;
  updateLink(spaceId: string, id: string, patch: LinkPatch): Promise<void>;
  linksOf(
    spaceId: string,
    ids: readonly string[],
    kinds?: readonly LinkKind[],
  ): Promise<FactLink[]>;
  /** Questions put to the owner in this thread that are not answered yet. */
  openQuestions(
    spaceId: string,
    threadId: string,
  ): Promise<{ conflicts: FactLink[]; unsure: Fact[] }>;
  /** Contradicts links already answered, for the pairs touching these facts. */
  answeredConflicts(spaceId: string, factIds: readonly string[]): Promise<FactLink[]>;
  /** Records a run for the writer. False when the run was already recorded. */
  claimJob(job: Omit<LedgerJob, "attempts">): Promise<boolean>;
  startJob(spaceId: string, runId: string): Promise<boolean>;
  finishJob(
    spaceId: string,
    runId: string,
    status: "done" | "failed",
    error?: string,
  ): Promise<void>;
  /**
   * Runs whose writer did not finish, oldest first. A failed job waits longer after each
   * attempt (`olderThanMs`, then twice that, ...) and stops being offered after
   * MAX_JOB_ATTEMPTS.
   */
  staleJobs(spaceId: string, olderThanMs: number, limit: number): Promise<LedgerJob[]>;
  /**
   * The write stage of a run's job, at most once: false when an earlier attempt of the job
   * already wrote its facts (it committed, then failed or timed out before the job was marked
   * done). `mark` records this attempt as the one that writes; call it inside writeTransaction
   * so the mark and the facts commit together or not at all.
   */
  claimWrite(spaceId: string, runId: string, mark: boolean): Promise<boolean>;
  /**
   * Runs `fn` as one transaction holding the Space's writer lock: writers of one Space take
   * turns, so the duplicate check and the insert that follows cannot interleave with another
   * job's, and a failure leaves nothing half written.
   */
  writeTransaction<T>(spaceId: string, fn: (store: LedgerStore) => Promise<T>): Promise<T>;
}

type Sql = Pick<PrismaClient, "$queryRawUnsafe"> & {
  $transaction?: PrismaClient["$transaction"] | undefined;
};

type FactRow = Omit<Fact, "confidence"> & { confidence: number | string };

const FACT_COLUMNS = `"id","spaceId","area","subject","text","quote","origin","status","confidence","mentions","sourceMessageIds","entities","sourceThreadId","sourceRunId","writtenByBotId","writtenByBotName","userId","validFrom","validTo","supersedesId","askedAt","askedThreadId","askedMessageId","createdAt","updatedAt"`;

const vectorLiteral = (vector: readonly number[]) => `[${vector.join(",")}]`;

function toFact(row: FactRow): Fact {
  return { ...row, confidence: Number(row.confidence) };
}

/** The ledger on Postgres. Runs inside the caller's tenant context (row-level security). */
export function createSqlLedgerStore(prisma: Sql, inTransaction = false): LedgerStore {
  const live = [...LIVE_FACT_STATUSES];
  const queryUnsafe = prisma as unknown as {
    $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  };
  const selectFacts = async (where: string, params: unknown[]) =>
    (
      await queryUnsafe.$queryRawUnsafe<FactRow[]>(
        `SELECT ${FACT_COLUMNS} FROM "memory_facts" WHERE ${where}`,
        ...params,
      )
    ).map(toFact);
  const store: LedgerStore = {
    async findRetired(spaceId, text, limit = 10) {
      const words = [...new Set(contentWords(text))]
        .filter((word) => /^[\p{L}\p{M}\p{N}]+$/u.test(word))
        .slice(0, 40);
      if (!words.length) return [];
      return selectFacts(
        // Most relevant first, not newest first: with many retired facts sharing common words
        // ("owner", "wants"), a recency order cut the one being named out of the LIMIT.
        `"spaceId" = $1 AND "status" IN ('superseded','retracted') AND "fts" @@ to_tsquery('english', $2)
         ORDER BY ts_rank_cd("fts", to_tsquery('english', $2)) DESC, "updatedAt" DESC LIMIT $3`,
        [spaceId, words.join(" | "), limit],
      );
    },
    async findLive(spaceId, query, limit = 30) {
      const subjects = query.subjects?.filter(Boolean) ?? [];
      const ids = query.ids?.filter(Boolean) ?? [];
      const words = [...new Set((query.texts ?? []).flatMap((text) => contentWords(text)))]
        .filter((word) => /^[\p{L}\p{M}\p{N}]+$/u.test(word))
        .slice(0, 40);
      const textQuery = words.join(" | ");
      return selectFacts(
        // Exact subject/id hits first, then by text relevance, then newest. Newest-first alone
        // dropped older facts once more than LIMIT live facts shared a word like "owner", so a
        // remove/replace quoting an older fact word for word found nothing (fork fix 2026-11-25).
        `"spaceId" = $1 AND "status" = ANY($2::text[]) AND ("subject" = ANY($3::text[]) OR "id" = ANY($4::text[]) OR ($5 <> '' AND "fts" @@ to_tsquery('english', $5)))
         ORDER BY ("subject" = ANY($3::text[]) OR "id" = ANY($4::text[])) DESC,
                  CASE WHEN $5 <> '' THEN ts_rank_cd("fts", to_tsquery('english', $5)) ELSE 0 END DESC,
                  "updatedAt" DESC LIMIT $6`,
        [spaceId, live, subjects, ids, textQuery, limit],
      );
    },
    async searchText(spaceId, query, limit) {
      const words = [...new Set(contentWords(query))]
        .filter((word) => /^[\p{L}\p{M}\p{N}]+$/u.test(word))
        .slice(0, 40);
      if (!words.length) return [];
      const rows = await queryUnsafe.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT "id" FROM "memory_facts"
         WHERE "spaceId" = $1 AND "status" = ANY($2::text[]) AND "fts" @@ to_tsquery('english', $3)
         ORDER BY ts_rank_cd("fts", to_tsquery('english', $3)) DESC, "updatedAt" DESC LIMIT $4`,
        spaceId,
        live,
        words.join(" | "),
        limit,
      );
      return rows.map((row) => row.id);
    },
    async searchVector(spaceId, vector, limit) {
      const rows = await queryUnsafe.$queryRawUnsafe<Array<{ id: string; similarity: number }>>(
        `SELECT "id", 1 - ("embedding" <=> $3::vector) AS similarity FROM "memory_facts"
         WHERE "spaceId" = $1 AND "status" = ANY($2::text[]) AND "embedding" IS NOT NULL
         ORDER BY "embedding" <=> $3::vector LIMIT $4`,
        spaceId,
        live,
        vectorLiteral(vector),
        limit,
      );
      return rows.map((row) => ({ id: row.id, similarity: Number(row.similarity) }));
    },
    async getFacts(spaceId, ids) {
      if (!ids.length) return [];
      return selectFacts(`"spaceId" = $1 AND "id" = ANY($2::text[])`, [spaceId, [...ids]]);
    },
    async coreFacts(spaceId, limit) {
      return selectFacts(
        `"spaceId" = $1 AND "status" IN ('confirmed', 'disputed') AND "area" IN ('about', 'preferences', 'people')
         ORDER BY CASE "area" WHEN 'about' THEN 0 WHEN 'preferences' THEN 1 ELSE 2 END, "updatedAt" DESC LIMIT $2`,
        [spaceId, limit],
      );
    },
    async insertFact(fact, embedding) {
      return (await store.insertFactOnce(fact, embedding)).fact;
    },
    async insertFactOnce(fact, embedding) {
      const id = randomUUID();
      const key = textKey(fact.text);
      const [row] = await queryUnsafe.$queryRawUnsafe<FactRow[]>(
        // The partial unique index memory_facts_live_text_key: one live fact per Space and text.
        `INSERT INTO "memory_facts" ("id","spaceId","area","subject","text","quote","origin","status","confidence","mentions","sourceMessageIds","entities","sourceThreadId","sourceRunId","writtenByBotId","writtenByBotName","userId","validFrom","validTo","supersedesId","embedding","textKey")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text[],$12::text[],$13,$14,
           (SELECT "id" FROM "bots" WHERE "id" = $15),$16,$17,$18,$19,$20,$21::vector,$22)
         ON CONFLICT ("spaceId","textKey") WHERE "textKey" IS NOT NULL AND "status" IN ('tentative','confirmed','disputed') DO NOTHING
         RETURNING ${FACT_COLUMNS}`,
        id,
        fact.spaceId,
        fact.area,
        fact.subject,
        fact.text,
        fact.quote,
        fact.origin,
        fact.status,
        fact.confidence,
        fact.mentions,
        fact.sourceMessageIds,
        fact.entities,
        fact.sourceThreadId,
        fact.sourceRunId,
        fact.writtenByBotId,
        fact.writtenByBotName,
        fact.userId,
        fact.validFrom,
        fact.validTo,
        fact.supersedesId,
        embedding ? vectorLiteral(embedding) : null,
        key,
      );
      if (row) return { fact: toFact(row), inserted: true };
      const [existing] = await selectFacts(
        `"spaceId" = $1 AND "textKey" = $2 AND "status" = ANY($3::text[]) LIMIT 1`,
        [fact.spaceId, key, live],
      );
      if (!existing) throw new Error("memory fact insert returned no row");
      return { fact: existing, inserted: false };
    },
    async updateFact(spaceId, id, patch) {
      const sets: string[] = [];
      const values: unknown[] = [spaceId, id];
      const casts: Partial<Record<keyof FactPatch, string>> = { sourceMessageIds: "::text[]" };
      for (const [key, value] of Object.entries(patch) as Array<[keyof FactPatch, unknown]>) {
        if (value === undefined) continue;
        values.push(value);
        sets.push(`"${key}" = $${values.length}${casts[key] ?? ""}`);
      }
      if (!sets.length) return;
      await queryUnsafe.$queryRawUnsafe(
        `UPDATE "memory_facts" SET ${sets.join(", ")}, "updatedAt" = CURRENT_TIMESTAMP WHERE "spaceId" = $1 AND "id" = $2`,
        ...values,
      );
    },
    async setEmbedding(spaceId, id, vector) {
      await queryUnsafe.$queryRawUnsafe(
        `UPDATE "memory_facts" SET "embedding" = $3::vector WHERE "spaceId" = $1 AND "id" = $2`,
        spaceId,
        id,
        vectorLiteral(vector),
      );
    },
    async missingEmbeddings(spaceId, limit) {
      return selectFacts(
        `"spaceId" = $1 AND "status" = ANY($2::text[]) AND "embedding" IS NULL ORDER BY "createdAt" DESC LIMIT $3`,
        [spaceId, live, limit],
      );
    },
    async addLink(link) {
      const [row] = await queryUnsafe.$queryRawUnsafe<FactLink[]>(
        `INSERT INTO "memory_fact_links" ("id","spaceId","fromId","toId","kind","score")
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT ("fromId","toId","kind") DO UPDATE SET "score" = COALESCE(EXCLUDED."score", "memory_fact_links"."score")
         RETURNING *`,
        randomUUID(),
        link.spaceId,
        link.fromId,
        link.toId,
        link.kind,
        link.score ?? null,
      );
      return row ? { ...row, score: row.score === null ? null : Number(row.score) } : undefined;
    },
    async updateLink(spaceId, id, patch) {
      const sets: string[] = [];
      const values: unknown[] = [spaceId, id];
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        values.push(value);
        sets.push(`"${key}" = $${values.length}`);
      }
      if (!sets.length) return;
      await queryUnsafe.$queryRawUnsafe(
        `UPDATE "memory_fact_links" SET ${sets.join(", ")} WHERE "spaceId" = $1 AND "id" = $2`,
        ...values,
      );
    },
    async linksOf(spaceId, ids, kinds) {
      if (!ids.length) return [];
      const rows = await queryUnsafe.$queryRawUnsafe<FactLink[]>(
        `SELECT * FROM "memory_fact_links" WHERE "spaceId" = $1 AND ("fromId" = ANY($2::text[]) OR "toId" = ANY($2::text[]))
         AND ($3::text[] IS NULL OR "kind" = ANY($3::text[]))`,
        spaceId,
        [...ids],
        kinds ? [...kinds] : null,
      );
      return rows.map((row) => ({ ...row, score: row.score === null ? null : Number(row.score) }));
    },
    async openQuestions(spaceId, threadId) {
      const conflicts = await queryUnsafe.$queryRawUnsafe<FactLink[]>(
        `SELECT * FROM "memory_fact_links" WHERE "spaceId" = $1 AND "askedThreadId" = $2
         AND "askedAt" IS NOT NULL AND "resolvedAt" IS NULL ORDER BY "askedAt"`,
        spaceId,
        threadId,
      );
      const unsure = await selectFacts(
        `"spaceId" = $1 AND "askedThreadId" = $2 AND "askedAt" IS NOT NULL AND "status" = 'tentative' ORDER BY "askedAt"`,
        [spaceId, threadId],
      );
      return { conflicts, unsure };
    },
    async answeredConflicts(spaceId, factIds) {
      if (!factIds.length) return [];
      return queryUnsafe.$queryRawUnsafe<FactLink[]>(
        `SELECT * FROM "memory_fact_links" WHERE "spaceId" = $1 AND "kind" = 'contradicts' AND "resolvedAt" IS NOT NULL
         AND ("fromId" = ANY($2::text[]) OR "toId" = ANY($2::text[]))`,
        spaceId,
        [...factIds],
      );
    },
    async claimJob(job) {
      const rows = await queryUnsafe.$queryRawUnsafe<Array<{ runId: string }>>(
        `INSERT INTO "memory_ledger_jobs" ("runId","spaceId","threadId","botId","userId")
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT ("runId") DO NOTHING RETURNING "runId"`,
        job.runId,
        job.spaceId,
        job.threadId,
        job.botId,
        job.userId,
      );
      return rows.length > 0;
    },
    async startJob(spaceId, runId) {
      // Taken by one writer at a time; a stale "running" row (a crash) is taken again later.
      const rows = await queryUnsafe.$queryRawUnsafe<Array<{ runId: string }>>(
        `UPDATE "memory_ledger_jobs" SET "status" = 'running', "attempts" = "attempts" + 1, "updatedAt" = CURRENT_TIMESTAMP
         WHERE "spaceId" = $1 AND "runId" = $2 AND ("status" IN ('pending', 'failed')
           OR ("status" = 'running' AND "updatedAt" < CURRENT_TIMESTAMP - interval '15 minutes'))
         RETURNING "runId"`,
        spaceId,
        runId,
      );
      return rows.length > 0;
    },
    async finishJob(spaceId, runId, status, error) {
      await queryUnsafe.$queryRawUnsafe(
        `UPDATE "memory_ledger_jobs" SET "status" = $3, "error" = $4, "updatedAt" = CURRENT_TIMESTAMP
         WHERE "spaceId" = $1 AND "runId" = $2`,
        spaceId,
        runId,
        status,
        error?.slice(0, 500) ?? null,
      );
    },
    async staleJobs(spaceId, olderThanMs, limit) {
      return queryUnsafe.$queryRawUnsafe<LedgerJob[]>(
        `SELECT "runId","spaceId","threadId","botId","userId","attempts","createdAt" FROM "memory_ledger_jobs"
         WHERE "spaceId" = $1 AND "attempts" < $4
           AND (("status" IN ('pending', 'failed') AND "updatedAt" < CURRENT_TIMESTAMP
                 - ($2::int * power(2, GREATEST("attempts", 1) - 1) * interval '1 millisecond'))
             OR ("status" = 'running' AND "updatedAt" < CURRENT_TIMESTAMP - interval '15 minutes'))
         ORDER BY "createdAt" LIMIT $3`,
        spaceId,
        Math.round(olderThanMs),
        limit,
        MAX_JOB_ATTEMPTS,
      );
    },
    async claimWrite(spaceId, runId, mark) {
      const rows = await queryUnsafe.$queryRawUnsafe<Array<{ runId: string }>>(
        mark
          ? `UPDATE "memory_ledger_jobs" SET "wroteAt" = CURRENT_TIMESTAMP
             WHERE "spaceId" = $1 AND "runId" = $2 AND "wroteAt" IS NULL RETURNING "runId"`
          : `SELECT "runId" FROM "memory_ledger_jobs"
             WHERE "spaceId" = $1 AND "runId" = $2 AND "wroteAt" IS NULL FOR UPDATE`,
        spaceId,
        runId,
      );
      return rows.length > 0;
    },
    async writeTransaction(spaceId, fn) {
      const lock = (target: LedgerStore, sql: typeof queryUnsafe) =>
        sql
          .$queryRawUnsafe(
            `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text AS "locked"`,
            `memory-ledger:${spaceId}`,
          )
          .then(() => fn(target));
      // Already inside a transaction (or a client without one): the caller owns the commit.
      if (inTransaction || !prisma.$transaction) return lock(store, queryUnsafe);
      return prisma.$transaction(
        (tx) => lock(createSqlLedgerStore(tx as unknown as Sql, true), tx as typeof queryUnsafe),
        WRITE_TRANSACTION_OPTIONS,
      ) as Promise<Awaited<ReturnType<typeof fn>>>;
    },
  };
  return store;
}

// --- In-memory store (tests, and the eval harness's offline mode) ----------------------------

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let left = 0;
  let right = 0;
  for (let index = 0; index < a.length; index += 1) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    dot += x * y;
    left += x * x;
    right += y * y;
  }
  return left && right ? dot / Math.sqrt(left * right) : 0;
}

type MemoryJob = LedgerJob & { status: string; updatedAt: number; wroteAt?: number | undefined };

export function createMemoryLedgerStore(): LedgerStore & {
  facts: Map<string, Fact>;
  links: Map<string, FactLink>;
  embeddings: Map<string, readonly number[]>;
  jobs: Map<string, MemoryJob>;
  /** Moves the store's clock (job ages) forward. */
  advance(ms: number): void;
} {
  const facts = new Map<string, Fact>();
  const links = new Map<string, FactLink>();
  const embeddings = new Map<string, readonly number[]>();
  const jobs = new Map<string, MemoryJob>();
  let serial = 0;
  let writers: Promise<unknown> = Promise.resolve();
  let clock = Date.parse("2026-11-24T00:00:00Z");
  const tick = () => {
    clock += 1000;
    return new Date(clock);
  };
  const isLive = (fact: Fact) => LIVE_FACT_STATUSES.includes(fact.status);
  const inSpace = (spaceId: string) =>
    [...facts.values()].filter((fact) => fact.spaceId === spaceId);
  const textScore = (fact: Fact, query: string) => {
    const words = new Set(contentWords(query));
    const own = contentWords(`${fact.text} ${(fact.subject ?? "").replace(/\./g, " ")}`);
    return own.filter((word) => words.has(word) || [...words].some((w) => stem(w) === stem(word)))
      .length;
  };
  const store: ReturnType<typeof createMemoryLedgerStore> = {
    facts,
    links,
    embeddings,
    jobs,
    advance(ms) {
      clock += ms;
    },
    async findRetired(spaceId, text, limit = 10) {
      return inSpace(spaceId)
        .filter((fact) => fact.status === "superseded" || fact.status === "retracted")
        .filter((fact) => textScore(fact, text) > 0)
        .slice(0, limit);
    },
    async findLive(spaceId, query, limit = 30) {
      return inSpace(spaceId)
        .filter(isLive)
        .filter(
          (fact) =>
            (fact.subject && query.subjects?.includes(fact.subject)) ||
            query.ids?.includes(fact.id) ||
            (query.texts ?? []).some(
              (text) => textScore(fact, text) > 0 || overlap(fact.text, text) > 0,
            ),
        )
        .slice(0, limit);
    },
    async searchText(spaceId, query, limit) {
      return inSpace(spaceId)
        .filter(isLive)
        .map((fact) => ({ fact, score: textScore(fact, query) }))
        .filter((item) => item.score > 0)
        .sort(
          (a, b) => b.score - a.score || b.fact.updatedAt.getTime() - a.fact.updatedAt.getTime(),
        )
        .slice(0, limit)
        .map((item) => item.fact.id);
    },
    async searchVector(spaceId, vector, limit) {
      return inSpace(spaceId)
        .filter(isLive)
        .flatMap((fact) => {
          const embedding = embeddings.get(fact.id);
          return embedding ? [{ id: fact.id, similarity: cosine(vector, embedding) }] : [];
        })
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);
    },
    async getFacts(spaceId, ids) {
      return ids.flatMap((id) => {
        const fact = facts.get(id);
        return fact && fact.spaceId === spaceId ? [fact] : [];
      });
    },
    async coreFacts(spaceId, limit) {
      const order = { about: 0, preferences: 1, people: 2 } as Record<string, number>;
      return inSpace(spaceId)
        .filter(
          (fact) =>
            (fact.status === "confirmed" || fact.status === "disputed") && fact.area in order,
        )
        .sort(
          (a, b) =>
            (order[a.area] ?? 9) - (order[b.area] ?? 9) ||
            b.updatedAt.getTime() - a.updatedAt.getTime(),
        )
        .slice(0, limit);
    },
    async insertFact(fact, embedding) {
      return (await store.insertFactOnce(fact, embedding)).fact;
    },
    async insertFactOnce(fact, embedding) {
      const key = textKey(fact.text);
      const same = inSpace(fact.spaceId).find(
        (other) => isLive(other) && key !== null && textKey(other.text) === key,
      );
      if (same) return { fact: same, inserted: false };
      const now = tick();
      serial += 1;
      const stored: Fact = {
        ...fact,
        id: `fact-${serial}`,
        askedAt: null,
        askedThreadId: null,
        askedMessageId: null,
        createdAt: now,
        updatedAt: now,
      };
      facts.set(stored.id, stored);
      if (embedding) embeddings.set(stored.id, embedding);
      return { fact: stored, inserted: true };
    },
    async updateFact(spaceId, id, patch) {
      const fact = facts.get(id);
      if (!fact || fact.spaceId !== spaceId) return;
      const defined = Object.fromEntries(
        Object.entries(patch).filter(([, value]) => value !== undefined),
      );
      facts.set(id, { ...fact, ...defined, updatedAt: tick() });
    },
    async setEmbedding(_spaceId, id, vector) {
      embeddings.set(id, vector);
    },
    async missingEmbeddings(spaceId, limit) {
      return inSpace(spaceId)
        .filter((fact) => isLive(fact) && !embeddings.has(fact.id))
        .slice(0, limit);
    },
    async addLink(link) {
      const existing = [...links.values()].find(
        (item) => item.fromId === link.fromId && item.toId === link.toId && item.kind === link.kind,
      );
      if (existing) return existing;
      const stored: FactLink = {
        id: `link-${links.size + 1}`,
        spaceId: link.spaceId,
        fromId: link.fromId,
        toId: link.toId,
        kind: link.kind,
        score: link.score ?? null,
        askedAt: null,
        askedThreadId: null,
        askedMessageId: null,
        resolvedAt: null,
        resolution: null,
        createdAt: tick(),
      };
      links.set(stored.id, stored);
      return stored;
    },
    async updateLink(spaceId, id, patch) {
      const link = links.get(id);
      if (!link || link.spaceId !== spaceId) return;
      const defined = Object.fromEntries(
        Object.entries(patch).filter(([, value]) => value !== undefined),
      );
      links.set(id, { ...link, ...defined });
    },
    async linksOf(spaceId, ids, kinds) {
      return [...links.values()].filter(
        (link) =>
          link.spaceId === spaceId &&
          (ids.includes(link.fromId) || ids.includes(link.toId)) &&
          (!kinds || kinds.includes(link.kind)),
      );
    },
    async openQuestions(spaceId, threadId) {
      return {
        conflicts: [...links.values()].filter(
          (link) =>
            link.spaceId === spaceId &&
            link.askedThreadId === threadId &&
            link.askedAt &&
            !link.resolvedAt,
        ),
        unsure: inSpace(spaceId).filter(
          (fact) => fact.askedThreadId === threadId && fact.askedAt && fact.status === "tentative",
        ),
      };
    },
    async answeredConflicts(spaceId, factIds) {
      return [...links.values()].filter(
        (link) =>
          link.spaceId === spaceId &&
          link.kind === "contradicts" &&
          link.resolvedAt &&
          (factIds.includes(link.fromId) || factIds.includes(link.toId)),
      );
    },
    async claimJob(job) {
      if (jobs.has(job.runId)) return false;
      jobs.set(job.runId, {
        ...job,
        attempts: 0,
        status: "pending",
        updatedAt: clock,
        createdAt: new Date(clock),
      });
      return true;
    },
    async startJob(_spaceId, runId) {
      const job = jobs.get(runId);
      if (!job || job.status === "done" || job.status === "running") return false;
      jobs.set(runId, { ...job, status: "running", attempts: job.attempts + 1, updatedAt: clock });
      return true;
    },
    async finishJob(_spaceId, runId, status) {
      const job = jobs.get(runId);
      if (job) jobs.set(runId, { ...job, status, updatedAt: clock });
    },
    async staleJobs(spaceId, olderThanMs, limit) {
      return [...jobs.values()]
        .filter(
          (job) =>
            job.spaceId === spaceId &&
            job.attempts < MAX_JOB_ATTEMPTS &&
            (job.status === "pending" || job.status === "failed") &&
            job.updatedAt <= clock - olderThanMs * 2 ** (Math.max(job.attempts, 1) - 1),
        )
        .slice(0, limit);
    },
    async claimWrite(_spaceId, runId, mark) {
      const job = jobs.get(runId);
      if (!job || job.wroteAt !== undefined) return false;
      if (mark) jobs.set(runId, { ...job, wroteAt: clock });
      return true;
    },
    writeTransaction(_spaceId, fn) {
      // One writer at a time, and a failed one leaves nothing behind.
      const run = writers.then(async () => {
        const before = {
          facts: new Map(facts),
          links: new Map(links),
          embeddings: new Map(embeddings),
          jobs: new Map(jobs),
        };
        try {
          return await fn(store);
        } catch (error) {
          for (const [live, saved] of [
            [facts, before.facts],
            [links, before.links],
            [embeddings, before.embeddings],
            [jobs, before.jobs],
          ] as Array<[Map<string, unknown>, Map<string, unknown>]>) {
            live.clear();
            for (const [key, value] of saved) live.set(key, value);
          }
          throw error;
        }
      });
      writers = run.catch(() => undefined);
      return run;
    },
  };
  return store;
}

export type { FactStatus };
