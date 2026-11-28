import { describe, expect, it, vi } from "vitest";
import { judgeOpenWorkPromise } from "./run-open-work.js";

/** Fork (FORK.md 1.33, A3): the small model settles an unclear closing, with a safe default. */
describe("the judge of an unclear closing", () => {
  const env = { MEMORY_LEDGER_MODEL_URL: "http://model.test/v1", MEMORY_LEDGER_MODEL: "small" };
  const config = { judge: true, judgeTimeoutMs: 1_000 };
  const answering = (content: string) =>
    (async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ choices: [{ message: { content }, finish_reason: "stop" }] }),
    })) as never;

  it("reads the model's verdict", async () => {
    expect(
      await judgeOpenWorkPromise("I'll have the rest in a while.", config, {
        env,
        fetchImpl: answering('{"more_work": true}'),
      }),
    ).toBe("promise");
    expect(
      await judgeOpenWorkPromise("I'll have the rest in a while.", config, {
        env,
        fetchImpl: answering('{"more_work": false}'),
      }),
    ).toBe("none");
  });

  it("answers none, the safe default, on any failure", async () => {
    const reply = "I'll have the rest in a while.";
    const failing = (async () => {
      throw new Error("timeout");
    }) as never;
    expect(await judgeOpenWorkPromise(reply, config, { env, fetchImpl: failing })).toBe("none");
    expect(
      await judgeOpenWorkPromise(reply, config, { env, fetchImpl: answering("not json") }),
    ).toBe("none");
    // No endpoint configured, or the switch off: the model is never called.
    const never = vi.fn();
    expect(await judgeOpenWorkPromise(reply, config, { env: {}, fetchImpl: never as never })).toBe(
      "none",
    );
    expect(
      await judgeOpenWorkPromise(
        reply,
        { judge: false, judgeTimeoutMs: 1_000 },
        { env, fetchImpl: never as never },
      ),
    ).toBe("none");
    expect(never).not.toHaveBeenCalled();
  });
});
