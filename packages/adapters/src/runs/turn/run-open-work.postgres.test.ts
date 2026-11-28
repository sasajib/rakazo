import { randomUUID } from "node:crypto";
import type { BackgroundJob } from "@rakazo/adapter-kit";
import { ONCE_ROUTINE_CRON, OPEN_WORK_NONCE_PREFIX } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { createDb, createThreadMessage, runAsSystem } from "@rakazo/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startBackgroundHelper } from "../../tasks/background-helpers.js";
import { continuityConfig } from "../../tasks/continuity-config.js";
import {
  addScratchpadItemFromTool,
  completeScratchpadItemFromTool,
  updateScratchpadItemFromTool,
} from "../../tasks/scratchpad-tools.js";
import type { RunContext } from "../assembly/run-context.js";
import { loadRunOrigin } from "../lifecycle/run-origin.js";
import type { EndedRun } from "./run-open-work.js";
import { disarmOpenWorkInTransaction, followOpenWork } from "./run-open-work.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

/** Fork (FORK.md 1.33, A3/A4): open work is continued, inside bounds; a stall is told once. */
describePostgres("open work continuation (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let db: ReturnType<typeof createDb>;
  const owners: string[] = [];
  const enqueued: BackgroundJob[] = [];
  const alerts: Array<{ title: string; body: string }> = [];
  const deps = () =>
    ({
      prisma,
      jobs: { enqueue: async (job: BackgroundJob) => void enqueued.push(job) },
      events: {
        notify: async () => undefined,
        publishChatAlert: async (_userId: string, alert: { title: string; body: string }) =>
          void alerts.push(alert),
      },
    }) as unknown as Parameters<typeof followOpenWork>[0];

  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
  });

  afterEach(() => vi.unstubAllEnvs());

  afterAll(async () => {
    if (!db) return;
    await runAsSystem("test cleanup", async () => {
      await prisma.organization.deleteMany({ where: { id: { in: owners } } });
      await prisma.user.deleteMany({ where: { id: { in: owners } } });
    });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  async function world() {
    const id = randomUUID();
    owners.push(id);
    return runAsSystem("test fixture", async () => {
      await prisma.user.create({
        data: { id, name: "Open work", email: `${id}@example.test`, emailVerified: true },
      });
      await prisma.organization.create({
        data: { id, name: "Open work", slug: id, createdAt: new Date() },
      });
      await prisma.space.create({
        data: { id, organizationId: id, name: "Open work", isDefault: true },
      });
      await prisma.member.create({
        data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
      });
      const bot = await prisma.bot.create({
        data: { spaceId: id, userId: id, name: "Writer", color: "test-color" },
      });
      const thread = await prisma.thread.create({
        data: { spaceId: id, userId: id, botId: bot.id },
      });
      const asked = await createThreadMessage(prisma, {
        threadId: thread.id,
        role: "user",
        authorUserId: id,
        botId: bot.id,
        blocks: [{ kind: "text", text: "write all the parts" }],
      });
      return { spaceId: id, userId: id, botId: bot.id, threadId: thread.id, askedId: asked.id };
    });
  }
  type World = Awaited<ReturnType<typeof world>>;

  /** A run of the agent in the chat that just completed (or another state). */
  async function endedRun(
    w: World,
    data: Record<string, unknown> = {},
    startedMsAgo = 60_000,
  ): Promise<EndedRun> {
    return runAsSystem("run", async () => {
      const task = await prisma.task.create({
        data: {
          spaceId: w.spaceId,
          userId: w.userId,
          botId: w.botId,
          threadId: w.threadId,
          prompt: "go",
          status: "completed",
        },
      });
      return prisma.run.create({
        data: {
          spaceId: w.spaceId,
          userId: w.userId,
          botId: w.botId,
          threadId: w.threadId,
          taskId: task.id,
          status: "completed",
          trigger: "helper_result",
          startedAt: new Date(Date.now() - startedMsAgo),
          completedAt: new Date(),
          ...data,
        },
      });
    });
  }
  const userRun = (w: World) => endedRun(w, { trigger: "user", sourceMessageId: w.askedId });

  const scope = (w: World) => ({ spaceId: w.spaceId, botId: w.botId, userId: w.userId });
  async function addItem(w: World, title: string, status = "open") {
    const added = await runAsSystem("item", () =>
      addScratchpadItemFromTool({ prisma }, { ...scope(w), title, status, threadId: w.threadId }),
    );
    if (!added.item) throw new Error("item not added");
    return added.item.id;
  }
  /** Make every item of the chat older than the run that is about to be judged. */
  const ageItems = (w: World, msAgo = 3_600_000) =>
    runAsSystem(
      "age",
      () =>
        prisma.$executeRaw`UPDATE scratchpad_items SET "updatedAt" = ${new Date(Date.now() - msAgo)} WHERE "threadId" = ${w.threadId}`,
    );

  const follow = (
    _w: World,
    run: EndedRun,
    more: Partial<Parameters<typeof followOpenWork>[1]> = {},
  ) =>
    runAsSystem("follow", () =>
      followOpenWork(deps(), {
        run,
        botName: "Writer",
        replyText: "Parts one and two are written.",
        toolCallCount: 3,
        judge: async () => "none",
        ...more,
      }),
    );
  const continuationRun = (id: string) =>
    runAsSystem("read", () =>
      prisma.run.findUniqueOrThrow({ where: { id }, include: { task: true } }),
    );
  const notices = (w: World) =>
    runAsSystem("read", () =>
      prisma.message.findMany({ where: { threadId: w.threadId, role: "system" } }),
    );
  const state = (w: World) =>
    runAsSystem("read", () =>
      prisma.openWorkState.findUnique({
        where: { threadId_botId: { threadId: w.threadId, botId: w.botId } },
      }),
    );

  it("continues a result run that ends with items open: a follow-up run that names them", async () => {
    const w = await world();
    const first = await userRun(w);
    await addItem(w, "Write part three");
    await addItem(w, "Write part four");
    await addItem(w, "Wait for the cover picture", "parked");
    const ended = await endedRun(w, { delegatedFromRunId: null });
    enqueued.length = 0;
    const outcome = await follow(w, ended);
    expect(outcome.decision).toEqual({ action: "continue", basis: "items" });
    const next = await continuationRun(outcome.continuationRunId!);
    expect(next).toMatchObject({
      trigger: "follow_up",
      status: "queued",
      threadId: w.threadId,
      botId: w.botId,
      clientNonce: `${OPEN_WORK_NONCE_PREFIX}${ended.id}`,
      sourceMessageId: null,
    });
    expect(next.task.prompt).toContain("[continuation]");
    expect(next.task.prompt).toContain("Write part three");
    expect(next.task.prompt).toContain("Write part four");
    expect(next.task.prompt).not.toContain("cover picture");
    expect(enqueued.map((job) => JSON.stringify(job)).join()).toContain(next.id);
    expect(await state(w)).toMatchObject({ continuations: 1, lastContinuationRunId: next.id });
    // The same finished run is never continued twice.
    expect((await follow(w, ended)).continuationRunId).toBeUndefined();
    expect(first.id).not.toBe(next.id);
  });

  it("continues on a first-person promise when no item is kept, and asks the judge only when unclear", async () => {
    const w = await world();
    await userRun(w);
    const judge = vi.fn(async () => "promise" as const);
    const promised = await follow(w, await endedRun(w), {
      replyText: "Parts 1 to 5 are saved. I'm continuing with part 6.",
      judge,
    });
    expect(promised.decision).toEqual({ action: "continue", basis: "promise" });
    expect(judge).not.toHaveBeenCalled();
    const next = await continuationRun(promised.continuationRunId!);
    expect(next.task.prompt).toContain("I'm continuing with part 6.");

    const other = await world();
    await userRun(other);
    const unclear = await follow(other, await endedRun(other), {
      replyText: "The first part is ready. I'll have the rest in a while.",
      judge,
    });
    expect(judge).toHaveBeenCalledOnce();
    expect(unclear.decision).toEqual({ action: "continue", basis: "promise" });

    const done = await world();
    await userRun(done);
    expect(
      (await follow(done, await endedRun(done), { replyText: "All parts are written." })).decision,
    ).toEqual({ action: "none", reason: "no_open_work" });
  });

  describe("nothing is started while something else will wake the agent", () => {
    const wakers: Array<[string, (w: World, ended: EndedRun) => Promise<unknown>]> = [
      [
        "helpers",
        async (w) => {
          const card = await createThreadMessage(prisma, {
            threadId: w.threadId,
            role: "bot",
            botId: w.botId,
            blocks: [
              { kind: "subagent", agentId: "a", name: "part", task: "t", status: "running" },
            ],
          });
          const helperThread = await prisma.thread.create({
            data: { spaceId: w.spaceId, userId: w.userId, helperBotId: w.botId },
          });
          const task = await prisma.task.create({
            data: { ...scope(w), threadId: helperThread.id, prompt: "p", status: "running" },
          });
          await prisma.run.create({
            data: {
              ...scope(w),
              threadId: helperThread.id,
              taskId: task.id,
              status: "running",
              trigger: "helper",
              sourceMessageId: card.id,
            },
          });
        },
      ],
      [
        "queuedHelpers",
        async (w) => {
          const card = await createThreadMessage(prisma, {
            threadId: w.threadId,
            role: "bot",
            botId: w.botId,
            blocks: [
              { kind: "subagent", agentId: "q", name: "part", task: "t", status: "running" },
            ],
          });
          await prisma.queuedHelper.create({
            data: {
              ...scope(w),
              threadId: w.threadId,
              originRunId: "origin",
              cardMessageId: card.id,
              clientNonce: `n-${randomUUID()}`,
              helperThreadId: "ht",
              taskId: "t",
              sourceMessageIds: [],
            },
          });
        },
      ],
      [
        "runs",
        async (w) => {
          const task = await prisma.task.create({
            data: { ...scope(w), threadId: w.threadId, prompt: "p", status: "queued" },
          });
          await prisma.run.create({
            data: {
              ...scope(w),
              threadId: w.threadId,
              taskId: task.id,
              status: "queued",
              trigger: "helper_result",
            },
          });
        },
      ],
      [
        "jobs",
        async (w, ended) => {
          await prisma.shellJob.create({
            data: {
              id: randomUUID().replaceAll("-", ""),
              spaceId: w.spaceId,
              botId: w.botId,
              threadId: w.threadId,
              userId: w.userId,
              originRunId: ended.id,
              computerId: "computer",
              commandPreview: "make build",
              jobDir: "~/jobs/x",
              deadlineAt: new Date(Date.now() + 3_600_000),
            },
          });
        },
      ],
      [
        "schedules",
        async (w) => {
          await prisma.routine.create({
            data: {
              ...scope(w),
              threadId: w.threadId,
              name: "check back",
              prompt: "check the item",
              crons: [ONCE_ROUTINE_CRON],
              active: true,
              nextRunAt: new Date(Date.now() + 3_600_000),
            },
          });
        },
      ],
      [
        "cards",
        async (w) => {
          await createThreadMessage(prisma, {
            threadId: w.threadId,
            role: "bot",
            botId: w.botId,
            blocks: [{ kind: "ask", text: "Which title?", status: "pending" } as never],
          });
        },
      ],
    ];
    it.each(wakers)("%s", async (name, arrange) => {
      const w = await world();
      await userRun(w);
      await addItem(w, "Write part three");
      const ended = await endedRun(w);
      await runAsSystem("arrange", () => arrange(w, ended));
      const judge = vi.fn(async () => "promise" as const);
      const outcome = await follow(w, ended, {
        // A status report with a promise in it: still nothing, the agent is woken anyway.
        replyText: "Two of four are back. I'm continuing when the others report.",
        judge,
      });
      expect(outcome.decision).toEqual({ action: "none", reason: `will_wake:${name}` });
      expect(outcome.continuationRunId).toBeUndefined();
      expect(judge).not.toHaveBeenCalled();
    });
  });

  it("ends a chain that makes no progress, tells the owner once, and stays quiet until the list moves", async () => {
    const w = await world();
    await userRun(w);
    const itemId = await addItem(w, "Write part three");
    await addItem(w, "Write part four");
    await ageItems(w);
    const started = await follow(w, await endedRun(w));
    expect(started.decision.action).toBe("continue");
    // The continuation ran, called tools, and touched no item.
    await runAsSystem("ran", () =>
      prisma.run.update({
        where: { id: started.continuationRunId! },
        data: { status: "completed", startedAt: new Date(Date.now() - 30_000) },
      }),
    );
    const continuation = await continuationRun(started.continuationRunId!);
    alerts.length = 0;
    const stalled = await follow(w, continuation);
    expect(stalled.decision).toEqual({ action: "stalled", reason: "no_progress", openCount: 2 });
    const [notice, ...rest] = await notices(w);
    expect(rest).toHaveLength(0);
    expect(JSON.stringify(notice!.blocks)).toContain("Stalled: 2 items open: Write part three");
    expect(stalled.noticeMessageId).toBe(notice!.id);
    expect(await state(w)).toMatchObject({
      stalledReason: "no_progress",
      stalledRunId: continuation.id,
      openCount: 2,
      noticeMessageId: notice!.id,
    });
    if (alerts.length) expect(alerts[0]!.title).toBe("Writer stalled");
    // The same end is never reported twice.
    await follow(w, continuation);
    expect(await notices(w)).toHaveLength(1);
    // A later run that leaves the same list untouched starts nothing and says nothing.
    const later = await follow(w, await endedRun(w, {}, 1_000));
    expect(later.decision).toEqual({ action: "none", reason: "no_open_work" });
    expect(await notices(w)).toHaveLength(1);
    // The agent moves an item: the list is live again and the work is continued.
    const working = await endedRun(w, {}, 5_000);
    await runAsSystem("done", () =>
      completeScratchpadItemFromTool({ prisma }, { ...scope(w), itemId, threadId: w.threadId }),
    );
    const again = await follow(w, working);
    expect(again.decision).toEqual({ action: "continue", basis: "items" });
    expect((await state(w))!.stalledAt).toBeNull();
  });

  it("a chain kept only by promises ends when a continuation calls no tool, and that end is reported once", async () => {
    const w = await world();
    await userRun(w);
    const promising = { replyText: "Part 5 is saved. I'm continuing with part 6." };
    const started = await follow(w, await endedRun(w), promising);
    expect(started.decision).toEqual({ action: "continue", basis: "promise" });
    await runAsSystem("ran", () =>
      prisma.run.update({
        where: { id: started.continuationRunId! },
        data: { status: "completed", startedAt: new Date(Date.now() - 2_000) },
      }),
    );
    const continuation = await continuationRun(started.continuationRunId!);
    // It only promised again.
    const stalled = await follow(w, continuation, { ...promising, toolCallCount: 0 });
    expect(stalled.decision).toEqual({ action: "stalled", reason: "no_progress", openCount: 1 });
    const line = JSON.stringify((await notices(w))[0]!.blocks);
    expect(line).toContain("promised work not done:");
    expect(line).toContain("I'm continuing with part 6.");
    // The same finished run, judged again (a retry, a second worker): no second line.
    const again = await follow(w, continuation, { ...promising, toolCallCount: 0 });
    expect(again.decision.action).toBe("stalled");
    expect(again.noticeMessageId).toBeUndefined();
    expect(await notices(w)).toHaveLength(1);
    // Two workers judging at the same moment: the second read the state before the first wrote
    // its mark. The claim is per finished run, taken under the chat's lock.
    await runAsSystem("skew", () =>
      prisma.openWorkState.update({
        where: { threadId_botId: { threadId: w.threadId, botId: w.botId } },
        data: { stalledAt: null },
      }),
    );
    const raced = await follow(w, continuation, { ...promising, toolCallCount: 0 });
    expect(raced.noticeMessageId).toBeUndefined();
    expect(await notices(w)).toHaveLength(1);
  });

  it("goes on while each continuation closes an item, up to the limit for one task", async () => {
    vi.stubEnv("OPEN_WORK_MAX_CONTINUATIONS", "2");
    const w = await world();
    await userRun(w);
    const ids: string[] = [];
    for (const n of [1, 2, 3, 4]) ids.push(await addItem(w, `Write part ${n}`));
    let ended = await endedRun(w);
    for (const round of [0, 1]) {
      const outcome = await follow(w, ended, { config: continuityConfig() });
      expect(outcome.decision).toEqual({ action: "continue", basis: "items" });
      await runAsSystem("ran", () =>
        prisma.run.update({
          where: { id: outcome.continuationRunId! },
          data: { status: "completed", startedAt: new Date(Date.now() - 2_000) },
        }),
      );
      await runAsSystem("done", () =>
        completeScratchpadItemFromTool(
          { prisma },
          { ...scope(w), itemId: ids[round]!, threadId: w.threadId },
        ),
      );
      ended = await continuationRun(outcome.continuationRunId!);
    }
    const third = await follow(w, ended, { config: continuityConfig() });
    expect(third.decision).toEqual({ action: "stalled", reason: "limit", openCount: 2 });
    expect(JSON.stringify((await notices(w))[0]!.blocks)).toContain("reached the limit");
    // A new message of the person starts a new task: the count starts again.
    await userRun(w);
    const fresh = await endedRun(w, {}, 1_000);
    await runAsSystem("touch", () =>
      updateScratchpadItemFromTool({ prisma }, { ...scope(w), itemId: ids[2]!, notes: "next" }),
    );
    expect((await follow(w, fresh, { config: continuityConfig() })).decision.action).toBe(
      "continue",
    );
  });

  it("tells the owner the agent is blocked when a continuation parks its work", async () => {
    const w = await world();
    await userRun(w);
    const itemId = await addItem(w, "Write part three");
    const started = await follow(w, await endedRun(w));
    await runAsSystem("ran", () =>
      prisma.run.update({
        where: { id: started.continuationRunId! },
        data: { status: "completed", startedAt: new Date(Date.now() - 2_000) },
      }),
    );
    await runAsSystem("park", () =>
      updateScratchpadItemFromTool(
        { prisma },
        { ...scope(w), itemId, status: "parked", notes: "the source file is missing" },
      ),
    );
    const blocked = await follow(w, await continuationRun(started.continuationRunId!), {
      replyText: "I cannot write part three: the source file is missing.",
    });
    expect(blocked.decision).toEqual({ action: "stalled", reason: "blocked", openCount: 1 });
    const text = JSON.stringify((await notices(w))[0]!.blocks);
    expect(text).toContain("Blocked: 1 item parked: Write part three");
    expect(text).toContain("the source file is missing");
  });

  it("follows no helper, no unfinished run, and nothing at all when switched off", async () => {
    const w = await world();
    await userRun(w);
    await addItem(w, "Write part three");
    expect((await follow(w, await endedRun(w, { trigger: "helper" }))).decision).toEqual({
      action: "none",
      reason: "trigger",
    });
    expect((await follow(w, await endedRun(w, { status: "failed" }))).decision).toEqual({
      action: "none",
      reason: "not_completed",
    });
    vi.stubEnv("OPEN_WORK_CONTINUATION", "0");
    expect((await follow(w, await endedRun(w), { config: continuityConfig() })).decision).toEqual({
      action: "none",
      reason: "disabled",
    });
  });

  it("OPEN_WORK_STALLED_NOTICE=0 ends the chain without a chat line", async () => {
    vi.stubEnv("OPEN_WORK_STALLED_NOTICE", "0");
    const w = await world();
    await userRun(w);
    await addItem(w, "Write part three");
    await ageItems(w);
    const started = await follow(w, await endedRun(w), { config: continuityConfig() });
    await runAsSystem("ran", () =>
      prisma.run.update({
        where: { id: started.continuationRunId! },
        data: { status: "completed", startedAt: new Date(Date.now() - 2_000) },
      }),
    );
    const stalled = await follow(w, await continuationRun(started.continuationRunId!), {
      toolCallCount: 0,
      config: continuityConfig(),
    });
    expect(stalled.decision.action).toBe("stalled");
    expect(await notices(w)).toHaveLength(0);
  });

  it("Stop means stop: the chat's open items start nothing until the agent moves one", async () => {
    const w = await world();
    await userRun(w);
    const itemId = await addItem(w, "Write part three");
    await ageItems(w);
    await runAsSystem("stop", () =>
      prisma.$transaction((tx) =>
        disarmOpenWorkInTransaction(tx, {
          spaceId: w.spaceId,
          threadId: w.threadId,
          botIds: [w.botId],
        }),
      ),
    );
    expect((await state(w))!.stalledReason).toBe("stopped");
    expect((await follow(w, await endedRun(w, {}, 1_000))).decision).toEqual({
      action: "none",
      reason: "no_open_work",
    });
    const working = await endedRun(w, {}, 5_000);
    await runAsSystem("touch", () =>
      updateScratchpadItemFromTool({ prisma }, { ...scope(w), itemId, notes: "asked again" }),
    );
    expect((await follow(w, working)).decision.action).toBe("continue");
  });

  it("a continuation can start helpers: they answer to the conversation that began the job", async () => {
    const w = await world();
    const origin = await userRun(w);
    await addItem(w, "Write part three");
    // The run that ended is a result run two links from the conversation.
    const ended = await endedRun(w, { trigger: "user", sourceMessageId: w.askedId });
    const outcome = await follow(w, ended);
    const next = await continuationRun(outcome.continuationRunId!);
    expect(next.delegatedFromRunId).toBe(ended.id);
    await runAsSystem("running", () =>
      prisma.run.update({ where: { id: next.id }, data: { status: "running" } }),
    );
    const ctx = {
      deps: deps(),
      run: { ...next, status: "running" },
      runId: next.id,
      bot: { id: w.botId },
      thread: { id: w.threadId, groupId: null, botId: w.botId },
      secrets: [],
    } as unknown as RunContext;
    const answer = await runAsSystem("delegate", () =>
      startBackgroundHelper(ctx, {
        name: "part",
        task: "write part three",
        instructions: "",
        modelProvider: "",
        modelId: "",
        executionId: "call-1",
        effectKey: `effect-${randomUUID()}`,
      }),
    );
    expect(answer).toMatchObject({ ok: true });
    const helper = await runAsSystem("read", () =>
      prisma.run.findFirstOrThrow({ where: { botId: w.botId, trigger: "helper" } }),
    );
    expect(helper.delegatedFromRunId).toBe(ended.id);
    expect((await runAsSystem("read", () => loadRunOrigin(prisma, helper)))?.id).toBe(ended.id);
    expect(origin.id).not.toBe(ended.id);
  });

  it("an item added by the tool belongs to the chat it was added in", async () => {
    const w = await world();
    const id = await addItem(w, "Write part three");
    const row = await runAsSystem("read", () =>
      prisma.scratchpadItem.findUniqueOrThrow({ where: { id } }),
    );
    expect(row.threadId).toBe(w.threadId);
    // An item with no chat (made before, or in the app) is not a chat's open work.
    await runAsSystem("old", () =>
      addScratchpadItemFromTool({ prisma }, { ...scope(w), title: "old note" }),
    );
    await runAsSystem("park", () =>
      updateScratchpadItemFromTool({ prisma }, { ...scope(w), itemId: id, status: "parked" }),
    );
    await userRun(w);
    expect((await follow(w, await endedRun(w, {}, 1))).decision).toEqual({
      action: "none",
      reason: "no_open_work",
    });
  });
});
