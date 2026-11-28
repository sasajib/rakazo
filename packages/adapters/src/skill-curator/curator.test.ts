import { describe, expect, it } from "vitest";
import { curatorConfig } from "./config.js";
import type { VisibleSkill } from "./curator.js";
import {
  cleanDescription,
  diffSummary,
  effectiveMode,
  learnedSkillBody,
  planProposal,
  taughtSkillMd,
} from "./curator.js";
import { createOpenAiCuratorModel, curatorPayload, parseProposal } from "./model.js";
import { skillsReadIn, toolOutline } from "./outline.js";
import { skillLearningInstruction } from "./seams.js";
import { classifyRun, isProcedureCorrection, teachingTask } from "./triggers.js";

const at = new Date("2026-11-25T10:00:00Z");
const owner = (text: string, current = true) => ({ text, at, current });

describe("classifyRun", () => {
  const base = { toolCalls: 0, minToolCalls: 6, teaching: false };
  it("learns from a correction about how a task is done", () => {
    expect(
      classifyRun({ ...base, current: ["No, always check the inbox folder first."], toolCalls: 2 }),
    ).toEqual({ kind: "curate", reason: "correction" });
  });
  it("counts the bot's earlier tool calls for a correction that comes after the work", () => {
    expect(
      classifyRun({ ...base, current: ["next time sort them by date first"], priorToolCalls: 3 }),
    ).toEqual({ kind: "curate", reason: "correction" });
  });
  it("needs real work for a correction", () => {
    expect(classifyRun({ ...base, current: ["no, always say hello"] })).toEqual({ kind: "skip" });
  });
  it("learns when asked", () => {
    expect(classifyRun({ ...base, current: ["Great. Make this a skill."] })).toEqual({
      kind: "curate",
      reason: "explicit",
    });
    expect(classifyRun({ ...base, current: ["remember how to do this please"] })).toEqual({
      kind: "curate",
      reason: "explicit",
    });
  });
  it("learns from a long run", () => {
    expect(classifyRun({ ...base, current: ["tidy the reports"], toolCalls: 6 })).toEqual({
      kind: "curate",
      reason: "iterative",
    });
    expect(classifyRun({ ...base, current: ["tidy the reports"], toolCalls: 5 })).toEqual({
      kind: "skip",
    });
  });
  it("opens, follows and closes a chat lesson", () => {
    expect(
      classifyRun({ ...base, current: ["Let me teach you how to archive old invoices."] }),
    ).toEqual({ kind: "teach_start", task: "archive old invoices" });
    expect(
      classifyRun({ ...base, teaching: true, current: ["Now move them into 2025/"], toolCalls: 3 }),
    ).toEqual({ kind: "skip" });
    expect(classifyRun({ ...base, teaching: true, current: ["done, save as skill"] })).toEqual({
      kind: "curate",
      reason: "teach_done",
    });
    expect(classifyRun({ ...base, teaching: true, current: ["cancel the lesson"] })).toEqual({
      kind: "teach_cancel",
    });
  });
  it("ignores small talk", () => {
    expect(classifyRun({ ...base, current: ["thanks!"] })).toEqual({ kind: "skip" });
    expect(isProcedureCorrection("I know")).toBe(false);
    expect(teachingTask("what is the weather")).toBeUndefined();
  });
});

const skill = (over: Partial<VisibleSkill> = {}): VisibleSkill => ({
  id: "skill-1",
  name: "Archive Invoices",
  description: "Use when archiving invoices",
  content:
    "---\nname: Archive Invoices\ndescription: Use when archiving invoices\n---\n\n## Steps\n1. Open the folder\n",
  source: "user",
  learned: true,
  ...over,
});

describe("planProposal", () => {
  const messages = [owner("No, always check the inbox folder first, then move the files.")];
  const create = {
    action: "create" as const,
    name: "Tidy Report Files",
    description: "when the owner asks to tidy report files",
    steps: ["Check the inbox folder first", "Move files into reports/"],
    pitfalls: ["Never delete originals"],
    summary: "Tidies report files the owner's way",
    quote: "always check the inbox folder first",
  };

  it("accepts a quoted create and writes a Use-when SKILL.md", () => {
    const plan = planProposal(create, { reason: "correction", messages, skills: [] });
    expect(plan.kind).toBe("create");
    if (plan.kind !== "create") return;
    expect(plan.description).toBe("Use when the owner asks to tidy report files");
    expect(plan.content).toContain("name: Tidy Report Files");
    expect(plan.content).toContain("1. Check the inbox folder first");
    expect(plan.content).toContain("## Pitfalls");
  });

  it("refuses a create the owner never said (quote gate)", () => {
    const plan = planProposal(
      { ...create, quote: "upload everything to the cloud" },
      { reason: "correction", messages, skills: [] },
    );
    expect(plan).toEqual({ kind: "skip", why: "quote" });
  });

  it("takes an explicit ask or a lesson as the evidence", () => {
    const plan = planProposal(
      { ...create, quote: "nothing like this" },
      { reason: "teach_done", messages, skills: [] },
    );
    expect(plan.kind).toBe("create");
  });

  it("never writes a secret", () => {
    const plan = planProposal(
      { ...create, steps: ["Log in with password: hunter22", "Move files"] },
      { reason: "correction", messages, skills: [] },
    );
    expect(plan).toEqual({ kind: "skip", why: "secret" });
  });

  it("refuses a name that is taken", () => {
    const plan = planProposal(create, {
      reason: "correction",
      messages,
      skills: [skill({ name: "tidy report files" })],
    });
    expect(plan).toEqual({ kind: "skip", why: "name_taken" });
  });

  it("patches a visible user skill; Auto only when the curator learned it", () => {
    const patch = {
      action: "patch" as const,
      skillId: "skill-1",
      body: "## Steps\n1. Check the inbox folder first\n2. Open the folder\n",
      change: "Check the inbox first",
      quote: "always check the inbox folder first",
    };
    const learned = planProposal(patch, { reason: "correction", messages, skills: [skill()] });
    expect(learned.kind).toBe("patch");
    if (learned.kind !== "patch") return;
    expect(learned.autoAllowed).toBe(true);
    expect(learned.diff).toContain("+ 1. Check the inbox folder first");
    const owners = planProposal(patch, {
      reason: "correction",
      messages,
      skills: [skill({ learned: false })],
    });
    expect(owners.kind === "patch" && owners.autoAllowed).toBe(false);
    expect(
      planProposal(patch, {
        reason: "correction",
        messages,
        skills: [skill({ source: "builtin" })],
      }),
    ).toEqual({ kind: "skip", why: "read_only" });
    // An organization's shared skill reads as the owner's kind but is not his to change.
    expect(
      planProposal(patch, {
        reason: "correction",
        messages,
        skills: [skill({ readOnly: true })],
      }),
    ).toEqual({ kind: "skip", why: "read_only" });
    expect(
      planProposal(
        { ...patch, skillId: "other" },
        { reason: "correction", messages, skills: [skill()] },
      ),
    ).toEqual({
      kind: "skip",
      why: "unknown_skill",
    });
  });

  it("does nothing for none or no answer", () => {
    expect(
      planProposal(
        { action: "none", reason: "chat" },
        { reason: "iterative", messages, skills: [] },
      ),
    ).toEqual({
      kind: "skip",
      why: "none",
    });
    expect(planProposal(undefined, { reason: "iterative", messages, skills: [] })).toEqual({
      kind: "skip",
      why: "no_answer",
    });
  });
});

describe("model I/O", () => {
  it("shows short skill ids and maps them back", () => {
    const { payload, idOf } = curatorPayload({
      today: "2026-11-25",
      reason: "correction",
      botName: "Bot",
      messages: [owner("hi")],
      replies: [],
      outline: [],
      skills: [{ id: "real-id", name: "X", description: "Use when x", learned: true }],
      rules: [],
    });
    expect(JSON.stringify(payload)).toContain('"id":"S1"');
    expect(JSON.stringify(payload)).not.toContain("real-id");
    expect(
      parseProposal('{"action":"patch","skill":"S1","body":"b","change":"c","quote":"q"}', idOf),
    ).toMatchObject({ action: "patch", skillId: "real-id" });
    expect(parseProposal('{"action":"patch","skill":"S9","body":"b"}', idOf)).toBeUndefined();
    expect(parseProposal("not json", idOf)).toBeUndefined();
    expect(parseProposal('```json\n{"action":"none","reason":"x"}\n```', idOf)).toEqual({
      action: "none",
      reason: "x",
    });
  });
});

describe("a curator model that spends the whole budget thinking", () => {
  const input = {
    today: "2026-11-26",
    reason: "correction" as const,
    botName: "Bot",
    messages: [owner("no, always check the calendar first")],
    replies: [],
    outline: [],
    skills: [],
    rules: [],
  };
  const ask = (answers: Array<{ content: string; finish_reason: string }>, maxTokens?: number) => {
    const budgets: number[] = [];
    const model = createOpenAiCuratorModel(
      { baseUrl: "http://omniroute:20128/v1", model: "glm/glm-5.3-flash" },
      {
        timeoutMs: 1000,
        ...(maxTokens ? { maxTokens } : {}),
        fetchImpl: async (_url, init) => {
          budgets.push((JSON.parse(init.body) as { max_tokens: number }).max_tokens);
          const answer = answers[Math.min(budgets.length, answers.length) - 1]!;
          return {
            ok: true,
            json: async () => ({
              choices: [
                { message: { content: answer.content }, finish_reason: answer.finish_reason },
              ],
            }),
          };
        },
      },
    );
    return { budgets, result: model.propose(input) };
  };

  it("asks once more with twice the budget, then gives up", async () => {
    const recovered = ask([
      { content: "", finish_reason: "length" },
      { content: '{"action":"none","reason":"covered"}', finish_reason: "stop" },
    ]);
    expect(await recovered.result).toEqual({ action: "none", reason: "covered" });
    expect(recovered.budgets).toEqual([16_000, 32_000]);
    const lost = ask([{ content: "", finish_reason: "length" }], 4_000);
    expect(await lost.result).toBeUndefined();
    expect(lost.budgets).toEqual([4_000, 8_000]);
    const answered = ask([{ content: '{"action":"none","reason":"x"}', finish_reason: "stop" }]);
    await answered.result;
    expect(answered.budgets).toEqual([16_000]);
  });

  it("takes its budget from the memory ledger's setting", () => {
    expect(curatorConfig({}).model.maxTokens).toBe(16_000);
    expect(curatorConfig({ MEMORY_LEDGER_MODEL_MAX_TOKENS: "20000" }).model.maxTokens).toBe(20_000);
  });
});

describe("outline", () => {
  it("lists calls with redacted, bounded args and finds skills read", () => {
    const outline = toolOutline({
      toolCalls: [
        { label: "Skill read", executionId: "a", tool: "skill_read" },
        { label: "Shell", executionId: "b", tool: "shell" },
        { label: "Shell", executionId: "b", tool: "shell" },
      ],
      toolOutcomes: new Map([["b", "succeeded"]]),
      toolStepCalls: new Map([
        ["a", { arguments: '{"name":"Archive Invoices"}' }],
        ["b", { arguments: '{"command":"curl -u bob:pa55word@x https://x"}' }],
      ]),
    });
    expect(outline).toHaveLength(2);
    expect(outline[1]?.outcome).toBe("succeeded");
    expect(skillsReadIn(outline)).toEqual(["Archive Invoices"]);
  });
});

describe("text helpers", () => {
  it("formats bodies, descriptions, diffs and modes", () => {
    expect(learnedSkillBody({ name: "N", steps: ["1. a", "b"], pitfalls: [] })).toBe(
      "# N\n\n## Steps\n1. a\n2. b\n",
    );
    expect(cleanDescription("Use when x")).toBe("Use when x");
    expect(diffSummary("a\nb", "a\nc")).toBe("+ c\n- b");
    expect(effectiveMode({ space: null, bot: null })).toBe("ask");
    expect(effectiveMode({ space: "auto", bot: null })).toBe("auto");
    expect(effectiveMode({ space: "auto", bot: "off" })).toBe("off");
  });

  it("turns a taught playbook into a SKILL.md", () => {
    const md = taughtSkillMd({
      name: "Export report",
      goal: "Export the weekly report",
      playbook: {
        whenToUse: "the owner asks for the weekly report",
        inputs: ["week"],
        steps: ["Open the dashboard", "Click Export"],
        howToCheck: "A CSV is downloaded",
        whatToReturn: "The file",
        approvalBoundaries: "",
        failureHandling: "Retry once",
      },
    });
    expect(md.description).toBe("Use when the owner asks for the weekly report");
    expect(md.content).toContain("2. Click Export");
    expect(md.content).toContain("- If it fails: Retry once");
  });
});

describe("prompt line and config", () => {
  it("is absent when the curator is off and honest when on", () => {
    expect(skillLearningInstruction(undefined, "x")).toBeUndefined();
    const on = skillLearningInstruction({ mode: "ask" }, "do it");
    expect(on).toContain("Say you saved a skill only when");
    const lesson = skillLearningInstruction(
      { mode: "ask" },
      "Let me teach you how to file receipts",
    );
    expect(lesson).toContain('teaching you how to "file receipts"');
    const off = skillLearningInstruction({ mode: "off" }, "Let me teach you how to file receipts");
    expect(off).not.toContain("teaching you");
  });
  it("falls back to the memory ledger's model", () => {
    const config = curatorConfig({
      SKILL_CURATOR: "1",
      MEMORY_LEDGER_MODEL_URL: "http://omni/v1",
      MEMORY_LEDGER_MODEL: "glm/glm-5.3-flash",
    });
    expect(config.enabled).toBe(true);
    expect(config.model.url).toBe("http://omni/v1");
    expect(config.model.model).toBe("glm/glm-5.3-flash");
    expect(curatorConfig({ SKILL_CURATOR_MODEL: "other" }).model.model).toBe("other");
    expect(curatorConfig({}).enabled).toBe(false);
  });
});
