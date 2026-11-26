/**
 * The model call when the service is overloaded: HTTP 429/5xx, a timeout or a dropped connection
 * is asked again after a growing wait, inside a fixed time budget. Before, each of these failed
 * the ledger job on its first attempt.
 */
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { describe, expect, it } from "vitest";
import { curatorConfig } from "../skill-curator/config.js";
import { createOpenAiCuratorModel } from "../skill-curator/model.js";
import { ledgerConfig } from "./config.js";
import type { FetchLike } from "./embeddings.js";
import { chatWithBudget, createOpenAiMemoryModel, retryAfterMs } from "./model.js";

type Step =
  | { status: number; retryAfter?: string }
  | { throws: Error }
  | { content: string; finish_reason?: string };

const answer =
  '{"facts":[{"area":"about","text":"Owner lives in Dhaka","quote":"I live in Dhaka","m":1}]}';
const timeoutError = () =>
  Object.assign(new Error("The operation timed out"), { name: "TimeoutError" });
const networkError = () =>
  Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });

/** A fake endpoint and a fake clock: sleeping moves the clock, nothing really waits. */
function harness(steps: Step[], options: { callMs?: number } = {}) {
  let clock = 1_000_000;
  const waits: number[] = [];
  let calls = 0;
  const fetchImpl: FetchLike = async () => {
    const step = steps[Math.min(calls, steps.length - 1)]!;
    calls += 1;
    clock += options.callMs ?? 0;
    if ("throws" in step) throw step.throws;
    if ("status" in step)
      return {
        ok: false,
        status: step.status,
        headers: { get: (name) => (name === "retry-after" ? (step.retryAfter ?? null) : null) },
        json: async () => ({}),
      };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          { message: { content: step.content }, finish_reason: step.finish_reason ?? "stop" },
        ],
      }),
    };
  };
  const seams = {
    fetchImpl,
    now: () => clock,
    random: () => 1,
    sleep: async (ms: number) => {
      waits.push(ms);
      clock += ms;
    },
  };
  const sink = createTestSink();
  installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
  const retryLogs = () =>
    sink.events
      .filter((event) => event.message === "memory.ledger.model_retry")
      .map((event) => ({ reason: event.reason, attempt: event.attempt, wait_ms: event.wait_ms }));
  const failures = () =>
    sink.events.filter((event) => event.message === "memory.ledger.model_failed").length;
  const chat = (extra: { retries?: number; budgetMs?: number; timeoutMs?: number } = {}) =>
    chatWithBudget({
      ...seams,
      url: "http://omniroute:20128/v1/chat/completions",
      endpoint: { baseUrl: "http://omniroute:20128/v1", model: "glm/glm-5.3-flash" },
      messages: [{ role: "user", content: "{}" }],
      maxTokens: 16_000,
      timeoutMs: extra.timeoutMs ?? 90_000,
      retryEvent: "memory.ledger.model_retry",
      retries: extra.retries,
      budgetMs: extra.budgetMs,
    });
  const extract = (extra: { retries?: number; budgetMs?: number } = {}) =>
    createOpenAiMemoryModel(
      { baseUrl: "http://omniroute:20128/v1", model: "glm/glm-5.3-flash" },
      { timeoutMs: 90_000, ...seams, ...extra },
    ).extract({
      today: "2026-11-27",
      messages: [{ id: "m1", text: "I live in Dhaka", at: new Date(), current: true }],
      known: [],
    });
  return { chat, extract, waits, retryLogs, failures, calls: () => calls, seams, sink };
}

describe("memory model call under overload", () => {
  it("429 then success: the job gets its answer", async () => {
    const h = harness([{ status: 429 }, { content: answer }]);
    expect(await h.extract()).toEqual([expect.objectContaining({ text: "Owner lives in Dhaka" })]);
    expect(h.calls()).toBe(2);
    expect(h.waits).toEqual([1_000]);
    expect(h.retryLogs()).toEqual([{ reason: "rate_limited", attempt: 1, wait_ms: 1_000 }]);
    expect(h.failures()).toBe(0);
  });

  it("waits longer each time, with jitter, and stops after MEMORY_LEDGER_MODEL_RETRIES", async () => {
    const h = harness([{ status: 503 }]);
    expect(await h.chat()).toEqual({ ok: false, status: 503 });
    // Default 3 repeats: 4 calls. random() = 1 gives the full wait.
    expect(h.calls()).toBe(4);
    expect(h.waits).toEqual([1_000, 2_000, 4_000]);
    expect(h.retryLogs().map((log) => log.reason)).toEqual([
      "server_error",
      "server_error",
      "server_error",
    ]);

    const jittered = harness([{ status: 503 }]);
    jittered.seams.random = () => 0;
    await jittered.chat({ retries: 2 });
    // random() = 0 gives half the wait: never less, so repeats are never immediate.
    expect(jittered.waits).toEqual([500, 1_000]);

    const off = harness([{ status: 429 }]);
    expect(await off.chat({ retries: 0 })).toEqual({ ok: false, status: 429 });
    expect(off.calls()).toBe(1);
  });

  it("respects Retry-After, in seconds or as a date", async () => {
    const h = harness([{ status: 429, retryAfter: "7" }, { content: answer }]);
    expect((await h.chat()).ok).toBe(true);
    expect(h.waits).toEqual([7_000]);
    expect(h.retryLogs()).toEqual([{ reason: "rate_limited", attempt: 1, wait_ms: 7_000 }]);

    expect(retryAfterMs("2", 0)).toBe(2_000);
    expect(retryAfterMs("Fri, 27 Nov 2026 10:00:30 GMT", Date.parse("2026-11-27T10:00:00Z"))).toBe(
      30_000,
    );
    expect(retryAfterMs("soon", 0)).toBeUndefined();
    expect(retryAfterMs(null, 0)).toBeUndefined();
  });

  it("gives up at once when Retry-After asks for longer than it may wait", async () => {
    const h = harness([{ status: 429, retryAfter: "3600" }, { content: answer }]);
    expect(await h.chat()).toEqual({ ok: false, status: 429 });
    expect(h.calls()).toBe(1);
    expect(h.waits).toEqual([]);
  });

  it("timeout then success, and a dropped connection then success", async () => {
    const slow = harness([{ throws: timeoutError() }, { content: answer }]);
    expect(await slow.extract()).toHaveLength(1);
    expect(slow.retryLogs()).toEqual([{ reason: "timeout", attempt: 1, wait_ms: 1_000 }]);
    expect(slow.failures()).toBe(0);

    const dropped = harness([{ throws: networkError() }, { content: answer }]);
    expect(await dropped.extract()).toHaveLength(1);
    expect(dropped.retryLogs()).toEqual([{ reason: "network", attempt: 1, wait_ms: 1_000 }]);
  });

  it("does not repeat a permanent 400, 401 or 404", async () => {
    for (const status of [400, 401, 404, 422]) {
      const h = harness([{ status }, { content: answer }]);
      expect(await h.extract()).toBeUndefined();
      expect(h.calls()).toBe(1);
      expect(h.waits).toEqual([]);
      expect(h.failures()).toBe(1);
    }
  });

  it("does not repeat once the caller cancelled", async () => {
    const h = harness([{ throws: timeoutError() }, { content: answer }]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      chatWithBudget({
        ...h.seams,
        url: "http://x/v1/chat/completions",
        endpoint: { baseUrl: "http://x/v1", model: "m" },
        messages: [],
        maxTokens: 100,
        timeoutMs: 1_000,
        retryEvent: "memory.ledger.model_retry",
        signal: controller.signal,
      }),
    ).rejects.toThrow("timed out");
    expect(h.calls()).toBe(1);
  });

  it("stays inside the time budget: no repeat that could not finish, still failing ends as failed", async () => {
    // Each call takes the full 90 s timeout; the budget is 5 minutes.
    const h = harness([{ throws: timeoutError() }], { callMs: 90_000 });
    expect(await h.extract({ retries: 8, budgetMs: 300_000 })).toBeUndefined();
    // 90 s + 1 s + 90 s + 2 s + 90 s + 4 s = 277 s; a fourth call's 8 s wait still fits, a fifth
    // could not start: the calls stop on their own, well before 8 repeats.
    expect(h.calls()).toBe(4);
    expect(h.waits.reduce((sum, wait) => sum + wait, 0) + h.calls() * 90_000).toBeLessThanOrEqual(
      300_000 + 90_000,
    );
    expect(h.failures()).toBe(1);

    // The remember tool waits 20 s at most: one slow call and nothing more.
    const tool = harness([{ throws: timeoutError() }, { content: answer }], { callMs: 20_000 });
    expect(await tool.extract({ budgetMs: 20_000 })).toBeUndefined();
    expect(tool.calls()).toBe(1);
    expect(tool.waits).toEqual([]);
  });

  it("gives a late attempt only the time that is left", async () => {
    const seen: number[] = [];
    const original = AbortSignal.timeout;
    AbortSignal.timeout = (ms: number) => {
      seen.push(ms);
      return original.call(AbortSignal, 60_000);
    };
    try {
      const h = harness([{ status: 500 }, { content: answer }], { callMs: 50_000 });
      await h.chat({ budgetMs: 100_000, timeoutMs: 90_000 });
      // First call: the full 90 s. Second: 100 s - 50 s - 1 s wait = 49 s.
      expect(seen).toEqual([90_000, 49_000]);
    } finally {
      AbortSignal.timeout = original;
    }
  });

  it("a budget-length retry after an overload retry still works", async () => {
    const h = harness([
      { status: 429 },
      { content: "", finish_reason: "length" },
      { status: 502 },
      { content: answer },
    ]);
    expect(await h.extract()).toHaveLength(1);
    expect(h.calls()).toBe(4);
    expect(
      h.sink.events.filter((e) => e.message === "memory.ledger.model_retry").map((e) => e.reason),
    ).toEqual(["rate_limited", "length", "server_error"]);
  });

  it("reads MEMORY_LEDGER_MODEL_RETRIES, 3 by default, and the curator shares it", async () => {
    expect(ledgerConfig({}).model.retries).toBe(3);
    expect(ledgerConfig({ MEMORY_LEDGER_MODEL_RETRIES: "5" }).model.retries).toBe(5);
    expect(ledgerConfig({ MEMORY_LEDGER_MODEL_RETRIES: "0" }).model.retries).toBe(0);
    expect(ledgerConfig({ MEMORY_LEDGER_MODEL_RETRIES: "99" }).model.retries).toBe(8);
    expect(ledgerConfig({ MEMORY_LEDGER_MODEL_RETRIES: "x" }).model.retries).toBe(3);
    expect(curatorConfig({ MEMORY_LEDGER_MODEL_RETRIES: "1" }).model.retries).toBe(1);

    const h = harness([{ status: 429 }, { content: '{"action":"none","reason":"covered"}' }]);
    const curator = createOpenAiCuratorModel(
      { baseUrl: "http://omniroute:20128/v1", model: "glm/glm-5.3-flash" },
      { timeoutMs: 90_000, ...h.seams },
    );
    expect(
      await curator.propose({
        today: "2026-11-27",
        reason: "correction",
        botName: "Bot",
        messages: [{ text: "no, always check the calendar first", at: new Date(), current: true }],
        replies: [],
        outline: [],
        skills: [],
        rules: [],
      }),
    ).toEqual({ action: "none", reason: "covered" });
    expect(h.sink.events.filter((e) => e.message === "skill.curator.model_retry")).toHaveLength(1);
  });
});
