import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { neighbors } from "./standing-graph.js";
import type { StandingEntry } from "./standing-orders.js";

/**
 * Suggests which standing orders relate to a new or changed one, by meaning (pgvector, cosine). Advice only:
 * the user's confirmed `>` `^` `+` links are the exact facts; similarity never changes a rule or its priority.
 * The embedding service is a local Ollama (bge-m3, 1024 dimensions); when it is not configured or does not
 * answer, saving a rule works exactly as before.
 */
export const EMBEDDING_DIMENSIONS = 1024;
export const SUGGEST_MIN_SIMILARITY = 0.55;
const EMBED_TIMEOUT_MS = 5_000;
const EMBED_MODEL = "bge-m3";

type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{
  ok: boolean;
  json: () => Promise<unknown>;
}>;

export const embeddingsUrl = (): string | undefined =>
  process.env.STANDING_EMBEDDINGS_URL?.trim() || undefined;

export const textHash = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The embedding of `text`, or undefined when the service is unconfigured, slow or returns something else. */
export async function embedText(
  baseUrl: string | undefined,
  text: string,
  fetchImpl: Fetch = fetch as unknown as Fetch,
): Promise<number[] | undefined> {
  if (!baseUrl || !text.trim()) return undefined;
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/api/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { embedding?: unknown };
    const v = body.embedding;
    if (
      !Array.isArray(v) ||
      v.length !== EMBEDDING_DIMENSIONS ||
      !v.every((x) => typeof x === "number")
    )
      return undefined;
    return v as number[];
  } catch {
    return undefined;
  }
}

const literal = (v: readonly number[]): string => `[${v.join(",")}]`;

/** Stores the embedding of one entry (replacing the old one). */
export async function saveEmbedding(
  prisma: Pick<PrismaClient, "$executeRaw">,
  input: { spaceId: string; key: string; text: string; vector: readonly number[] },
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO standing_embeddings ("id", "spaceId", "key", "textHash", "embedding", "updatedAt")
    VALUES (${randomUUID()}, ${input.spaceId}, ${input.key}, ${textHash(input.text)}, ${literal(input.vector)}::vector, now())
    ON CONFLICT ("spaceId", "key")
    DO UPDATE SET "textHash" = EXCLUDED."textHash", "embedding" = EXCLUDED."embedding", "updatedAt" = now()`;
}

export async function removeEmbedding(
  prisma: Pick<PrismaClient, "$executeRaw">,
  input: { spaceId: string; key: string },
): Promise<void> {
  await prisma.$executeRaw`DELETE FROM standing_embeddings WHERE "spaceId" = ${input.spaceId} AND "key" = ${input.key}`;
}

export type SimilarEntry = { key: string; similarity: number };

/** The closest other entries to `vector` (cosine similarity), best first. */
export async function nearestEntries(
  prisma: Pick<PrismaClient, "$queryRaw">,
  input: { spaceId: string; key: string; vector: readonly number[]; limit?: number },
): Promise<SimilarEntry[]> {
  const rows = await prisma.$queryRaw<{ key: string; similarity: number }[]>`
    SELECT "key", 1 - ("embedding" <=> ${literal(input.vector)}::vector) AS similarity
    FROM standing_embeddings
    WHERE "spaceId" = ${input.spaceId} AND "key" <> ${input.key} AND "embedding" IS NOT NULL
    ORDER BY "embedding" <=> ${literal(input.vector)}::vector
    LIMIT ${input.limit ?? 5}`;
  return rows.map((r) => ({
    key: r.key,
    similarity: Math.round(Number(r.similarity) * 100) / 100,
  }));
}

/** Similar entries worth a look: close in meaning and not already linked to `key`. */
export function suggestionsFor(
  entries: readonly StandingEntry[],
  key: string,
  similar: readonly SimilarEntry[],
  limit = 3,
): SimilarEntry[] {
  const linked = new Set(neighbors(entries, key));
  const known = new Set(entries.map((e) => e.key));
  return similar
    .filter((s) => s.similarity >= SUGGEST_MIN_SIMILARITY && known.has(s.key) && !linked.has(s.key))
    .slice(0, limit);
}

/**
 * After a save: embed the entry and return the related entries that are not yet linked to it. Never throws and
 * never blocks the save; a missing service or a database problem just yields no suggestions.
 */
export async function suggestRelated(
  prisma: Pick<PrismaClient, "$executeRaw" | "$queryRaw">,
  input: { spaceId: string; key: string; text: string; entries: readonly StandingEntry[] },
  deps: { baseUrl?: string | undefined; fetchImpl?: Fetch } = {},
): Promise<SimilarEntry[]> {
  try {
    const vector = await embedText(deps.baseUrl ?? embeddingsUrl(), input.text, deps.fetchImpl);
    if (!vector) return [];
    await saveEmbedding(prisma, {
      spaceId: input.spaceId,
      key: input.key,
      text: input.text,
      vector,
    });
    const near = await nearestEntries(prisma, { spaceId: input.spaceId, key: input.key, vector });
    return suggestionsFor(input.entries, input.key, near);
  } catch {
    return [];
  }
}

/** Embeds every entry that has no current embedding (new text or never embedded). Returns how many were embedded. */
export async function backfillEmbeddings(
  prisma: Pick<PrismaClient, "$executeRaw" | "$queryRaw">,
  input: { spaceId: string; entries: readonly StandingEntry[] },
  deps: { baseUrl?: string | undefined; fetchImpl?: Fetch; max?: number } = {},
): Promise<number> {
  const baseUrl = deps.baseUrl ?? embeddingsUrl();
  if (!baseUrl) return 0;
  try {
    const have = await prisma.$queryRaw<{ key: string; textHash: string }[]>`
      SELECT "key", "textHash" FROM standing_embeddings WHERE "spaceId" = ${input.spaceId} AND "embedding" IS NOT NULL`;
    const current = new Map(have.map((r) => [r.key, r.textHash]));
    let done = 0;
    for (const e of input.entries) {
      if (done >= (deps.max ?? 60)) break;
      if (current.get(e.key) === textHash(e.text)) continue;
      const vector = await embedText(baseUrl, e.text, deps.fetchImpl);
      if (!vector) break;
      await saveEmbedding(prisma, { spaceId: input.spaceId, key: e.key, text: e.text, vector });
      done += 1;
    }
    return done;
  } catch {
    return 0;
  }
}

/** Pairs of entries close in meaning that are not linked yet, closest first. */
export async function relatedPairs(
  prisma: Pick<PrismaClient, "$queryRaw">,
  input: {
    spaceId: string;
    entries: readonly StandingEntry[];
    minSimilarity?: number;
    limit?: number;
  },
): Promise<{ a: string; b: string; similarity: number }[]> {
  try {
    const min = input.minSimilarity ?? 0.7;
    const rows = await prisma.$queryRaw<{ a: string; b: string; similarity: number }[]>`
      SELECT x."key" AS a, y."key" AS b, 1 - (x."embedding" <=> y."embedding") AS similarity
      FROM standing_embeddings x JOIN standing_embeddings y ON y."spaceId" = x."spaceId" AND x."key" < y."key"
      WHERE x."spaceId" = ${input.spaceId} AND x."embedding" IS NOT NULL AND y."embedding" IS NOT NULL
        AND 1 - (x."embedding" <=> y."embedding") >= ${min}
      ORDER BY similarity DESC LIMIT 60`;
    const known = new Set(input.entries.map((e) => e.key));
    return rows
      .filter(
        (r) => known.has(r.a) && known.has(r.b) && !neighbors(input.entries, r.a).includes(r.b),
      )
      .slice(0, input.limit ?? 8)
      .map((r) => ({ a: r.a, b: r.b, similarity: Math.round(Number(r.similarity) * 100) / 100 }));
  } catch {
    return [];
  }
}
