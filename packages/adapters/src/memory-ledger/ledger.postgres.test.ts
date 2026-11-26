import { randomUUID } from "node:crypto";
import { createDb, createThreadMessage, runAsSystem, runAsTenant } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import type { MemoryModel } from "./model.js";
import { assemblePack } from "./pack.js";
import { loadOwnerMessages } from "./seams.js";
import { createSqlLedgerStore, MAX_JOB_ATTEMPTS } from "./store.js";
import type { FactCandidate, NewFact } from "./types.js";
import { learnFromMessages } from "./writer.js";

const postgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

const axis = (index: number) => {
  const vector = new Array(1024).fill(0);
  vector[index] = 1;
  return vector;
};

postgres("memory ledger (PostgreSQL)", () => {
  it("stores, searches, links, isolates by space and survives bot deletion", async () => {
    const { prisma, pool } = createDb(process.env.DATABASE_URL!);
    const id = `ledger-${randomUUID()}`;
    const userId = `${id}-user`;
    const otherUserId = `${id}-other`;
    const spaceId = `${id}-space`;
    const otherSpaceId = `${id}-space2`;
    const organizationId = `${id}-org`;
    const fixture = <T>(fn: () => Promise<T>) => runAsSystem("test fixture", fn);
    try {
      const { bot, threadId } = await fixture(async () => {
        await prisma.user.create({
          data: { id: userId, name: "Owner", email: `${id}@rakazo.test` },
        });
        await prisma.user.create({
          data: { id: otherUserId, name: "Other", email: `${id}-2@rakazo.test` },
        });
        await prisma.organization.create({
          data: { id: organizationId, name: "Ledger tests", slug: id, createdAt: new Date() },
        });
        await prisma.space.create({ data: { id: spaceId, organizationId, name: "A" } });
        await prisma.space.create({ data: { id: otherSpaceId, organizationId, name: "B" } });
        const bot = await prisma.bot.create({
          data: {
            spaceId,
            userId,
            name: "Umar",
            color: "ink",
            thread: { create: { spaceId, userId } },
          },
          include: { thread: true },
        });
        return { bot, threadId: bot.thread!.id };
      });

      const tenant = <T>(fn: () => Promise<T>) => runAsTenant({ spaceId, userId }, fn);
      const store = createSqlLedgerStore(prisma);
      const base = (text: string, extra: Partial<NewFact> = {}): NewFact => ({
        spaceId,
        area: "about",
        subject: null,
        text,
        quote: text,
        origin: "stated",
        status: "confirmed",
        confidence: 0.9,
        mentions: 1,
        sourceMessageIds: ["m1"],
        entities: [],
        sourceThreadId: threadId,
        sourceRunId: null,
        writtenByBotId: bot.id,
        writtenByBotName: bot.name,
        userId,
        validFrom: new Date(),
        validTo: null,
        supersedesId: null,
        ...extra,
      });

      // Insert, full-text (stemmed) and vector search, core block.
      const [home, invoices, pdf] = await tenant(async () => [
        await store.insertFact(
          base("Owner lives in Dhaka", { subject: "owner.home-city" }),
          axis(1),
        ),
        await store.insertFact(
          base("Acme invoices are due on the 5th", { area: "work", status: "tentative" }),
          axis(2),
        ),
        await store.insertFact(base("Owner wants reports as PDF", { area: "preferences" })),
      ]);
      expect(home!.writtenByBotId).toBe(bot.id);
      expect(
        await tenant(() => store.searchText(spaceId, "when is the Acme invoice due", 5)),
      ).toEqual([invoices!.id]);
      expect(
        (await tenant(() => store.searchVector(spaceId, axis(1), 2))).map((hit) => hit.id),
      ).toEqual([home!.id, invoices!.id]);
      expect((await tenant(() => store.coreFacts(spaceId, 10))).map((fact) => fact.id)).toEqual([
        home!.id,
        pdf!.id,
      ]);
      expect(
        (await tenant(() => store.findLive(spaceId, { subjects: ["owner.home-city"] }))).map(
          (f) => f.id,
        ),
      ).toEqual([home!.id]);

      // Update, links (idempotent), missing embeddings.
      await tenant(async () => {
        await store.updateFact(spaceId, invoices!.id, {
          status: "confirmed",
          mentions: 2,
          sourceMessageIds: ["m1", "m2"],
        });
        const first = await store.addLink({
          spaceId,
          fromId: invoices!.id,
          toId: home!.id,
          kind: "related",
          score: 0.7,
        });
        const again = await store.addLink({
          spaceId,
          fromId: invoices!.id,
          toId: home!.id,
          kind: "related",
        });
        expect(again?.id).toBe(first?.id);
        expect(again?.score).toBeCloseTo(0.7);
      });
      const [updated] = await tenant(() => store.getFacts(spaceId, [invoices!.id]));
      expect(updated).toMatchObject({
        status: "confirmed",
        mentions: 2,
        sourceMessageIds: ["m1", "m2"],
      });
      expect((await tenant(() => store.linksOf(spaceId, [home!.id]))).length).toBe(1);
      expect((await tenant(() => store.missingEmbeddings(spaceId, 5))).map((f) => f.id)).toEqual([
        pdf!.id,
      ]);

      // The pack on Postgres: hybrid search inside the budget.
      const pack = await tenant(() =>
        assemblePack(
          { store, embedder: { embed: async () => axis(2) } },
          {
            spaceId,
            query: "Acme invoice",
            limit: 5,
            budgetMs: 2_000,
            coreMaxBytes: 6144,
            packMaxBytes: 4096,
          },
        ),
      );
      expect(pack.search).toBe("hybrid");
      expect(pack.text).toContain("Acme invoices are due on the 5th");

      // Row-level security: another space's tenant sees nothing and cannot write.
      const foreign = await runAsTenant({ spaceId: otherSpaceId, userId: otherUserId }, () =>
        store.getFacts(spaceId, [home!.id]),
      );
      expect(foreign).toEqual([]);
      await expect(
        runAsTenant({ spaceId: otherSpaceId, userId: otherUserId }, () =>
          store.insertFact(base("Planted fact")),
        ),
      ).rejects.toThrow();

      // Jobs: claimed once, started once, finished.
      await tenant(async () => {
        const job = { runId: `${id}-run`, spaceId, threadId, botId: bot.id, userId };
        expect(await store.claimJob(job)).toBe(true);
        expect(await store.claimJob(job)).toBe(false);
        expect(await store.startJob(spaceId, job.runId)).toBe(true);
        expect(await store.startJob(spaceId, job.runId)).toBe(false);
        await store.finishJob(spaceId, job.runId, "failed", "boom");
        expect((await store.staleJobs(spaceId, 0, 5)).map((row) => row.runId)).toEqual([job.runId]);
        await store.finishJob(spaceId, job.runId, "done");
        expect(await store.staleJobs(spaceId, 0, 5)).toEqual([]);
      });

      // The writer end to end: owner messages only, card posted as a bot message, answer read.
      const sent = await fixture(async () => {
        const first = await createThreadMessage(prisma, {
          threadId,
          role: "user",
          authorUserId: userId,
          blocks: [{ kind: "text", text: "I live in Berlin now" }],
        });
        await createThreadMessage(prisma, {
          threadId,
          role: "bot",
          botId: bot.id,
          blocks: [{ kind: "text", text: "Noted. Also, I live in Paris (bot text)." }],
        });
        await createThreadMessage(prisma, {
          threadId,
          role: "user",
          blocks: [{ kind: "delivery" }, { kind: "text", text: "Webhook: my bank is Evil Bank" }],
        });
        return first;
      });
      const messages = await tenant(() =>
        loadOwnerMessages(prisma, { threadId, userId, sourceMessageId: sent.id }),
      );
      expect(messages.map((message) => message.text)).toEqual(["I live in Berlin now"]);

      const proposals: FactCandidate[][] = [
        [
          {
            area: "about",
            subject: "owner.home-city",
            text: "Owner lives in Berlin",
            quote: "I live in Berlin now",
            message: 1,
            origin: "stated",
            confidence: 0.85,
            entities: ["Berlin"],
          },
          {
            area: "about",
            subject: "owner.bank",
            text: "Owner banks with Evil Bank",
            quote: "my bank is Evil Bank",
            origin: "stated",
            confidence: 0.9,
            entities: [],
          },
        ],
        [],
      ];
      const model: MemoryModel = { extract: async () => proposals.shift() };
      const posted: string[] = [];
      const postCard = async (card: { threadId: string; botId: string | null; text: string }) => {
        const message = await createThreadMessage(prisma, {
          threadId: card.threadId,
          role: "bot",
          botId: card.botId ?? undefined,
          blocks: [{ kind: "text", text: card.text }],
          clientNonce: `memory-ledger:${id}`,
        });
        posted.push(card.text);
        return message.id;
      };
      const learned = await tenant(() =>
        learnFromMessages(
          { store, model, config: { model: {} as never }, postCard },
          { spaceId, userId, threadId, botId: bot.id, botName: bot.name, messages },
        ),
      );
      expect(learned.rejected.quote).toBe(1);
      expect(learned.disputed.map((fact) => fact.text)).toContain("Owner lives in Dhaka");
      expect(posted).toHaveLength(1);

      const reply = await fixture(() =>
        createThreadMessage(prisma, {
          threadId,
          role: "user",
          authorUserId: userId,
          blocks: [{ kind: "text", text: "new" }],
        }),
      );
      const replies = await tenant(() =>
        loadOwnerMessages(prisma, { threadId, userId, sourceMessageId: reply.id }),
      );
      const answered = await tenant(() =>
        learnFromMessages(
          { store, model, config: { model: {} as never }, postCard },
          { spaceId, userId, threadId, botId: bot.id, botName: bot.name, messages: replies },
        ),
      );
      expect(answered.resolved).toBe(1);
      const [oldHome] = await tenant(() => store.getFacts(spaceId, [home!.id]));
      expect(oldHome?.status).toBe("superseded");

      // An older fact is still found by its own words when more than LIMIT newer facts share
      // common words with it (live 2026-11-25: remove of an older fact said "no entry matches").
      const older = await tenant(() =>
        store.insertFact(
          base("On Jumma the owner wants the assistant to call him 1 hour before jamat", {
            area: "preferences",
          }),
        ),
      );
      const retiredOld = await tenant(() =>
        store.insertFact(
          base("The owner wants the assistant to ring the bell before maghrib", {
            area: "preferences",
            status: "retracted",
          }),
        ),
      );
      await tenant(async () => {
        for (let n = 0; n < 25; n++) {
          await store.insertFact(
            base(`The owner wants the assistant to handle chore number ${n}`, {
              area: "preferences",
            }),
          );
          await store.insertFact(
            base(`The owner wants the assistant to skip errand number ${n}`, {
              area: "preferences",
              status: "retracted",
            }),
          );
        }
      });
      const liveHits = await tenant(() => store.findLive(spaceId, { texts: [older!.text] }, 20));
      expect(liveHits[0]?.id).toBe(older!.id);
      const retiredHits = await tenant(() => store.findRetired(spaceId, retiredOld!.text, 20));
      expect(retiredHits[0]?.id).toBe(retiredOld!.id);

      // Deleting the bot keeps the space's facts and clears only the attribution.
      await fixture(() => prisma.bot.delete({ where: { id: bot.id } }));
      const [kept] = await tenant(() => store.getFacts(spaceId, [pdf!.id]));
      expect(kept).toMatchObject({
        text: "Owner wants reports as PDF",
        writtenByBotId: null,
        writtenByBotName: "Umar",
      });
    } finally {
      await fixture(async () => {
        await prisma.space.deleteMany({ where: { id: { in: [spaceId, otherSpaceId] } } });
        await prisma.organization.deleteMany({ where: { id: organizationId } });
        await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
      }).catch(() => undefined);
      await prisma.$disconnect();
      await pool.end();
    }
  }, 60_000);

  it("writes a fact once: one live fact per text, one write stage per job, all or nothing", async () => {
    const { prisma, pool } = createDb(process.env.DATABASE_URL!);
    const id = `ledger-once-${randomUUID()}`;
    const userId = `${id}-user`;
    const spaceId = `${id}-space`;
    const organizationId = `${id}-org`;
    const fixture = <T>(fn: () => Promise<T>) => runAsSystem("test fixture", fn);
    try {
      const threadId = await fixture(async () => {
        await prisma.user.create({
          data: { id: userId, name: "Owner", email: `${id}@rakazo.test` },
        });
        await prisma.organization.create({
          data: { id: organizationId, name: "Ledger once", slug: id, createdAt: new Date() },
        });
        await prisma.space.create({ data: { id: spaceId, organizationId, name: "A" } });
        const bot = await prisma.bot.create({
          data: {
            spaceId,
            userId,
            name: "Bot",
            color: "ink",
            thread: { create: { spaceId, userId } },
          },
          include: { thread: true },
        });
        return bot.thread!.id;
      });
      const tenant = <T>(fn: () => Promise<T>) => runAsTenant({ spaceId, userId }, fn);
      const store = createSqlLedgerStore(prisma);
      const base = (text: string, extra: Partial<NewFact> = {}): NewFact => ({
        spaceId,
        area: "work",
        subject: null,
        text,
        quote: text,
        origin: "stated",
        status: "tentative",
        confidence: 0.8,
        mentions: 1,
        sourceMessageIds: [],
        entities: [],
        sourceThreadId: threadId,
        sourceRunId: null,
        writtenByBotId: null,
        writtenByBotName: "Bot",
        userId,
        validFrom: new Date(),
        validTo: null,
        supersedesId: null,
        ...extra,
      });
      const live = () =>
        tenant(() => store.findLive(spaceId, { texts: ["agency Northwind Sylhet office"] }, 50));

      // The database refuses a second LIVE fact with the same words, whoever inserts it and
      // however the two inserts are timed; the copy's caller gets the fact that stands.
      const racers = await Promise.all(
        Array.from({ length: 6 }, () =>
          tenant(() => store.insertFactOnce(base("Owner's agency is called  Northwind."))),
        ),
      );
      expect(racers.filter((racer) => racer.inserted)).toHaveLength(1);
      expect(new Set(racers.map((racer) => racer.fact.id)).size).toBe(1);
      const again = await tenant(() =>
        store.insertFactOnce(base("owner's agency is called northwind")),
      );
      expect(again.inserted).toBe(false);
      // A retired fact does not block the words from being said again.
      await tenant(() =>
        store.updateFact(spaceId, again.fact.id, { status: "superseded", validTo: new Date() }),
      );
      const fresh = await tenant(() =>
        store.insertFactOnce(base("Owner's agency is called Northwind")),
      );
      expect(fresh.inserted).toBe(true);
      expect(fresh.fact.id).not.toBe(again.fact.id);

      // A job's write stage: claimed once, together with its facts.
      const jobOf = (runId: string) => ({ runId, spaceId, threadId, botId: null, userId });
      await tenant(() => store.claimJob(jobOf(`${id}-run1`)));
      expect(await tenant(() => store.startJob(spaceId, `${id}-run1`))).toBe(true);
      expect(await tenant(() => store.claimWrite(spaceId, `${id}-run1`, false))).toBe(true);
      await expect(
        tenant(() =>
          store.writeTransaction(spaceId, async (tx) => {
            expect(await tx.claimWrite(spaceId, `${id}-run1`, true)).toBe(true);
            await tx.insertFactOnce(base("The office moves to Sylhet"));
            throw new Error("connection lost");
          }),
        ),
      ).rejects.toThrow("connection lost");
      // Rolled back: no fact, and the job may still write.
      expect((await live()).map((fact) => fact.text)).toEqual([
        "Owner's agency is called Northwind",
      ]);
      expect(
        await tenant(() =>
          store.writeTransaction(spaceId, async (tx) => {
            const claimed = await tx.claimWrite(spaceId, `${id}-run1`, true);
            if (claimed) await tx.insertFactOnce(base("The office moves to Sylhet"));
            return claimed;
          }),
        ),
      ).toBe(true);
      expect(await tenant(() => store.claimWrite(spaceId, `${id}-run1`, true))).toBe(false);
      expect(await tenant(() => store.claimWrite(spaceId, `${id}-run1`, false))).toBe(false);

      // End to end through the writer: the same job twice, then three late jobs at once that
      // all read the same words (what the catch-up pass did after a deploy).
      const sentence = "we will open a second studio in Khulna";
      const reply = (text: string): FactCandidate[] => [
        { area: "work", text, quote: sentence, origin: "stated", confidence: 0.85, entities: [] },
      ];
      const answers = [
        reply("Owner will open a second studio in Khulna"),
        reply("A second studio of the owner opens in Khulna city"),
      ];
      const model: MemoryModel = {
        extract: async () => answers.shift() ?? reply("Owner will open a second studio in Khulna"),
      };
      const messages = [
        { id: `${id}-m1`, text: `By March ${sentence}.`, at: new Date(), current: true },
      ];
      const learn = (runId: string) =>
        tenant(() =>
          learnFromMessages(
            { store, model, config: { model: {} as never } },
            {
              spaceId,
              userId,
              threadId,
              runId,
              botId: null,
              botName: "Bot",
              messages,
              writeOnce: true,
            },
          ),
        );
      const first = await learn(`${id}-run1`);
      // run1's write stage was used above, so its job writes nothing more.
      expect(first.alreadyWritten).toBe(true);
      for (const run of ["run2", "run3", "run4", "run5"]) {
        await tenant(() => store.claimJob(jobOf(`${id}-${run}`)));
        await tenant(() => store.startJob(spaceId, `${id}-${run}`));
      }
      const one = await learn(`${id}-run2`);
      expect(one.saved).toHaveLength(1);
      const twice = await learn(`${id}-run2`);
      expect(twice.alreadyWritten).toBe(true);
      const late = await Promise.all(["run3", "run4", "run5"].map((run) => learn(`${id}-${run}`)));
      expect(late.flatMap((result) => result.saved)).toHaveLength(0);
      const studio = await tenant(() => store.findLive(spaceId, { texts: ["studio Khulna"] }, 50));
      expect(studio.map((fact) => fact.id)).toEqual([one.saved[0]?.id]);

      // A failed job comes back after a longer wait each time, with the time its run finished.
      await tenant(() => store.finishJob(spaceId, `${id}-run3`, "failed", "model"));
      expect(await tenant(() => store.staleJobs(spaceId, 60_000, 5))).toEqual([]);
      await fixture(() =>
        prisma.$executeRawUnsafe(
          `UPDATE "memory_ledger_jobs" SET "updatedAt" = CURRENT_TIMESTAMP - interval '90 seconds', "attempts" = 1 WHERE "runId" = $1`,
          `${id}-run3`,
        ),
      );
      const [stale] = await tenant(() => store.staleJobs(spaceId, 60_000, 5));
      expect(stale).toMatchObject({ runId: `${id}-run3`, attempts: 1 });
      expect(stale?.createdAt).toBeInstanceOf(Date);
      await fixture(() =>
        prisma.$executeRawUnsafe(
          `UPDATE "memory_ledger_jobs" SET "attempts" = 2 WHERE "runId" = $1`,
          `${id}-run3`,
        ),
      );
      // Second failure: 2 x 60 s must pass, 90 s is not enough.
      expect(await tenant(() => store.staleJobs(spaceId, 60_000, 5))).toEqual([]);
      await fixture(() =>
        prisma.$executeRawUnsafe(
          `UPDATE "memory_ledger_jobs" SET "attempts" = $2, "updatedAt" = CURRENT_TIMESTAMP - interval '1 day' WHERE "runId" = $1`,
          `${id}-run3`,
          MAX_JOB_ATTEMPTS,
        ),
      );
      expect(await tenant(() => store.staleJobs(spaceId, 60_000, 5))).toEqual([]);
    } finally {
      await fixture(async () => {
        await prisma.space.deleteMany({ where: { id: spaceId } });
        await prisma.organization.deleteMany({ where: { id: organizationId } });
        await prisma.user.deleteMany({ where: { id: userId } });
      }).catch(() => undefined);
      await prisma.$disconnect();
      await pool.end();
    }
  }, 60_000);
});
