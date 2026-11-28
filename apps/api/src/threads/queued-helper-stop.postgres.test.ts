import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { createDb, createThreadMessage, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cancelThreadRuns } from "./thread-stop.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

/** Fork (FORK.md 1.33, A2): Stop reaches the helpers that only waited for a slot. */
describePostgres("stopping a chat with queued helpers (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let db: ReturnType<typeof createDb>;
  const owners: string[] = [];

  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
  });

  afterAll(async () => {
    if (!db) return;
    await runAsSystem("test cleanup", async () => {
      await prisma.organization.deleteMany({ where: { id: { in: owners } } });
      await prisma.user.deleteMany({ where: { id: { in: owners } } });
    });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  async function chatWithQueuedHelpers(count: number) {
    const id = randomUUID();
    owners.push(id);
    return runAsSystem("test fixture", async () => {
      await prisma.user.create({
        data: { id, name: "Stop test", email: `${id}@example.test`, emailVerified: true },
      });
      await prisma.organization.create({
        data: { id, name: "Stop", slug: id, createdAt: new Date() },
      });
      await prisma.space.create({
        data: { id, organizationId: id, name: "Stop", isDefault: true },
      });
      await prisma.member.create({
        data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
      });
      const bot = await prisma.bot.create({
        data: { spaceId: id, userId: id, name: "Worker", color: "test-color" },
      });
      const thread = await prisma.thread.create({
        data: { spaceId: id, userId: id, botId: bot.id },
      });
      const cards: string[] = [];
      for (let n = 0; n < count; n++) {
        const card = await createThreadMessage(prisma, {
          threadId: thread.id,
          role: "bot",
          botId: bot.id,
          blocks: [
            {
              kind: "subagent",
              agentId: `call-${n}`,
              name: `part ${n}`,
              task: "t",
              status: "running",
              progress: "Queued",
            },
          ],
        });
        const helperThread = await prisma.thread.create({
          data: { spaceId: id, userId: id, helperBotId: bot.id },
        });
        const task = await prisma.task.create({
          data: {
            spaceId: id,
            userId: id,
            botId: bot.id,
            threadId: helperThread.id,
            prompt: "brief",
            status: "queued",
          },
        });
        await prisma.queuedHelper.create({
          data: {
            spaceId: id,
            botId: bot.id,
            threadId: thread.id,
            userId: id,
            originRunId: "origin",
            cardMessageId: card.id,
            clientNonce: `nonce-${n}`,
            helperThreadId: helperThread.id,
            taskId: task.id,
            sourceMessageIds: [],
          },
        });
        cards.push(card.id);
      }
      return { spaceId: id, botId: bot.id, threadId: thread.id, cards };
    });
  }

  const statuses = (botId: string) =>
    runAsSystem("read", async () =>
      (
        await prisma.queuedHelper.findMany({
          where: { botId },
          orderBy: { clientNonce: "asc" },
          select: { status: true },
        })
      ).map((row) => row.status),
    );
  async function cardOf(messageId: string) {
    const row = await runAsSystem("read", () =>
      prisma.message.findUniqueOrThrow({ where: { id: messageId }, select: { blocks: true } }),
    );
    return (row.blocks as Array<Record<string, unknown>>)[0]!;
  }

  it("Stop on one card cancels only that queued helper", async () => {
    const w = await chatWithQueuedHelpers(2);
    const stop = await runAsSystem("stop", () =>
      prisma.$transaction(
        cancelThreadRuns(
          { spaceId: w.spaceId },
          { kind: "bot", botId: w.botId, threadId: w.threadId },
          undefined,
          w.cards[1],
        ),
      ),
    );
    expect(stop.eventSeq).not.toBeNull();
    expect(await statuses(w.botId)).toEqual(["queued", "cancelled"]);
    expect(await cardOf(w.cards[1]!)).toMatchObject({
      status: "failed",
      result: "stopped",
      stopped: true,
    });
    expect(await cardOf(w.cards[0]!)).toMatchObject({ status: "running" });
  });

  it("Stop on the chat cancels every queued helper of it", async () => {
    const w = await chatWithQueuedHelpers(2);
    await runAsSystem("stop", () =>
      prisma.$transaction(
        cancelThreadRuns(
          { spaceId: w.spaceId },
          { kind: "bot", botId: w.botId, threadId: w.threadId },
        ),
      ),
    );
    expect(await statuses(w.botId)).toEqual(["cancelled", "cancelled"]);
    for (const card of w.cards)
      expect(await cardOf(card)).toMatchObject({
        status: "failed",
        result: "stopped",
        stopped: true,
      });
  });

  it("Stop on the chat stands the agent's open items down; Stop on one card does not", async () => {
    const w = await chatWithQueuedHelpers(1);
    await runAsSystem("item", () =>
      prisma.scratchpadItem.create({
        data: {
          spaceId: w.spaceId,
          botId: w.botId,
          userId: w.spaceId,
          title: "Write part three",
          threadId: w.threadId,
        },
      }),
    );
    const state = () =>
      runAsSystem("read", () =>
        prisma.openWorkState.findUnique({
          where: { threadId_botId: { threadId: w.threadId, botId: w.botId } },
        }),
      );
    const target = { kind: "bot", botId: w.botId, threadId: w.threadId } as const;
    await runAsSystem("stop", () =>
      prisma.$transaction(cancelThreadRuns({ spaceId: w.spaceId }, target, undefined, w.cards[0])),
    );
    expect(await state()).toBeNull();
    await runAsSystem("stop", () =>
      prisma.$transaction(cancelThreadRuns({ spaceId: w.spaceId }, target)),
    );
    expect(await state()).toMatchObject({ stalledReason: "stopped", openCount: 1 });
  });
});
