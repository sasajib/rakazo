import { describe, expect, it, vi } from "vitest";
import {
  EMBEDDING_DIMENSIONS,
  embedText,
  suggestionsFor,
  suggestRelated,
  textHash,
} from "./standing-embeddings.js";
import type { StandingEntry } from "./standing-orders.js";
import { emptyLinks } from "./standing-orders.js";

const vec = (n: number) => Array.from({ length: EMBEDDING_DIMENSIONS }, () => n);
const ok = (embedding: unknown) =>
  vi.fn(async (_url: string, _init?: unknown) => ({ ok: true, json: async () => ({ embedding }) }));
const entry = (key: string, links?: Partial<ReturnType<typeof emptyLinks>>): StandingEntry => ({
  kind: "rule",
  key,
  date: "2026-11-17",
  text: `Rule ${key}`,
  ...(links ? { links: Object.assign(emptyLinks(), links) } : {}),
});

describe("standing embeddings", () => {
  it("returns the vector from the service and calls its embeddings endpoint", async () => {
    const f = ok(vec(0.1));
    expect(await embedText("http://emb:11434/", "Solve the captcha", f)).toHaveLength(
      EMBEDDING_DIMENSIONS,
    );
    expect(f.mock.calls[0]?.[0]).toBe("http://emb:11434/api/embeddings");
  });

  it("returns nothing when unconfigured, failing, slow or the wrong size", async () => {
    expect(await embedText(undefined, "x", ok(vec(1)))).toBeUndefined();
    expect(await embedText("http://e", "", ok(vec(1)))).toBeUndefined();
    expect(await embedText("http://e", "x", ok([1, 2, 3]))).toBeUndefined();
    expect(
      await embedText(
        "http://e",
        "x",
        vi.fn(async () => ({ ok: false, json: async () => ({}) })),
      ),
    ).toBeUndefined();
    expect(
      await embedText(
        "http://e",
        "x",
        vi.fn(async () => {
          throw new Error("down");
        }),
      ),
    ).toBeUndefined();
  });

  it("suggests close, existing entries that are not yet linked, best first", () => {
    const entries = [entry("a"), entry("b", { dependsOn: ["a"] }), entry("c"), entry("d")];
    const out = suggestionsFor(entries, "a", [
      { key: "b", similarity: 0.9 }, // already linked
      { key: "c", similarity: 0.8 },
      { key: "d", similarity: 0.3 }, // too far
      { key: "ghost", similarity: 0.95 }, // no such entry
    ]);
    expect(out).toEqual([{ key: "c", similarity: 0.8 }]);
  });

  it("suggestRelated saves the embedding, queries the neighbours, and never throws", async () => {
    const prisma = {
      $executeRaw: vi.fn(async () => 1),
      $queryRaw: vi.fn(async () => [{ key: "c", similarity: 0.71 }]),
    };
    const out = await suggestRelated(
      prisma as never,
      { spaceId: "s1", key: "a", text: "Solve the captcha", entries: [entry("a"), entry("c")] },
      { baseUrl: "http://e", fetchImpl: ok(vec(0.2)) },
    );
    expect(out).toEqual([{ key: "c", similarity: 0.71 }]);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const broken = {
      $executeRaw: vi.fn(async () => {
        throw new Error("db");
      }),
      $queryRaw: vi.fn(),
    };
    expect(
      await suggestRelated(
        broken as never,
        { spaceId: "s", key: "a", text: "t", entries: [] },
        { baseUrl: "http://e", fetchImpl: ok(vec(0.2)) },
      ),
    ).toEqual([]);
    expect(
      await suggestRelated(
        prisma as never,
        { spaceId: "s", key: "a", text: "t", entries: [] },
        { baseUrl: undefined },
      ),
    ).toEqual([]);
  });

  it("hashes text stably", () => {
    expect(textHash("a")).toBe(textHash("a"));
    expect(textHash("a")).not.toBe(textHash("b"));
  });
});
