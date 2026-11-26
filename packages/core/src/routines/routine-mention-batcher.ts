import type { Routine } from "@rakazo/contracts";
import { ROUTINE_MENTION_BATCH_MAX } from "@rakazo/contracts";

type RoutineList = { botId: string; routines: Routine[] };
type Pending = {
  botId: string;
  signal?: AbortSignal;
  resolve: (routines: Routine[]) => void;
  reject: (error: unknown) => void;
};

/**
 * What a read gets for a bot the batch answer left out when the batch is trusted: the same
 * "not found" the per-bot endpoint would give, without asking it. Not retryable (status 404).
 */
export class RoutineBotGoneError extends Error {
  readonly status = 404;
  readonly code = "NOT_FOUND";
  constructor(readonly botId: string) {
    super("Resource not found");
    this.name = "RoutineBotGoneError";
  }
}

/** Batch simultaneous routine reads without changing the per-bot cache or its invalidations. */
export function createRoutineMentionBatcher(
  listBatch: (botIds: string[], signal: AbortSignal) => Promise<RoutineList[]>,
  listOne: (botId: string, signal?: AbortSignal) => Promise<Routine[]>,
  options: {
    /**
     * Fork: the batch endpoint applies the same ownership rules as the per-bot one, so a bot it
     * leaves out is gone (removed or archived a moment ago, while this client still lists it).
     * With this on, such a bot is answered "not found" here instead of being asked for one by
     * one (each of those was a 404 and a server warning per removed bot, on every refresh until
     * the roster caught up), and two or more reads always go as one batch.
     */
    omittedIsGone?: boolean;
  } = {},
) {
  const smallRoster = options.omittedIsGone ? 1 : 4;
  let queued: Pending[] = [];
  const signals = new Map<AbortSignal, { entries: Set<Pending>; abort: () => void }>();

  async function legacy(entries: Pending[]) {
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, entries.length) }, async () => {
        while (next < entries.length) {
          const entry = entries[next++]!;
          try {
            if (entry.signal?.aborted) throw entry.signal.reason ?? new Error("Request aborted.");
            entry.resolve(await listOne(entry.botId, entry.signal));
          } catch (error) {
            entry.reject(error);
          }
        }
      }),
    );
  }

  async function flush(entries: Pending[]) {
    const active = entries.filter((entry) => !entry.signal?.aborted);
    // Small rosters retain their existing bounded per-bot reads.
    if (active.length <= smallRoster) return legacy(active);
    // Bound request size and keep only one batch in flight, including on mobile.
    for (let offset = 0; offset < active.length; offset += ROUTINE_MENTION_BATCH_MAX) {
      const chunk = active
        .slice(offset, offset + ROUTINE_MENTION_BATCH_MAX)
        .filter((entry) => !entry.signal?.aborted);
      if (!chunk.length) continue;
      const abort = new AbortController();
      const abortIfUnused = () => {
        if (chunk.every((entry) => entry.signal?.aborted)) abort.abort();
      };
      const chunkSignals = new Set(chunk.flatMap((entry) => (entry.signal ? [entry.signal] : [])));
      for (const signal of chunkSignals) signal.addEventListener("abort", abortIfUnused);
      try {
        const lists = await listBatch(
          [...new Set(chunk.map((entry) => entry.botId))],
          abort.signal,
        );
        const byBot = new Map(lists.map((list) => [list.botId, list.routines]));
        const missing: Pending[] = [];
        for (const entry of chunk) {
          const routines = byBot.get(entry.botId);
          if (routines) entry.resolve(routines);
          else if (options.omittedIsGone) entry.reject(new RoutineBotGoneError(entry.botId));
          // Preserve per-bot failures, authorization and partial cached data.
          else missing.push(entry);
        }
        await legacy(missing);
      } catch {
        // Older servers and failed batch reads use the original endpoint.
        await legacy(chunk);
      } finally {
        for (const signal of chunkSignals) signal.removeEventListener("abort", abortIfUnused);
      }
    }
  }

  return (botId: string, signal?: AbortSignal): Promise<Routine[]> => {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Request aborted."));
    return new Promise<Routine[]>((resolve, reject) => {
      const detach = () => {
        if (!signal) return;
        const group = signals.get(signal);
        group?.entries.delete(entry);
        if (group?.entries.size === 0) {
          signal.removeEventListener("abort", group.abort);
          signals.delete(signal);
        }
      };
      const entry: Pending = {
        botId,
        signal,
        resolve: (routines) => {
          detach();
          resolve(routines);
        },
        reject: (error) => {
          detach();
          reject(error);
        },
      };
      if (signal) {
        let group = signals.get(signal);
        if (!group) {
          const entries = new Set<Pending>();
          const abort = () => {
            for (const entry of [...entries])
              entry.reject(signal.reason ?? new Error("Request aborted."));
          };
          group = { entries, abort };
          signals.set(signal, group);
          signal.addEventListener("abort", abort, { once: true });
        }
        group.entries.add(entry);
      }
      queued.push(entry);
      if (queued.length === 1) {
        void Promise.resolve().then(() => {
          const entries = queued;
          queued = [];
          return flush(entries).catch((error) => {
            for (const entry of entries) entry.reject(error);
          });
        });
      }
    });
  };
}
