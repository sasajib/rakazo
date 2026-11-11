import { describe, expect, it } from "vitest";
import { ACK_MAX_CHARS, acknowledgementFor } from "./run-progress.js";

describe("acknowledgementFor", () => {
  it("says what was asked, before any work starts", () => {
    const line = acknowledgementFor("user", "create a voice testing agent");
    expect(line).toContain("create a voice testing agent");
    expect(line).toContain("On it");
  });

  it("quotes a long request only up to the limit", () => {
    const long = "please ".repeat(80);
    const line = acknowledgementFor("user", long) ?? "";
    expect(line).toContain("…");
    expect(line.length).toBeLessThan(ACK_MAX_CHARS + 120);
  });

  it("collapses whitespace so the line stays one sentence", () => {
    expect(acknowledgementFor("user", "  a\n\nb   c ")).toContain("“a b c”");
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
    expect(acknowledgementFor("follow_up", "and then?")).toContain("and then?");
  });
});
