import { randomUUID } from "node:crypto";
import type { MessageBlock } from "@rakazo/contracts";
import {
  asSystem,
  createDb,
  createThreadMessageInTransaction,
  runAsTenant,
  storedMessageBlocks,
} from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { messageBot } from "../messaging/bot-messages.js";
import { admissionBlock } from "../runs/lifecycle/run-gate.js";
import {
  createPlanStore,
  decidePlan,
  PLAN_REQUIRED_NOTE,
  planGateForMessageBot,
  planInstruction,
  planPromptState,
  proposePlan,
} from "./plans.js";

const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe
    : describe.skip;

describePostgres("plan confirmation and superseding requests under PostgreSQL (fork)", () => {
  it("cards, spoken approval, the message_bot gate, workflow trust and supersede", async () => {
    const db = createDb(runtimeUrl!);
    const fixtures = asSystem(db.prisma);
    const organizationId = randomUUID();
    const userId = randomUUID();
    try {
      await fixtures.user.create({
        data: { id: userId, name: "Owner", email: `${userId}@rakazo.test` },
      });
      await fixtures.organization.create({
        data: { id: organizationId, slug: organizationId, name: "Plans", createdAt: new Date() },
      });
      const space = await fixtures.space.create({
        data: { id: randomUUID(), organizationId, name: "Space" },
      });
      const planner = await fixtures.bot.create({
        data: { spaceId: space.id, userId, name: "Planner", color: "gray" },
      });
      const worker = await fixtures.bot.create({
        data: { spaceId: space.id, userId, name: "Worker", color: "gray" },
      });
      const plannerThread = await fixtures.thread.create({
        data: { spaceId: space.id, botId: planner.id, userId },
      });
      await fixtures.thread.create({ data: { spaceId: space.id, botId: worker.id, userId } });
      const actor = { spaceId: space.id, userId };
      const notified: number[] = [];
      const jobs: string[] = [];
      const deps = {
        prisma: db.prisma,
        events: { notify: async (_thread: string, seq: number) => void notified.push(seq) },
        jobs: {
          enqueue: async (job: { key?: string; payload?: unknown }) =>
            void jobs.push(JSON.stringify(job)),
        },
      };

      /** An owner message (spoken when `call`) and the run it starts. */
      const ownerTurn = async (text: string, call = false) =>
        db.prisma.$transaction(async (tx) => {
          const message = await createThreadMessageInTransaction(tx, {
            threadId: plannerThread.id,
            role: "user",
            blocks: [{ kind: "text", text }],
            ...(call ? { clientNonce: `call:c1:${randomUUID()}` } : {}),
          });
          const task = await tx.task.create({
            data: {
              spaceId: space.id,
              botId: planner.id,
              threadId: plannerThread.id,
              userId,
              prompt: text,
              status: "running",
            },
          });
          const run = await tx.run.create({
            data: {
              spaceId: space.id,
              botId: planner.id,
              threadId: plannerThread.id,
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
            threadId: plannerThread.id,
            botId: planner.id,
            userId,
            trigger: "user",
            sourceMessageId: message.id,
          };
        });
      const cards = async () => {
        const rows = await db.prisma.message.findMany({
          where: { threadId: plannerThread.id, role: "bot" },
          orderBy: { seq: "asc" },
          select: { id: true, blocks: true },
        });
        return rows.flatMap((row) =>
          storedMessageBlocks(row).filter(
            (block): block is Extract<MessageBlock, { kind: "plan" }> => block.kind === "plan",
          ),
        );
      };
      const owner = { ownerStartedRun: true, events: deps.events };

      await runAsTenant(actor, async () => {
        const store = createPlanStore(db.prisma);
        // (a) A request: the run must propose before message_bot gets through.
        const ask = await ownerTurn(
          "Open YouTube history, find the Dan Martell video, give the link to Worker, get subtitles, report",
          true,
        );
        expect(planInstruction(await planPromptState(db.prisma, ask, owner))).toContain(
          "plan_propose",
        );
        expect(
          await planGateForMessageBot(db.prisma, ask, { ownerStartedRun: true, intent: "request" }),
        ).toBe(PLAN_REQUIRED_NOTE);
        // Results and status to another bot are never held.
        expect(
          await planGateForMessageBot(db.prisma, ask, { ownerStartedRun: true, intent: "result" }),
        ).toBeUndefined();
        const proposed = await proposePlan(deps, ask, {
          title: "Dan Martell subtitles",
          steps: [
            { text: "Open YouTube history and find the video", agent: "Worker" },
            { text: "Download the subtitles", agent: "Worker" },
          ],
          inputs: [{ label: "Video", value: "one-person business with AI agents, Dan Martell" }],
        });
        expect(proposed).toMatchObject({ ok: true, status: "pending" });
        expect((await cards()).at(-1)).toMatchObject({ status: "pending", revision: 1 });

        // (b) A spoken "change step 2" settles the card as changes; the revision replaces it.
        const change = await ownerTurn(
          "Change step 2 to download the English subtitles only",
          true,
        );
        const changing = await planPromptState(db.prisma, change, owner);
        expect(changing?.changing?.id).toBe(proposed.planId);
        expect(planInstruction(changing)).toContain(`revises="${proposed.planId}"`);
        const revised = await proposePlan(deps, change, {
          title: "Dan Martell subtitles",
          steps: [
            { text: "Open YouTube history and find the video", agent: "Worker" },
            { text: "Download the English subtitles only", agent: "Worker" },
          ],
          revises: proposed.planId,
        });
        expect((await cards()).at(-1)).toMatchObject({ status: "pending", revision: 2 });

        // A call turn "yes, go ahead" approves the pending plan and binds it to its run.
        const yes = await ownerTurn("Yes, go ahead.", true);
        const approved = await planPromptState(db.prisma, yes, owner);
        expect(approved?.approved?.id).toBe(revised.planId);
        expect(await store.get(String(revised.planId))).toMatchObject({
          status: "approved",
          decidedVia: "voice",
          executingRunId: yes.id,
        });
        expect((await cards()).at(-1)).toMatchObject({ status: "approved", decidedVia: "voice" });
        expect(planInstruction(approved)).toContain("Carry it out now");
        // Now message_bot to the worker gets through, and it returns a request id.
        expect(
          await planGateForMessageBot(db.prisma, yes, { ownerStartedRun: true, intent: "request" }),
        ).toBeUndefined();
        const first = await messageBot(
          deps as never,
          yes,
          { id: planner.id, name: "Planner" },
          {
            bot_id: worker.id,
            message:
              "Open his YouTube history in your own tab, find the Dan Martell video and get its subtitles.",
          },
        );
        expect(first.ok && "requestId" in first && first.requestId).toBeTruthy();
        const firstRunId = (first as { requestId: string }).requestId;
        // The worker starts it (running).
        await db.prisma.run.update({
          where: { id: firstRunId },
          data: {
            status: "running",
            startedAt: new Date(),
            leaseExpiresAt: new Date(Date.now() + 60_000),
          },
        });

        // (c) The owner corrects it: the correction supersedes the running request at once.
        const fix = await ownerTurn("No, tell him to use the history tab, not a web search");
        const fixed = await messageBot(
          deps as never,
          fix,
          { id: planner.id, name: "Planner" },
          {
            bot_id: worker.id,
            message: "Correction: use the history tab of his logged-in YouTube, not a web search.",
            replaces: "latest",
          },
        );
        expect(fixed).toMatchObject({
          ok: true,
          replaced: { requestId: firstRunId, stopped: true },
        });
        const old = await db.prisma.run.findUniqueOrThrow({ where: { id: firstRunId } });
        expect(old.status).toBe("cancelled");
        expect(old.botOutcomeReturnedAt).not.toBeNull();
        const newRunId = (fixed as { requestId: string }).requestId;
        const fresh = await db.prisma.run.findUniqueOrThrow({
          where: { id: newRunId },
          select: {
            id: true,
            botId: true,
            threadId: true,
            trigger: true,
            lane: true,
            createdAt: true,
            sourceMessageId: true,
          },
        });
        // Nothing holds it: the old request no longer occupies the lane.
        const active = await db.prisma.run.findMany({
          where: { botId: worker.id, status: { in: ["leased", "running"] } },
          select: {
            id: true,
            botId: true,
            threadId: true,
            trigger: true,
            lane: true,
            createdAt: true,
          },
        });
        const queued = await db.prisma.run.findMany({
          where: { botId: worker.id, status: "queued", trigger: "bot_message" },
          select: {
            id: true,
            botId: true,
            threadId: true,
            trigger: true,
            lane: true,
            createdAt: true,
          },
        });
        expect(admissionBlock(fresh, 1, active, queued)).toBeUndefined();
        // The worker is told plainly what it replaces.
        const inbound = await db.prisma.message.findUniqueOrThrow({
          where: { id: fresh.sourceMessageId! },
          select: { id: true, blocks: true },
        });
        const received = storedMessageBlocks(inbound).find(
          (block) => block.kind === "bot_message_received",
        );
        expect(received && "text" in received ? received.text : "").toContain(
          `This replaces my earlier request ${firstRunId.slice(0, 8)}`,
        );
        // Only the sender may replace a request.
        const intruder = await messageBot(
          deps as never,
          fix,
          { id: worker.id, name: "Worker" },
          {
            bot_id: planner.id,
            message: "x",
            replaces: newRunId,
          },
        );
        expect(intruder.ok).toBe(false);

        // (d) A known workflow: approved as proposed 3 times -> the 4th runs without asking.
        for (let i = 0; i < 3; i++) {
          const turn = await ownerTurn(`Get the subtitles of video ${i}`);
          const p = await proposePlan(deps, turn, {
            title: `Subtitles ${i}`,
            steps: [{ text: "yt-dlp with cookies", agent: "Worker" }],
            workflow: "YouTube Subtitle Download",
          });
          expect(p.status).toBe("pending");
          await decidePlan(deps, actor, { planId: String(p.planId), decision: "approve" });
        }
        const fourth = await ownerTurn("Get the subtitles of video 4");
        const auto = await proposePlan(deps, fourth, {
          title: "Subtitles 4",
          steps: [{ text: "yt-dlp with cookies", agent: "Worker" }],
          workflow: "youtube subtitle download",
        });
        expect(auto).toMatchObject({ status: "auto" });
        expect((await cards()).at(-1)).toMatchObject({ status: "auto", decidedVia: "trust" });
        expect(
          await planGateForMessageBot(db.prisma, fourth, {
            ownerStartedRun: true,
            intent: "request",
          }),
        ).toBeUndefined();
        // A correction resets the count; Always ask never runs it unasked.
        const fifth = await ownerTurn("Get the subtitles of video 5");
        const p5 = await proposePlan(deps, fifth, {
          title: "Subtitles 5",
          steps: [{ text: "yt-dlp", agent: "Worker" }],
          workflow: "YouTube Subtitle Download",
        });
        expect(p5.status).toBe("auto");
        const sixth = await ownerTurn("Get the subtitles of video 6");
        await store.setSetting(space.id, planner.id, "always");
        const p6 = await proposePlan(deps, sixth, {
          title: "Subtitles 6",
          steps: [{ text: "yt-dlp", agent: "Worker" }],
          workflow: "YouTube Subtitle Download",
        });
        expect(p6.status).toBe("pending");
        await decidePlan(deps, actor, { planId: String(p6.planId), decision: "change" });
        expect((await store.trust(planner.id, "YouTube Subtitle Download"))?.approvals).toBe(0);
        // Never ask: no gate at all.
        await store.setSetting(space.id, planner.id, "never");
        const seventh = await ownerTurn("Ask Worker for the report");
        expect(
          await planGateForMessageBot(db.prisma, seventh, {
            ownerStartedRun: true,
            intent: "request",
          }),
        ).toBeUndefined();
      });

      // Row security: another space sees no plans.
      const otherSpace = await fixtures.space.create({
        data: { id: randomUUID(), organizationId, name: "Other" },
      });
      await runAsTenant({ spaceId: otherSpace.id, userId }, async () => {
        const rows = await db.prisma.$queryRawUnsafe<unknown[]>(`SELECT "id" FROM "agent_plans"`);
        expect(rows).toHaveLength(0);
      });
      expect(notified.length).toBeGreaterThan(0);
    } finally {
      await fixtures.space.deleteMany({ where: { organizationId } }).catch(() => undefined);
      await fixtures.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
      await fixtures.user.delete({ where: { id: userId } }).catch(() => undefined);
      await db.prisma.$disconnect();
    }
  }, 120_000);
});
