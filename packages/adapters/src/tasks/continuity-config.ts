/**
 * Fork (FORK.md 1.33): settings of long-task continuity. A long job in several waves must finish
 * without its owner nudging the agent, so the platform, not the model, keeps it moving:
 *   - any run of the agent itself may delegate (a helper still may not), under a start budget;
 *   - a helper asked for while every slot is busy is queued and started by the platform;
 *   - a run that ends with its own work still open is continued while nothing else will wake it;
 *   - when that chain ends with work open, the owner is told once.
 * Every behaviour has its own switch, on unless set to 0 / false / off.
 */

export interface ContinuityConfig {
  /** `HELPER_DELEGATION_ANY_RUN=0`: only a person's conversational run may delegate, as upstream. */
  delegateFromAnyRun: boolean;
  /** Helpers one chat may start (running, queued and finished) inside the window. */
  helperStartsPerThread: number;
  helperStartsWindowMs: number;
  /** `HELPER_QUEUE=0`: a helper asked for while every slot is busy is refused, as upstream. */
  queueHelpers: boolean;
  /** Helpers one agent may have waiting for a slot. */
  helperQueueMax: number;
  /** `OPEN_WORK_CONTINUATION=0`: a run that ends with its own work open is final, as upstream. */
  continueOpenWork: boolean;
  /**
   * Continuation runs for one task (since the last message a person sent in the chat). A job done
   * one part per run needs one each, so the limit is generous: what stops a loop is the
   * no-progress rule, and this only caps a chain that keeps moving.
   */
  maxContinuations: number;
  /** `OPEN_WORK_JUDGE=0`: an unclear promise in a final reply is never put to the small model. */
  judge: boolean;
  judgeTimeoutMs: number;
  /** `OPEN_WORK_STALLED_NOTICE=0`: no chat line or notification when the chain ends with work open. */
  stalledNotice: boolean;
}

// Values are read by literal name at the call site so the compose-env test can see each key.
function intEnv(setting: string | undefined, fallback: number, min: number, max: number): number {
  const raw = setting?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function on(setting: string | undefined): boolean {
  const flag = setting?.trim().toLowerCase();
  return !(flag === "0" || flag === "false" || flag === "off");
}

export function continuityConfig(
  env: Record<string, string | undefined> = process.env,
): ContinuityConfig {
  return {
    delegateFromAnyRun: on(env.HELPER_DELEGATION_ANY_RUN),
    helperStartsPerThread: intEnv(env.HELPER_STARTS_PER_THREAD, 60, 1, 1_000),
    helperStartsWindowMs: intEnv(env.HELPER_STARTS_WINDOW_MINUTES, 60, 1, 24 * 60) * 60_000,
    queueHelpers: on(env.HELPER_QUEUE),
    helperQueueMax: intEnv(env.HELPER_QUEUE_MAX, 16, 1, 200),
    continueOpenWork: on(env.OPEN_WORK_CONTINUATION),
    maxContinuations: intEnv(env.OPEN_WORK_MAX_CONTINUATIONS, 25, 1, 200),
    judge: on(env.OPEN_WORK_JUDGE),
    judgeTimeoutMs: intEnv(env.OPEN_WORK_JUDGE_TIMEOUT_MS, 12_000, 500, 60_000),
    stalledNotice: on(env.OPEN_WORK_STALLED_NOTICE),
  };
}
