import { describe, expect, it } from "vitest";
import {
  CONTINUATION_MARKER,
  continuationPrompt,
  MAX_CONTINUATIONS,
  needsContinuation,
  replyIsTheWork,
  requestsWork,
} from "./run-supervision.js";

describe("requestsWork", () => {
  it("recognises a dictated instruction", () => {
    for (const said of [
      "Hey chief, can you please create a voice agent",
      "uh, we need to send the invoice today",
      "delete the old bot",
      "I want you to summarise the report",
    ]) {
      expect(requestsWork(said), said).toBe(true);
    }
  });

  it("does not mistake a question for work", () => {
    for (const said of [
      "what is the capital of Bangladesh?",
      "how long will that take",
      "tell me about the report",
      "show me the numbers",
      "",
    ]) {
      expect(requestsWork(said), said).toBe(false);
    }
  });
});

describe("requestsWork: a work word used as a noun asks for nothing", () => {
  it("does not mistake a statement for an instruction", () => {
    for (const said of [
      "this is a safe test",
      "thanks for the update",
      "that was a good call",
      "nice find",
      "the report looks great",
      "good plan, I like it",
    ]) {
      expect(requestsWork(said), said).toBe(false);
    }
  });

  it("still sees the verb wherever an instruction puts it", () => {
    for (const said of [
      "install the gsc cli and sign in",
      "spawn a bot named Scout to research venues",
      "can you quickly fix the login page",
      "ok, then deploy it",
      "the invoice is wrong: update it",
      "let's test the new build",
      "don't delete it, just rename the folder",
      "I need a report on last week's sales",
      "we really want a plan for the launch",
      "create a voice agent for testing",
    ]) {
      expect(requestsWork(said), said).toBe(true);
    }
  });
});

describe("needsContinuation", () => {
  const base = {
    trigger: "user",
    request: "create a voice agent for testing",
    toolCallCount: 0,
    replyText: "Got it — you want a voice agent. First I",
    status: "completed" as const,
  };

  it("continues a run that announced the work and did none of it", () => {
    expect(needsContinuation(base)).toBe(true);
  });

  it("leaves a run alone once it used a tool", () => {
    expect(needsContinuation({ ...base, toolCallCount: 2 })).toBe(false);
  });

  it("leaves a run alone once it stopped for the person, with or without a tool call", () => {
    const afterTakeover = {
      ...base,
      request: "install the gsc cli and sign in",
      replyText: "signed in. the session stays in this computer.",
    };
    expect(needsContinuation(afterTakeover)).toBe(true);
    expect(needsContinuation({ ...afterTakeover, pausedForPerson: true })).toBe(false);
  });

  it("leaves a statement alone: nothing was asked for, so nothing is left undone", () => {
    expect(
      needsContinuation({ ...base, request: "this is a safe test", replyText: "Noted." }),
    ).toBe(false);
  });

  it("leaves a question alone, however short the answer", () => {
    expect(needsContinuation({ ...base, request: "what is the capital of India?" })).toBe(false);
  });

  it("leaves a long answer alone", () => {
    expect(needsContinuation({ ...base, replyText: "x".repeat(400) })).toBe(false);
  });

  it("leaves a finished text-only job alone: the reply is the work", () => {
    const summary = {
      ...base,
      request:
        'Summarise this article in one line: "Karim Hossain, founder of BrightPay, lives in Rajshahi."',
      replyText: "Karim Hossain is the Rajshahi-based founder of BrightPay.",
    };
    expect(needsContinuation(summary)).toBe(false);
    // Cut off mid-sentence, it is still continued.
    expect(needsContinuation({ ...summary, replyText: "Sure, first I" })).toBe(true);
  });

  // Live test 1128a: six agents asked only to reply "ready"; three got a second run.
  describe("a reply that completes the request (fork L5)", () => {
    const REPLY_ONLY = [
      "Reply with the single word ready",
      "reply ready",
      "Please reply with just: ready.",
      "Reply only with OK",
      "ok, reply yes or no",
      "Reply to me with one word",
      "Just reply in one sentence",
      "hi there, reply with the number 4",
    ];
    const REPLIES = [
      "ready",
      "Ready.",
      "I'll answer with that and nothing more: ready",
      "I'll answer with that and nothing more…",
      "Sure",
      "On it",
    ];

    it.each(REPLY_ONLY)('"%s": whatever it replied, it replied', (request) => {
      expect(replyIsTheWork(request), request).toBe(true);
      for (const replyText of REPLIES)
        expect(needsContinuation({ ...base, request, replyText }), replyText).toBe(false);
    });

    it("still continues it when nothing was said at all", () => {
      expect(needsContinuation({ ...base, request: REPLY_ONLY[0]!, replyText: "  " })).toBe(true);
    });

    it.each([
      "reply to the supplier's email and attach the invoice",
      "Reply to Karim on Slack that we ship on Friday",
      "reply with ready, then deploy the site",
      "create a voice agent for testing",
      "send the report to the board",
    ])('"%s" is work beyond a reply: an announcement is still continued', (request) => {
      expect(replyIsTheWork(request), request).toBe(false);
      for (const replyText of ["On it", "Sure, I'll do that now.", "ready"])
        expect(needsContinuation({ ...base, request, replyText }), replyText).toBe(true);
    });

    it("is the first rule again when the judgement is switched off", () => {
      expect(
        needsContinuation({
          ...base,
          request: REPLY_ONLY[0]!,
          replyText: "ready",
          replyCompletes: false,
        }),
      ).toBe(true);
    });
  });

  it("never continues a continuation: one retry, not a loop", () => {
    expect(needsContinuation({ ...base, taskPrompt: continuationPrompt(base.request) })).toBe(
      false,
    );
  });

  it("never continues a run that did not complete", () => {
    for (const status of ["failed", "cancelled", "running", "waiting_input"]) {
      expect(needsContinuation({ ...base, status }), status).toBe(false);
    }
  });

  it("only supervises runs that answer a person", () => {
    for (const trigger of ["routine", "bot_message", "talk", "helper", "webhook"]) {
      expect(needsContinuation({ ...base, trigger }), trigger).toBe(false);
    }
  });
});

describe("continuationPrompt", () => {
  it("carries the marker and the original request", () => {
    const prompt = continuationPrompt("  create a voice agent  ");
    expect(prompt.startsWith(CONTINUATION_MARKER)).toBe(true);
    expect(prompt).toContain("create a voice agent");
    expect(MAX_CONTINUATIONS).toBe(1);
  });
});
