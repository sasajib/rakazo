import { describe, expect, it, vi } from "vitest";
import { holdsFinishNotice, judgeOpenWorkPromise, settleFinishNotice } from "./run-open-work.js";

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

/** Fork (FORK.md 1.33): one "finished" notification for a continued job, at the end of the chain. */
describe("the finished notification of a continuation run", () => {
  const on = { continueOpenWork: true };
  const run = { id: "run-1", botId: "bot-1", threadId: "thread-1" };

  it("is held only for a run the platform started to continue open work", () => {
    expect(holdsFinishNotice({ trigger: "follow_up", clientNonce: "open-work:run-0" }, on)).toBe(
      true,
    );
    // The person's own run, a result run and the older follow-up keep their notification.
    expect(holdsFinishNotice({ trigger: "user", clientNonce: "c1" }, on)).toBe(false);
    expect(holdsFinishNotice({ trigger: "helper_result", clientNonce: null }, on)).toBe(false);
    expect(holdsFinishNotice({ trigger: "follow_up" }, on)).toBe(false);
    expect(holdsFinishNotice({ trigger: "follow_up", clientNonce: "unfinished:run-0" }, on)).toBe(
      false,
    );
    // Switched off with the continuation itself.
    expect(
      holdsFinishNotice(
        { trigger: "follow_up", clientNonce: "open-work:run-0" },
        { continueOpenWork: false },
      ),
    ).toBe(false);
  });

  it("is dropped when the job goes on, and when the stalled notice went out instead", async () => {
    const send = vi.fn(async () => undefined);
    expect(
      await settleFinishNotice(
        run,
        { decision: { action: "continue", basis: "items" }, continuationRunId: "run-2" },
        send,
      ),
    ).toBe("held");
    expect(
      await settleFinishNotice(
        run,
        {
          decision: { action: "stalled", reason: "no_progress", openCount: 1 },
          noticeMessageId: "message-1",
        },
        send,
      ),
    ).toBe("held");
    expect(send).not.toHaveBeenCalled();
  });

  it("is sent, once, when the chain ends here", async () => {
    const send = vi.fn(async () => undefined);
    // All open work is done.
    expect(
      await settleFinishNotice(run, { decision: { action: "none", reason: "no_open_work" } }, send),
    ).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
    // Something else will wake the agent, or a continuation was not started after all.
    for (const reason of ["will_wake:helpers", "already_continued", "asked_person"])
      expect(await settleFinishNotice(run, { decision: { action: "none", reason } }, send)).toBe(
        "sent",
      );
    // A stall the owner gets no notice for (switched off, or told before) is not silent either.
    expect(
      await settleFinishNotice(
        run,
        { decision: { action: "stalled", reason: "limit", openCount: 2 } },
        send,
      ),
    ).toBe("sent");
    // The check failed: nothing is known, so the notification goes out.
    expect(await settleFinishNotice(run, undefined, send)).toBe("sent");
    expect(send).toHaveBeenCalledTimes(6);
  });

  it("does nothing for a run whose notification was not held", async () => {
    expect(
      await settleFinishNotice(
        run,
        { decision: { action: "continue", basis: "items" }, continuationRunId: "run-2" },
        undefined,
      ),
    ).toBe("none");
  });
});
