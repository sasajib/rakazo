import { describe, expect, it } from "vitest";
import { ACK_MAX_CHARS, acknowledgementFor, summariseRequest } from "./run-progress.js";

describe("summariseRequest", () => {
  it("restates a dictated request without the caller's noises", () => {
    const said =
      "Hi, chief. Uh, we we we going... we are going to need have a a voice testing agent. " +
      "So can you please create a voice testing agent so we can do some few... we can do few, uh, " +
      "voice testing with him?";
    const summary = summariseRequest(said);
    expect(summary.toLowerCase()).toContain("voice testing agent");
    for (const noise of [" uh", " um", " hmm", "we we", "a a "]) {
      expect(summary.toLowerCase()).not.toContain(noise);
    }
    expect(summary.endsWith("?")).toBe(false);
  });

  it("finds the task inside a dictated request, and keeps the same words as the agent", () => {
    const said =
      "Hi, chief. Uh, we we we going... we are going to need have a a voice testing agent. " +
      "So can you please create a voice testing agent so we can do some few... we can do few, uh, " +
      "voice testing with him?";
    const line = acknowledgementFor("user", said) ?? "";
    expect(line).not.toMatch(/can you please|\buh\b|we we/i);
    expect(line).toMatch(/create a voice testing agent/i);
  });

  it("drops the greeting and the request wrapper", () => {
    expect(summariseRequest("Hey chief, can you please create a voice agent")).toBe(
      "create a voice agent",
    );
    expect(summariseRequest("I need you to summarise the report")).toBe("summarise the report");
  });

  it("collapses stutters", () => {
    expect(summariseRequest("make make make a plan")).toBe("make a plan");
  });
});

describe("acknowledgementFor", () => {
  it("states the task in its own words, not the transcript", () => {
    const line = acknowledgementFor("user", "uh, can you please create a voice testing agent?");
    expect(line).toContain("Got it — create a voice testing agent.");
    expect(line).not.toContain("uh");
    expect(line).not.toContain("?");
  });

  it("clips a long request to the limit", () => {
    const long = "write a report about every customer ".repeat(20);
    const line = acknowledgementFor("user", long) ?? "";
    expect(line).toContain("…");
    expect(line.length).toBeLessThan(ACK_MAX_CHARS + 120);
  });

  it("collapses whitespace so the line stays one sentence", () => {
    expect(acknowledgementFor("user", "  a\n\nb   c ")).toContain("Got it — a b c.");
  });

  it("stays quiet for runs that are not a person's turn", () => {
    for (const trigger of ["routine", "bot_message", "talk", "helper", "webhook", "reaction"]) {
      expect(acknowledgementFor(trigger, "do the thing"), trigger).toBeNull();
    }
  });

  it("stays quiet when there is nothing to quote", () => {
    expect(acknowledgementFor("user", "   ")).toBeNull();
  });

  it("answers a follow-up too, which is still the person's message", () => {
    expect(acknowledgementFor("follow_up", "add the export step")).toContain("add the export step");
  });
});
