import { randomUUID } from "node:crypto";
import {
  asSystem,
  createDb,
  createThreadMessageInTransaction,
  retireWaitingQuestionInTransaction,
  runAsTenant,
  storedMessageBlocks,
} from "@rakazo/db";
import { afterEach, describe, expect, it } from "vitest";
import { returnStoppedBotMessageOutcomes } from "./bot-message-stopped.js";
import { botMessageStoppedText } from "./bot-message-stopped.prompt.js";
import { messageBot } from "./bot-messages.js";

const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe
    : describe.skip;

const previous = process.env.BOT_MESSAGE_STOP_NOTICE;
afterEach(() => {
  if (previous === undefined) delete process.env.BOT_MESSAGE_STOP_NOTICE;
  else process.env.BOT_MESSAGE_STOP_NOTICE = previous;
});

/**
 * Fork (1.39), the live case of 2026-11-27: agent A asked agent B for something; B stopped to
 * ask the user a question; hours later the user typed something else in B's chat, which retired
 * B's waiting run. A had been told "paused until the user responds" and never heard again.
 */
describePostgres("a delegated request that was stopped answers its requester (fork)", () => {
  it("returns a stopped notice once, retries a failed delivery, and stays silent for old or replaced runs", async () => {
    const db = createDb(runtimeUrl!);
    const fixtures = asSystem(db.prisma);
    const organizationId = randomUUID();
    const userId = randomUUID();
    try {
      await fixtures.user.create({
        data: { id: userId, name: "Owner", email: `${userId}@rakazo.test` },
      });
      await fixtures.organization.create({
        data: { id: organizationId, slug: organizationId, name: "Stopped", createdAt: new Date() },
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
      const bThread = await fixtures.thread.create({
        data: { spaceId: space.id, botId: b.id, userId },
      });
      const deps = {
        prisma: db.prisma,
        events: { notify: async () => undefined },
        jobs: { enqueue: async () => undefined },
      };
      const reported: string[] = [];
      const reconcile = (now = new Date()) =>
        returnStoppedBotMessageOutcomes(deps as never, {
          now,
          batchSize: 10,
          report: (label) => reported.push(label),
        });
      const statusTextsInA = async () => {
        const rows = await db.prisma.message.findMany({
          where: { threadId: aThread.id },
          orderBy: { seq: "asc" },
          select: { id: true, blocks: true },
        });
        return rows.map((row) =>
          storedMessageBlocks(row)
            .map((block) => ("text" in block ? String(block.text) : ""))
            .join(" "),
        );
      };

      await runAsTenant({ spaceId: space.id, userId }, async () => {
        const ask = async (text: string) => {
          const sender = await db.prisma.$transaction(async (tx) => {
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
          const sent = await messageBot(
            deps as never,
            sender,
            { id: a.id, name: "A" },
            { bot_id: b.id, message: `${text}: please prepare it.` },
          );
          expect(sent.ok).toBe(true);
          return db.prisma.run.findFirstOrThrow({
            where: { botId: b.id, trigger: "bot_message" },
            orderBy: { createdAt: "desc" },
          });
        };
        /** B stops on a question, then the user types something else in B's chat. */
        const waitThenRetire = async (runId: string) => {
          await db.prisma.run.update({
            where: { id: runId },
            data: { status: "waiting_input", startedAt: new Date() },
          });
          const retired = await db.prisma.$transaction(async (tx) => {
            await createThreadMessageInTransaction(tx, {
              threadId: bThread.id,
              role: "bot",
              runId,
              blocks: [{ kind: "ask", text: "Which file do you mean?" }],
            } as never);
            const typed = await createThreadMessageInTransaction(tx, {
              threadId: bThread.id,
              role: "user",
              blocks: [{ kind: "text", text: "are you working or stopped?" }],
            });
            return retireWaitingQuestionInTransaction(tx, {
              spaceId: space.id,
              threadId: bThread.id,
              botId: b.id,
              runId,
              answer: "are you working or stopped?",
              answerMessageId: typed.id,
            });
          });
          expect(retired).toBe(true);
        };

        // 1. The live case.
        const first = await ask("Report one");
        await waitThenRetire(first.id);
        const retiredRun = await db.prisma.run.findUniqueOrThrow({ where: { id: first.id } });
        expect(retiredRun).toMatchObject({
          status: "cancelled",
          error: null,
          botOutcomeReturnedAt: null,
        });
        const before = (await statusTextsInA()).length;

        // With the switch off nothing goes back (the old behaviour: the requester hears nothing).
        process.env.BOT_MESSAGE_STOP_NOTICE = "0";
        expect(await reconcile()).toBe(0);
        expect((await statusTextsInA()).length).toBe(before);
        delete process.env.BOT_MESSAGE_STOP_NOTICE;

        // A delivery that fails is kept for the next pass, not lost.
        const broken = {
          ...deps,
          events: {
            notify: async () => {
              throw new Error("realtime down");
            },
          },
          prisma: new Proxy(db.prisma, {
            get(target, key, receiver) {
              if (key === "$transaction") return () => Promise.reject(new Error("database busy"));
              return Reflect.get(target, key, receiver);
            },
          }),
        };
        expect(
          await returnStoppedBotMessageOutcomes(broken as never, {
            now: new Date(),
            batchSize: 10,
            report: (label) => reported.push(label),
          }),
        ).toBe(0);
        expect(reported).toContain("stopped bot message outcome");
        expect(
          (await db.prisma.run.findUniqueOrThrow({ where: { id: first.id } })).botOutcomeReturnedAt,
        ).toBeNull();

        expect(await reconcile()).toBe(1);
        const after = await statusTextsInA();
        expect(after.length).toBe(before + 1);
        expect(after.at(-1)).toContain(botMessageStoppedText(first.id));
        expect(
          (await db.prisma.run.findUniqueOrThrow({ where: { id: first.id } })).botOutcomeReturnedAt,
        ).not.toBeNull();
        // A's chat got a run to read it.
        expect(await db.prisma.run.count({ where: { botId: a.id, trigger: "bot_message" } })).toBe(
          1,
        );
        // Once: the next pass finds nothing.
        expect(await reconcile()).toBe(0);
        expect((await statusTextsInA()).length).toBe(before + 1);

        // 2. A stop from long ago is history, not news.
        const old = await ask("Report two");
        await db.prisma.run.update({
          where: { id: old.id },
          data: { status: "cancelled", completedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
        });
        expect(await reconcile()).toBe(0);

        // 3. A request its sender replaced is already settled and stays silent.
        const replaced = await ask("Report three");
        await db.prisma.run.update({
          where: { id: replaced.id },
          data: { status: "cancelled", completedAt: new Date(), botOutcomeReturnedAt: new Date() },
        });
        expect(await reconcile()).toBe(0);

        // 4. A plain Stop by the user is told the same way.
        const stopped = await ask("Report four");
        await db.prisma.run.update({
          where: { id: stopped.id },
          data: { status: "cancelled", completedAt: new Date() },
        });
        expect(await reconcile()).toBe(1);
        // A second notice to the same requester is its own message, not a repeat of the first.
        expect((await statusTextsInA()).at(-1)).toContain(botMessageStoppedText(stopped.id));
      });
    } finally {
      await fixtures.space.deleteMany({ where: { organizationId } }).catch(() => undefined);
      await fixtures.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
      await fixtures.user.delete({ where: { id: userId } }).catch(() => undefined);
      await db.prisma.$disconnect();
    }
  }, 90_000);
});
