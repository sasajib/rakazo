import { describe, expect, it } from "vitest";
import {
  CONTINUATION_MARKER,
  continuationPrompt,
  MAX_CONTINUATIONS,
  needsContinuation,
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

  it("leaves a question alone, however short the answer", () => {
    expect(needsContinuation({ ...base, request: "what is the capital of India?" })).toBe(false);
  });

  it("leaves a long answer alone", () => {
    expect(needsContinuation({ ...base, replyText: "x".repeat(400) })).toBe(false);
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
