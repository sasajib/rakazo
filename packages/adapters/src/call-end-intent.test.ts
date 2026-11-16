import { describe, expect, it } from "vitest";
import { callEndRequested } from "./call-end-intent.js";

describe("call end intent", () => {
  it.each([
    "Okay, bye.",
    "ok thanks, goodbye",
    "Please hang up now",
    "you can end the call",
    "That's all for today.",
    "talk to you later",
    "Allah hafez",
    "ঠিক আছে, রাখি",
  ])("lets the bot end the call after %j", (text) => {
    expect(callEndRequested(text)).toBe(true);
  });

  it.each([
    "Okay.",
    "Hi. Omar.",
    "Nada. Nad.",
    "thanks",
    "yes",
    "",
    "clogged code directly.",
    "What is the status?",
  ])("keeps the call open after %j", (text) => {
    expect(callEndRequested(text)).toBe(false);
  });

  it("treats a missing turn as no request", () => {
    expect(callEndRequested(undefined)).toBe(false);
  });
});
