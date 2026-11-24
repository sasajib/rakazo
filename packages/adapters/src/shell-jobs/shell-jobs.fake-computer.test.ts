import type { BackgroundJob } from "@rakazo/adapter-kit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunContext } from "../runs/assembly/run-context.js";
import type { ToolCall } from "../runs/tools/run-tool-gate.js";
import { computerTools } from "../runs/tools/run-tools-computer.js";
import { LocalBashComputer } from "./local-bash-computer.test-support.js";
import type { ShellJobTestDb } from "./shell-job-db.test-support.js";
import { createShellJobTestDb, seedShellJobWorld } from "./shell-job-db.test-support.js";
import type { ShellJobDeps } from "./shell-job-poll.js";
import { claimFinishedShellJobs, pollShellJob, reconcileShellJobs } from "./shell-job-poll.js";
import { stopThreadShellJobs } from "./shell-job-stop.js";
import { shellJobToolHandlers } from "./shell-job-tools.js";

vi.mock("../secrets/bot-secrets.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../secrets/bot-secrets.js")>()),
  shellCommandEnvironment: async () => ({ env: {}, unsetEnv: [], used: [] }),
}));

vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  createThreadMessageInTransaction: vi.fn(
    async (
      tx: ShellJobTestDb,
      input: { threadId: string; role: string; blocks: unknown; clientNonce?: string },
    ) =>
      tx.message.create({
        data: {
          threadId: input.threadId,
          role: input.role,
          blocks: input.blocks,
          clientNonce: input.clientNonce ?? null,
          seq: 99,
        },
      }),
  ),
  appendEventInTransaction: vi.fn(async () => ({ seq: 7 })),
}));

const env = {
  SHELL_BACKGROUND_AFTER_MS: process.env.SHELL_BACKGROUND_AFTER_MS,
  SHELL_JOBS_PER_BOT: process.env.SHELL_JOBS_PER_BOT,
};

let computer: LocalBashComputer;
let db: ShellJobTestDb;
let ids: ReturnType<typeof seedShellJobWorld>;
let enqueued: BackgroundJob[];
let notified: number[];

beforeAll(() => {
  process.env.SHELL_BACKGROUND_AFTER_MS = "1500";
});

afterAll(() => {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  computer = new LocalBashComputer();
  db = createShellJobTestDb();
  ids = seedShellJobWorld(db, computer.computerId);
  enqueued = [];
  notified = [];
});

afterEach(async () => {
  // Nothing a test started may outlive it.
  await stopThreadShellJobs({ prisma: db as never, sandbox: computer }, ids.threadId);
  for (const job of db.shellJob.rows) {
    if (job.status === "running")
      await stopThreadShellJobs({ prisma: db as never, sandbox: computer }, String(job.threadId));
  }
  computer.dispose();
});

const jobs = { enqueue: async (job: BackgroundJob) => void enqueued.push(job) };

function deps(): ShellJobDeps {
  return {
    prisma: db as never,
    sandbox: computer,
    jobs,
    events: { notify: async (_threadId: string, seq: number) => void notified.push(seq) },
  };
}

function runContext(overrides: { trigger?: string; runId?: string } = {}) {
  const runId = overrides.runId ?? "origin-run";
  if (!db.run.rows.some((run) => run.id === runId)) {
    db.run.rows.push({
      id: runId,
      spaceId: ids.spaceId,
      botId: ids.botId,
      threadId: ids.threadId,
      userId: ids.userId,
      trigger: overrides.trigger ?? "user",
      status: "completed",
      lane: null,
      createdAt: new Date(Date.now() - 30_000),
    });
  }
  return {
    deps: {
      prisma: db,
      secretStore: {},
      jobs,
      events: { append: async () => undefined, notify: async () => undefined },
      sandbox: computer,
    },
    run: {
      id: runId,
      spaceId: ids.spaceId,
      userId: ids.userId,
      trigger: overrides.trigger ?? "user",
    },
    runId,
    bot: { id: ids.botId },
    thread: { id: ids.threadId },
    context: { signal: new AbortController().signal },
    secrets: ["hunter2"],
    computer: {
      mode: "personal",
      graphical: false,
      stored: { id: computer.computerId, kind: "docker" },
      checkpoint: { markDirty: () => undefined },
      get: async () => computer.ref,
    },
  } as unknown as RunContext;
}

async function shell(command: string, options: { background?: boolean; trigger?: string } = {}) {
  const onShellStillRunning = vi.fn();
  const call = {
    name: "shell",
    args: { command, ...(options.background ? { background: true } : {}) },
    executionId: `execution-${Math.random()}`,
    observer: { onShellStillRunning },
    finish: async (result: unknown) => result,
  } as unknown as ToolCall;
  const started = Date.now();
  const result = (await computerTools.shell!(
    runContext({ trigger: options.trigger }),
    call,
  )) as Record<string, unknown>;
  return { result, elapsedMs: Date.now() - started, onShellStillRunning };
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out waiting");
}

const job = (id: unknown) => db.shellJob.rows.find((row) => row.id === id)!;
const exited = (id: unknown) => async () => {
  const probe = await import("./shell-job-computer.js").then((m) =>
    m.probeShellJob(computer, computer.ref, String(id), {
      signal: new AbortController().signal,
    } as never),
  );
  return probe.exitCode !== null;
};
const wakeRuns = () => db.run.rows.filter((run) => run.trigger === "job_result");

describe("shell on a computer that holds background jobs (real bash)", () => {
  it("returns a fast command exactly as before and marks it returned, with nothing to wake", async () => {
    const { result } = await shell("echo hi; echo oops >&2; exit 3");
    expect(result).toEqual({ stdout: "hi\n", stderr: "oops\n", code: 3 });
    const [row] = db.shellJob.rows;
    expect(row).toMatchObject({ status: "failed", exitCode: 3, deliveredAs: "foreground" });
    expect(row?.returnedAt).toBeInstanceOf(Date);
    await pollShellJob(deps(), { jobId: String(row?.id) });
    expect(wakeRuns()).toHaveLength(0);
  });

  it("promotes a silent command after the wait, leaves pendingShells alone, then wakes the bot once", async () => {
    const { result, elapsedMs, onShellStillRunning } = await shell("sleep 2.5; echo DONE-42");
    expect(result).toMatchObject({ code: null, running: true });
    expect(String(result.notice)).toContain("moved to background job");
    expect(elapsedMs).toBeGreaterThanOrEqual(1_400);
    expect(elapsedMs).toBeLessThan(5_000);
    // The run's final turn has nothing in memory to wait for.
    expect(onShellStillRunning).not.toHaveBeenCalled();
    const id = result.job_id;
    expect(job(id)).toMatchObject({ status: "running", returnedAt: null });
    expect(enqueued.some((queued) => queued.name === "shell_job.poll")).toBe(true);

    await waitFor(exited(id));
    await pollShellJob(deps(), { jobId: String(id) });
    expect(job(id)).toMatchObject({ status: "completed", exitCode: 0, deliveredAs: "wake" });
    const [wake] = wakeRuns();
    expect(wake).toMatchObject({ status: "queued", clientNonce: `shell-job-result:${id}` });
    const task = db.task.rows.find((row) => row.id === wake?.taskId);
    expect(String(task?.prompt)).toContain("DONE-42");
    expect(enqueued.some((queued) => queued.name === "run.continue")).toBe(true);

    // Polled again (a retry, a second worker): still one wake.
    await pollShellJob(deps(), { jobId: String(id) });
    expect(wakeRuns()).toHaveLength(1);
  });

  it("starts at once with background:true", async () => {
    const { result, elapsedMs } = await shell("sleep 30", { background: true });
    expect(result).toMatchObject({ running: true });
    expect(String(result.notice)).toContain("Started as background job");
    expect(elapsedMs).toBeLessThan(1_400);
  });

  it("still returns a sign-in prompt after about a second", async () => {
    process.env.SHELL_BACKGROUND_AFTER_MS = "6000";
    try {
      const { result, elapsedMs } = await shell(
        "echo 'Open https://example.test/device and enter code ABCD-1234'; sleep 20",
      );
      expect(result).toMatchObject({ running: true });
      expect(String(result.stdout)).toContain("ABCD-1234");
      expect(elapsedMs).toBeLessThan(4_000);
    } finally {
      process.env.SHELL_BACKGROUND_AFTER_MS = "1500";
    }
  });

  it("keeps routines on the foreground shell", async () => {
    const { result } = await shell("echo routine", { trigger: "routine" });
    expect(result).toMatchObject({ code: 0 });
    expect(db.shellJob.rows).toHaveLength(0);
  });

  it("runs the fifth concurrent command in the foreground and says why", async () => {
    for (let i = 0; i < 4; i++) await shell("sleep 30", { background: true });
    expect(db.shellJob.rows.filter((row) => row.status === "running")).toHaveLength(4);
    const { result } = await shell("echo fifth");
    expect(result).toMatchObject({ code: 0, stdout: "fifth\n" });
    expect(String(result.note)).toContain("4 background jobs of this bot are already running");
    expect(db.shellJob.rows).toHaveLength(4);
  });
});

describe("delivery of a finished job, once", () => {
  async function finishedJob(command = "echo out-1") {
    const { result } = await shell(`sleep 2.5; ${command}`);
    const id = String(result.job_id);
    await waitFor(exited(id));
    return id;
  }

  it("two pollers racing make exactly one wake", async () => {
    const id = await finishedJob();
    await Promise.all([pollShellJob(deps(), { jobId: id }), pollShellJob(deps(), { jobId: id })]);
    expect(wakeRuns()).toHaveLength(1);
  });

  it("leaves the result to a run still working in the thread, which takes it once", async () => {
    const id = await finishedJob("echo for-the-working-run");
    db.run.rows.push({
      id: "working",
      threadId: ids.threadId,
      botId: ids.botId,
      trigger: "user",
      status: "running",
      createdAt: new Date(),
    });
    await pollShellJob(deps(), { jobId: id });
    expect(wakeRuns()).toHaveLength(0);
    expect(job(id)).toMatchObject({ status: "completed", returnedAt: null });

    const claim = {
      runId: "working",
      trigger: "user",
      threadId: ids.threadId,
      botId: ids.botId,
      secrets: [],
    };
    const [steered] = await claimFinishedShellJobs(deps(), claim);
    expect(steered?.stdout).toContain("for-the-working-run");
    expect(await claimFinishedShellJobs(deps(), claim)).toHaveLength(0);
    expect(job(id)).toMatchObject({ deliveredAs: "steered" });

    // The run ends; the poller must not deliver it again.
    db.run.rows.find((run) => run.id === "working")!.status = "completed";
    await pollShellJob(deps(), { jobId: id });
    expect(wakeRuns()).toHaveLength(0);
  });

  it("adds a second result to the job_result run that has not started", async () => {
    const first = await finishedJob("echo first");
    await pollShellJob(deps(), { jobId: first });
    const second = await finishedJob("echo second");
    await pollShellJob(deps(), { jobId: second });
    expect(wakeRuns()).toHaveLength(1);
    const task = db.task.rows.find((row) => row.id === wakeRuns()[0]?.taskId);
    expect(String(task?.prompt)).toContain("first");
    expect(String(task?.prompt)).toContain("Another background job finished");
    expect(String(task?.prompt)).toContain("second");
  });

  it("stops waking after six job results with no owner message, and posts the result", async () => {
    for (let i = 0; i < 6; i++) {
      db.run.rows.push({
        id: `old-wake-${i}`,
        threadId: ids.threadId,
        botId: ids.botId,
        trigger: "job_result",
        status: "completed",
        createdAt: new Date(),
      });
    }
    const id = await finishedJob();
    await pollShellJob(deps(), { jobId: id });
    expect(wakeRuns().filter((run) => run.status === "queued")).toHaveLength(0);
    expect(job(id)).toMatchObject({ deliveredAs: "budget" });
    expect(db.message.rows.some((m) => m.clientNonce === `shell-job-budget:${id}`)).toBe(true);
    expect(notified).toContain(7);

    // An owner message resets the budget.
    db.message.rows.push({
      id: "again",
      threadId: ids.threadId,
      role: "user",
      seq: 200,
      createdAt: new Date(Date.now() + 1_000),
    });
    const next = await finishedJob();
    await pollShellJob({ ...deps(), now: () => new Date(Date.now() + 2_000) }, { jobId: next });
    expect(job(next)).toMatchObject({ deliveredAs: "wake" });
  });
});

describe("timeouts, failures, stop and restarts", () => {
  it("kills a job at its deadline and reports it timed_out", async () => {
    const { result } = await shell("sleep 60", { background: true });
    const id = String(result.job_id);
    job(id).deadlineAt = new Date(Date.now() - 1_000);
    await pollShellJob(deps(), { jobId: id });
    expect(job(id)).toMatchObject({ status: "timed_out", deliveredAs: "wake" });
    expect(await exited(id)().catch(() => false)).toBe(false);
    const probe = await import("./shell-job-computer.js").then((m) =>
      m.probeShellJob(computer, computer.ref, id, {
        signal: new AbortController().signal,
      } as never),
    );
    expect(probe.alive).toBe(false);
  });

  it("gives a job up as lost after ten failed polls in a row, and reports it", async () => {
    const { result } = await shell("sleep 60", { background: true });
    const id = String(result.job_id);
    computer.failNext = 100;
    for (let i = 0; i < 10; i++) await pollShellJob(deps(), { jobId: id });
    expect(job(id)).toMatchObject({ status: "lost", deliveredAs: "wake" });
    computer.failNext = 0;
  });

  it("job_stop kills the job and nothing wakes", async () => {
    const { result } = await shell("sleep 60", { background: true });
    const id = String(result.job_id);
    const stopped = (await shellJobToolHandlers.job_stop!(runContext(), {
      args: { job_id: id },
      finish: async (value: unknown) => value,
    } as unknown as ToolCall)) as Record<string, unknown>;
    expect(stopped).toMatchObject({ job_id: id, stopped: true });
    expect(job(id)).toMatchObject({ status: "killed", deliveredAs: "none" });
    await pollShellJob(deps(), { jobId: id });
    expect(wakeRuns()).toHaveLength(0);
    const listed = (await shellJobToolHandlers.job_list!(runContext(), {
      args: {},
      finish: async (value: unknown) => value,
    } as unknown as ToolCall)) as { jobs: Array<{ job_id: string; status: string }> };
    expect(listed.jobs).toEqual([expect.objectContaining({ job_id: id, status: "killed" })]);
  });

  it("the owner's thread Stop stops that thread's jobs only", async () => {
    const { result } = await shell("sleep 60", { background: true });
    const id = String(result.job_id);
    db.thread.rows.push({ id: "other-thread", spaceId: ids.spaceId });
    const other = await shell("sleep 60", { background: true });
    job(other.result.job_id).threadId = "other-thread";
    expect(
      await stopThreadShellJobs({ prisma: db as never, sandbox: computer }, ids.threadId),
    ).toBe(1);
    expect(job(id)).toMatchObject({ status: "killed" });
    expect(job(other.result.job_id)).toMatchObject({ status: "running" });
  });

  it("a run that ends normally leaves its jobs running", async () => {
    const { result } = await shell("sleep 60", { background: true });
    db.run.rows.find((run) => run.id === "origin-run")!.status = "completed";
    await pollShellJob(deps(), { jobId: String(result.job_id) });
    expect(job(result.job_id)).toMatchObject({ status: "running" });
  });

  it("after a worker restart, a fresh poller finds the job on the computer and wakes once", async () => {
    const { result } = await shell("sleep 2.5; echo survived-restart");
    const id = String(result.job_id);
    // The process that ran the tool is gone: nothing of it is kept but the row and the computer.
    enqueued = [];
    await waitFor(exited(id));
    job(id).nextPollAt = new Date(Date.now() - 5 * 60_000);
    await reconcileShellJobs({ prisma: db as never, jobs });
    expect(enqueued).toEqual([
      expect.objectContaining({ name: "shell_job.poll", payload: { jobId: id } }),
    ]);
    const restarted: ShellJobDeps = { ...deps(), sandbox: computer };
    await pollShellJob(restarted, { jobId: id });
    expect(wakeRuns()).toHaveLength(1);
    const task = db.task.rows.find((row) => row.id === wakeRuns()[0]?.taskId);
    expect(String(task?.prompt)).toContain("survived-restart");
  });

  it("reports a job whose computer vanished as lost", async () => {
    const { result } = await shell("sleep 60", { background: true });
    const id = String(result.job_id);
    db.computer.rows[0]!.providerRef = null;
    await pollShellJob(deps(), { jobId: id });
    expect(job(id)).toMatchObject({ status: "lost", deliveredAs: "wake" });
    db.computer.rows[0]!.providerRef = "local";
  });
});
