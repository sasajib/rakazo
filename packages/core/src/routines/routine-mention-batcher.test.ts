import type { Routine } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { deferred } from "../primitives/async.test-support.js";
import { createRoutineMentionBatcher, RoutineBotGoneError } from "./routine-mention-batcher.js";

const ids = Array.from({ length: 100 }, (_, index) => `bot-${index}`);
const rows = (botId: string) =>
  [
    { id: `${botId}-2`, botId },
    { id: `${botId}-1`, botId },
  ] as Routine[];
const lists = (ids: string[]) =>
  [...ids].reverse().map((botId) => ({ botId, routines: rows(botId) }));

describe("routine mention cache-miss batching", () => {
  it("replaces 100 simultaneous reads with one batch and preserves every bot's routine order", async () => {
    const batch = vi.fn(async (ids: string[]) => lists(ids));
    const single = vi.fn(async (id: string) => rows(id));
    const load = createRoutineMentionBatcher(batch, single);
    expect(await Promise.all(ids.map((id) => load(id)))).toEqual(ids.map(rows));
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]![0]).toEqual(ids);
    expect(single).not.toHaveBeenCalled();
    // A later one-bot invalidation keeps its existing per-bot endpoint.
    expect(await load(ids[0]!)).toEqual(rows(ids[0]!));
    expect(batch).toHaveBeenCalledTimes(1);
    expect(single).toHaveBeenCalledTimes(1);
  });

  it("bounds an older-server fallback to four reads and keeps per-bot errors separate", async () => {
    let active = 0;
    let peak = 0;
    const single = vi.fn(async (id: string) => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      if (id === "bot-1") throw new Error("offline");
      return rows(id);
    });
    const load = createRoutineMentionBatcher(async () => {
      throw new Error("unknown endpoint");
    }, single);
    const result = await Promise.allSettled(ids.map((id) => load(id)));
    expect(peak).toBe(4);
    expect(single).toHaveBeenCalledTimes(100);
    expect(result[1]!.status).toBe("rejected");
    expect(result.filter((entry) => entry.status === "fulfilled")).toHaveLength(99);
  });

  it("retries only omitted bots, preserving existing authorization errors and cached data", async () => {
    const single = vi.fn(async () => {
      throw new Error("not found");
    });
    const load = createRoutineMentionBatcher(async (ids) => lists(ids.slice(1)), single);
    const result = await Promise.allSettled(ids.map((id) => load(id)));
    expect(result[0]!.status).toBe("rejected");
    expect(single).toHaveBeenCalledExactlyOnceWith("bot-0", undefined);
    expect(result[1]).toEqual({ status: "fulfilled", value: rows("bot-1") });
  });

  it("cancels one query without cancelling other cache misses and aborts an unused batch", async () => {
    const pending = deferred<ReturnType<typeof lists>>();
    let signal!: AbortSignal;
    const batch = vi.fn(async (_ids: string[], nextSignal: AbortSignal) => {
      signal = nextSignal;
      return pending.promise;
    });
    const single = vi.fn();
    const load = createRoutineMentionBatcher(batch, single);
    const controllers = ids.map(() => new AbortController());
    const results = Promise.allSettled(ids.map((id, i) => load(id, controllers[i]!.signal)));
    await Promise.resolve();
    controllers[0]!.abort(new Error("left"));
    expect(signal.aborted).toBe(false);
    for (const controller of controllers.slice(1)) controller.abort();
    expect(signal.aborted).toBe(true);
    expect((await results).every((entry) => entry.status === "rejected")).toBe(true);
    pending.resolve(lists(ids));
    await Promise.resolve();
    expect(single).not.toHaveBeenCalled();
  });

  it("skips work cancelled before dispatch and bounds large rosters to sequential batches", async () => {
    const batch = vi.fn(async (ids: string[]) => lists(ids));
    const single = vi.fn();
    const load = createRoutineMentionBatcher(batch, single);
    const abort = new AbortController();
    const cancelled = Promise.allSettled(ids.map((id) => load(id, abort.signal)));
    abort.abort();
    await cancelled;
    expect(batch).not.toHaveBeenCalled();
    const many = Array.from({ length: 205 }, (_, index) => `bot-${index}`);
    expect(await Promise.all(many.map((id) => load(id)))).toEqual(many.map(rows));
    expect(batch.mock.calls.map(([ids]) => ids.length)).toEqual([100, 100, 5]);
  });

  // Fork: with `omittedIsGone` a bot the batch answer leaves out (removed or archived a moment
  // ago) is not asked for one by one; each of those reads was a 404 and a server warning.
  describe("a bot the batch leaves out, when the batch is trusted", () => {
    it("is answered not found without asking for it, and the others get their routines", async () => {
      const single = vi.fn(async (id: string) => rows(id));
      const batch = vi.fn(async (asked: string[]) => lists(asked.filter((id) => id !== "bot-3")));
      const load = createRoutineMentionBatcher(batch, single, { omittedIsGone: true });
      const result = await Promise.allSettled(ids.slice(0, 8).map((id) => load(id)));
      expect(single).not.toHaveBeenCalled();
      expect(batch).toHaveBeenCalledTimes(1);
      expect(result[3]).toMatchObject({ status: "rejected" });
      const reason = (result[3] as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(RoutineBotGoneError);
      // Not retried by the clients' retry policy: a 404.
      expect(reason).toMatchObject({ status: 404, code: "NOT_FOUND", botId: "bot-3" });
      expect(result.filter((entry) => entry.status === "fulfilled")).toHaveLength(7);
    });

    it("sends even two reads as one batch, so a small roster does not ask for a gone bot either", async () => {
      const single = vi.fn(async (id: string) => rows(id));
      const batch = vi.fn(async (asked: string[]) => lists(asked.filter((id) => id !== "bot-1")));
      const load = createRoutineMentionBatcher(batch, single, { omittedIsGone: true });
      const result = await Promise.allSettled([load("bot-0"), load("bot-1")]);
      expect(batch).toHaveBeenCalledExactlyOnceWith(["bot-0", "bot-1"], expect.anything());
      expect(single).not.toHaveBeenCalled();
      expect(result.map((entry) => entry.status)).toEqual(["fulfilled", "rejected"]);
      // Without the option (upstream's behaviour) both are asked for one by one.
      const plain = createRoutineMentionBatcher(batch, single);
      await Promise.allSettled([plain("bot-0"), plain("bot-1")]);
      expect(single).toHaveBeenCalledTimes(2);
    });

    it("keeps the per-bot endpoint for one read and for a server without the batch", async () => {
      const single = vi.fn(async (id: string) => rows(id));
      const batch = vi.fn(async (): Promise<ReturnType<typeof lists>> => {
        throw new Error("unknown endpoint");
      });
      const load = createRoutineMentionBatcher(batch, single, { omittedIsGone: true });
      expect(await load("bot-0")).toEqual(rows("bot-0"));
      expect(batch).not.toHaveBeenCalled();
      expect(await Promise.all(ids.slice(0, 6).map((id) => load(id)))).toEqual(
        ids.slice(0, 6).map(rows),
      );
      expect(batch).toHaveBeenCalledTimes(1);
      expect(single).toHaveBeenCalledTimes(7);
    });
  });
});
