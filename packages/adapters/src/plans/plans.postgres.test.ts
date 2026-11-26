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
  PLAN_NOTICE_FIRST_NOTE,
  PLAN_REQUIRED_NOTE,
  planGateCheck,
  planGateForMessageBot,
  planInstruction,
  planPromptState,
  proposePlan,
  recordPlanRecipient,
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
  // FORK.md 1.22: the approval used to be spent by the first message_bot of one run.
  it("an approved plan covers the owner's corrections and follow-ups to the agents it involves", async () => {
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
      const bot = (name: string) =>
        fixtures.bot.create({ data: { spaceId: space.id, userId, name, color: "gray" } });
      const planner = await bot("Planner");
      const worker = await bot("Worker");
      const helper = await bot("Helper");
      const outsider = await bot("Outsider");
      const plannerThread = await fixtures.thread.create({
        data: { spaceId: space.id, botId: planner.id, userId },
      });
      for (const other of [worker, helper, outsider])
        await fixtures.thread.create({ data: { spaceId: space.id, botId: other.id, userId } });
      const actor = { spaceId: space.id, userId };
      const deps = {
        prisma: db.prisma,
        events: { notify: async () => undefined },
        jobs: { enqueue: async () => undefined },
      };
      const ownerTurn = async (text: string) =>
        db.prisma.$transaction(async (tx) => {
          const message = await createThreadMessageInTransaction(tx, {
            threadId: plannerThread.id,
            role: "user",
            blocks: [{ kind: "text", text }],
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
      const owner = { ownerStartedRun: true, events: deps.events };
      const to = (target: { id: string }, replaces?: string) => ({
        ownerStartedRun: true,
        intent: "request",
        recipient: { botId: target.id },
        ...(replaces ? { replaces } : {}),
      });
      /** What the message_bot tool does: gate, send, record the recipient on the plan. */
      const send = async (
        run: Awaited<ReturnType<typeof ownerTurn>>,
        target: { id: string },
        message: string,
        replaces?: string,
      ) => {
        const gate = await planGateCheck(db.prisma, run, to(target, replaces));
        if (gate.refused) return { refused: gate.refused };
        const sent = await messageBot(
          deps as never,
          run,
          { id: planner.id, name: "Planner" },
          { bot_id: target.id, message, ...(replaces ? { replaces } : {}) },
        );
        if (sent.ok) await recordPlanRecipient(db.prisma, gate, sent.botId);
        return { gate, sent };
      };
      const endRun = (id: string) =>
        db.prisma.run.update({
          where: { id },
          data: { status: "completed", completedAt: new Date() },
        });

      await runAsTenant(actor, async () => {
        const store = createPlanStore(db.prisma);
        // The owner asks; the plan names Worker as who does the work; he approves; it is sent.
        const ask = await ownerTurn("Have Worker build the landing page from the brief");
        const proposed = await proposePlan(deps, ask, {
          title: "Landing page",
          steps: [{ text: "Build the page from the brief", agent: "Worker" }, { text: "Report" }],
        });
        const yes = await ownerTurn("Yes, go ahead.");
        expect((await planPromptState(db.prisma, yes, owner))?.approved?.id).toBe(proposed.planId);
        // The executing run may also hand a part to an agent the steps did not name.
        const first = await send(yes, worker, "Build the landing page from the brief.");
        const side = await send(yes, helper, "Collect the images for the landing page.");
        expect(first.gate).toMatchObject({ planId: proposed.planId, basis: "bound" });
        expect(first.sent?.ok && side.sent?.ok).toBe(true);
        expect((await store.get(String(proposed.planId)))?.recipients.sort()).toEqual(
          [worker.id, helper.id].sort(),
        );
        const firstRunId = (first.sent as { requestId: string }).requestId;
        await endRun(yes.id);

        // His NEXT message is a correction. It is a new run with no plan bound to it.
        const fix = await ownerTurn("Tell it to use the existing server, not a new one");
        const fixState = await planPromptState(db.prisma, fix, owner);
        expect(fixState?.approved).toBeUndefined();
        expect(fixState?.covering?.plan.id).toBe(proposed.planId);
        expect(fixState?.covering?.agents.sort()).toEqual(["Helper", "Worker"]);
        expect(planInstruction(fixState)).toContain("do not propose a new plan for that");
        // Same recipient: allowed without a new plan (this FAILED before: PLAN_REQUIRED_NOTE).
        const followUp = await send(fix, worker, "Use the existing server; do not create one.");
        expect(followUp.refused).toBeUndefined();
        expect(followUp.gate).toMatchObject({ planId: proposed.planId, basis: "follow_up" });
        expect(followUp.sent?.ok).toBe(true);
        // An agent that got a request under the plan without being named in it is covered too.
        expect(await planGateForMessageBot(db.prisma, fix, to(helper))).toBeUndefined();
        // An agent the plan does not involve still needs a plan, with or without replaces.
        expect(await planGateForMessageBot(db.prisma, fix, to(outsider))).toBe(PLAN_REQUIRED_NOTE);
        expect(await planGateForMessageBot(db.prisma, fix, to(outsider, "latest"))).toBe(
          PLAN_REQUIRED_NOTE,
        );
        // So does a request whose recipient is not given.
        expect(
          await planGateForMessageBot(db.prisma, fix, { ownerStartedRun: true, intent: "request" }),
        ).toBe(PLAN_REQUIRED_NOTE);

        // replaces of a request that already FINISHED: delivered as a new request, not refused.
        await db.prisma.run.updateMany({
          where: { botId: worker.id, trigger: "bot_message" },
          data: { status: "completed", completedAt: new Date() },
        });
        await endRun(fix.id);
        const later = await ownerTurn("And make the headline shorter");
        const corrected = await send(later, worker, "Make the headline shorter.", "latest");
        expect(corrected.gate).toMatchObject({ planId: proposed.planId, basis: "correction" });
        expect(corrected.sent).toMatchObject({ ok: true, earlierRequestFinished: true });
        expect((corrected.sent as { note: string }).note).toContain("had already finished");
        expect((corrected.sent as { replaced?: unknown }).replaced).toBeUndefined();
        const correctedRun = await db.prisma.run.findUniqueOrThrow({
          where: { id: (corrected.sent as { requestId: string }).requestId },
          select: { status: true, trigger: true, sourceMessageId: true },
        });
        expect(correctedRun).toMatchObject({ status: "queued", trigger: "bot_message" });
        const inbound = await db.prisma.message.findUniqueOrThrow({
          where: { id: correctedRun.sourceMessageId! },
          select: { id: true, blocks: true },
        });
        const received = storedMessageBlocks(inbound).find(
          (block) => block.kind === "bot_message_received",
        );
        expect(received && "text" in received ? received.text : "").toContain(
          "which you already finished",
        );
        // By id as well, and the finished run itself is untouched.
        await db.prisma.run.updateMany({
          where: { botId: worker.id, trigger: "bot_message" },
          data: { status: "completed", completedAt: new Date() },
        });
        const byId = await send(later, worker, "Also fix the footer.", firstRunId);
        expect(byId.sent).toMatchObject({ ok: true, earlierRequestFinished: true });
        expect((await db.prisma.run.findUniqueOrThrow({ where: { id: firstRunId } })).status).toBe(
          "completed",
        );
        // Someone else's request can still not be replaced.
        const foreign = await messageBot(
          deps as never,
          later,
          { id: helper.id, name: "Helper" },
          { bot_id: worker.id, message: "x", replaces: firstRunId },
        );
        expect(foreign).toMatchObject({ ok: false });

        // A newer plan still waiting for his answer: nothing goes out until he answers it.
        await endRun(later.id);
        const more = await ownerTurn("Now also have Worker write the blog post");
        const second = await proposePlan(deps, more, {
          title: "Blog post",
          steps: [{ text: "Write the post", agent: "Worker" }],
        });
        expect(second.status).toBe("pending");
        expect(await planGateForMessageBot(db.prisma, more, to(worker))).toBe(PLAN_REQUIRED_NOTE);
        await decidePlan(deps, actor, { planId: String(second.planId), decision: "reject" });
        // He said no to the new plan; the approved one still covers its own follow-ups.
        expect(await planGateForMessageBot(db.prisma, more, to(worker))).toBeUndefined();

        // Always ask stays strict: a plain follow-up needs a plan, a correction does not.
        await store.setSetting(space.id, planner.id, "always");
        expect(await planGateForMessageBot(db.prisma, more, to(worker))).toBe(PLAN_REQUIRED_NOTE);
        expect(await planGateForMessageBot(db.prisma, more, to(worker, "latest"))).toBeUndefined();
        expect(await planGateForMessageBot(db.prisma, more, to(outsider, "latest"))).toBe(
          PLAN_REQUIRED_NOTE,
        );
        await store.setSetting(space.id, planner.id, "until_trusted");

        // The cover ends with the plan's life (PLAN_LIVE_MS after approval).
        await db.prisma.$executeRawUnsafe(
          `UPDATE "agent_plans" SET "decidedAt" = now() - interval '7 hours', "createdAt" = now() - interval '7 hours' WHERE "id" = $1`,
          String(proposed.planId),
        );
        expect(await planGateForMessageBot(db.prisma, more, to(worker))).toBe(PLAN_REQUIRED_NOTE);
      });
    } finally {
      await fixtures.space.deleteMany({ where: { organizationId } }).catch(() => undefined);
      await fixtures.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
      await fixtures.user.delete({ where: { id: userId } }).catch(() => undefined);
      await db.prisma.$disconnect();
    }
  }, 120_000);
  // FORK.md 1.25: the plan is a notice. On the code before it, every plan waited for the owner.
  it("notify mode posts the plan as a notice and lets the run carry on at once", async () => {
    const db = createDb(runtimeUrl!);
    const fixtures = asSystem(db.prisma);
    const organizationId = randomUUID();
    const userId = randomUUID();
    const previous = process.env.PLAN_DEFAULT_MODE;
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
      const bot = (name: string) =>
        fixtures.bot.create({ data: { spaceId: space.id, userId, name, color: "gray" } });
      const planner = await bot("Planner");
      const worker = await bot("Worker");
      const outsider = await bot("Outsider");
      const plannerThread = await fixtures.thread.create({
        data: { spaceId: space.id, botId: planner.id, userId },
      });
      for (const other of [worker, outsider])
        await fixtures.thread.create({ data: { spaceId: space.id, botId: other.id, userId } });
      const actor = { spaceId: space.id, userId };
      const deps = {
        prisma: db.prisma,
        events: { notify: async () => undefined },
        jobs: { enqueue: async () => undefined },
      };
      const ownerTurn = async (text: string) =>
        db.prisma.$transaction(async (tx) => {
          const message = await createThreadMessageInTransaction(tx, {
            threadId: plannerThread.id,
            role: "user",
            blocks: [{ kind: "text", text }],
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
      const owner = { ownerStartedRun: true, events: deps.events };
      const to = (target: { id: string }) => ({
        ownerStartedRun: true,
        intent: "request",
        recipient: { botId: target.id },
      });
      const lastCard = async () => {
        const rows = await db.prisma.message.findMany({
          where: { threadId: plannerThread.id, role: "bot" },
          orderBy: { seq: "asc" },
          select: { id: true, blocks: true },
        });
        return rows
          .flatMap((row) =>
            storedMessageBlocks(row).filter(
              (block): block is Extract<MessageBlock, { kind: "plan" }> => block.kind === "plan",
            ),
          )
          .at(-1);
      };

      await runAsTenant(actor, async () => {
        const store = createPlanStore(db.prisma);
        // The deployment default: an agent with no setting of its own follows PLAN_DEFAULT_MODE.
        process.env.PLAN_DEFAULT_MODE = "notify";
        expect((await store.setting(planner.id)).mode).toBeNull();
        const ask = await ownerTurn("Have Worker pull the subtitles of the video and report");
        const state = await planPromptState(db.prisma, ask, owner);
        expect(state?.mode).toBe("notify");
        expect(planInstruction(state)).toContain("Do NOT ask whether to go ahead");
        // Before the plan is posted the hand-off is held, but nothing waits on the owner.
        expect(await planGateForMessageBot(db.prisma, ask, to(worker))).toBe(
          PLAN_NOTICE_FIRST_NOTE,
        );
        const proposed = await proposePlan(deps, ask, {
          title: "Video subtitles",
          steps: [{ text: "Pull the subtitles", agent: "Worker" }, { text: "Report" }],
          workflow: "YouTube Subtitle Download",
          spoken: "I will have Worker pull the subtitles. Shall I go ahead?",
        });
        // Approved as it is posted, bound to the run that proposed it.
        expect(proposed).toMatchObject({ ok: true, status: "auto" });
        expect(String(proposed.note)).toContain("Carry it out NOW in this same turn");
        expect(await store.get(String(proposed.planId))).toMatchObject({
          status: "auto",
          decidedVia: "notify",
          executingRunId: ask.id,
        });
        // The card is a notice (no buttons: not pending), and a call says it as a statement.
        const card = await lastCard();
        expect(card).toMatchObject({ status: "auto", decidedVia: "notify" });
        expect(card?.spoken).toBe("I will have Worker pull the subtitles. I am starting now.");
        // The same run may hand the work on at once.
        const gate = await planGateCheck(db.prisma, ask, to(worker));
        expect(gate).toMatchObject({ planId: proposed.planId, basis: "bound" });
        const sent = await messageBot(
          deps as never,
          ask,
          { id: planner.id, name: "Planner" },
          { bot_id: worker.id, message: "Pull the subtitles of the video and report back." },
        );
        expect(sent.ok).toBe(true);
        // A notice is not the owner's approval: the workflow's trust counter does not move.
        expect(await store.trust(planner.id, "YouTube Subtitle Download")).toBeUndefined();
        // His correction afterwards is covered (Fix B) and needs no new plan; a revision is a
        // notice too.
        await db.prisma.run.update({
          where: { id: ask.id },
          data: { status: "completed", completedAt: new Date() },
        });
        const fix = await ownerTurn("English subtitles only");
        expect(await planGateForMessageBot(db.prisma, fix, to(worker))).toBeUndefined();
        expect(await planGateForMessageBot(db.prisma, fix, to(outsider))).toBe(
          PLAN_NOTICE_FIRST_NOTE,
        );
        const revised = await proposePlan(deps, fix, {
          title: "Video subtitles",
          steps: [{ text: "Pull the English subtitles only", agent: "Worker" }],
          revises: proposed.planId,
        });
        expect(revised).toMatchObject({ status: "auto" });
        expect(await lastCard()).toMatchObject({
          status: "auto",
          revision: 2,
          decidedVia: "notify",
        });

        // The agent's own setting wins over the deployment default, in both directions.
        await store.setSetting(space.id, planner.id, "always");
        const strict = await ownerTurn("Have Worker write the summary");
        const waiting = await proposePlan(deps, strict, {
          title: "Summary",
          steps: [{ text: "Write the summary", agent: "Worker" }],
        });
        expect(waiting).toMatchObject({ status: "pending" });
        expect(await planGateForMessageBot(db.prisma, strict, to(worker))).toBe(PLAN_REQUIRED_NOTE);
        await decidePlan(deps, actor, { planId: String(waiting.planId), decision: "reject" });
        delete process.env.PLAN_DEFAULT_MODE;
        await store.setSetting(space.id, planner.id, "notify");
        expect((await store.setting(planner.id)).mode).toBe("notify");
        const own = await ownerTurn("Have Worker tidy the folder");
        expect(
          await proposePlan(deps, own, {
            title: "Tidy",
            steps: [{ text: "Tidy the folder", agent: "Worker" }],
          }),
        ).toMatchObject({ status: "auto" });
        // With neither a setting nor the env, it is Ask until trusted as before.
        await store.setSetting(space.id, planner.id, null);
        const asBefore = await ownerTurn("Have Worker archive the folder");
        expect(
          await proposePlan(deps, asBefore, {
            title: "Archive",
            steps: [{ text: "Archive the folder", agent: "Worker" }],
          }),
        ).toMatchObject({ status: "pending" });
      });
    } finally {
      if (previous === undefined) delete process.env.PLAN_DEFAULT_MODE;
      else process.env.PLAN_DEFAULT_MODE = previous;
      await fixtures.space.deleteMany({ where: { organizationId } }).catch(() => undefined);
      await fixtures.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
      await fixtures.user.delete({ where: { id: userId } }).catch(() => undefined);
      await db.prisma.$disconnect();
    }
  }, 120_000);
});
