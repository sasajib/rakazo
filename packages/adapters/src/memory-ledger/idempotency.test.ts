/**
 * A ledger job writes once, whatever happens to it: processed twice, retried after an attempt
 * that had already committed, run late beside other late jobs, or run at the same moment as
 * another job that read the same words. Each case below wrote a second live fact before.
 */
import { describe, expect, it } from "vitest";
import type { Embedder } from "./embeddings.js";
import type { ExtractionInput, MemoryModel } from "./model.js";
import { loadOwnerMessages } from "./seams.js";
import { createMemoryLedgerStore, MAX_JOB_ATTEMPTS } from "./store.js";
import type { FactCandidate, OwnerMessage } from "./types.js";
import { LIVE_FACT_STATUSES } from "./types.js";
import type { LearnInput, LedgerServices } from "./writer.js";
import { learnFromMessages } from "./writer.js";

const SPACE = "space-1";
let clock = Date.parse("2026-11-26T10:00:00Z");
const tick = () => {
  clock += 60_000;
  return new Date(clock);
};
const owner = (id: string, text: string, current = true): OwnerMessage => ({
  id,
  text,
  at: tick(),
  current,
});

function scripted(answers: Array<FactCandidate[] | undefined>, wait = 0) {
  const seen: ExtractionInput[] = [];
  const model: MemoryModel = {
    async extract(input) {
      seen.push(input);
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      return answers.shift();
    },
  };
  return { model, seen };
}

function setup(overrides: Partial<LedgerServices> = {}) {
  const store = createMemoryLedgerStore();
  const services: LedgerServices = {
    store,
    config: { model: {} as never },
    now: tick,
    postCard: async () => "card-1",
    ...overrides,
  };
  const live = () =>
    [...store.facts.values()].filter((fact) => LIVE_FACT_STATUSES.includes(fact.status));
  const job = async (runId: string) => {
    await store.claimJob({
      runId,
      spaceId: SPACE,
      threadId: "thread-1",
      botId: "bot-a",
      userId: "u",
    });
    await store.startJob(SPACE, runId);
  };
  return { store, services, live, job };
}

const input = (
  runId: string,
  messages: OwnerMessage[],
  extra: Partial<LearnInput> = {},
): LearnInput => ({
  spaceId: SPACE,
  userId: "u",
  threadId: "thread-1",
  runId,
  botId: "bot-a",
  botName: "Bot",
  messages,
  writeOnce: true,
  ...extra,
});

const fact = (text: string, quote: string, extra: Partial<FactCandidate> = {}): FactCandidate => ({
  area: "work",
  text,
  quote,
  message: 1,
  origin: "stated",
  confidence: 0.85,
  entities: [],
  ...extra,
});

function unit(second: number): number[] {
  const vector = new Array(1024).fill(0);
  vector[0] = 1;
  vector[1] = second;
  return vector;
}

describe("a ledger job writes once", () => {
  it("the same job processed twice writes once, however the model words it the second time", async () => {
    // The memory model is not deterministic: asked again it names and words the fact anew.
    const { model } = scripted([
      [fact("Owner's agency is called Northwind", "my agency is called Northwind")],
      [
        fact(
          "The agency the owner runs has the name Northwind Studio",
          "agency is called Northwind",
          {
            subject: "work.agency-name",
          },
        ),
        fact("Owner dislikes long reports", "I do not like long reports", {
          area: "preferences",
        }),
      ],
    ]);
    const { services, live, job, store } = setup({ model });
    const messages = [
      owner("m1", "By the way my agency is called Northwind. I do not like long reports."),
    ];
    await job("run-1");
    const first = await learnFromMessages(services, input("run-1", messages));
    expect(first.saved).toHaveLength(1);
    expect(first.alreadyWritten).toBe(false);

    const second = await learnFromMessages(services, input("run-1", messages));
    expect(second.alreadyWritten).toBe(true);
    expect([second.saved, second.reinforced, second.superseded]).toEqual([[], [], []]);
    expect(live().map((item) => item.text)).toEqual(["Owner's agency is called Northwind"]);
    expect(store.facts.size).toBe(1);
  });

  it("a retry after an attempt that committed and then failed writes nothing new", async () => {
    const { model } = scripted([
      // Unsure (0.5): the owner is asked on a card after the facts are written.
      [
        fact("Owner may move the office to Sylhet", "we move the office to Sylhet", {
          confidence: 0.5,
        }),
      ],
      [fact("The office is moving to Sylhet", "move the office to Sylhet", { confidence: 0.5 })],
    ]);
    let cards = 0;
    const { services, live, job, store } = setup({
      model,
      // The first attempt dies after its facts are in (a timeout, a restart): here, on the card.
      postCard: async () => {
        cards += 1;
        if (cards === 1) throw new Error("timeout");
        return "card-2";
      },
    });
    const messages = [owner("m1", "Next year we move the office to Sylhet")];
    await job("run-1");
    await expect(learnFromMessages(services, input("run-1", messages))).rejects.toThrow("timeout");
    expect(store.facts.size).toBe(1);

    const retry = await learnFromMessages(services, input("run-1", messages));
    expect(retry.alreadyWritten).toBe(true);
    expect(store.facts.size).toBe(1);
    expect(live()).toHaveLength(1);
  });

  it("a retry with the model does not repeat what the fallback of a failed attempt saved", async () => {
    // Attempt 1: the model call fails (429, timeout), the cue reader saves the "remember" line.
    // Attempt 2: the model answers and words the same sentence its own way.
    const { model } = scripted([
      undefined,
      [
        fact(
          "Owner wants invoices sent to the billing address of Acme",
          "invoices go to the billing address of Acme",
          {
            subject: "work.acme-invoices",
          },
        ),
        fact("Owner's accountant is Rahim", "my accountant is Rahim", { area: "people" }),
      ],
    ]);
    const { services, live, job } = setup({ model });
    const messages = [
      owner(
        "m1",
        "Remember that invoices go to the billing address of Acme. Also my accountant is Rahim.",
      ),
    ];
    await job("run-1");
    const first = await learnFromMessages(services, input("run-1", messages));
    expect(first.usedModel).toBe(false);
    expect(first.saved).toHaveLength(1);

    const retry = await learnFromMessages(services, input("run-1", messages));
    // Not "already written": the fallback leaves the job open so the model's reading lands.
    expect(retry.alreadyWritten).toBe(false);
    expect(retry.saved.map((item) => item.text)).toEqual(["Owner's accountant is Rahim"]);
    expect(retry.reinforced).toHaveLength(1);
    expect(live()).toHaveLength(2);
    // The repeat is the same message: no second mention, no promotion.
    expect(live()[0]?.mentions).toBe(1);

    // And a third pass over the job (a duplicate delivery) writes nothing at all.
    const third = await learnFromMessages(services, input("run-1", messages));
    expect(third.alreadyWritten).toBe(true);
    expect(live()).toHaveLength(2);
  });

  it("two near-identical facts from different runs end as one live fact", async () => {
    const vectors: Record<string, number[]> = {
      "Agents must hand work to other agents": unit(0),
      // cosine 0.98 to the first: the same lesson under another slug and in other words.
      "Owner expects every agent to delegate tasks across the team": unit(0.2),
    };
    const embedder: Embedder = { embed: async (text) => vectors[text] };
    const { model } = scripted([
      [
        fact("Agents must hand work to other agents", "agents must hand work to other agents", {
          area: "lessons",
          subject: "lesson.agents-must-delegate",
        }),
      ],
      [
        fact(
          "Owner expects every agent to delegate tasks across the team",
          "every agent should delegate tasks across the team",
          { area: "lessons", subject: "lesson.task-delegation" },
        ),
      ],
    ]);
    const { services, live, job, store } = setup({ model, embedder });
    await job("run-1");
    await job("run-2");
    await learnFromMessages(
      services,
      input("run-1", [owner("m1", "Listen: agents must hand work to other agents.")]),
    );
    const second = await learnFromMessages(
      services,
      input("run-2", [owner("m2", "Again, every agent should delegate tasks across the team.")]),
    );
    expect(store.facts.size).toBe(2);
    expect(live().map((item) => item.text)).toEqual([
      "Owner expects every agent to delegate tasks across the team",
    ]);
    // Retired the ledger's own way: superseded, closed, and linked from the fact that stands.
    expect(second.superseded.map((item) => [item.status, item.validTo !== null])).toEqual([
      ["superseded", true],
    ]);
    expect(
      [...store.links.values()].map((link) => [link.fromId, link.toId, link.kind]),
    ).toContainEqual(["fact-2", "fact-1", "supersedes"]);
  });

  it("a near fact with the same words adds evidence instead of a copy; one with another date stays", async () => {
    const vectors: Record<string, number[]> = {
      "Owner wants reports as PDF": unit(0),
      "Owner wants every report as a PDF": unit(0.2),
      // Far from the two above, and all but identical to each other.
      "Owner meets Acme on 2026-12-01": unit(3),
      "Owner meets Acme on 2026-12-08": unit(3.05),
    };
    const embedder: Embedder = { embed: async (text) => vectors[text] };
    const { model } = scripted([
      [fact("Owner wants reports as PDF", "send me reports as PDF", { area: "preferences" })],
      [
        fact("Owner wants every report as a PDF", "every report as a PDF", {
          area: "preferences",
          subject: "pref.report-format",
        }),
      ],
      [fact("Owner meets Acme on 2026-12-01", "I meet Acme on 1 December")],
      [fact("Owner meets Acme on 2026-12-08", "I meet Acme again on 8 December")],
    ]);
    const { services, live } = setup({ model, embedder });
    const once = (id: string, text: string) =>
      learnFromMessages(services, input(id, [owner(id, text)], { writeOnce: false }));
    await once("m1", "Please send me reports as PDF");
    const again = await once("m2", "I want every report as a PDF file");
    expect(again.saved).toHaveLength(0);
    expect(again.reinforced.map((item) => [item.text, item.mentions, item.status])).toEqual([
      ["Owner wants reports as PDF", 2, "confirmed"],
    ]);
    await once("m3", "I meet Acme on 1 December");
    await once("m4", "I meet Acme again on 8 December");
    expect(live().map((item) => item.text)).toEqual([
      "Owner wants reports as PDF",
      "Owner meets Acme on 2026-12-01",
      "Owner meets Acme on 2026-12-08",
    ]);
  });

  it("two jobs that read the same words at the same moment write the fact once", async () => {
    const same = () => [
      fact("Owner's agency is called Northwind", "my agency is called Northwind", {
        subject: "work.agency-name",
      }),
    ];
    const { model } = scripted([same(), same(), same()], 5);
    // A slow embedding call used to sit between a job's duplicate check and its insert.
    const embedder: Embedder = {
      embed: async () => {
        await new Promise((resolve) => setTimeout(resolve, 3));
        return undefined;
      },
    };
    const { services, live, job, store } = setup({ model, embedder });
    const messages = [owner("m1", "my agency is called Northwind")];
    await Promise.all(["run-1", "run-2", "run-3"].map(job));
    const results = await Promise.all(
      ["run-1", "run-2", "run-3"].map((runId) =>
        learnFromMessages(services, input(runId, messages)),
      ),
    );
    expect(results.map((result) => result.saved.length).sort()).toEqual([0, 0, 1]);
    expect(store.facts.size).toBe(1);
    expect(live()).toHaveLength(1);
  });

  it("a failed write leaves nothing behind, and the job can write on the next attempt", async () => {
    const { model } = scripted([
      [fact("Owner's agency is called Northwind", "my agency is called Northwind")],
      [fact("Owner's agency is called Northwind", "my agency is called Northwind")],
    ]);
    const { services, live, job, store } = setup({ model });
    const messages = [owner("m1", "my agency is called Northwind")];
    await job("run-1");
    const insert = store.insertFactOnce;
    store.insertFactOnce = async (...args) => {
      await insert(...args);
      throw new Error("connection lost");
    };
    await expect(learnFromMessages(services, input("run-1", messages))).rejects.toThrow(
      "connection lost",
    );
    expect(store.facts.size).toBe(0);
    store.insertFactOnce = insert;
    const retry = await learnFromMessages(services, input("run-1", messages));
    expect(retry.alreadyWritten).toBe(false);
    expect(live()).toHaveLength(1);
  });
});

describe("a job caught up later", () => {
  // The owner's messages of one thread; runs finished at the times in `until`.
  const rows = Array.from({ length: 40 }, (_, index) => ({
    id: `m${index + 1}`,
    seq: (index + 1) * 2,
    createdAt: new Date(Date.parse("2026-11-26T07:00:00Z") + index * 10 * 60_000),
    blocks: [{ kind: "text", text: `message ${index + 1}` }],
  }));
  type Where = { id?: string; createdAt?: { lte: Date } };
  const prisma = {
    message: {
      findFirst: async ({ where }: { where: Where }) =>
        rows.find((row) => row.id === where.id) ?? null,
      findMany: async ({ where, take }: { where: Where; take: number }) =>
        rows
          .filter((row) => !where.createdAt || row.createdAt <= where.createdAt.lte)
          .sort((a, b) => b.seq - a.seq)
          .slice(0, take),
    },
  } as never;

  it("reads its own run's messages, not the newest ones of the thread", async () => {
    // Run on message 5 finished one minute after it; its job is caught up hours later.
    const until = new Date(rows[4]!.createdAt.getTime() + 60_000);
    const late = await loadOwnerMessages(prisma, {
      threadId: "t",
      userId: "u",
      sourceMessageId: "m5",
      until,
    });
    expect(late.filter((message) => message.current).map((message) => message.id)).toEqual(["m5"]);
    expect(late.filter((message) => !message.current).map((message) => message.id)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
    ]);

    // Without the bound (the old behaviour) the job read the 24 newest messages as its own and
    // never saw message 5 at all.
    const unbounded = await loadOwnerMessages(prisma, {
      threadId: "t",
      userId: "u",
      sourceMessageId: "m5",
    });
    expect(unbounded.filter((message) => message.current)).toHaveLength(24);
    expect(unbounded.map((message) => message.id)).not.toContain("m5");
  });

  it("is offered again after a longer wait each time, and no more after the last attempt", async () => {
    const { store, job } = setup();
    await job("run-1");
    await store.finishJob(SPACE, "run-1", "failed", "memory model gave no usable answer");
    const offered = async () => (await store.staleJobs(SPACE, 10 * 60_000, 5)).map((j) => j.runId);
    // One failure is not the end of a job: it comes back after the wait.
    expect(await offered()).toEqual([]);
    store.advance(10 * 60_000);
    expect(await offered()).toEqual(["run-1"]);
    expect((await store.staleJobs(SPACE, 10 * 60_000, 5))[0]?.createdAt).toBeInstanceOf(Date);

    await store.startJob(SPACE, "run-1");
    await store.finishJob(SPACE, "run-1", "failed", "again");
    store.advance(10 * 60_000);
    expect(await offered()).toEqual([]);
    store.advance(10 * 60_000);
    expect(await offered()).toEqual(["run-1"]);

    for (let attempt = 2; attempt < MAX_JOB_ATTEMPTS; attempt += 1) {
      await store.startJob(SPACE, "run-1");
      await store.finishJob(SPACE, "run-1", "failed", "again");
    }
    store.advance(24 * 60 * 60_000);
    expect(await offered()).toEqual([]);
  });
});
