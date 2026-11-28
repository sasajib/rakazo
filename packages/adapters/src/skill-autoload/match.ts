/**
 * Fork: skill auto-load, the matching half. Pure and cheap: it scores the task text against each
 * skill's name, trigger words and description, so the fitting skill is found without the model
 * deciding to look. No skill, agent or Space is named here; every number is a general rule.
 *
 * Score of a skill = sum over the task's words it shares of (how rare the word is among this
 * agent's skills, 0..1) x (3 in the name, 2 in trigger words, 1 in the description). A skill is
 * taken when the score reaches the threshold AND either its whole name is in the task or at least
 * two words match and they cover a fair share of what the skill says about itself. Small talk
 * shares no rare words with any skill and loads nothing.
 */
import { parseSkillMd } from "@rakazo/core";
import { continuesEarlierRequest } from "./continuation.js";

export interface MatchableSkill {
  id: string;
  name: string;
  description: string;
  content: string;
}

export interface SkillScore {
  id: string;
  name: string;
  score: number;
  /** Share of the skill's own weighted words found in the task, 0..1. */
  coverage: number;
  /** Distinct words shared with the task. */
  matched: number;
  nameHit: boolean;
  /** Cosine similarity of task and skill, when embeddings took part. */
  similarity?: number;
  eligible: boolean;
}

const NAME_WEIGHT = 3;
const TRIGGER_WEIGHT = 2;
const DESCRIPTION_WEIGHT = 1;
const MIN_COVERAGE = 0.25;
/** A long task shares words with many skills by chance, so it must cover more of the skill. */
const LONG_TASK_WORDS = 60;
const LONG_TASK_MIN_COVERAGE = 0.4;
/** A skill far below the best match is noise, not a second fitting skill. */
const RELATIVE_CUT = 0.6;
/** A task with fewer content words than this says too little by itself ("ok, go"). */
export const SHORT_TASK_WORDS = 4;

/** Frontmatter keys whose words count as trigger words. */
const TRIGGER_KEYS = [
  "triggers",
  "trigger",
  "keywords",
  "tags",
  "when_to_use",
  "whenToUse",
  "when",
  "use_when",
];

// Words that say nothing about which skill fits: function words plus the verbs every request uses.
const STOP_WORDS = new Set(
  (
    "a an the and or but if then else so of to in on at by for with from into onto over under about as is are was " +
    "were be been being am do does did done doing have has had having it its this that these those there here " +
    "i me my mine we us our you your yours he him his she her they them their what which who whom whose when " +
    "where why how all any both each few more most other some such no nor not only own same than too very can " +
    "could will would shall should may might must just also now ok okay yes yeah go please thanks thank hi hello " +
    "hey use used using need needs want wants make makes made get gets got let lets help helps like new one two " +
    "out up down off again once via per etc skill skills task tasks thing things something anything " +
    "work works working way ways time times know tell say see look give take put try"
  ).split(" "),
);

const SUFFIXES = [
  "izations",
  "ization",
  "izers",
  "izer",
  "izing",
  "ized",
  "izes",
  "ize",
  "ations",
  "ation",
  "ings",
  "ing",
  "ers",
  "er",
  "ies",
  "ied",
  "ed",
  "es",
  "s",
  "ly",
  "e",
];

/** Crude English stem so "humanize", "humanizer" and "humanizing" meet. Other scripts pass through. */
export function stem(word: string): string {
  if (!/^[a-z]+$/.test(word)) return word;
  for (const suffix of SUFFIXES) {
    if (word.length - suffix.length >= 3 && word.endsWith(suffix)) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

/** Distinct content words of a text, stemmed, in first-seen order. */
export function contentWords(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? []) {
    if (raw.length < 2 || STOP_WORDS.has(raw) || /^\d+$/.test(raw)) continue;
    const word = stem(raw);
    if (!STOP_WORDS.has(word)) seen.add(word);
  }
  return [...seen];
}

function flattenText(value: unknown, depth = 0): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (depth > 3 || !value || typeof value !== "object") return "";
  return (Array.isArray(value) ? value : Object.values(value))
    .map((item) => flattenText(item, depth + 1))
    .join(" ");
}

type Indexed = { skill: MatchableSkill; weights: Map<string, number>; nameWords: string[] };

const triggerCache = new Map<string, string>();
const TRIGGER_CACHE_MAX = 2_000;

/** Trigger words written in the skill's frontmatter, if any. Parsed once per skill text. */
export function skillTriggerText(skill: MatchableSkill): string {
  // No trigger key anywhere in the text: skip the YAML parse, which is the slow part.
  if (!TRIGGER_KEYS.some((key) => skill.content.includes(`${key}:`))) return "";
  const cacheKey = `${skill.id}:${skill.content.length}:${skill.content.slice(0, 200)}`;
  const cached = triggerCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const parsed = parseSkillMd(skill.content);
  const text =
    "error" in parsed
      ? ""
      : TRIGGER_KEYS.map((key) => flattenText(parsed.frontmatter[key]))
          .filter(Boolean)
          .join(" ");
  if (triggerCache.size >= TRIGGER_CACHE_MAX) triggerCache.clear();
  triggerCache.set(cacheKey, text);
  return text;
}

function indexSkill(skill: MatchableSkill): Indexed {
  const weights = new Map<string, number>();
  const add = (text: string, weight: number) => {
    for (const word of contentWords(text)) {
      if ((weights.get(word) ?? 0) < weight) weights.set(word, weight);
    }
  };
  add(skill.description, DESCRIPTION_WEIGHT);
  add(skillTriggerText(skill), TRIGGER_WEIGHT);
  add(skill.name, NAME_WEIGHT);
  return { skill, weights, nameWords: contentWords(skill.name) };
}

/** Lexical scores of every skill for one task text, best first. */
export function scoreSkills(
  task: string,
  skills: readonly MatchableSkill[],
  minScore: number,
): SkillScore[] {
  const taskWords = new Set(contentWords(task));
  if (taskWords.size === 0 || skills.length === 0) return [];
  const indexed = skills.map(indexSkill);
  const documentFrequency = new Map<string, number>();
  for (const { weights } of indexed) {
    for (const word of weights.keys()) {
      documentFrequency.set(word, (documentFrequency.get(word) ?? 0) + 1);
    }
  }
  const total = indexed.length;
  const rarity = (word: string) =>
    Math.log(1 + total / (documentFrequency.get(word) ?? 1)) / Math.log(1 + total);
  const minCoverage = taskWords.size > LONG_TASK_WORDS ? LONG_TASK_MIN_COVERAGE : MIN_COVERAGE;
  return indexed
    .map(({ skill, weights, nameWords }) => {
      let score = 0;
      let all = 0;
      let matched = 0;
      for (const [word, weight] of weights) {
        const value = rarity(word) * weight;
        all += value;
        if (taskWords.has(word)) {
          score += value;
          matched += 1;
        }
      }
      const coverage = all > 0 ? score / all : 0;
      const nameHit = nameWords.length > 0 && nameWords.every((word) => taskWords.has(word));
      return {
        id: skill.id,
        name: skill.name,
        score: round(score),
        coverage: round(coverage),
        matched,
        nameHit,
        eligible: score >= minScore && (nameHit || (matched >= 2 && coverage >= minCoverage)),
      };
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

const round = (value: number) => Math.round(value * 1000) / 1000;

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  return normA > 0 && normB > 0 ? dot / Math.sqrt(normA * normB) : 0;
}

/**
 * Adds meaning to the word scores: a skill whose description is close to the task in the
 * embedding space is taken even when they share no word (another language, a synonym). A skill
 * that already shares words with the task (half the lexical threshold) needs less similarity,
 * which catches the paraphrase that names one word of the skill. Its rank score is at least the
 * threshold, plus ten points per 1.0 of similarity above the bar it had to clear.
 *
 * Measured on bge-m3 with 18 skill descriptions and 19 requests: small talk peaked at 0.47, true
 * matches without shared words at 0.60, paraphrases with one shared word at 0.49-0.50.
 */
export const HYBRID_SIMILARITY_DISCOUNT = 0.12;

export function withSimilarity(
  scores: readonly SkillScore[],
  similarity: ReadonlyMap<string, number>,
  options: { minScore: number; minSimilarity: number },
): SkillScore[] {
  return scores
    .map((entry) => {
      const value = similarity.get(entry.id);
      if (value === undefined) return entry;
      const bar =
        entry.score >= options.minScore / 2
          ? options.minSimilarity - HYBRID_SIMILARITY_DISCOUNT
          : options.minSimilarity;
      const near = value >= bar;
      return {
        ...entry,
        similarity: round(value),
        score: near
          ? round(Math.max(entry.score, options.minScore) + (value - bar) * 10)
          : entry.score,
        eligible: entry.eligible || near,
      };
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

/** The skills to load: eligible, near the best one, at most `maxSkills`. */
export function chooseSkills(scores: readonly SkillScore[], maxSkills: number): SkillScore[] {
  const eligible = scores.filter((entry) => entry.eligible);
  const best = eligible[0]?.score ?? 0;
  return eligible.filter((entry) => entry.score >= best * RELATIVE_CUT).slice(0, maxSkills);
}

/**
 * The text to match: the task itself, plus the chat's latest request that says enough when the
 * task is as short as "ok, go" (`earlier` = the person's earlier messages, newest first) AND goes
 * on with that request. A greeting, thanks or a new short question is matched alone (L1).
 * `continuationOnly: false` restores the first rule: any short message borrows.
 */
export function matchText(
  task: string,
  earlier: readonly string[] = [],
  options: { continuationOnly?: boolean } = {},
): { text: string; usedEarlier: boolean } {
  if (contentWords(task).length >= SHORT_TASK_WORDS) return { text: task, usedEarlier: false };
  if (options.continuationOnly !== false && !continuesEarlierRequest(task))
    return { text: task, usedEarlier: false };
  const open = earlier.find((message) => contentWords(message).length >= SHORT_TASK_WORDS);
  return open
    ? { text: `${task}\n${open}`, usedEarlier: true }
    : { text: task, usedEarlier: false };
}
