/**
 * Fork (FORK.md 1.42): settings of message routing, concurrent chat tasks and the transient retry.
 * Every behaviour is on unless its switch is set to 0 / false / off. Values are read by literal
 * name so the compose-env test can see each key.
 */

export interface RoutingConfig {
  /** `MESSAGE_ROUTING=0`: a message into a busy chat steers the working run, as before. */
  routing: boolean;
  /** `MESSAGE_ROUTING_JUDGE=0`: no model is asked; every uncertain message is an addition. */
  judge: boolean;
  /** Wall time of one judge call, everything included. Steering is held at most this long. */
  judgeTimeoutMs: number;
  /** Model, endpoint and key of the judge; empty = the memory ledger's (1.10). */
  judgeModel: string | undefined;
  judgeUrl: string | undefined;
  judgeApiKey: string | undefined;
  /** Judge confidence below this is not acted on (addition instead). Overrides need more. */
  minConfidence: number;
  overrideMinConfidence: number;
  /** A stop-and-replace override needs this; below it the override only redirects (steers). */
  replaceMinConfidence: number;
  /** `MESSAGE_ROUTING_OPEN_ITEM=0`: an addition is steering only, not also an open-work item. */
  additionOpenItem: boolean;
  /** `CHAT_CONCURRENT_TASKS=0`: a new task in a busy chat waits as steering, as before. */
  concurrentTasks: boolean;
  /** Tasks of one agent working at once in one chat; more wait in line. */
  concurrentTasksMax: number;
  /** `RUN_TRANSIENT_RETRY=0`: a run failing on a provider outage fails at once, as before. */
  transientRetry: boolean;
  transientRetryMax: number;
  transientRetryBaseMs: number;
  transientRetryMaxMs: number;
}

function on(setting: string | undefined): boolean {
  const flag = setting?.trim().toLowerCase();
  return !(flag === "0" || flag === "false" || flag === "off" || flag === "no");
}

function intEnv(setting: string | undefined, fallback: number, min: number, max: number): number {
  const raw = setting?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function numberEnv(setting: string | undefined, fallback: number, min: number, max: number) {
  const raw = setting?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function text(setting: string | undefined): string | undefined {
  return setting?.trim() || undefined;
}

export function routingConfig(
  env: Record<string, string | undefined> = process.env,
): RoutingConfig {
  return {
    routing: on(env.MESSAGE_ROUTING),
    judge: on(env.MESSAGE_ROUTING_JUDGE),
    judgeTimeoutMs: intEnv(env.MESSAGE_ROUTING_JUDGE_TIMEOUT_MS, 8_000, 1_000, 30_000),
    judgeModel: text(env.MESSAGE_ROUTING_JUDGE_MODEL),
    judgeUrl: text(env.MESSAGE_ROUTING_JUDGE_URL),
    judgeApiKey: text(env.MESSAGE_ROUTING_JUDGE_API_KEY),
    minConfidence: numberEnv(env.MESSAGE_ROUTING_MIN_CONFIDENCE, 0.6, 0, 1),
    overrideMinConfidence: numberEnv(env.MESSAGE_ROUTING_OVERRIDE_MIN_CONFIDENCE, 0.7, 0, 1),
    replaceMinConfidence: numberEnv(env.MESSAGE_ROUTING_REPLACE_MIN_CONFIDENCE, 0.85, 0, 1),
    additionOpenItem: on(env.MESSAGE_ROUTING_OPEN_ITEM),
    concurrentTasks: on(env.CHAT_CONCURRENT_TASKS),
    concurrentTasksMax: intEnv(env.CHAT_CONCURRENT_TASKS_MAX, 3, 1, 8),
    transientRetry: on(env.RUN_TRANSIENT_RETRY),
    transientRetryMax: intEnv(env.RUN_TRANSIENT_RETRY_MAX, 3, 0, 10),
    transientRetryBaseMs: intEnv(env.RUN_TRANSIENT_RETRY_BASE_MS, 5_000, 100, 120_000),
    transientRetryMaxMs: intEnv(env.RUN_TRANSIENT_RETRY_MAX_MS, 120_000, 1_000, 900_000),
  };
}
