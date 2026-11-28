/**
 * Fork (1.32, L2): timings against a real embeddings endpoint. Skipped unless
 * SKILL_AUTOLOAD_LIVE_EMBEDDINGS_URL is set (read-only calls), e.g. on bee:
 *   SKILL_AUTOLOAD_LIVE_EMBEDDINGS_URL=http://127.0.0.1:11435 npx vitest run \
 *     packages/adapters/src/skill-autoload/embeddings-timing.live.test.ts
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createEmbedder } from "../memory-ledger/embeddings.js";
import { helperPrompt } from "../tasks/background-helpers.prompt.js";
import { autoloadSkills, resetSkillVectorCache, warmTaskVector } from "./autoload.js";
import { skillAutoloadConfig } from "./config.js";
import { cosine } from "./match.js";
import { taskDigest, taskFocus } from "./task-digest.js";

const url = process.env.SKILL_AUTOLOAD_LIVE_EMBEDDINGS_URL;
const live = url ? describe : describe.skip;

const skill = (name: string, description: string) => ({
  id: name,
  name,
  description,
  content: `---\nname: ${name}\ndescription: ${description}\n---\nSteps for ${name}.`,
});
const SKILLS = [
  skill("ledger-filing", "File supplier invoices and receipts in the quarterly ledger."),
  skill("garden-care", "Plan watering and feeding for balcony vegetables."),
  skill("trip-planner", "Plan flights, hotels and a day by day itinerary."),
];
const steps = (count: number) =>
  Array.from(
    { length: count },
    (_, index) =>
      `Step ${index}: open document ${index}, compare its total with the bank statement and write down any difference.`,
  ).join("\n");
const taskOf = (chars: number) =>
  `Book the supplier bills of this quarter into our accounts book and tell me what is missing.\n\n${steps(80)}`.slice(
    0,
    chars,
  );
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

live("skill auto-load against the real embeddings endpoint", () => {
  const env = { MEMORY_EMBEDDINGS_URL: url! };
  const config = skillAutoloadConfig(env);
  const embedder = createEmbedder(config.embeddings.endpoint)!;
  const timed = async (text: string) => {
    const started = performance.now();
    const vector = await embedder.embed(text);
    return { ms: performance.now() - started, vector };
  };

  beforeAll(async () => {
    resetSkillVectorCache();
    await autoloadSkills(
      { trigger: "user", task: taskOf(90), skills: SKILLS },
      { config, embedder },
    );
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }, 30_000);

  it("embeds a long task's digest inside the wait, where the whole text is not", async () => {
    const rows: string[] = [];
    for (const chars of [60, 600, 3_000, 8_000]) {
      const task = taskOf(chars);
      const digest = taskDigest(task);
      const whole: number[] = [];
      const digested: number[] = [];
      for (let round = 0; round < 3; round += 1) {
        // A different tail each round, so no server-side cache answers.
        whole.push((await timed(`${task.slice(0, 4_000)} ${round}`)).ms);
        digested.push((await timed(`${digest.slice(0, 396)} ${round}`)).ms);
      }
      rows.push(
        `${chars} chars: whole text ${Math.round(median(whole))} ms, digest (${digest.length} chars) ${Math.round(median(digested))} ms`,
      );
      if (chars >= 3_000) expect(median(digested)).toBeLessThan(config.embeddings.timeoutMs);
    }
    process.stdout.write(`\nEMBED TIMINGS\n${rows.join("\n")}`);
  }, 120_000);

  it("matches a paraphrased long task and a helper brief by meaning, without holding the run", async () => {
    const rows: string[] = [];
    for (const [kind, trigger, task] of [
      ["long request (3000 chars)", "bot_message", taskOf(3_000)],
      [
        "helper brief (3000 chars)",
        "helper",
        helperPrompt({ name: "h", task: taskOf(3_000), instructions: "" }),
      ],
    ] as const) {
      resetSkillVectorCache();
      await autoloadSkills(
        { trigger: "user", task: taskOf(90), skills: SKILLS },
        { config, embedder },
      );
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      // Asked in the step itself: the run waits for the digest's embedding.
      const direct = await autoloadSkills({ trigger, task, skills: SKILLS }, { config, embedder });
      // Asked for early, with 300 ms of other assembly work in between.
      const later = `${task}\nAlso list the three largest bills.`;
      warmTaskVector({ trigger, task: later }, { config, embedder });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const early = await autoloadSkills(
        { trigger, task: later, skills: SKILLS },
        { config, embedder },
      );
      for (const [how, result] of [
        ["in the step", direct],
        ["asked early", early],
      ] as const) {
        const ledger = result.log.candidates.find(({ name }) => name === "ledger-filing");
        rows.push(
          `${kind}, ${how}: method ${result.log.method}, waited ${result.log.embed?.waitMs} ms (${result.log.embed?.source}, ${result.log.embed?.chars} chars), ledger similarity ${ledger?.similarity?.toFixed(3)}, chosen ${JSON.stringify(result.log.chosen)}`,
        );
        expect(result.log.method).toBe("lexical+embeddings");
        expect(result.log.embed!.waitMs).toBeLessThan(config.embeddings.timeoutMs);
      }
      expect(early.log.embed!.waitMs).toBeLessThan(direct.log.embed!.waitMs + 50);
    }
    process.stdout.write(`\nAUTOLOAD TIMINGS\n${rows.join("\n")}`);
  }, 120_000);

  it("keeps the meaning: the digest of a long task is as close to its skill as the whole text", async () => {
    const task = taskOf(3_000);
    const [whole, digest, ledger, garden] = await Promise.all(
      [
        task,
        taskDigest(taskFocus("user", task)),
        SKILLS[0]!.description,
        SKILLS[1]!.description,
      ].map(async (text) => (await embedder.embed(text))!),
    );
    process.stdout.write(
      `\nSIMILARITY ledger skill: whole text ${cosine(whole!, ledger!).toFixed(3)}, digest ${cosine(digest!, ledger!).toFixed(3)}; garden skill: whole ${cosine(whole!, garden!).toFixed(3)}, digest ${cosine(digest!, garden!).toFixed(3)}`,
    );
    expect(cosine(digest!, ledger!)).toBeGreaterThan(cosine(digest!, garden!) + 0.1);
    expect(cosine(digest!, ledger!)).toBeGreaterThanOrEqual(cosine(whole!, ledger!) - 0.05);
  }, 60_000);
});
