import { randomUUID } from "node:crypto";
import { createDb, createThreadMessage, runAsSystem, runAsTenant } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import type { MemoryModel } from "./model.js";
import { assemblePack } from "./pack.js";
import { loadOwnerMessages } from "./seams.js";
import { createSqlLedgerStore } from "./store.js";
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
});
