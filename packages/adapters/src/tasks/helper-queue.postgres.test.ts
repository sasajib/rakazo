import { randomUUID } from "node:crypto";
import type { BackgroundJob } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { createDb, createThreadMessage, runAsSystem, runAsTenant } from "@rakazo/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { RunContext } from "../runs/assembly/run-context.js";
import { loadRunOrigin } from "../runs/lifecycle/run-origin.js";
import { returnHelperOutcome, startBackgroundHelper } from "./background-helpers.js";
import { QUEUED_HELPER_PROGRESS } from "./background-helpers.prompt.js";
import {
  cancelQueuedHelpersInTransaction,
  startAllQueuedHelpers,
  startQueuedHelpers,
} from "./helper-queue.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

/** Fork (FORK.md 1.33): helpers beyond the cap queue and start by themselves; waves chain. */
describePostgres("queued helpers and helper waves (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let db: ReturnType<typeof createDb>;
  const owners: string[] = [];
  const enqueued: BackgroundJob[] = [];
  const jobs = { enqueue: async (job: BackgroundJob) => void enqueued.push(job) };
  const events = { notify: async () => undefined };

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
        data: { id, name: "Queue test", email: `${id}@example.test`, emailVerified: true },
      });
      await prisma.organization.create({
        data: { id, name: "Queue", slug: id, createdAt: new Date() },
      });
      await prisma.space.create({
        data: { id, organizationId: id, name: "Queue", isDefault: true },
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
      const asked = await createThreadMessage(prisma, {
        threadId: thread.id,
        role: "user",
        authorUserId: id,
        botId: bot.id,
        blocks: [{ kind: "text", text: "do the long job" }],
      });
      const task = await prisma.task.create({
        data: {
          spaceId: id,
          userId: id,
          botId: bot.id,
          threadId: thread.id,
          prompt: "do the long job",
          status: "running",
        },
      });
      const origin = await prisma.run.create({
        data: {
          spaceId: id,
          userId: id,
          botId: bot.id,
          threadId: thread.id,
          taskId: task.id,
          status: "running",
          trigger: "user",
          sourceMessageId: asked.id,
        },
      });
      return { spaceId: id, userId: id, botId: bot.id, threadId: thread.id, origin };
    });
  }

  type World = Awaited<ReturnType<typeof world>>;
  const deps = () =>
    ({ prisma, events, jobs }) as unknown as Parameters<typeof startQueuedHelpers>[0];

  function ctxFor(w: World, run: World["origin"]): RunContext {
    return {
      deps: deps(),
      run,
      runId: run.id,
      bot: { id: w.botId },
      thread: { id: w.threadId, groupId: null, botId: w.botId },
      secrets: [],
    } as unknown as RunContext;
  }

  let call = 0;
  function ask(w: World, run: World["origin"], effectKey = `effect-${++call}-${randomUUID()}`) {
    return runAsSystem("run", () =>
      startBackgroundHelper(ctxFor(w, run), {
        name: `part ${call}`,
        task: `do part ${call}`,
        instructions: "",
        modelProvider: "",
        modelId: "",
        executionId: `call-${call}`,
        effectKey,
      }),
    );
  }

  const helperRuns = (w: World) =>
    runAsSystem("read", () =>
      prisma.run.findMany({
        where: { botId: w.botId, trigger: "helper" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
    );
  const queueRows = (w: World) =>
    runAsSystem("read", () =>
      prisma.queuedHelper.findMany({
        where: { botId: w.botId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
    );
  async function card(messageId: string) {
    const row = await runAsSystem("read", () =>
      prisma.message.findUniqueOrThrow({ where: { id: messageId }, select: { blocks: true } }),
    );
    return (row.blocks as Array<Record<string, unknown>>)[0]!;
  }
  async function finish(w: World, runId: string) {
    await runAsSystem("helper ends", () =>
      prisma.run.update({
        where: { id: runId },
        data: { status: "completed", completedAt: new Date() },
      }),
    );
    const run = await runAsSystem("read", () =>
      prisma.run.findUniqueOrThrow({ where: { id: runId } }),
    );
    await runAsSystem("outcome", () =>
      returnHelperOutcome(deps(), run, { status: "completed", text: `result of ${runId}` }),
    );
    return w;
  }

  it("accepts helpers beyond the cap, and starts each when a slot frees, with no model turn", async () => {
    const w = await world();
    const answers = [];
    for (let n = 0; n < 6; n++) answers.push(await ask(w, w.origin));
    expect(answers.slice(0, 4).every((a) => "ok" in a && !("queued" in a))).toBe(true);
    expect(answers[4]).toMatchObject({ ok: true, queued: true });
    expect(answers[5]).toMatchObject({
      ok: true,
      queued: true,
      note: expect.stringContaining("starts by itself"),
    });
    expect(await helperRuns(w)).toHaveLength(4);
    const queued = await queueRows(w);
    expect(queued.map((row) => row.status)).toEqual(["queued", "queued"]);
    expect(await card(queued[0]!.cardMessageId)).toMatchObject({
      kind: "subagent",
      status: "running",
      progress: QUEUED_HELPER_PROGRESS,
    });

    // One helper reports back: the platform starts the oldest queued one at once.
    enqueued.length = 0;
    const [first] = await helperRuns(w);
    await finish(w, first!.id);
    const after = await queueRows(w);
    expect(after.map((row) => row.status)).toEqual(["started", "queued"]);
    const started = await runAsSystem("read", () =>
      prisma.run.findUniqueOrThrow({ where: { id: after[0]!.helperRunId! } }),
    );
    expect(started).toMatchObject({
      trigger: "helper",
      status: "queued",
      sourceMessageId: after[0]!.cardMessageId,
      delegatedFromRunId: w.origin.id,
      clientNonce: after[0]!.clientNonce,
      taskId: after[0]!.taskId,
      threadId: after[0]!.helperThreadId,
    });
    expect(enqueued.map((job) => JSON.stringify(job))).toEqual(
      expect.arrayContaining([expect.stringContaining(started.id)]),
    );
    const startedCard = await card(after[0]!.cardMessageId);
    expect(startedCard).toMatchObject({ status: "running" });
    expect(startedCard.progress).toBeUndefined();
    // Never more than the cap at work.
    const active = (await helperRuns(w)).filter((run) => run.status !== "completed");
    expect(active).toHaveLength(4);
  });

  it("queues nothing twice when the same call is replayed", async () => {
    const w = await world();
    for (let n = 0; n < 4; n++) await ask(w, w.origin);
    const key = `replay-${randomUUID()}`;
    expect(await ask(w, w.origin, key)).toMatchObject({ queued: true });
    expect(await ask(w, w.origin, key)).toMatchObject({ queued: true });
    expect(await queueRows(w)).toHaveLength(1);
  });

  it("lets the run that receives a result start the next wave, authorized by the first conversation", async () => {
    const w = await world();
    await ask(w, w.origin);
    const [first] = await helperRuns(w);
    await finish(w, first!.id);
    const resultRun = await runAsSystem("read", () =>
      prisma.run.findFirstOrThrow({ where: { threadId: w.threadId, trigger: "helper_result" } }),
    );
    // Wave two, asked for by the result run.
    expect(await ask(w, resultRun)).toMatchObject({ ok: true });
    const wave2 = (await helperRuns(w)).at(-1)!;
    expect(wave2.delegatedFromRunId).toBe(w.origin.id);
    // Its own result run starts wave three: the chain to the conversation stays two links.
    await finish(w, wave2.id);
    const resultRun2 = await runAsSystem("read", () =>
      prisma.run.findFirstOrThrow({
        where: { threadId: w.threadId, trigger: "helper_result", delegatedFromRunId: wave2.id },
      }),
    );
    expect(await ask(w, resultRun2)).toMatchObject({ ok: true });
    const wave3 = (await helperRuns(w)).at(-1)!;
    expect(wave3.delegatedFromRunId).toBe(w.origin.id);
    const origin = await runAsSystem("read", () => loadRunOrigin(prisma, wave3));
    expect(origin?.id).toBe(w.origin.id);
    const resultOrigin = await runAsSystem("read", () => loadRunOrigin(prisma, resultRun2));
    expect(resultOrigin?.id).toBe(w.origin.id);
  });

  it("Stop cancels the helpers still queued and settles their cards; none starts later", async () => {
    const w = await world();
    for (let n = 0; n < 6; n++) await ask(w, w.origin);
    const [keep, stop] = await queueRows(w);
    // Stop on one card only.
    const one = await runAsSystem("stop", () =>
      prisma.$transaction((tx) =>
        cancelQueuedHelpersInTransaction(tx, {
          threadId: w.threadId,
          cardMessageId: stop!.cardMessageId,
        }),
      ),
    );
    expect(one.cancelled).toBe(1);
    expect(await card(stop!.cardMessageId)).toMatchObject({ status: "failed", result: "stopped" });
    expect((await queueRows(w)).map((row) => row.status)).toEqual(["queued", "cancelled"]);
    // Stop on the whole chat.
    const all = await runAsSystem("stop", () =>
      prisma.$transaction((tx) => cancelQueuedHelpersInTransaction(tx, { threadId: w.threadId })),
    );
    expect(all.cancelled).toBe(1);
    expect(await card(keep!.cardMessageId)).toMatchObject({ status: "failed", result: "stopped" });
    const [first] = await helperRuns(w);
    await finish(w, first!.id);
    expect(await helperRuns(w)).toHaveLength(4);
    expect(await runAsSystem("drain", () => startQueuedHelpers(deps(), w.botId))).toBe(0);
  });

  it("the reconciler's pass starts a queued helper whose slot freed unseen", async () => {
    const w = await world();
    for (let n = 0; n < 5; n++) await ask(w, w.origin);
    const [first] = await helperRuns(w);
    // The helper ended and its outcome was claimed, but the start after it was lost.
    await runAsSystem("lost", () =>
      prisma.run.update({
        where: { id: first!.id },
        data: { status: "failed", completedAt: new Date(), botOutcomeReturnedAt: new Date() },
      }),
    );
    expect(await runAsSystem("tick", () => startAllQueuedHelpers(deps()))).toBeGreaterThanOrEqual(
      1,
    );
    expect((await queueRows(w)).map((row) => row.status)).toEqual(["started"]);
  });

  it("refuses beyond the queue's length, and beyond the cap when HELPER_QUEUE=0", async () => {
    const w = await world();
    vi.stubEnv("HELPER_QUEUE_MAX", "1");
    for (let n = 0; n < 5; n++) await ask(w, w.origin);
    expect(await ask(w, w.origin)).toEqual({
      error: expect.stringContaining("1 more are queued"),
    });
    expect(await queueRows(w)).toHaveLength(1);

    const off = await world();
    vi.stubEnv("HELPER_QUEUE", "0");
    for (let n = 0; n < 4; n++) await ask(off, off.origin);
    expect(await ask(off, off.origin)).toEqual({
      error: expect.stringContaining("4 subagents are already working"),
    });
    expect(await queueRows(off)).toHaveLength(0);
  });

  it("keeps a queued helper inside its Space (row-level security)", async () => {
    const a = await world();
    const b = await world();
    for (let n = 0; n < 5; n++) await ask(a, a.origin);
    const [row] = await queueRows(a);
    const tenant = (w: World) => ({ spaceId: w.spaceId, userId: w.userId });
    expect(
      await runAsTenant(tenant(a), () =>
        prisma.queuedHelper.findUnique({ where: { id: row!.id } }),
      ),
    ).not.toBeNull();
    expect(
      await runAsTenant(tenant(b), () =>
        prisma.queuedHelper.findUnique({ where: { id: row!.id } }),
      ),
    ).toBeNull();
  });
});
