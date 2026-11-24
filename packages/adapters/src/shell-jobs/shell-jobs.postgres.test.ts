import { randomUUID } from "node:crypto";
import type {
  BackgroundJob,
  CommandRequest,
  ProcessEvent,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { createDb, createThreadMessage, runAsSystem, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ShellJobDeps } from "./shell-job-poll.js";
import { claimFinishedShellJobs, deliverShellJobResult, pollShellJob } from "./shell-job-poll.js";
import { stopThreadShellJobs } from "./shell-job-stop.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

/** A computer whose jobs all ended: the probe reports `exit`, the kill succeeds. */
function endedComputer(
  exit: number | null,
  stdout = "job output\n",
): Pick<SandboxProvider, "execute"> & {
  kills: number;
} {
  const computer = {
    kills: 0,
    async *execute(_ref: unknown, request: CommandRequest): AsyncIterable<ProcessEvent> {
      const name = request.argv[3];
      if (name === "rakazo-job-kill") {
        computer.kills += 1;
        yield { type: "exit", code: 0 };
        return;
      }
      if (name === "rakazo-job-probe") {
        const alive = exit === null ? 1 : 0;
        yield { type: "stdout", data: `present=1 alive=${alive} exit=${exit ?? ""}\n${stdout}` };
        yield { type: "exit", code: 0 };
        return;
      }
      yield { type: "exit", code: 1 };
    },
  };
  return computer;
}

describePostgres("shell_jobs (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let db: ReturnType<typeof createDb>;
  const owners: string[] = [];
  const enqueued: BackgroundJob[] = [];
  const jobs = { enqueue: async (job: BackgroundJob) => void enqueued.push(job) };

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

  async function world() {
    const id = randomUUID();
    owners.push(id);
    return runAsSystem("test fixture", async () => {
      await prisma.user.create({
        data: { id, name: "Jobs test", email: `${id}@example.test`, emailVerified: true },
      });
      await prisma.organization.create({
        data: { id, name: "Jobs", slug: id, createdAt: new Date() },
      });
      await prisma.space.create({
        data: { id, organizationId: id, name: "Jobs", isDefault: true },
      });
      await prisma.member.create({
        data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
      });
      const bot = await prisma.bot.create({
        data: { spaceId: id, userId: id, name: "Jobs", color: "test-color" },
      });
      const thread = await prisma.thread.create({
        data: { spaceId: id, userId: id, botId: bot.id },
      });
      const computer = await prisma.computer.create({
        data: {
          spaceId: id,
          userId: id,
          scopeKey: `scope-${id}`,
          homeKey: `home-${id}`,
          kind: "docker",
          providerRef: `ref-${id}`,
          state: "running",
        },
      });
      const task = await prisma.task.create({
        data: {
          spaceId: id,
          userId: id,
          botId: bot.id,
          threadId: thread.id,
          prompt: "go",
          status: "completed",
        },
      });
      const origin = await prisma.run.create({
        data: {
          spaceId: id,
          userId: id,
          botId: bot.id,
          threadId: thread.id,
          taskId: task.id,
          status: "completed",
          trigger: "user",
        },
      });
      return {
        spaceId: id,
        userId: id,
        botId: bot.id,
        threadId: thread.id,
        computerId: computer.id,
        originRunId: origin.id,
      };
    });
  }

  type World = Awaited<ReturnType<typeof world>>;
  const tenant = (w: World) => ({ spaceId: w.spaceId, userId: w.userId });

  function addJob(w: World, data: Record<string, unknown> = {}) {
    return runAsTenant(tenant(w), () =>
      prisma.shellJob.create({
        data: {
          id: randomUUID().replaceAll("-", ""),
          spaceId: w.spaceId,
          botId: w.botId,
          threadId: w.threadId,
          userId: w.userId,
          originRunId: w.originRunId,
          computerId: w.computerId,
          commandPreview: "make build",
          jobDir: "~/.rakazo/jobs/x",
          deadlineAt: new Date(Date.now() + 3_600_000),
          ...data,
        },
      }),
    );
  }

  const deps = (sandbox: Pick<SandboxProvider, "execute">): ShellJobDeps => ({
    prisma,
    sandbox,
    jobs,
    events: { notify: async () => undefined },
  });

  it("keeps a job inside its Space (row-level security)", async () => {
    const a = await world();
    const b = await world();
    const job = await addJob(a);
    expect(
      await runAsTenant(tenant(a), () => prisma.shellJob.findUnique({ where: { id: job.id } })),
    ).not.toBeNull();
    expect(
      await runAsTenant(tenant(b), () => prisma.shellJob.findUnique({ where: { id: job.id } })),
    ).toBeNull();
    expect(
      await runAsTenant(tenant(b), () =>
        prisma.shellJob.updateMany({ where: { id: job.id }, data: { cancelRequested: true } }),
      ),
    ).toEqual({ count: 0 });
  });

  it("delivers a finished job exactly once when pollers race, as one job_result run", async () => {
    const w = await world();
    const job = await addJob(w);
    const computer = endedComputer(0, "BUILD-OK\n");
    await runAsTenant(tenant(w), () =>
      Promise.all([0, 1, 2, 3].map(() => pollShellJob(deps(computer), { jobId: job.id }))),
    );
    const { runs, row, task } = await runAsTenant(tenant(w), async () => {
      const runs = await prisma.run.findMany({
        where: { threadId: w.threadId, trigger: "job_result" },
      });
      const row = await prisma.shellJob.findUniqueOrThrow({ where: { id: job.id } });
      const task = runs[0]?.taskId
        ? await prisma.task.findUnique({ where: { id: runs[0].taskId } })
        : null;
      return { runs, row, task };
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "queued", clientNonce: `shell-job-result:${job.id}` });
    expect(row).toMatchObject({
      status: "completed",
      exitCode: 0,
      deliveredAs: "wake",
      wakeRunId: runs[0]?.id,
    });
    // The prompt is sealed like every task prompt and reads back whole.
    expect(task?.prompt).toContain("BUILD-OK");
  });

  it("delivers an ended, unreturned job once when poll ticks race (claim-once guards)", async () => {
    // The real path: the job ended while a run of the bot was working, so its delivery was
    // deferred; the run then ended and two poll ticks (the scheduled one and the reconciler's)
    // run at once. Both find it ended and unreturned; only the returnedAt claim keeps it single.
    const w = await world();
    const job = await addJob(w, { status: "completed", exitCode: 0, finishedAt: new Date() });
    const computer = endedComputer(0, "ONCE\n");
    const stale = await runAsTenant(tenant(w), () =>
      prisma.shellJob.findUniqueOrThrow({ where: { id: job.id } }),
    );
    await runAsTenant(tenant(w), () =>
      Promise.all([
        ...[0, 1, 2].map(() => pollShellJob(deps(computer), { jobId: job.id })),
        // A delivery holding a stale read of the row, as a second worker would.
        ...[0, 1].map(() => deliverShellJobResult(deps(computer), stale)),
      ]),
    );
    const { wakes, steered, row } = await runAsTenant(tenant(w), async () => ({
      wakes: await prisma.run.count({ where: { threadId: w.threadId, trigger: "job_result" } }),
      steered: await claimFinishedShellJobs(deps(computer), {
        runId: "late-run",
        trigger: "user",
        threadId: w.threadId,
        botId: w.botId,
        secrets: [],
      }),
      row: await prisma.shellJob.findUniqueOrThrow({ where: { id: job.id } }),
    }));
    expect(wakes).toBe(1);
    expect(steered).toHaveLength(0);
    expect(row).toMatchObject({ deliveredAs: "wake" });
    // One delivery, not one run carrying the same result several times (coalescing would hide it).
    const prompt = await runAsTenant(tenant(w), async () => {
      const run = await prisma.run.findFirstOrThrow({
        where: { threadId: w.threadId, trigger: "job_result" },
      });
      return (await prisma.task.findUniqueOrThrow({ where: { id: run.taskId! } })).prompt;
    });
    expect(prompt.match(/ONCE/g)).toHaveLength(1);
    expect(prompt).not.toContain("Another background job finished");
  });

  it("takes the thread lock in the same order as a message send: no deadlock, one outcome", async () => {
    const w = await world();
    const job = await addJob(w);
    const computer = endedComputer(0);
    await runAsTenant(tenant(w), () =>
      Promise.all([
        pollShellJob(deps(computer), { jobId: job.id }),
        ...[0, 1, 2].map((n) =>
          createThreadMessage(prisma, {
            threadId: w.threadId,
            role: "user",
            authorUserId: w.userId,
            blocks: [{ kind: "text", text: `owner message ${n}` }],
          }),
        ),
        pollShellJob(deps(computer), { jobId: job.id }),
      ]),
    );
    const row = await runAsTenant(tenant(w), () =>
      prisma.shellJob.findUniqueOrThrow({ where: { id: job.id } }),
    );
    expect(row.returnedAt).not.toBeNull();
    const wakes = await runAsTenant(tenant(w), () =>
      prisma.run.count({ where: { threadId: w.threadId, trigger: "job_result" } }),
    );
    expect(wakes).toBe(1);
  });

  it("leaves the result to a working run, whose steering claim takes it once", async () => {
    const w = await world();
    const job = await addJob(w);
    const working = await runAsTenant(tenant(w), async () =>
      prisma.run.create({
        data: {
          taskId: (
            await prisma.task.create({
              data: {
                spaceId: w.spaceId,
                userId: w.userId,
                botId: w.botId,
                threadId: w.threadId,
                prompt: "working",
                status: "running",
              },
            })
          ).id,
          spaceId: w.spaceId,
          userId: w.userId,
          botId: w.botId,
          threadId: w.threadId,
          status: "running",
          trigger: "user",
        },
      }),
    );
    const computer = endedComputer(2, "boom\n");
    await runAsTenant(tenant(w), () => pollShellJob(deps(computer), { jobId: job.id }));
    const deferred = await runAsTenant(tenant(w), () =>
      prisma.shellJob.findUniqueOrThrow({ where: { id: job.id } }),
    );
    expect(deferred).toMatchObject({ status: "failed", returnedAt: null });
    const claim = {
      runId: working.id,
      trigger: "user",
      threadId: w.threadId,
      botId: w.botId,
      secrets: [],
    };
    const [first, second] = await runAsTenant(tenant(w), () =>
      Promise.all([
        claimFinishedShellJobs(deps(computer), claim),
        claimFinishedShellJobs(deps(computer), claim),
      ]),
    );
    expect([...(first ?? []), ...(second ?? [])]).toHaveLength(1);
    await runAsTenant(tenant(w), () => deliverShellJobResult(deps(computer), deferred));
    expect(
      await runAsTenant(tenant(w), () =>
        prisma.run.count({ where: { threadId: w.threadId, trigger: "job_result" } }),
      ),
    ).toBe(0);
  });

  it("adds a second result to the queued job_result run under its row lock", async () => {
    const w = await world();
    const computer = endedComputer(0, "one\n");
    const a = await addJob(w);
    const b = await addJob(w);
    await runAsTenant(tenant(w), () => pollShellJob(deps(computer), { jobId: a.id }));
    await runAsTenant(tenant(w), () =>
      pollShellJob(deps(endedComputer(0, "two\n")), { jobId: b.id }),
    );
    const runs = await runAsTenant(tenant(w), () =>
      prisma.run.findMany({ where: { threadId: w.threadId, trigger: "job_result" } }),
    );
    expect(runs).toHaveLength(1);
    const task = await runAsTenant(tenant(w), () =>
      prisma.task.findUniqueOrThrow({ where: { id: runs[0]!.taskId! } }),
    );
    expect(task.prompt).toContain("one");
    expect(task.prompt).toContain("two");
  });

  it("the owner's Stop stops the thread's running jobs; a run that ends does not", async () => {
    const w = await world();
    const running = await addJob(w);
    const computer = endedComputer(null);
    await runAsTenant(tenant(w), () =>
      prisma.run.update({ where: { id: w.originRunId }, data: { status: "completed" } }),
    );
    await runAsTenant(tenant(w), () => pollShellJob(deps(computer), { jobId: running.id }));
    expect(
      await runAsTenant(tenant(w), () =>
        prisma.shellJob.findUniqueOrThrow({ where: { id: running.id } }),
      ),
    ).toMatchObject({ status: "running", returnedAt: null });
    expect(
      await runAsTenant(tenant(w), () =>
        stopThreadShellJobs({ prisma, sandbox: computer }, w.threadId),
      ),
    ).toBe(1);
    expect(computer.kills).toBe(1);
    const stopped = await runAsTenant(tenant(w), () =>
      prisma.shellJob.findUniqueOrThrow({ where: { id: running.id } }),
    );
    expect(stopped).toMatchObject({ status: "killed", deliveredAs: "none" });
    await runAsTenant(tenant(w), () => pollShellJob(deps(computer), { jobId: running.id }));
    expect(
      await runAsTenant(tenant(w), () =>
        prisma.run.count({ where: { threadId: w.threadId, trigger: "job_result" } }),
      ),
    ).toBe(0);
  });

  it("cascades away with its bot", async () => {
    const w = await world();
    const job = await addJob(w);
    await runAsSystem("test", () => prisma.thread.delete({ where: { id: w.threadId } }));
    expect(
      await runAsSystem("test", () => prisma.shellJob.findUnique({ where: { id: job.id } })),
    ).toBeNull();
  });
});
