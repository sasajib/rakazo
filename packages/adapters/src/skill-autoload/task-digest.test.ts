import { describe, expect, it } from "vitest";
import { helperPrompt } from "../tasks/background-helpers.prompt.js";
import { TASK_DIGEST_MAX_CHARS, taskDigest, taskFocus } from "./task-digest.js";

const filler = (lines: number) =>
  Array.from(
    { length: lines },
    (_, index) => `Row ${index} holds the figures of the week and the notes the team left on them.`,
  );

describe("taskDigest", () => {
  it("sends a task that fits whole and unchanged", () => {
    const task = "file the supplier invoice for March\n\nin the quarterly ledger";
    expect(taskDigest(task)).toBe(task);
    expect(taskDigest(`  ${task}\n`)).toBe(task);
    expect(taskDigest("x".repeat(TASK_DIGEST_MAX_CHARS))).toHaveLength(TASK_DIGEST_MAX_CHARS);
    expect(taskDigest("")).toBe("");
  });

  it("is bounded, whatever the task's length or shape", () => {
    for (const task of [
      filler(200).join("\n"),
      filler(200).join(" "),
      "x".repeat(8_000),
      `${"# Heading\n".repeat(400)}`,
      `Do this:\n${"- item\n".repeat(900)}`,
    ]) {
      const digest = taskDigest(task);
      expect(digest.length).toBeLessThanOrEqual(TASK_DIGEST_MAX_CHARS);
      expect(digest.length).toBeGreaterThan(0);
      // The same text gives the same digest: the vector is cached by it.
      expect(taskDigest(task)).toBe(digest);
    }
  });

  it("keeps the opening lines, then the headings, labelled lines and list items in order", () => {
    const task = [
      "Prepare the quarterly supplier report for the finance team.",
      "Use last quarter's layout and keep every figure in euros.",
      ...filler(8),
      "## Collect the invoices",
      ...filler(6),
      "Output:",
      "One spreadsheet with a sheet per supplier",
      ...filler(6),
      "**Deadline**",
      ...filler(4),
      "1. Check the totals against the ledger",
      "- Flag anything over the limit",
      ...filler(30),
    ].join("\n");
    const digest = taskDigest(task);
    expect(digest.startsWith("Prepare the quarterly supplier report for the finance team.")).toBe(
      true,
    );
    expect(digest).toContain("Use last quarter's layout");
    const order = [
      "Collect the invoices",
      "One spreadsheet with a sheet per supplier",
      "Deadline",
      "Check the totals against the ledger",
    ].map((piece) => digest.indexOf(piece));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(digest).not.toContain("##");
    expect(digest.length).toBeLessThanOrEqual(TASK_DIGEST_MAX_CHARS);
  });

  it("skips lines that are only markup and cuts at a word", () => {
    const digest = taskDigest(
      [
        "---",
        "<request>",
        "Summarise the meeting notes for the board",
        "</request>",
        "```",
        ...filler(40),
      ].join("\n"),
    );
    expect(digest.startsWith("Summarise the meeting notes for the board")).toBe(true);
    expect(digest).not.toContain("<request>");
    const long = `Translate ${"the following paragraph carefully ".repeat(200)}`;
    const oneLine = taskDigest(long);
    expect(long.startsWith(`${oneLine} `)).toBe(true);
    expect(oneLine.length).toBeGreaterThan(200);
  });
});

describe("taskFocus", () => {
  const work = `Rewrite the draft so it reads plainly.\n${filler(40).join("\n")}`;

  it("is the task a helper was given, without the paragraphs every helper gets", () => {
    const brief = helperPrompt({ name: "writer", task: work, instructions: "Be brief." });
    expect(taskFocus("helper", brief)).toBe(work);
    expect(taskDigest(taskFocus("helper", brief)).startsWith("Rewrite the draft")).toBe(true);
    // Without the focus the digest would open with words no skill is about.
    expect(taskDigest(brief).startsWith("You are a background helper")).toBe(true);
  });

  it("is the whole task for every other run, and for a helper task without the label", () => {
    expect(taskFocus("user", work)).toBe(work);
    expect(
      taskFocus("bot_message", helperPrompt({ name: "w", task: work, instructions: "" })),
    ).toContain("background helper");
    expect(taskFocus("helper", "plain text")).toBe("plain text");
  });
});
