import { describe, expect, it } from "vitest";
import type { RunContext } from "../runs/assembly/run-context.js";
import { runFacts } from "./run-hooks.js";
import { learnsFrom } from "./seams.js";

function ctx(source: Partial<RunContext["source"]>): RunContext {
  return {
    runId: "run1",
    run: { spaceId: "s1", userId: "u1", threadId: "t1", trigger: "user", sourceMessageId: "m1" },
    bot: { id: "b1", name: "Bot" },
    source: { ownerStartedRun: true, meetingChat: false, messagingChannelRun: false, ...source },
  } as unknown as RunContext;
}

describe("runFacts", () => {
  it("learns from the owner's one-to-one chat, which upstream marks as a meeting chat", () => {
    const facts = runFacts(ctx({ meetingChat: true, conversationThreadId: "t1" }));
    expect(facts.ownerStartedRun).toBe(true);
    expect(learnsFrom(facts)).toBe(true);
  });

  it("does not learn from runs the owner did not start or from connected chats", () => {
    expect(learnsFrom(runFacts(ctx({ ownerStartedRun: false })))).toBe(false);
    expect(learnsFrom(runFacts(ctx({ messagingChannelRun: true })))).toBe(false);
  });
});
