import { getLogger } from "@rakazo/logging";

/**
 * Fork (FORK.md 1.42, item 7): runs this worker saw stopped (status cancelled while it worked: the
 * Stop button, a "stop" message, an override, a replaced request). A command that Stop ended
 * completes with an error ("terminated"); the audit then counts it as `stopped`, not as a tool
 * fault. Kept for a few minutes after the run is seen stopped, per process.
 */
const STOPPED_KEEP_MS = 10 * 60_000;
const stopped = new Map<string, number>();

export function markRunStopped(
  run: { id: string; spaceId?: string; threadId?: string; botId?: string; trigger?: string },
  now = Date.now(),
): void {
  for (const [id, at] of stopped) if (now - at > STOPPED_KEEP_MS) stopped.delete(id);
  if (stopped.has(run.id)) return;
  stopped.set(run.id, now);
  getLogger().info("run.stopped", {
    "run.id": run.id,
    ...(run.spaceId ? { "space.id": run.spaceId } : {}),
    ...(run.threadId ? { "thread.id": run.threadId } : {}),
    ...(run.botId ? { "bot.id": run.botId } : {}),
    ...(run.trigger ? { "run.trigger": run.trigger } : {}),
  });
}

export function runWasStopped(runId: string, now = Date.now()): boolean {
  const at = stopped.get(runId);
  return at !== undefined && now - at <= STOPPED_KEEP_MS;
}
