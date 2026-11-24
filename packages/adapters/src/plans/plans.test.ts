import { describe, expect, it } from "vitest";
import { planReplyIntent } from "./intent.js";
import { planInstruction, spokenPlan, workflowTrusted } from "./plans.js";

describe("planReplyIntent (fork: plan confirmation)", () => {
  it.each([
    ["Yes.", "approve"],
    ["yes go ahead", "approve"],
    ["Okay, do it.", "approve"],
    ["Uh, go ahead.", "approve"],
    ["Approved", "approve"],
    ["sounds good, proceed", "approve"],
    ["Change step 2 to download the English subtitles only", "change"],
    ["No, first open the history tab in my browser", "change"],
    ["yes but tell him to use the history tab", "change"],
    ["No.", "reject"],
    ["cancel it", "reject"],
    ["don't do that", "reject"],
    ["What is the capital of India?", "other"],
    ["Did he report back?", "other"],
    ["Is that okay?", "other"],
    ["", "other"],
  ])("%s -> %s", (text, intent) => {
    expect(planReplyIntent(text)).toBe(intent);
  });
});

describe("plan prompt and trust rules", () => {
  it("trust needs Ask until trusted and enough clean approvals", () => {
    expect(workflowTrusted("until_trusted", 3, { approvals: 3 })).toBe(true);
    expect(workflowTrusted("until_trusted", 3, { approvals: 2 })).toBe(false);
    expect(workflowTrusted("always", 3, { approvals: 9 })).toBe(false);
    expect(workflowTrusted("until_trusted", 3, undefined)).toBe(false);
  });

  it("says what the run may do with the chat's plan", () => {
    expect(planInstruction(undefined)).toBeUndefined();
    const base = planInstruction({
      mode: "until_trusted",
      threshold: 3,
      trusted: ["YouTube Subtitle Download"],
    });
    expect(base).toContain("plan_propose");
    expect(base).toContain("replaces");
    expect(base).toContain("Trusted workflows (approved 3 times");
    const plan = {
      id: "p1",
      title: "Subtitles",
      revision: 2,
      steps: [{ text: "Find the video in YouTube history", agent: "YouTube Specialist" }],
    } as never;
    expect(
      planInstruction({ mode: "always", threshold: 3, trusted: [], approved: plan }),
    ).toContain("1. YouTube Specialist: Find the video in YouTube history");
    expect(planInstruction({ mode: "always", threshold: 3, trusted: [], pending: plan })).toContain(
      "still waiting",
    );
  });

  it("speaks a short version ending in a question", () => {
    const line = spokenPlan("the subtitles", [
      { text: "Find it in history", agent: "YouTube Specialist" },
      { text: "Download the subtitles" },
    ]);
    expect(line).toContain("1, YouTube Specialist Find it in history");
    expect(line.endsWith("Shall I go ahead?")).toBe(true);
  });
});
