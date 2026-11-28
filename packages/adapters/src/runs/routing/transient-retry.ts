import { ModelAccountError, ModelOutputError, TransientModelError } from "@rakazo/adapter-kit";
import { normalizeRunError, redactSecrets } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import type { RunContext } from "../assembly/run-context.js";
import { requeueInterruptedRun } from "../lifecycle/run-lifecycle.js";
import type { RoutingConfig } from "./routing-config.js";
import { routingConfig } from "./routing-config.js";

/**
 * Fork (FORK.md 1.42): a run that fails on a transient model or provider error (HTTP 429, 408, 5xx,
 * a timeout, an overloaded or unreachable provider) after the model stream's own retries is put
 * back in the queue with bounded exponential backoff and jitter, keeping its progress (the turn
 * checkpoint, as after a database outage). A permanent error fails at once as before; a run that
 * keeps failing fails after `RUN_TRANSIENT_RETRY_MAX` repeats with its one-line reason, and nothing
 * starts it again by itself (a failed run is never continued).
 */
const TRANSIENT_TEXT =
  /\b(?:overloaded|rate[ -]?limit(?:ed)?|too many requests|timed? ?out|timeout|temporarily unavailable|service unavailable|bad gateway|gateway time-?out|econnreset|econnrefused|etimedout|socket hang up|fetch failed|connection (?:reset|closed|refused))\b/i;

export function isTransientRunError(error: unknown): boolean {
  if (error instanceof ModelAccountError || error instanceof ModelOutputError) return false;
  if (error instanceof TransientModelError) return true;
  if (!(error instanceof Error)) return false;
  const { status } = normalizeRunError(error.message);
  if (status === 429 || status === 408 || status === 425) return true;
  if (status !== undefined && status >= 500 && status <= 599) return true;
  if (status !== undefined) return false;
  return TRANSIENT_TEXT.test(error.message);
}

/** Wait before repeat `attempt` (1-based): base·2^(attempt-1), capped, half to all of it at random. */
export function transientRetryDelayMs(
  attempt: number,
  config: Pick<RoutingConfig, "transientRetryBaseMs" | "transientRetryMaxMs">,
  random: () => number = Math.random,
): number {
  const raw = Math.min(
    config.transientRetryMaxMs,
    config.transientRetryBaseMs * 2 ** (attempt - 1),
  );
  return Math.round(raw * (0.5 + 0.5 * random()));
}

/** Requeue the failed turn when the error is transient and repeats remain. True = handled. */
export async function retryRunAfterTransientFailure(
  ctx: Pick<
    RunContext,
    "deps" | "runId" | "workerId" | "fence" | "run" | "state" | "computer" | "secrets"
  >,
  error: unknown,
  config: RoutingConfig = routingConfig(),
): Promise<boolean> {
  if (!config.transientRetry || config.transientRetryMax <= 0) return false;
  if (!ctx.state.lease.valid) return false;
  if (!isTransientRunError(error)) return false;
  const { deps, runId, workerId, fence } = ctx;
  const current = await deps.prisma.run.findUnique({
    where: { id: runId },
    select: { transientRetries: true, status: true },
  });
  if (!current || current.status !== "running") return false;
  const reason = redactSecrets(error instanceof Error ? error.message : String(error), ctx.secrets)
    .replace(/\s+/g, " ")
    .slice(0, 200);
  if (current.transientRetries >= config.transientRetryMax) {
    getLogger().warn("run.transient_retry_exhausted", {
      "run.id": runId,
      "run.trigger": ctx.run.trigger,
      "run.transient_retries": current.transientRetries,
      reason,
    });
    return false;
  }
  const attempt = current.transientRetries + 1;
  const counted = await deps.prisma.run.updateMany({
    where: { id: runId, status: "running", leaseOwner: workerId, leaseFence: fence },
    data: { transientRetries: attempt },
  });
  if (counted.count !== 1) return false;
  if (!ctx.state.terminalCheckpointComplete) {
    await ctx.computer.checkpoint.flush().catch(() => undefined);
  }
  const waitMs = transientRetryDelayMs(attempt, config);
  const handedBack = await requeueInterruptedRun(
    deps,
    runId,
    workerId,
    fence,
    new Date(Date.now() + waitMs),
  );
  if (!handedBack) return false;
  ctx.state.lease.handedBack = true;
  getLogger().warn("run.transient_retry", {
    "run.id": runId,
    "run.trigger": ctx.run.trigger,
    "run.transient_retry": attempt,
    "run.transient_retry_max": config.transientRetryMax,
    wait_ms: waitMs,
    "error.name": error instanceof Error ? error.name : "UnknownFailure",
    reason,
  });
  return true;
}
