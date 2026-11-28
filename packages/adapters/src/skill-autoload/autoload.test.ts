import { buildSkillMd, byteLength } from "@rakazo/core";
import { beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../memory-ledger/embeddings.js";
import { helperPrompt } from "../tasks/background-helpers.prompt.js";
import {
  autoloadAppliesTo,
  autoloadSkills,
  resetSkillVectorCache,
  warmTaskVector,
} from "./autoload.js";
import { skillAutoloadConfig } from "./config.js";
import {
  chooseSkills,
  contentWords,
  matchText,
  scoreSkills,
  stem,
  withSimilarity,
} from "./match.js";
import { renderLoadedSkills, renderPinnedSkills, skillBody } from "./skill-autoload.prompt.js";

// Neutral fixtures: no real skill, agent or Space is named in the code under test.
const skill = (name: string, description: string, body = `Steps for ${name}.`, extra = {}) => ({
  id: `id-${name.toLowerCase().replaceAll(" ", "-")}`,
  name,
  description,
  content: buildSkillMd({ name, description, body, frontmatter: extra }),
});

const CATALOG = [
  skill("Plain Voice", "Rewrite text so it reads like a person wrote it: strip filler, add voice."),
  skill("Invoice Filing", "File supplier invoices: name the PDF, pick the folder, log the amount."),
  skill(
    "Site Checks",
    "Use when a site shows a captcha or a security check: what to click, when to stop.",
  ),
  skill("Deck Builder", "Create and edit slide decks from an outline."),
  skill("Trip Planner", "Plan a trip: flights, hotel, daily route, budget."),
  skill("Release Notes", "Write release notes from merged changes.", "Body.", {
    triggers: ["changelog", "what shipped"],
  }),
];

const config = (env: Record<string, string> = {}) => skillAutoloadConfig(env);
const run = (task: string, extra: Partial<Parameters<typeof autoloadSkills>[0]> = {}, env = {}) =>
  autoloadSkills(
    { trigger: "user", task, skills: CATALOG, ...extra },
    { config: config(env), embedder: undefined },
  );

describe("skill auto-load: matching", () => {
  it("stems so a verb, its agent noun and its gerund meet", () => {
    expect(new Set(["humanize", "humanizer", "humanizing", "humanizes"].map(stem)).size).toBe(1);
    expect(stem("invoices")).toBe(stem("invoice"));
    expect(stem("লেখা")).toBe("লেখা");
  });

  it("drops function words and request verbs, keeps other scripts", () => {
    expect(contentWords("Please can you help me make the thing")).toEqual([]);
    expect(contentWords("File the supplier invoice")).toEqual(["fil", "suppli", "invoic"]);
    expect(contentWords("এই লেখাটা ঠিক করো").length).toBe(4);
  });

  it("loads the skill named in the task, by any word form", async () => {
    for (const task of ["use plain voice on this paragraph", "file this supplier invoice pdf"]) {
      const result = await run(task);
      expect(result.log.chosen).toHaveLength(1);
    }
    expect((await run("use plain voice on this paragraph")).log.chosen).toEqual(["Plain Voice"]);
    expect((await run("file these supplier invoices")).log.chosen).toEqual(["Invoice Filing"]);
  });

  it("matches on the description when the name is not said", async () => {
    const result = await run("the site is showing a captcha, what do I click");
    expect(result.log.chosen).toEqual(["Site Checks"]);
    expect(result.text).toContain("<loaded_skills>");
    expect(result.text).toContain("## Skill: Site Checks");
    expect(result.text).toContain("Steps for Site Checks.");
    // Frontmatter is not repeated in the body.
    expect(result.text).not.toContain("---\nname:");
  });

  it("uses trigger words from the frontmatter", async () => {
    expect((await run("write the changelog for what shipped this week")).log.chosen).toEqual([
      "Release Notes",
    ]);
  });

  it("loads nothing for small talk and unrelated requests", async () => {
    for (const task of [
      "hello, how are you today?",
      "thanks, that looks good",
      "ok, go",
      "what time is it in Dhaka",
      "remind me to call mom tomorrow",
      "",
    ]) {
      const result = await run(task);
      expect(result.log.chosen, task).toEqual([]);
      expect(result.text, task).toBeUndefined();
      expect(result.log.bytes).toBe(0);
    }
  });

  it("one shared common word is not a match", () => {
    const scores = scoreSkills("click the button to save my profile", CATALOG, 2);
    expect(chooseSkills(scores, 3)).toEqual([]);
  });

  it("a long task must cover more of the skill than a short one", () => {
    const filler = Array.from({ length: 70 }, (_, index) => `word${index}x`).join(" ");
    const short = scoreSkills("plan the flights and hotel", CATALOG, 2);
    const long = scoreSkills(`plan the flights and hotel ${filler}`, CATALOG, 2);
    expect(chooseSkills(short, 3).map((entry) => entry.name)).toEqual(["Trip Planner"]);
    expect(long.find((entry) => entry.name === "Trip Planner")?.coverage).toBeLessThan(0.4);
    expect(chooseSkills(long, 3)).toEqual([]);
  });

  it("keeps only skills near the best match, at most the configured number", () => {
    const scores = [
      { id: "a", name: "A", score: 10, coverage: 1, matched: 3, nameHit: true, eligible: true },
      { id: "b", name: "B", score: 7, coverage: 1, matched: 3, nameHit: false, eligible: true },
      { id: "c", name: "C", score: 5, coverage: 1, matched: 3, nameHit: false, eligible: true },
      { id: "d", name: "D", score: 9, coverage: 1, matched: 3, nameHit: false, eligible: false },
    ];
    expect(chooseSkills(scores, 3).map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(chooseSkills(scores, 1).map((entry) => entry.id)).toEqual(["a"]);
  });

  it("a short go-ahead is matched with the chat's latest real request", async () => {
    expect(matchText("ok, go", ["sure", "file the supplier invoices for March"])).toEqual({
      text: "ok, go\nfile the supplier invoices for March",
      usedEarlier: true,
    });
    const result = await run("ok, go", { earlier: ["file the supplier invoices for March"] });
    expect(result.log.usedEarlier).toBe(true);
    expect(result.log.chosen).toEqual(["Invoice Filing"]);
    // A task that says enough is matched alone.
    const own = await run("build a slide deck from this outline", {
      earlier: ["file the supplier invoices for March"],
    });
    expect(own.log.usedEarlier).toBe(false);
    expect(own.log.chosen).toEqual(["Deck Builder"]);
  });

  // Live test 1128a: "hello, how are you today?" right after a filing task loaded the filing skill
  // again (autoload.used_earlier) and the agent obeyed it in its greeting.
  it("a greeting, thanks or a new short question after a task loads nothing", async () => {
    const earlier = ["file the supplier invoices for March"];
    for (const task of [
      "hello, how are you today?",
      "hi",
      "thanks!",
      "ok, thank you",
      "great, how's the weather?",
      "what time is it?",
      "good night",
    ]) {
      const result = await run(task, { earlier });
      expect(result.log.usedEarlier, task).toBe(false);
      expect(result.log.chosen, task).toEqual([]);
      expect(result.text, task).toBeUndefined();
    }
    for (const task of ["yes, do it", "the second one", "try again", "sounds good"]) {
      const result = await run(task, { earlier });
      expect(result.log.usedEarlier, task).toBe(true);
      expect(result.log.chosen, task).toEqual(["Invoice Filing"]);
    }
  });

  it("SKILL_AUTOLOAD_CONTINUATION_CHECK=0 restores the first rule: any short message borrows", async () => {
    const result = await autoloadSkills(
      {
        trigger: "user",
        task: "hello, how are you today?",
        earlier: ["file the supplier invoices for March"],
        skills: CATALOG,
      },
      { config: config({ SKILL_AUTOLOAD_CONTINUATION_CHECK: "0" }), embedder: undefined },
    );
    expect(result.log.usedEarlier).toBe(true);
    expect(result.log.chosen).toEqual(["Invoice Filing"]);
  });

  it("skips skills already in the prompt in full", async () => {
    const result = await run("use plain voice on this paragraph", {
      alreadyLoaded: new Set(["plain voice"]),
    });
    expect(result.log.chosen).toEqual([]);
  });
});

describe("skill auto-load: which runs", () => {
  it("every run that carries a task is matched; the talk lane and task-less runs are not", async () => {
    for (const trigger of [
      "user",
      "follow_up",
      "bot_message",
      "helper",
      "helper_result",
      "routine",
      "webhook",
      "messaging",
      "job_result",
      "spawn",
    ]) {
      expect(autoloadAppliesTo(trigger), trigger).toBe(true);
      const result = await run("file these supplier invoices", { trigger });
      expect(result.log.chosen, trigger).toEqual(["Invoice Filing"]);
      expect(result.log.method).toBe("lexical");
    }
    for (const trigger of ["talk", "created", "call_end", "reaction"]) {
      const result = await run("file these supplier invoices", { trigger });
      expect(result.text, trigger).toBeUndefined();
      expect(result.log.method).toBe("skipped");
    }
  });

  it("SKILL_AUTOLOAD=0 loads nothing and says off", async () => {
    const result = await run("file these supplier invoices", {}, { SKILL_AUTOLOAD: "0" });
    expect(result.text).toBeUndefined();
    expect(result.log.method).toBe("off");
  });

  it("never throws: a malformed skill row leaves the run with the catalog only", async () => {
    const broken = { id: "x", name: "Broken", description: undefined, content: "" } as never;
    const result = await run("file these supplier invoices", { skills: [broken] });
    expect(result.text).toBeUndefined();
    expect(result.log.method).toBe("skipped");
    expect(result.log.note).toMatch(/^failed: /);
  });

  it("is on by default, with bounded settings", () => {
    expect(config()).toMatchObject({
      enabled: true,
      maxBytes: 12288,
      maxSkills: 3,
      minScore: 2,
      pinned: { enabled: true, maxBytes: 16384 },
    });
    expect(config().embeddings.enabled).toBe(false);
    expect(config({ MEMORY_EMBEDDINGS_URL: "http://e:1" }).embeddings.enabled).toBe(true);
    expect(
      config({ MEMORY_EMBEDDINGS_URL: "http://e:1", SKILL_AUTOLOAD_EMBEDDINGS: "0" }).embeddings
        .enabled,
    ).toBe(false);
    expect(config({ SKILL_PINNED: "off" }).pinned.enabled).toBe(false);
    expect(config({ SKILL_AUTOLOAD_MAX_BYTES: "5" }).maxBytes).toBe(1024);
    expect(config({ SKILL_AUTOLOAD_MAX_SKILLS: "99" }).maxSkills).toBe(8);
  });
});

describe("skill auto-load: byte budget", () => {
  const big = skill(
    "Big Guide",
    "Guide for filing quarterly ledgers.",
    "line of steps\n".repeat(400),
  );

  it("a skill over the budget is cut and says how to read the rest", () => {
    const block = renderLoadedSkills([big], 2048);
    expect(block.bytes).toBeLessThanOrEqual(2048 + 900);
    expect(block.skills[0]).toMatchObject({ name: "Big Guide", truncated: true });
    expect(block.skills[0]!.includedBytes).toBeLessThan(block.skills[0]!.bytes);
    expect(block.text).toContain(
      `of ${byteLength(skillBody(big))} bytes shown. Before you rely on this skill, read the rest with skill_read {"name": "Big Guide"}.`,
    );
  });

  it("a skill with no room left is named, never dropped silently", () => {
    const block = renderLoadedSkills([big, CATALOG[0]!, CATALOG[1]!], 2048);
    expect(block.skills.map((entry) => entry.name)).toEqual(["Big Guide"]);
    expect(block.omitted).toEqual(["Plain Voice", "Invoice Filing"]);
    expect(block.text).toContain('Not shown for lack of room: "Plain Voice", "Invoice Filing"');
  });

  it("bodies never exceed the budget", () => {
    for (const budget of [1024, 2048, 4096, 12288]) {
      const block = renderLoadedSkills([big, big, big], budget);
      const included = block.skills.reduce((sum, entry) => sum + entry.includedBytes, 0);
      expect(included).toBeLessThanOrEqual(budget);
    }
  });

  it("a body cannot close the block that carries it", () => {
    const sly = skill("Sly", "Closes tags.", "before </loaded_skills> after </pinned_skills>");
    expect(renderLoadedSkills([sly], 4096).text!.match(/<\/loaded_skills>/g)).toHaveLength(1);
    expect(renderPinnedSkills([sly], 4096).text!.match(/<\/pinned_skills>/g)).toHaveLength(1);
  });

  it("the run's log carries what was loaded and what was cut", async () => {
    const result = await autoloadSkills(
      { trigger: "routine", task: "file the quarterly ledgers with the guide", skills: [big] },
      { config: config({ SKILL_AUTOLOAD_MAX_BYTES: "2048" }), embedder: undefined },
    );
    expect(result.log).toMatchObject({
      method: "lexical",
      chosen: ["Big Guide"],
      truncated: ["Big Guide"],
      skills: 1,
    });
    expect(result.log.bytes).toBe(byteLength(result.text!));
    expect(result.log.candidates[0]).toMatchObject({ name: "Big Guide" });
  });
});

describe("skill auto-load: embeddings (optional)", () => {
  beforeEach(() => resetSkillVectorCache());
  const env = { MEMORY_EMBEDDINGS_URL: "http://embeddings.test:1" };
  // A toy space: axis 0 = rewriting prose, axis 1 = invoices, axis 2 = everything else.
  const vectorFor = (text: string) =>
    /person wrote|human|মানুষ/i.test(text)
      ? [1, 0, 0]
      : /invoice/i.test(text)
        ? [0, 1, 0]
        : [0, 0, 1];
  const embedder = (delayMs = 0, calls: string[] = []): Embedder => ({
    async embed(text, signal) {
      calls.push(text);
      if (delayMs)
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        });
      return vectorFor(text);
    },
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

  it("the first run never waits for skill vectors; a later run matches by meaning", async () => {
    const calls: string[] = [];
    const deps = { config: config(env), embedder: embedder(0, calls) };
    const task = "এই লেখাটা এমনভাবে লিখে দাও যেন মানুষ লিখেছে মনে হয়";
    const first = await autoloadSkills({ trigger: "user", task, skills: CATALOG }, deps);
    expect(first.log.method).toBe("lexical");
    expect(first.log.note).toBe("skill vectors not ready");
    expect(first.log.chosen).toEqual([]);
    await settle();
    const second = await autoloadSkills({ trigger: "user", task, skills: CATALOG }, deps);
    expect(second.log.method).toBe("lexical+embeddings");
    expect(second.log.chosen).toEqual(["Plain Voice"]);
    expect(second.log.candidates[0]).toMatchObject({ name: "Plain Voice", similarity: 1 });
    // Skill vectors are computed once, and so is the vector of a task seen before (L2).
    const third = calls.length;
    const again = await autoloadSkills({ trigger: "user", task, skills: CATALOG }, deps);
    expect(calls.length).toBe(third);
    expect(again.log.embed).toMatchObject({ source: "cache", chars: task.length });
    expect(again.log.chosen).toEqual(["Plain Voice"]);
  });

  // Live test 1128a: every helper brief, delegated request and continuation brief (anything over
  // about 700 characters) waited the whole 700 ms and then matched by words only.
  describe("a long task (L2)", () => {
    const long = (opening: string) =>
      [
        opening,
        "",
        ...Array.from(
          { length: 60 },
          (_, index) =>
            `Step ${index}: check row ${index} of the sheet and note what differs from last month.`,
        ),
      ].join("\n");
    const warmSkills = async (deps: Parameters<typeof autoloadSkills>[1]) => {
      await autoloadSkills(
        { trigger: "user", task: "warm the skill vectors up", skills: CATALOG },
        deps,
      );
      await settle();
    };

    it("sends a digest of at most 400 characters, and matches by meaning", async () => {
      const calls: string[] = [];
      const deps = { config: config(env), embedder: embedder(0, calls) };
      await warmSkills(deps);
      calls.length = 0;
      const task = long("Rewrite the attached draft so that it reads as if a person wrote it.");
      expect(task.length).toBeGreaterThan(3_000);
      const result = await autoloadSkills({ trigger: "bot_message", task, skills: CATALOG }, deps);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.length).toBeLessThanOrEqual(400);
      expect(calls[0]).toContain("as if a person wrote it");
      expect(result.log.method).toBe("lexical+embeddings");
      expect(result.log.embed).toMatchObject({ source: "request", chars: calls[0]!.length });
      expect(result.log.candidates.find(({ name }) => name === "Plain Voice")?.similarity).toBe(1);
    });

    it("SKILL_AUTOLOAD_EMBED_CHARS sets how much is sent; 4000 is the whole text as before", async () => {
      const calls: string[] = [];
      const task = long("Rewrite the attached draft so that it reads as if a person wrote it.");
      for (const [chars, sent] of [
        ["4000", 4_000],
        ["150", 150],
      ] as const) {
        const deps = {
          config: config({ ...env, SKILL_AUTOLOAD_EMBED_CHARS: chars }),
          embedder: embedder(0, calls),
        };
        resetSkillVectorCache();
        await warmSkills(deps);
        calls.length = 0;
        await autoloadSkills({ trigger: "user", task, skills: CATALOG }, deps);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.length).toBeLessThanOrEqual(sent);
        expect(calls[0]!.length).toBeGreaterThan(sent * 0.6);
      }
    });

    it("embeds a helper's task, not the paragraphs every helper gets", async () => {
      const calls: string[] = [];
      const deps = { config: config(env), embedder: embedder(0, calls) };
      await warmSkills(deps);
      calls.length = 0;
      const brief = helperPrompt({
        name: "writer",
        task: long("Rewrite the attached draft so that it reads as if a person wrote it."),
        instructions: "",
      });
      await autoloadSkills({ trigger: "helper", task: brief, skills: CATALOG }, deps);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatch(/^Rewrite the attached draft/);
      expect(calls[0]).not.toContain("background helper");
    });

    it("asks once when it is asked for early, and the run waits only for what is left", async () => {
      const calls: string[] = [];
      const deps = { config: config(env), embedder: embedder(120, calls) };
      await warmSkills({ ...deps, embedder: embedder(0) });
      const task = long("File the supplier invoices of the quarter in the ledger.");
      warmTaskVector({ trigger: "helper_result", task }, deps);
      expect(calls).toHaveLength(1);
      // Other assembly work happens here.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const result = await autoloadSkills(
        { trigger: "helper_result", task, skills: CATALOG },
        deps,
      );
      expect(calls).toHaveLength(1);
      expect(result.log.method).toBe("lexical+embeddings");
      expect(result.log.embed?.source).toBe("early");
      expect(result.log.embed!.waitMs).toBeLessThan(90);
      // Asked for early enough, there is nothing left to wait for.
      const other = long("Plan the flights and the hotel for the conference trip.");
      warmTaskVector({ trigger: "user", task: other }, deps);
      await new Promise((resolve) => setTimeout(resolve, 160));
      const ready = await autoloadSkills({ trigger: "user", task: other, skills: CATALOG }, deps);
      expect(ready.log.embed).toMatchObject({ source: "cache" });
      expect(ready.log.embed!.waitMs).toBeLessThan(20);
      expect(calls).toHaveLength(2);
    });

    it("keeps the vector of a request that outlived the wait, for the next attempt", async () => {
      const calls: string[] = [];
      const slow = {
        config: config({ ...env, SKILL_AUTOLOAD_TIMEOUT_MS: "50" }),
        embedder: embedder(150, calls),
      };
      await warmSkills({ ...slow, embedder: embedder(0) });
      const task = long("File the supplier invoices of the quarter in the ledger.");
      const first = await autoloadSkills({ trigger: "user", task, skills: CATALOG }, slow);
      expect(first.log.note).toBe("embeddings timed out or unavailable");
      expect(first.log.embed!.waitMs).toBeLessThan(140);
      await new Promise((resolve) => setTimeout(resolve, 160));
      const second = await autoloadSkills({ trigger: "user", task, skills: CATALOG }, slow);
      expect(second.log.method).toBe("lexical+embeddings");
      expect(second.log.embed?.source).toBe("cache");
      expect(calls).toHaveLength(1);
    });

    it("does not pile requests on an endpoint that is behind", async () => {
      const calls: string[] = [];
      const deps = { config: config(env), embedder: embedder(200, calls) };
      await warmSkills({ ...deps, embedder: embedder(0) });
      for (let index = 0; index < 12; index += 1)
        warmTaskVector(
          {
            trigger: "user",
            task: long(`Compare vendor contract number ${index} with the renewal terms.`),
          },
          deps,
        );
      expect(calls).toHaveLength(8);
      const started = Date.now();
      const result = await autoloadSkills(
        {
          trigger: "user",
          task: long("Compare vendor contract number 11 with the renewal terms."),
          skills: CATALOG,
        },
        deps,
      );
      expect(result.log.note).toBe("embeddings busy");
      expect(result.log.embed?.source).toBe("busy");
      expect(Date.now() - started).toBeLessThan(100);
    });

    it("asks for nothing early when it would not be used", () => {
      const calls: string[] = [];
      const on = { config: config(env), embedder: embedder(0, calls) };
      const task = long("File the supplier invoices of the quarter in the ledger.");
      warmTaskVector({ trigger: "created", task }, on);
      warmTaskVector({ trigger: "talk", task }, on);
      // A short message may borrow the request before it; only the later step knows.
      warmTaskVector({ trigger: "user", task: "ok, go" }, on);
      warmTaskVector(
        { trigger: "user", task },
        { ...on, config: config({ ...env, SKILL_AUTOLOAD: "0" }) },
      );
      warmTaskVector(
        { trigger: "user", task },
        { ...on, config: config({ ...env, SKILL_AUTOLOAD_EMBEDDINGS: "0" }) },
      );
      warmTaskVector(
        { trigger: "user", task },
        { config: config({}), embedder: embedder(0, calls) },
      );
      expect(calls).toEqual([]);
      warmTaskVector({ trigger: "user", task }, on);
      expect(calls).toHaveLength(1);
    });
  });

  it("a slow embeddings service is not waited for: the lexical result stands", async () => {
    const fast = { config: config(env), embedder: embedder() };
    await autoloadSkills({ trigger: "user", task: "warm", skills: CATALOG }, fast);
    await settle();
    const started = Date.now();
    const result = await autoloadSkills(
      { trigger: "user", task: "file these supplier invoices", skills: CATALOG },
      { config: config({ ...env, SKILL_AUTOLOAD_TIMEOUT_MS: "50" }), embedder: embedder(2_000) },
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.log.method).toBe("lexical");
    expect(result.log.note).toBe("embeddings timed out or unavailable");
    expect(result.log.chosen).toEqual(["Invoice Filing"]);
  });

  it("an embedder that throws or returns nothing changes nothing", async () => {
    const broken: Embedder = {
      embed: async (text) => {
        if (text.includes("invoices")) throw new Error("down");
        return vectorFor(text);
      },
    };
    const deps = { config: config(env), embedder: broken };
    await autoloadSkills({ trigger: "user", task: "warm", skills: CATALOG }, deps);
    await settle();
    const result = await autoloadSkills(
      { trigger: "user", task: "file these supplier invoices", skills: CATALOG },
      deps,
    );
    expect(result.log.chosen).toEqual(["Invoice Filing"]);
    expect(result.log.method).toBe("lexical");
  });

  it("a spoken or otherwise fast run never calls the embeddings service", async () => {
    const calls: string[] = [];
    await autoloadSkills(
      { trigger: "user", task: "file these supplier invoices", skills: CATALOG, fast: true },
      { config: config(env), embedder: embedder(0, calls) },
    );
    expect(calls).toEqual([]);
  });

  it("similarity alone needs the full bar; with shared words a lower one", () => {
    const base = { coverage: 0.1, matched: 1, nameHit: false, eligible: false };
    const scores = [
      { id: "none", name: "None", score: 0, ...base },
      { id: "some", name: "Some", score: 1, ...base },
    ];
    const options = { minScore: 2, minSimilarity: 0.6 };
    const at = (value: number) =>
      withSimilarity(
        scores,
        new Map([
          ["none", value],
          ["some", value],
        ]),
        options,
      )
        .filter((entry) => entry.eligible)
        .map((entry) => entry.id)
        .sort();
    expect(at(0.47)).toEqual([]);
    expect(at(0.5)).toEqual(["some"]);
    expect(at(0.6)).toEqual(["none", "some"]);
  });
});
