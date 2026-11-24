import { describe, expect, it } from "vitest";
import {
  commandPreview,
  DEFAULT_SHELL_JOB_CONFIG,
  foregroundWaitMs,
  headAndTail,
  isShellJobId,
  MAX_DEFER_MS,
  MAX_POLL_ERRORS,
  nextShellJobStep,
  pollFailureStep,
  pollIntervalMs,
  routeShellJobResult,
  runMayStartShellJobs,
  shellJobConfig,
  shellJobEligibility,
} from "./shell-job-rules.js";

const start = new Date("2027-01-10T09:00:00Z");
const at = (ms: number) => new Date(start.getTime() + ms);
const deadline = at(2 * 60 * 60 * 1000);

describe("shellJobConfig", () => {
  it("defaults to the design's limits", () => {
    expect(shellJobConfig({})).toEqual(DEFAULT_SHELL_JOB_CONFIG);
  });

  it("reads and clamps the env settings, and can be switched off", () => {
    const config = shellJobConfig({
      SHELL_BACKGROUND_JOBS: "0",
      SHELL_BACKGROUND_AFTER_MS: "0",
      SHELL_JOB_MAX_MS: "5",
      SHELL_JOBS_PER_BOT: "999",
      SHELL_JOB_MAX_WAKES: "nope",
    });
    expect(config).toMatchObject({
      enabled: false,
      backgroundAfterMs: 0,
      maxMs: 10_000,
      perBot: 32,
      maxWakesInARow: 6,
    });
  });
});

describe("which runs may start jobs", () => {
  it.each([
    ["user", true],
    ["follow_up", true],
    ["call_end", true],
    ["job_result", true],
    ["cloud_agent", true],
    ["helper_result", true],
    ["talk", false],
    ["helper", false],
    ["routine", false],
    ["webhook", false],
    ["bot_message", false],
    ["tickets", false],
    ["created", false],
    ["messaging", false],
  ])("%s → %s", (trigger, allowed) => {
    expect(runMayStartShellJobs(trigger)).toBe(allowed);
  });
});

describe("shellJobEligibility (promote decision)", () => {
  const base = {
    config: DEFAULT_SHELL_JOB_CONFIG,
    trigger: "user",
    linuxComputer: true,
    runningForBot: 0,
    runningForSpace: 0,
  };

  it("makes a job of a shell call in the owner's run on a Linux computer", () => {
    expect(shellJobEligibility(base)).toEqual({ job: true });
  });

  it("keeps the foreground shell when switched off, on other computers and other runs", () => {
    expect(shellJobEligibility({ ...base, config: { ...base.config, enabled: false } })).toEqual({
      job: false,
      reason: "disabled",
    });
    expect(shellJobEligibility({ ...base, linuxComputer: false })).toMatchObject({
      reason: "computer",
    });
    expect(shellJobEligibility({ ...base, trigger: "routine" })).toMatchObject({ reason: "run" });
  });

  it("runs the fifth command in the foreground with a reason (4 per bot)", () => {
    expect(shellJobEligibility({ ...base, runningForBot: 3 })).toEqual({ job: true });
    expect(shellJobEligibility({ ...base, runningForBot: 4 })).toEqual({
      job: false,
      reason: "bot_limit",
    });
    expect(shellJobEligibility({ ...base, runningForSpace: 12 })).toEqual({
      job: false,
      reason: "space_limit",
    });
  });

  it("waits 8 s by default, none with background:true, and never past the job cap", () => {
    expect(foregroundWaitMs(DEFAULT_SHELL_JOB_CONFIG, false)).toBe(8_000);
    expect(foregroundWaitMs(DEFAULT_SHELL_JOB_CONFIG, true)).toBe(0);
    expect(foregroundWaitMs({ ...DEFAULT_SHELL_JOB_CONFIG, backgroundAfterMs: 0 }, false)).toBe(0);
    expect(foregroundWaitMs({ ...DEFAULT_SHELL_JOB_CONFIG, maxMs: 3_000 }, false)).toBe(3_000);
  });
});

describe("nextShellJobStep (job state machine)", () => {
  const step = (
    probe: { exitCode: number | null; alive: boolean; present: boolean },
    options: { cancelRequested?: boolean; now?: Date } = {},
  ) =>
    nextShellJobStep({
      probe,
      cancelRequested: options.cancelRequested ?? false,
      deadlineAt: deadline,
      now: options.now ?? at(20_000),
      startedAt: start,
    });

  it("keeps waiting while the job runs, backing off with its age", () => {
    expect(step({ exitCode: null, alive: true, present: true })).toEqual({
      kind: "wait",
      nextPollInMs: 5_000,
    });
    expect(step({ exitCode: null, alive: true, present: true }, { now: at(45_000) })).toMatchObject(
      {
        nextPollInMs: 10_000,
      },
    );
    expect(pollIntervalMs(10 * 60_000)).toBe(60_000);
  });

  it("maps an exit status to completed or failed", () => {
    expect(step({ exitCode: 0, alive: false, present: true })).toEqual({
      kind: "finish",
      status: "completed",
      exitCode: 0,
    });
    expect(step({ exitCode: 3, alive: false, present: true })).toEqual({
      kind: "finish",
      status: "failed",
      exitCode: 3,
    });
  });

  it("calls the wrapper's own timeout at the deadline timed_out, but not an early 124", () => {
    expect(step({ exitCode: 124, alive: false, present: true }, { now: deadline })).toMatchObject({
      status: "timed_out",
    });
    expect(step({ exitCode: 124, alive: false, present: true })).toMatchObject({
      status: "failed",
    });
  });

  it("kills a job past its deadline and reports it timed_out", () => {
    expect(
      step({ exitCode: null, alive: true, present: true }, { now: at(3 * 3_600_000) }),
    ).toEqual({
      kind: "kill",
      status: "timed_out",
    });
  });

  it("kills a job the owner or the bot stopped, and settles it killed once it is gone", () => {
    expect(step({ exitCode: null, alive: true, present: true }, { cancelRequested: true })).toEqual(
      {
        kind: "kill",
        status: "killed",
      },
    );
    expect(step({ exitCode: 143, alive: false, present: true }, { cancelRequested: true })).toEqual(
      {
        kind: "finish",
        status: "killed",
        exitCode: 143,
      },
    );
  });

  it("calls a job lost when its folder vanished or its process died without an exit status", () => {
    expect(step({ exitCode: null, alive: false, present: false })).toMatchObject({
      status: "lost",
    });
    expect(step({ exitCode: null, alive: false, present: true })).toMatchObject({ status: "lost" });
  });

  it("retries failed polls with back-off and gives up after ten in a row", () => {
    expect(pollFailureStep(0)).toEqual({ kind: "wait", nextPollInMs: 5_000 });
    expect(pollFailureStep(3)).toEqual({ kind: "wait", nextPollInMs: 40_000 });
    expect(pollFailureStep(MAX_POLL_ERRORS - 2)).toMatchObject({ kind: "wait" });
    expect(pollFailureStep(MAX_POLL_ERRORS - 1)).toEqual({
      kind: "finish",
      status: "lost",
      exitCode: null,
    });
  });
});

describe("routeShellJobResult (delivery)", () => {
  const base = {
    status: "completed" as const,
    detached: false,
    workingRunInThread: false,
    finishedAt: at(0),
    now: at(1_000),
    queuedJobResultRunId: null,
    wakesSinceOwnerMessage: 0,
    maxWakesInARow: 6,
  };

  it("wakes the bot when nobody is working in the thread", () => {
    expect(routeShellJobResult(base)).toEqual({ kind: "wake" });
  });

  it("leaves the result to a run of the bot still working there", () => {
    expect(routeShellJobResult({ ...base, workingRunInThread: true })).toEqual({
      kind: "defer",
      retryInMs: 5_000,
    });
  });

  it("stops deferring to a run stuck in one long step", () => {
    expect(
      routeShellJobResult({ ...base, workingRunInThread: true, now: at(MAX_DEFER_MS + 1) }),
    ).toEqual({ kind: "wake" });
  });

  it("adds the result to a job_result run that is still queued instead of waking twice", () => {
    expect(routeShellJobResult({ ...base, queuedJobResultRunId: "run-9" })).toEqual({
      kind: "coalesce",
      runId: "run-9",
    });
  });

  it("stops waking after six job results in a row with no owner message", () => {
    expect(routeShellJobResult({ ...base, wakesSinceOwnerMessage: 5 })).toEqual({ kind: "wake" });
    expect(routeShellJobResult({ ...base, wakesSinceOwnerMessage: 6 })).toEqual({ kind: "budget" });
  });

  it("delivers nothing for a stopped job or a detached chat", () => {
    expect(routeShellJobResult({ ...base, status: "killed" })).toEqual({
      kind: "none",
      why: "killed",
    });
    expect(routeShellJobResult({ ...base, detached: true })).toEqual({
      kind: "none",
      why: "detached",
    });
  });

  it("still reports failed, timed-out and lost jobs", () => {
    for (const status of ["failed", "timed_out", "lost"] as const)
      expect(routeShellJobResult({ ...base, status })).toEqual({ kind: "wake" });
  });
});

describe("small helpers", () => {
  it("keeps the head and tail of long output", () => {
    const text = `${"a".repeat(500)}MIDDLE${"z".repeat(500)}`;
    const kept = headAndTail(text, 200);
    expect(kept.length).toBeLessThanOrEqual(200);
    expect(kept.startsWith("a")).toBe(true);
    expect(kept.endsWith("z")).toBe(true);
    expect(kept).toContain("characters omitted");
    expect(headAndTail("short", 200)).toBe("short");
  });

  it("previews a command on one line, capped", () => {
    expect(commandPreview("  npm   run\nbuild ")).toBe("npm run build");
    expect(commandPreview("x".repeat(400))).toHaveLength(300);
  });

  it("accepts only id-shaped job ids", () => {
    expect(isShellJobId("0f9c2e7b8d1a4c3e9b7a6d5c4b3a2f1e")).toBe(true);
    expect(isShellJobId("../etc")).toBe(false);
    expect(isShellJobId("a; rm -rf /")).toBe(false);
    expect(isShellJobId(42)).toBe(false);
  });
});
