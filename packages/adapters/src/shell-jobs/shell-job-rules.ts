/**
 * Background shell jobs (fork, slice A of BACKGROUND-JOBS-DESIGN.md): the pure rules. A `shell` call
 * on a Linux computer starts its command as a detached job and waits for it a short while; a job
 * still running then is "promoted" and the run carries on, and its result comes back once when it
 * ends. Everything here is side-effect free so the state machine can be tested without a database.
 */
import { BACKGROUND_HELPER_TRIGGER, isConversationalRun, TALK_RUN_TRIGGER } from "@rakazo/core";

export const SHELL_JOB_STATUSES = [
  "running",
  "completed",
  "failed",
  "killed",
  "timed_out",
  "lost",
] as const;
export type ShellJobStatus = (typeof SHELL_JOB_STATUSES)[number];
export type ShellJobTerminalStatus = Exclude<ShellJobStatus, "running">;

export const JOB_RESULT_TRIGGER = "job_result";

export interface ShellJobConfig {
  /** Off switch: `SHELL_BACKGROUND_JOBS=0` keeps today's foreground shell everywhere. */
  enabled: boolean;
  /** How long a `shell` call waits before the command becomes a background job. 0 = at once. */
  backgroundAfterMs: number;
  /** Hard cap on one job's life; the job is killed and reported as timed_out at the deadline. */
  maxMs: number;
  /** Running jobs per bot; beyond it the command runs in the foreground as before. */
  perBot: number;
  /** Running jobs per Space. */
  perSpace: number;
  /** `job_result` wakes in a thread with no owner message in between, before wakes stop. */
  maxWakesInARow: number;
}

export const DEFAULT_SHELL_JOB_CONFIG: ShellJobConfig = {
  enabled: true,
  backgroundAfterMs: 8_000,
  maxMs: 2 * 60 * 60 * 1000,
  perBot: 4,
  perSpace: 12,
  maxWakesInARow: 6,
};

function intEnv(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function shellJobConfig(
  env: Record<string, string | undefined> = process.env,
): ShellJobConfig {
  const flag = env.SHELL_BACKGROUND_JOBS?.trim().toLowerCase();
  return {
    enabled: !(flag === "0" || flag === "false" || flag === "off"),
    backgroundAfterMs: intEnv(env, "SHELL_BACKGROUND_AFTER_MS", 8_000, 0, 600_000),
    maxMs: intEnv(env, "SHELL_JOB_MAX_MS", DEFAULT_SHELL_JOB_CONFIG.maxMs, 10_000, 24 * 3_600_000),
    perBot: intEnv(env, "SHELL_JOBS_PER_BOT", 4, 1, 32),
    perSpace: intEnv(env, "SHELL_JOBS_PER_SPACE", 12, 1, 256),
    maxWakesInARow: intEnv(env, "SHELL_JOB_MAX_WAKES", 6, 1, 100),
  };
}

/**
 * Which runs may start background jobs. Only the owner's conversation: its result comes back into
 * the same chat as a conversational `job_result` run. A talk run has no tools; a helper keeps the
 * blocking shell (its result returns to its parent, not to a chat); unattended runs (routines,
 * webhooks, bot-to-bot requests, tickets, the creation intro) and connected-chat runs reply
 * somewhere a later wake cannot reach, so they keep today's behaviour.
 */
export function runMayStartShellJobs(trigger: string | null | undefined): boolean {
  const value = trigger ?? "";
  if (value === TALK_RUN_TRIGGER || value === BACKGROUND_HELPER_TRIGGER) return false;
  if (value === "messaging" || value === "created") return false;
  return isConversationalRun(value);
}

export type ShellJobEligibility =
  | { job: true }
  | { job: false; reason: "disabled" | "computer" | "run" | "bot_limit" | "space_limit" };

/** Whether this `shell` call runs as a job, and if not, why (the limit reasons are told to the model). */
export function shellJobEligibility(input: {
  config: ShellJobConfig;
  trigger: string | null | undefined;
  /** The computer runs a plain Linux shell through the launcher (not a native or user machine). */
  linuxComputer: boolean;
  runningForBot: number;
  runningForSpace: number;
}): ShellJobEligibility {
  if (!input.config.enabled) return { job: false, reason: "disabled" };
  if (!input.linuxComputer) return { job: false, reason: "computer" };
  if (!runMayStartShellJobs(input.trigger)) return { job: false, reason: "run" };
  if (input.runningForBot >= input.config.perBot) return { job: false, reason: "bot_limit" };
  if (input.runningForSpace >= input.config.perSpace) return { job: false, reason: "space_limit" };
  return { job: true };
}

/**
 * How long the `shell` call itself follows the job. `background:true` returns at once; otherwise
 * the configured window, never past the job's own deadline.
 */
export function foregroundWaitMs(config: ShellJobConfig, background: boolean): number {
  if (background) return 0;
  return Math.min(config.backgroundAfterMs, config.maxMs);
}

/** What one read of a job's folder on the computer says. */
export interface ShellJobProbe {
  /** The wrapper wrote its exit status: the command ended. */
  exitCode: number | null;
  /** The job's process group still has a live process. */
  alive: boolean;
  /** The job folder exists (false after the computer was rebuilt or the folder removed). */
  present: boolean;
}

/** Exit status `timeout(1)` reports when it stopped the command at the deadline. */
export const TIMEOUT_EXIT_CODES = new Set([124, 137]);

export type ShellJobStep =
  | { kind: "wait"; nextPollInMs: number }
  | { kind: "finish"; status: ShellJobTerminalStatus; exitCode: number | null }
  | { kind: "kill"; status: "killed" | "timed_out" };

/**
 * Back-off between polls, from the job's age: every 5 s in its first 30 s, then 10, 20, 30 s, and
 * once a minute after five minutes. A short job is noticed quickly, a long one costs little.
 */
export function pollIntervalMs(ageMs: number): number {
  if (ageMs < 30_000) return 5_000;
  if (ageMs < 60_000) return 10_000;
  if (ageMs < 120_000) return 20_000;
  if (ageMs < 300_000) return 30_000;
  return 60_000;
}

/** Back-off after a failed poll: 5, 10, 20, 40, then 60 s. */
export function pollErrorBackoffMs(pollErrors: number): number {
  return Math.min(60_000, 5_000 * 2 ** Math.max(0, pollErrors - 1));
}

export const MAX_POLL_ERRORS = 10;

/**
 * The job's state machine, from one probe. A command that ended maps to completed or failed (or
 * timed_out when the wrapper's own `timeout` stopped it); a cancel or a passed deadline asks for a
 * kill; a folder that vanished, or a dead process group that left no exit status, is lost.
 */
export function nextShellJobStep(input: {
  probe: ShellJobProbe;
  cancelRequested: boolean;
  deadlineAt: Date;
  now: Date;
  startedAt: Date;
}): ShellJobStep {
  const { probe } = input;
  if (input.cancelRequested) {
    if (probe.exitCode !== null || !probe.alive)
      return { kind: "finish", status: "killed", exitCode: probe.exitCode };
    return { kind: "kill", status: "killed" };
  }
  if (probe.exitCode !== null) {
    const timedOut = TIMEOUT_EXIT_CODES.has(probe.exitCode) && input.now >= input.deadlineAt;
    return {
      kind: "finish",
      status: timedOut ? "timed_out" : probe.exitCode === 0 ? "completed" : "failed",
      exitCode: probe.exitCode,
    };
  }
  if (!probe.present) return { kind: "finish", status: "lost", exitCode: null };
  if (input.now >= input.deadlineAt) {
    return probe.alive
      ? { kind: "kill", status: "timed_out" }
      : { kind: "finish", status: "timed_out", exitCode: null };
  }
  // The wrapper writes the exit file after the command; a dead group with none means it was killed
  // from outside (an OOM kill, a reboot), so nothing will ever report.
  if (!probe.alive) return { kind: "finish", status: "lost", exitCode: null };
  return {
    kind: "wait",
    nextPollInMs: pollIntervalMs(input.now.getTime() - input.startedAt.getTime()),
  };
}

/** A poll that could not read the computer: retry, or give the job up as lost after too many. */
export function pollFailureStep(pollErrors: number): ShellJobStep {
  return pollErrors + 1 >= MAX_POLL_ERRORS
    ? { kind: "finish", status: "lost", exitCode: null }
    : { kind: "wait", nextPollInMs: pollErrorBackoffMs(pollErrors + 1) };
}

export type ShellJobRoute =
  | { kind: "none"; why: "killed" | "detached" }
  | { kind: "defer"; retryInMs: number }
  | { kind: "wake" }
  | { kind: "coalesce"; runId: string }
  | { kind: "budget" };

/** A still-working run of the same bot and thread takes the result itself, at its next turn. */
export const DEFER_TO_WORKING_RUN_MS = 5_000;
/** ...but not forever: a run stuck in one long step must not hold a finished result back. */
export const MAX_DEFER_MS = 15 * 60_000;

/**
 * Where a finished job's result goes, decided with the thread locked. A job the bot or the owner
 * stopped reports nothing. While a run of this bot is working in the thread it takes the result as
 * steering, so the poller waits for it. Otherwise one `job_result` run wakes the bot: a queued one
 * that has not started takes this result too, and past the wake budget the result is only posted.
 */
export function routeShellJobResult(input: {
  status: ShellJobTerminalStatus;
  detached: boolean;
  workingRunInThread: boolean;
  finishedAt: Date;
  now: Date;
  queuedJobResultRunId: string | null;
  wakesSinceOwnerMessage: number;
  maxWakesInARow: number;
}): ShellJobRoute {
  if (input.status === "killed") return { kind: "none", why: "killed" };
  if (input.detached) return { kind: "none", why: "detached" };
  if (input.workingRunInThread && input.now.getTime() - input.finishedAt.getTime() < MAX_DEFER_MS) {
    return { kind: "defer", retryInMs: DEFER_TO_WORKING_RUN_MS };
  }
  if (input.queuedJobResultRunId) return { kind: "coalesce", runId: input.queuedJobResultRunId };
  if (input.wakesSinceOwnerMessage >= input.maxWakesInARow) return { kind: "budget" };
  return { kind: "wake" };
}

/** Output kept for the model: head and tail, so a build's last error survives. */
export function headAndTail(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const marker = `\n…[${text.length - limit} characters omitted]…\n`;
  const room = Math.max(0, limit - marker.length);
  const head = Math.floor(room / 3);
  return `${text.slice(0, head)}${marker}${text.slice(text.length - (room - head))}`;
}

export const COMMAND_PREVIEW_CHARS = 300;

export function commandPreview(command: string): string {
  const flat = command.replace(/\s+/g, " ").trim();
  return flat.length > COMMAND_PREVIEW_CHARS
    ? `${flat.slice(0, COMMAND_PREVIEW_CHARS - 1)}…`
    : flat;
}

/** Job ids are cuids; anything else is refused before it reaches a shell argument. */
export function isShellJobId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]{8,40}$/i.test(value);
}

/** The marker run-id slot the background-work probe and cancel scripts key on. */
export function shellJobMarkerId(jobId: string): string {
  return `job_${jobId}`;
}
