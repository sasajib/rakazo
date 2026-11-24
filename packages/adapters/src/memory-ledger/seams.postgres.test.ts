import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createDb, createThreadMessage, runAsSystem, runAsTenant } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import {
  recallViaLedger,
  rememberViaLedger,
  scheduleLedgerLearning,
  withLedgerMemory,
} from "./seams.js";
import { createSqlLedgerStore } from "./store.js";

const postgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

/** A stand-in OpenAI-compatible memory model: proposes one fact per quoted owner message. */
async function fakeModel(reply: (ownerText: string) => object) {
  const requests: Array<{ model: string; owner: string[] }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const parsed = JSON.parse(body) as { model: string; messages: Array<{ content: string }> };
      const payload = JSON.parse(parsed.messages[1]!.content) as {
        owner_messages: Array<{ text: string; current: boolean }>;
      };
      const owner = payload.owner_messages.filter((m) => m.current).map((m) => m.text);
      requests.push({ model: parsed.model, owner });
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(reply(owner.join("\n"))) } }],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1`, requests, close: () => server.close() };
}

postgres("memory ledger seams (PostgreSQL + fake model endpoint)", () => {
  it("learns after a run, answers the remember tool, recalls and injects the block", async () => {
    const { prisma, pool } = createDb(process.env.DATABASE_URL!);
    const id = `seams-${randomUUID()}`;
    const userId = `${id}-user`;
    const spaceId = `${id}-space`;
    const organizationId = `${id}-org`;
    const fixture = <T>(fn: () => Promise<T>) => runAsSystem("test fixture", fn);
    const model = await fakeModel((text) =>
      /accountant/.test(text)
        ? {
            facts: [
              {
                area: "people",
                subject: "person.rahim.role",
                text: "Rahim is the owner's accountant",
                quote: "Rahim is my accountant",
                m: 1,
                origin: "stated",
                confidence: 0.9,
                entities: ["Rahim"],
              },
            ],
          }
        : /PDF/.test(text)
          ? {
              facts: [
                {
                  area: "preferences",
                  subject: "pref.report-format",
                  text: "Owner wants reports as PDF",
                  quote: "remember I want reports as PDF",
                  origin: "stated",
                  confidence: 0.9,
                  entities: [],
                },
              ],
            }
          : { facts: [] },
    );
    const env = {
      MEMORY_LEDGER: "1",
      MEMORY_LEDGER_MODEL_URL: model.url,
      MEMORY_LEDGER_MODEL: "glm/glm-5.3-flash",
    };
    try {
      const { botId, threadId } = await fixture(async () => {
        await prisma.user.create({
          data: { id: userId, name: "Owner", email: `${id}@rakazo.test` },
        });
        await prisma.organization.create({
          data: { id: organizationId, name: "Seam tests", slug: id, createdAt: new Date() },
        });
        await prisma.space.create({ data: { id: spaceId, organizationId, name: "S" } });
        const bot = await prisma.bot.create({
          data: {
            spaceId,
            userId,
            name: "Madad",
            color: "ink",
            thread: { create: { spaceId, userId } },
          },
          include: { thread: true },
        });
        return { botId: bot.id, threadId: bot.thread!.id };
      });
      const say = (text: string) =>
        fixture(() =>
          createThreadMessage(prisma, {
            threadId,
            role: "user",
            authorUserId: userId,
            blocks: [{ kind: "text", text }],
          }),
        );
      const tenant = <T>(fn: () => Promise<T>) => runAsTenant({ spaceId, userId }, fn);
      const store = createSqlLedgerStore(prisma);
      const run = (runId: string, sourceMessageId: string) => ({
        runId,
        spaceId,
        userId,
        threadId,
        botId,
        botName: "Madad",
        trigger: "user",
        sourceMessageId,
        ownerStartedRun: true,
        messagingChannelRun: false,
      });

      // Run-finished hook: returns at once, the writer finishes in the background.
      const first = await say("Rahim is my accountant, he does my taxes.");
      const started = Date.now();
      scheduleLedgerLearning(
        { prisma, secretStore: { load: async () => "" } },
        run(`${id}-r1`, first.id),
        env,
      );
      expect(Date.now() - started).toBeLessThan(50);
      let facts = [] as Awaited<ReturnType<typeof store.findLive>>;
      for (let attempt = 0; attempt < 50 && !facts.length; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        facts = await tenant(() => store.findLive(spaceId, { subjects: ["person.rahim.role"] }));
      }
      expect(facts.map((fact) => [fact.text, fact.writtenByBotName])).toEqual([
        ["Rahim is the owner's accountant", "Madad"],
      ]);
      expect(model.requests[0]).toEqual({
        model: "glm/glm-5.3-flash",
        owner: ["Rahim is my accountant, he does my taxes."],
      });

      // The remember tool is answered by the ledger.
      const second = await say("Please remember I want reports as PDF.");
      const remembered = await tenant(() =>
        rememberViaLedger(
          { prisma, secretStore: { load: async () => "" } },
          run(`${id}-r2`, second.id),
          [{ action: "add", content: "Owner wants reports as PDF" }],
          env,
        ),
      );
      expect(remembered).toMatchObject({
        ok: true,
        facts: [{ text: "Owner wants reports as PDF", status: "confirmed" }],
      });
      // Not the owner's words, no model fact: falls back to the bot's own memory document.
      const third = await say("ok thanks");
      expect(
        await tenant(() =>
          rememberViaLedger(
            { prisma, secretStore: { load: async () => "" } },
            run(`${id}-r3`, third.id),
            [{ action: "add", content: "I am in the middle of the tax report" }],
            env,
          ),
        ),
      ).toBeUndefined();

      // recall_memory and the prompt block.
      const recalled = await tenant(() =>
        recallViaLedger({ prisma }, { spaceId, query: "who is my accountant" }, env),
      );
      expect(recalled?.map((row) => row.fact)).toContain("Rahim is the owner's accountant");
      const block = await tenant(() =>
        withLedgerMemory(
          { prisma },
          { spaceId, trigger: "user", query: "prepare the tax report for my accountant" },
          Promise.resolve("<durable_memory>notes</durable_memory>"),
          env,
        ),
      );
      expect(block).toContain("<durable_memory>notes</durable_memory>");
      expect(block).toContain("(preferences): Owner wants reports as PDF");
      expect(block).toContain("Rahim is the owner's accountant");
    } finally {
      model.close();
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
