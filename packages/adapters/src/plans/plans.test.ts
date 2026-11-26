import { describe, expect, it } from "vitest";
import { planReplyIntent } from "./intent.js";
import type { PlanRow } from "./plans.js";
import {
  effectivePlanMode,
  planDefaultMode,
  planInstruction,
  planInvolves,
  spokenNotice,
  spokenPlan,
  workflowTrusted,
} from "./plans.js";

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

// FORK.md 1.22: one approval covers the task, not one message.
describe("what an approved plan covers", () => {
  const plan = {
    id: "plan-1",
    title: "Subtitles",
    steps: [
      { text: "Find the video", agent: "Worker" },
      { text: "Check the result", agent: "Reviewer (second opinion)" },
      { text: "Report" },
    ],
    recipients: ["bot-sent"],
  } as unknown as PlanRow;

  it("involves an agent a step names or one that already got a request under it", () => {
    expect(planInvolves(plan, { id: "bot-w", name: "Worker" })).toBe(true);
    expect(planInvolves(plan, { id: "bot-w", name: "worker" })).toBe(true);
    expect(planInvolves(plan, { id: "bot-r", name: "Reviewer" })).toBe(true);
    expect(planInvolves(plan, { id: "bot-sent", name: "Unnamed" })).toBe(true);
    expect(planInvolves(plan, { id: "bot-x", name: "Networker" })).toBe(false);
    expect(planInvolves(plan, { id: "bot-x", name: "Designer" })).toBe(false);
    expect(planInvolves(plan, { id: "bot-x", name: "Re" })).toBe(false);
    expect(planInvolves({ steps: [], recipients: [] }, { id: "bot-w", name: "Worker" })).toBe(
      false,
    );
  });

  it("tells a later run that follow-ups are covered, and Always ask that only corrections are", () => {
    const base = { threshold: 3, trusted: [], covering: { plan, agents: ["Worker", "Reviewer"] } };
    const trusted = planInstruction({ ...base, mode: "until_trusted" });
    expect(trusted).toContain("still covers this task for: Worker, Reviewer");
    expect(trusted).toContain("do not propose a new plan for that");
    expect(trusted).toContain("corrections and follow-ups about it");
    const always = planInstruction({ ...base, mode: "always" });
    expect(always).toContain("use message_bot with replaces; no new plan is needed for that");
    expect(always).toContain("An approved plan is one hand-off");
    expect(always).not.toContain("still covers this task");
    expect(planInstruction({ mode: "until_trusted", threshold: 3, trusted: [] })).toContain(
      "if the old one has already finished, the correction is delivered as a new request",
    );
  });
});

// FORK.md 1.25: Notify mode and the deployment default.
describe("plan mode notify and PLAN_DEFAULT_MODE", () => {
  it("takes the default from the deployment, and the agent's own choice over it", () => {
    expect(planDefaultMode({})).toBe("until_trusted");
    expect(planDefaultMode({ PLAN_DEFAULT_MODE: "" })).toBe("until_trusted");
    expect(planDefaultMode({ PLAN_DEFAULT_MODE: "notify" })).toBe("notify");
    expect(planDefaultMode({ PLAN_DEFAULT_MODE: " Notify " })).toBe("notify");
    expect(planDefaultMode({ PLAN_DEFAULT_MODE: "always" })).toBe("always");
    expect(planDefaultMode({ PLAN_DEFAULT_MODE: "never" })).toBe("never");
    expect(planDefaultMode({ PLAN_DEFAULT_MODE: "until-trusted" })).toBe("until_trusted");
    // A value nobody knows never switches approval off by accident.
    expect(planDefaultMode({ PLAN_DEFAULT_MODE: "yolo" })).toBe("until_trusted");
    expect(effectivePlanMode(null, { PLAN_DEFAULT_MODE: "notify" })).toBe("notify");
    expect(effectivePlanMode("always", { PLAN_DEFAULT_MODE: "notify" })).toBe("always");
    expect(effectivePlanMode("until_trusted", { PLAN_DEFAULT_MODE: "never" })).toBe(
      "until_trusted",
    );
    expect(effectivePlanMode(null, {})).toBe("until_trusted");
  });

  it("tells the agent to post the plan and carry on, never to ask or wait", () => {
    const line = planInstruction({ mode: "notify", threshold: 3, trusted: [] }) ?? "";
    expect(line).toContain("Plans (notify, no approval needed)");
    expect(line).toContain("carry it out in the same turn");
    expect(line).toContain("Do NOT ask whether to go ahead");
    expect(line).not.toContain("end your turn with one short question");
    expect(line).not.toContain("nothing else happens until he approves");
    // Corrections afterwards still work the same way.
    expect(line).toContain("use message_bot with replaces");
    expect(line).toContain("corrections and follow-ups about it");
    // The asking modes are worded as before.
    const asking = planInstruction({ mode: "until_trusted", threshold: 3, trusted: [] }) ?? "";
    expect(asking).toContain("Then end your turn with one short question");
    expect(asking).not.toContain("no approval needed");
  });

  it("never trusts a workflow by count under notify", () => {
    expect(workflowTrusted("notify", 3, { approvals: 9 })).toBe(false);
  });

  it("speaks a notice as a statement, not a question", () => {
    const steps = [{ text: "Find the video", agent: "Worker" }, { text: "Report" }];
    const own = spokenNotice("Subtitles", steps, "I will have Worker find it. Shall I go ahead?");
    expect(own).toBe("I will have Worker find it. I am starting now.");
    const built = spokenNotice("Subtitles", steps);
    expect(built).toContain("My plan for Subtitles: 1, Worker Find the video; 2, Report");
    expect(built.endsWith("I am starting now.")).toBe(true);
    expect(`${own}${built}`).not.toContain("?");
  });
});
