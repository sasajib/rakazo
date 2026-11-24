import { describe, expect, it } from "vitest";
import { ledgerConfig } from "./config.js";
import type { FetchLike } from "./embeddings.js";
import { createEmbedder } from "./embeddings.js";
import {
  createOpenAiMemoryModel,
  extractionPayload,
  normalizeSubject,
  parseExtraction,
} from "./model.js";
import { isFastRun, learnsFrom, placeLedgerBlock, withLedgerMemory } from "./seams.js";
import type { Fact } from "./types.js";

const known = {
  id: "real-id-1",
  area: "about",
  subject: "owner.home-city",
  text: "Owner lives in Dhaka",
  status: "confirmed",
  validFrom: new Date("2026-11-12T00:00:00Z"),
} as Fact;

describe("memory model reply", () => {
  it("maps short ids back and drops ids it never showed", () => {
    const { idOf } = extractionPayload({ today: "2026-11-24", messages: [], known: [known] });
    const [candidate] = parseExtraction(
      'Here you go: {"facts":[{"area":"about","subject":"Owner.Home City","text":"Owner lives in Berlin","quote":"I live in Berlin","m":1,"origin":"stated","confidence":0.9,"entities":["Berlin"],"replaces":["F1","F9"],"correction":true}]}',
      idOf,
    )!;
    expect(candidate).toMatchObject({
      subject: "owner.home-city",
      replaces: ["real-id-1"],
      correction: true,
      message: 1,
    });
  });

  it("skips malformed entries and survives broken JSON", () => {
    expect(
      parseExtraction('{"facts":[{"area":"nowhere","text":"x","quote":"y"}]}', new Map()),
    ).toEqual([]);
    expect(parseExtraction("not json at all", new Map())).toBeUndefined();
    expect(
      parseExtraction('{"facts":[{"area":"about","text":"a b","quote":"a b",}]}', new Map()),
    ).toHaveLength(1);
  });

  it("normalizes subjects", () => {
    expect(normalizeSubject(" Person.Rahim  Role ")).toBe("person.rahim-role");
    expect(normalizeSubject("x")).toBeUndefined();
  });

  it("calls an OpenAI-compatible endpoint with only the owner's messages", async () => {
    const bodies: unknown[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"facts":[]}' } }] }),
      };
    };
    const model = createOpenAiMemoryModel(
      { baseUrl: "http://omniroute:20128/v1/", model: "glm/glm-5.3-flash", apiKey: "k" },
      { timeoutMs: 1000, fetchImpl },
    );
    const result = await model.extract({
      today: "2026-11-24",
      messages: [{ id: "m1", text: "I live in Dhaka", at: new Date(), current: true }],
      known: [],
    });
    expect(result).toEqual([]);
    const body = bodies[0] as { model: string; messages: Array<{ role: string; content: string }> };
    expect(body.model).toBe("glm/glm-5.3-flash");
    expect(JSON.parse(body.messages[1]!.content).owner_messages).toEqual([
      expect.objectContaining({ m: 1, text: "I live in Dhaka", current: true }),
    ]);
  });

  it("returns undefined (cue fallback) when the endpoint is down", async () => {
    const model = createOpenAiMemoryModel(
      { baseUrl: "http://127.0.0.1:9/v1", model: "m" },
      {
        timeoutMs: 200,
        fetchImpl: async () => {
          throw new Error("ECONNREFUSED");
        },
      },
    );
    expect(await model.extract({ today: "x", messages: [], known: [] })).toBeUndefined();
  });
});

describe("embeddings", () => {
  const vector = new Array(1024).fill(0.01);
  it("speaks Ollama by default and OpenAI for a /v1 URL", async () => {
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      urls.push(url);
      return {
        ok: true,
        json: async () =>
          url.endsWith("/api/embeddings")
            ? { embedding: vector }
            : { data: [{ embedding: vector }] },
      };
    };
    const config = ledgerConfig({});
    expect(
      await createEmbedder({ ...config.embeddings, url: "http://ollama:11434" }, fetchImpl)!.embed(
        "hi",
      ),
    ).toHaveLength(1024);
    expect(
      await createEmbedder({ ...config.embeddings, url: "http://tei:80/v1" }, fetchImpl)!.embed(
        "hi",
      ),
    ).toHaveLength(1024);
    expect(urls).toEqual(["http://ollama:11434/api/embeddings", "http://tei:80/v1/embeddings"]);
  });

  it("is absent without a URL and quiet on wrong dimensions", async () => {
    expect(createEmbedder(ledgerConfig({}).embeddings)).toBeUndefined();
    const wrong: FetchLike = async () => ({
      ok: true,
      json: async () => ({ embedding: [1, 2, 3] }),
    });
    expect(
      await createEmbedder({ ...ledgerConfig({}).embeddings, url: "http://x" }, wrong)!.embed("hi"),
    ).toBeUndefined();
  });

  it("falls back to the STANDING embeddings service", () => {
    expect(ledgerConfig({ STANDING_EMBEDDINGS_URL: "http://ollama:11434" }).embeddings.url).toBe(
      "http://ollama:11434",
    );
  });
});

describe("seams", () => {
  it("leave the durable memory untouched while the ledger is off", async () => {
    const prisma = new Proxy(
      {},
      {
        get: () => {
          throw new Error("no database access when off");
        },
      },
    );
    const text = await withLedgerMemory(
      { prisma: prisma as never },
      { spaceId: "s", trigger: "user", query: "hi" },
      Promise.resolve("<durable_memory>x</durable_memory>"),
      {},
    );
    expect(text).toBe("<durable_memory>x</durable_memory>");
  });

  it("place the ledger after the standing orders and before durable memory", () => {
    const standing = "Standing orders.\n\n<standing_orders>\n- r1\n</standing_orders>";
    const durable = "Durable memory follows.\n\n<durable_memory>\nx\n</durable_memory>";
    const ledger = "Memory ledger.\n\n<memory_facts>\nf\n</memory_facts>";
    const text = placeLedgerBlock(`${standing}\n\n${durable}`, ledger) ?? "";
    expect(text).toBe(`${standing}\n\n${ledger}\n\n${durable}`);
    expect(placeLedgerBlock(durable, ledger)).toBe(`${ledger}\n\n${durable}`);
    expect(placeLedgerBlock(standing, ledger)).toBe(`${standing}\n\n${ledger}`);
    expect(placeLedgerBlock(undefined, ledger)).toBe(ledger);
    expect(placeLedgerBlock(durable, undefined)).toBe(durable);
  });

  it("default the work-start pack budget to 400 ms", () => {
    expect(ledgerConfig({ MEMORY_LEDGER: "1" }).packBudgetMs).toBe(400);
  });

  it("append nothing when the ledger database cannot be read", async () => {
    const prisma = {
      $queryRawUnsafe: async () => {
        throw new Error("relation memory_facts does not exist");
      },
    };
    const text = await withLedgerMemory(
      { prisma: prisma as never },
      { spaceId: "s", trigger: "user", query: "hi" },
      Promise.resolve("durable"),
      { MEMORY_LEDGER: "1" },
    );
    expect(text).toBe("durable");
  });

  it("learn only from owner-started chat runs with a message", () => {
    const run = {
      runId: "r",
      spaceId: "s",
      userId: "u",
      threadId: "t",
      botId: "b",
      botName: null,
      trigger: "user",
      sourceMessageId: "m",
      ownerStartedRun: true,
      messagingChannelRun: false,
    };
    expect(learnsFrom(run)).toBe(true);
    expect(learnsFrom({ ...run, trigger: "routine" })).toBe(false);
    expect(learnsFrom({ ...run, trigger: "webhook" })).toBe(false);
    expect(learnsFrom({ ...run, messagingChannelRun: true })).toBe(false);
    expect(learnsFrom({ ...run, ownerStartedRun: false })).toBe(false);
    expect(learnsFrom({ ...run, sourceMessageId: null })).toBe(false);
  });

  it("give talk runs and call turns the fast pack", () => {
    expect(isFastRun("talk")).toBe(true);
    expect(isFastRun("user", "call:abc123:turn-1")).toBe(true);
    expect(isFastRun("user", "web-123")).toBe(false);
  });

  it("read the switches from the environment", () => {
    const config = ledgerConfig({
      MEMORY_LEDGER: "on",
      MEMORY_LEDGER_PACK_BUDGET_MS: "9999999",
      MEMORY_LEDGER_MODEL_URL: "off",
    });
    expect(config.enabled).toBe(true);
    expect(config.packBudgetMs).toBe(5000);
    expect(config.model.disabled).toBe(true);
    expect(ledgerConfig({}).model.model).toBe("glm/glm-5.3-flash");
  });
});
