/**
 * Fork: skill auto-load. At run assembly the platform matches the run's task to the skills the
 * agent may use and puts the fitting skill bodies in the prompt, so following a skill no longer
 * depends on the model choosing to call skill_read. The catalog and skill_read are unchanged.
 *
 * Never blocks a run: lexical matching is in-process; the optional embeddings step waits at most
 * SKILL_AUTOLOAD_TIMEOUT_MS for the task's vector and falls back to the lexical result. Skill
 * vectors are computed in the background and reused, so a run never waits for them.
 */
import { createHash } from "node:crypto";
import { getLogger } from "@rakazo/logging";
import type { Embedder } from "../memory-ledger/embeddings.js";
import { createEmbedder } from "../memory-ledger/embeddings.js";
import type { SkillAutoloadConfig } from "./config.js";
import { skillAutoloadConfig } from "./config.js";
import type { SkillScore } from "./match.js";
import {
  chooseSkills,
  contentWords,
  cosine,
  matchText,
  scoreSkills,
  skillTriggerText,
  withSimilarity,
} from "./match.js";
import type { LoadableSkill, SkillBlock } from "./skill-autoload.prompt.js";
import { renderLoadedSkills } from "./skill-autoload.prompt.js";

/** Runs that carry no task of their own: the tool-less talk lane, a bot's creation intro, a hang-up note, a reaction. */
const NO_TASK_TRIGGERS = new Set(["talk", "created", "call_end", "reaction"]);
const LOGGED_CANDIDATES = 8;
const MATCH_TEXT_MAX_CHARS = 8_000;

export function autoloadAppliesTo(trigger: string): boolean {
  return !NO_TASK_TRIGGERS.has(trigger);
}

export interface SkillAutoloadInput {
  trigger: string;
  /** The run's task: the person's message, the delegated request, the routine or webhook prompt. */
  task: string;
  /** The person's earlier messages in this chat, newest first; read only when the task is short. */
  earlier?: readonly string[];
  /** The skills this agent may use in this run (already filtered for it). */
  skills: readonly LoadableSkill[];
  /** Names already in the prompt in full (forced with /Name, pinned for the Space). */
  alreadyLoaded?: ReadonlySet<string>;
  /** A spoken turn or other run that must not wait: lexical only. */
  fast?: boolean;
}

export interface SkillAutoloadLog {
  trigger: string;
  method: "off" | "skipped" | "lexical" | "lexical+embeddings";
  /** Why nothing was matched, or why embeddings did not take part. */
  note?: string;
  skills: number;
  taskWords: number;
  usedEarlier: boolean;
  candidates: Array<Pick<SkillScore, "name" | "score" | "coverage" | "matched" | "similarity">>;
  chosen: string[];
  truncated: string[];
  omitted: string[];
  bytes: number;
  ms: number;
}

export interface SkillAutoloadResult {
  /** The `<loaded_skills>` block for the turn prompt, when a skill fits. */
  text?: string;
  block: SkillBlock;
  log: SkillAutoloadLog;
}

type Dependencies = {
  config?: SkillAutoloadConfig;
  embedder?: Embedder | undefined;
  now?: () => number;
};

const vectors = new Map<string, number[]>();
const pending = new Set<string>();
const VECTOR_CACHE_MAX = 4_000;
const WARM_PER_RUN = 8;

let sharedEmbedder: { url: string | undefined; embedder: Embedder | undefined } | undefined;
function defaultEmbedder(config: SkillAutoloadConfig): Embedder | undefined {
  if (!config.embeddings.enabled) return undefined;
  const { endpoint } = config.embeddings;
  if (!sharedEmbedder || sharedEmbedder.url !== endpoint.url)
    sharedEmbedder = { url: endpoint.url, embedder: createEmbedder(endpoint) };
  return sharedEmbedder.embedder;
}

function skillText(skill: LoadableSkill): string {
  return [skill.name, skill.description, skillTriggerText(skill)].filter(Boolean).join("\n");
}

const vectorKey = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 24);

/** Starts computing the vectors a later run will use. Never awaited by a run. */
function warmSkillVectors(embedder: Embedder, texts: ReadonlyMap<string, string>): void {
  let started = 0;
  for (const [key, text] of texts) {
    if (vectors.has(key) || pending.has(key)) continue;
    if (started++ >= WARM_PER_RUN) break;
    pending.add(key);
    void embedder
      .embed(text)
      .then((vector) => {
        if (!vector) return;
        if (vectors.size >= VECTOR_CACHE_MAX) vectors.clear();
        vectors.set(key, vector);
      })
      .catch(() => undefined)
      .finally(() => pending.delete(key));
  }
}

/** For tests: forget cached skill vectors. */
export function resetSkillVectorCache(): void {
  vectors.clear();
  pending.clear();
}

async function taskSimilarity(
  embedder: Embedder,
  task: string,
  skills: readonly LoadableSkill[],
  timeoutMs: number,
): Promise<{ similarity?: Map<string, number>; note?: string }> {
  const keys = new Map(skills.map((skill) => [skill.id, vectorKey(skillText(skill))]));
  warmSkillVectors(
    embedder,
    new Map(skills.map((skill) => [keys.get(skill.id)!, skillText(skill)])),
  );
  const known = skills.filter((skill) => vectors.has(keys.get(skill.id)!));
  if (known.length === 0) return { note: "skill vectors not ready" };
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const taskVector = await Promise.race([
    embedder.embed(task, abort.signal).catch(() => undefined),
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        abort.abort();
        resolve(undefined);
      }, timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (!taskVector) return { note: "embeddings timed out or unavailable" };
  return {
    similarity: new Map(
      known.map((skill) => [skill.id, cosine(taskVector, vectors.get(keys.get(skill.id)!)!)]),
    ),
  };
}

/**
 * Matches the run's task to its skills and renders the block. Never throws: whatever goes wrong
 * (a malformed skill row, a bad setting), the run starts with the catalog only and the log says why.
 */
export async function autoloadSkills(
  input: SkillAutoloadInput,
  dependencies: Dependencies = {},
): Promise<SkillAutoloadResult> {
  try {
    return await matchAndRender(input, dependencies);
  } catch (error) {
    return {
      block: { bytes: 0, skills: [], omitted: [] },
      log: {
        trigger: input.trigger,
        method: "skipped",
        note: `failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200),
        skills: input.skills.length,
        taskWords: 0,
        usedEarlier: false,
        candidates: [],
        chosen: [],
        truncated: [],
        omitted: [],
        bytes: 0,
        ms: 0,
      },
    };
  }
}

async function matchAndRender(
  input: SkillAutoloadInput,
  dependencies: Dependencies,
): Promise<SkillAutoloadResult> {
  const config = dependencies.config ?? skillAutoloadConfig();
  const now = dependencies.now ?? Date.now;
  const started = now();
  const empty: SkillBlock = { bytes: 0, skills: [], omitted: [] };
  const log: SkillAutoloadLog = {
    trigger: input.trigger,
    method: "lexical",
    skills: input.skills.length,
    taskWords: 0,
    usedEarlier: false,
    candidates: [],
    chosen: [],
    truncated: [],
    omitted: [],
    bytes: 0,
    ms: 0,
  };
  const done = (block: SkillBlock = empty): SkillAutoloadResult => {
    log.ms = now() - started;
    return { ...(block.text ? { text: block.text } : {}), block, log };
  };
  if (!config.enabled) {
    log.method = "off";
    return done();
  }
  if (!autoloadAppliesTo(input.trigger)) {
    log.method = "skipped";
    log.note = "run carries no task";
    return done();
  }
  const loaded = new Set([...(input.alreadyLoaded ?? [])].map((name) => name.toLowerCase()));
  const skills = input.skills.filter((skill) => !loaded.has(skill.name.toLowerCase()));
  const { text, usedEarlier } = matchText(input.task, input.earlier);
  const task = text.slice(0, MATCH_TEXT_MAX_CHARS);
  log.usedEarlier = usedEarlier;
  log.taskWords = contentWords(task).length;
  if (skills.length === 0 || log.taskWords === 0) return done();

  let scores = scoreSkills(task, skills, config.minScore);
  const embedder = "embedder" in dependencies ? dependencies.embedder : defaultEmbedder(config);
  if (embedder && config.embeddings.enabled && !input.fast) {
    const semantic = await taskSimilarity(
      embedder,
      task,
      skills,
      config.embeddings.timeoutMs,
    ).catch(() => ({ similarity: undefined, note: "embeddings failed" }));
    if (semantic.similarity) {
      scores = withSimilarity(scores, semantic.similarity, {
        minScore: config.minScore,
        minSimilarity: config.embeddings.minSimilarity,
      });
      log.method = "lexical+embeddings";
    } else if (semantic.note) log.note = semantic.note;
  }
  const chosen = chooseSkills(scores, config.maxSkills);
  log.candidates = scores
    .filter((entry) => entry.score > 0 || entry.similarity !== undefined)
    .slice(0, LOGGED_CANDIDATES)
    .map(({ name, score, coverage, matched, similarity }) => ({
      name,
      score,
      coverage,
      matched,
      ...(similarity === undefined ? {} : { similarity }),
    }));
  if (chosen.length === 0) return done();
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  const block = renderLoadedSkills(
    chosen.map((entry) => byId.get(entry.id)!),
    config.maxBytes,
  );
  log.chosen = block.skills.map((skill) => skill.name);
  log.truncated = block.skills.filter((skill) => skill.truncated).map((skill) => skill.name);
  log.omitted = block.omitted;
  log.bytes = block.bytes;
  return done(block);
}

/** One `skill.autoload` line per run: what was considered, what was loaded, how long it took. */
export function logSkillAutoload(
  target: { runId: string; spaceId: string; threadId: string; botId: string },
  log: SkillAutoloadLog,
  pinned?: { names: string[]; bytes: number; truncated: string[]; omitted: string[] },
): void {
  getLogger().info("skill.autoload", {
    "run.id": target.runId,
    "space.id": target.spaceId,
    "thread.id": target.threadId,
    "bot.id": target.botId,
    "run.trigger": log.trigger,
    "autoload.method": log.method,
    ...(log.note ? { "autoload.note": log.note } : {}),
    "autoload.skills": log.skills,
    "autoload.task_words": log.taskWords,
    "autoload.used_earlier": log.usedEarlier,
    "autoload.candidates": log.candidates,
    "autoload.chosen": log.chosen,
    "autoload.truncated": log.truncated,
    "autoload.omitted": log.omitted,
    "autoload.bytes": log.bytes,
    "autoload.ms": log.ms,
    "pinned.names": pinned?.names ?? [],
    "pinned.bytes": pinned?.bytes ?? 0,
    "pinned.truncated": pinned?.truncated ?? [],
    "pinned.omitted": pinned?.omitted ?? [],
  });
}
