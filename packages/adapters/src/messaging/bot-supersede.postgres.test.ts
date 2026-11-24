import { randomUUID } from "node:crypto";
import {
  asSystem,
  createDb,
  createThreadMessageInTransaction,
  runAsTenant,
  storedMessageBlocks,
} from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { admissionBlock } from "../runs/lifecycle/run-gate.js";
import { messageBot } from "./bot-messages.js";

const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe
    : describe.skip;

/**
 * Fork regression (2026-11-25): a correction sent to a busy agent queued behind the wrong request
 * it corrected. With `replaces`, the earlier request is stopped (or cancelled) in the same commit and
 * the correction is free to start at once.
 */
describePostgres("message_bot replaces an earlier request (fork)", () => {
  it("stops the running request and the correction is not held behind it", async () => {
    const db = createDb(runtimeUrl!);
    const fixtures = asSystem(db.prisma);
    const organizationId = randomUUID();
    const userId = randomUUID();
    try {
      await fixtures.user.create({
        data: { id: userId, name: "Owner", email: `${userId}@rakazo.test` },
      });
      await fixtures.organization.create({
        data: {
          id: organizationId,
          slug: organizationId,
          name: "Supersede",
          createdAt: new Date(),
        },
      });
      const space = await fixtures.space.create({
        data: { id: randomUUID(), organizationId, name: "S" },
      });
      const a = await fixtures.bot.create({
        data: { spaceId: space.id, userId, name: "A", color: "gray" },
      });
      const b = await fixtures.bot.create({
        data: { spaceId: space.id, userId, name: "B", color: "gray" },
      });
      const aThread = await fixtures.thread.create({
        data: { spaceId: space.id, botId: a.id, userId },
      });
      await fixtures.thread.create({ data: { spaceId: space.id, botId: b.id, userId } });
      const deps = {
        prisma: db.prisma,
        events: { notify: async () => undefined },
        jobs: { enqueue: async () => undefined },
      };
      await runAsTenant({ spaceId: space.id, userId }, async () => {
        const senderRun = async (text: string) =>
          db.prisma.$transaction(async (tx) => {
            const message = await createThreadMessageInTransaction(tx, {
              threadId: aThread.id,
              role: "user",
              blocks: [{ kind: "text", text }],
            });
            const task = await tx.task.create({
              data: {
                spaceId: space.id,
                botId: a.id,
                threadId: aThread.id,
                userId,
                prompt: text,
                status: "running",
              },
            });
            const run = await tx.run.create({
              data: {
                spaceId: space.id,
                botId: a.id,
                threadId: aThread.id,
                taskId: task.id,
                userId,
                status: "running",
                trigger: "user",
                sourceMessageId: message.id,
                startedAt: new Date(),
              },
            });
            return {
              id: run.id,
              spaceId: space.id,
              threadId: aThread.id,
              botId: a.id,
              userId,
              sourceMessageId: message.id,
            };
          });
        const first = await messageBot(
          deps as never,
          await senderRun("ask B"),
          { id: a.id, name: "A" },
          {
            bot_id: b.id,
            message: "Search the web for the Dan Martell video and download its subtitles.",
          },
        );
        expect(first.ok).toBe(true);
        const oldRun = await db.prisma.run.findFirstOrThrow({
          where: { botId: b.id, trigger: "bot_message" },
          orderBy: { createdAt: "asc" },
        });
        await db.prisma.run.update({
          where: { id: oldRun.id },
          data: {
            status: "running",
            startedAt: new Date(),
            leaseExpiresAt: new Date(Date.now() + 60_000),
          },
        });
        const fixed = await messageBot(
          deps as never,
          await senderRun("no, the history tab"),
          { id: a.id, name: "A" },
          {
            bot_id: b.id,
            message: "Correction: open his YouTube history tab and take the link from there.",
            replaces: "latest",
          } as never,
        );
        expect(fixed.ok).toBe(true);
        expect((await db.prisma.run.findUniqueOrThrow({ where: { id: oldRun.id } })).status).toBe(
          "cancelled",
        );
        const runs = await db.prisma.run.findMany({
          where: { botId: b.id, trigger: "bot_message" },
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            botId: true,
            threadId: true,
            trigger: true,
            lane: true,
            createdAt: true,
            status: true,
            sourceMessageId: true,
          },
        });
        const correction = runs.at(-1)!;
        expect(correction.id).not.toBe(oldRun.id);
        const active = runs.filter((r) => r.status === "running" || r.status === "leased");
        const queued = runs.filter((r) => r.status === "queued");
        expect(admissionBlock(correction, 1, active, queued)).toBeUndefined();
        const inbound = await db.prisma.message.findUniqueOrThrow({
          where: { id: correction.sourceMessageId! },
          select: { id: true, blocks: true },
        });
        const text = storedMessageBlocks(inbound)
          .map((block) => ("text" in block ? String(block.text) : ""))
          .join(" ");
        expect(text).toContain("This replaces my earlier request");
      });
    } finally {
      await fixtures.space.deleteMany({ where: { organizationId } }).catch(() => undefined);
      await fixtures.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
      await fixtures.user.delete({ where: { id: userId } }).catch(() => undefined);
      await db.prisma.$disconnect();
    }
  }, 60_000);
});
