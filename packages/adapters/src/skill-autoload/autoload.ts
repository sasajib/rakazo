/**
 * Fork: skill auto-load. At run assembly the platform matches the run's task to the skills the
 * agent may use and puts the fitting skill bodies in the prompt, so following a skill no longer
 * depends on the model choosing to call skill_read. The catalog and skill_read are unchanged.
 *
 * Never blocks a run: lexical matching is in-process; the optional embeddings step waits at most
 * SKILL_AUTOLOAD_TIMEOUT_MS for the task's vector and falls back to the lexical result. Skill
 * vectors are computed in the background and reused, so a run never waits for them.
 *
 * The task's vector (L2): a digest of the task is embedded, not the whole text (task-digest.ts);
 * the request starts as soon as the run's task is read (`warmTaskVector`), beside the rest of run
 * assembly, and its result is kept by the digest's hash, so the wait here is what is left of it:
 * usually nothing. A request that outlives the wait still fills the cache for the next attempt.
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
  SHORT_TASK_WORDS,
  scoreSkills,
  skillTriggerText,
  withSimilarity,
} from "./match.js";
import type { LoadableSkill, SkillBlock } from "./skill-autoload.prompt.js";
import { renderLoadedSkills } from "./skill-autoload.prompt.js";
import { taskDigest, taskFocus } from "./task-digest.js";

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
  /** The task's embedding: characters sent, where the vector came from, how long the run waited. */
  embed?: { chars: number; source: TaskVectorSource; waitMs: number };
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

/** For tests: forget cached skill and task vectors. */
export function resetSkillVectorCache(): void {
  vectors.clear();
  pending.clear();
  taskVectors.clear();
  taskVectorsInFlight.clear();
}

/** `cache`: computed by an earlier run; `early`: asked for before this step; `request`: asked here. */
export type TaskVectorSource = "cache" | "early" | "request" | "busy";

const taskVectors = new Map<string, number[]>();
const taskVectorsInFlight = new Map<string, Promise<number[] | undefined>>();
const TASK_VECTOR_CACHE_MAX = 500;
/** Requests for task vectors at once. Beyond it a run matches by words: the endpoint is behind. */
const TASK_VECTORS_IN_FLIGHT_MAX = 8;

/**
 * The vector of a task digest: from the cache, from the request already on its way, or from a
 * new one. The request is shared and not tied to one caller's wait, so it is made once per text.
 */
function taskVector(
  embedder: Embedder,
  digest: string,
): { source: TaskVectorSource; vector?: Promise<number[] | undefined> } {
  const key = vectorKey(digest);
  const cached = taskVectors.get(key);
  if (cached) {
    // Most recently used last, so the oldest entry is the one dropped.
    taskVectors.delete(key);
    taskVectors.set(key, cached);
    return { source: "cache", vector: Promise.resolve(cached) };
  }
  const flying = taskVectorsInFlight.get(key);
  if (flying) return { source: "early", vector: flying };
  if (taskVectorsInFlight.size >= TASK_VECTORS_IN_FLIGHT_MAX) return { source: "busy" };
  const request = embedder
    .embed(digest)
    .catch(() => undefined)
    .then((vector) => {
      if (vector) {
        if (taskVectors.size >= TASK_VECTOR_CACHE_MAX)
          taskVectors.delete(taskVectors.keys().next().value as string);
        taskVectors.set(key, vector);
      }
      return vector;
    })
    .finally(() => taskVectorsInFlight.delete(key));
  taskVectorsInFlight.set(key, request);
  return { source: "request", vector: request };
}

/** What is embedded for a run's task: a digest of the part that states the work. */
function embeddedText(trigger: string, task: string, maxChars: number): string {
  return taskDigest(taskFocus(trigger, task), maxChars);
}

/**
 * Starts the task's embedding as soon as the task is known, so run assembly does not wait for it
 * later. Never awaited, never throws; does nothing when auto-load or embeddings are off.
 */
export function warmTaskVector(
  input: { trigger: string; task: string },
  dependencies: Dependencies = {},
): void {
  try {
    const config = dependencies.config ?? skillAutoloadConfig();
    if (!config.enabled || !config.embeddings.enabled || !autoloadAppliesTo(input.trigger)) return;
    // A short task may be matched with the request before it, which only the later step knows.
    if (contentWords(input.task).length < SHORT_TASK_WORDS) return;
    const embedder = "embedder" in dependencies ? dependencies.embedder : defaultEmbedder(config);
    if (embedder)
      void taskVector(embedder, embeddedText(input.trigger, input.task, config.embeddings.maxChars))
        .vector;
  } catch {
    // The later step asks again.
  }
}

async function taskSimilarity(
  embedder: Embedder,
  task: string,
  skills: readonly LoadableSkill[],
  timeoutMs: number,
  now: () => number,
): Promise<{
  similarity?: Map<string, number>;
  note?: string;
  embed?: SkillAutoloadLog["embed"];
}> {
  const keys = new Map(skills.map((skill) => [skill.id, vectorKey(skillText(skill))]));
  warmSkillVectors(
    embedder,
    new Map(skills.map((skill) => [keys.get(skill.id)!, skillText(skill)])),
  );
  const known = skills.filter((skill) => vectors.has(keys.get(skill.id)!));
  if (known.length === 0) return { note: "skill vectors not ready" };
  const started = now();
  const { source, vector } = taskVector(embedder, task);
  const embed = (): SkillAutoloadLog["embed"] => ({
    chars: task.length,
    source,
    waitMs: now() - started,
  });
  if (!vector) return { note: "embeddings busy", embed: embed() };
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The request is not cancelled when the wait ends: its vector is kept for the next attempt.
  const found = await Promise.race([
    vector,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (!found) return { note: "embeddings timed out or unavailable", embed: embed() };
  return {
    similarity: new Map(
      known.map((skill) => [skill.id, cosine(found, vectors.get(keys.get(skill.id)!)!)]),
    ),
    embed: embed(),
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
  const { text, usedEarlier } = matchText(input.task, input.earlier, {
    continuationOnly: config.continuationOnly,
  });
  const task = text.slice(0, MATCH_TEXT_MAX_CHARS);
  log.usedEarlier = usedEarlier;
  log.taskWords = contentWords(task).length;
  if (skills.length === 0 || log.taskWords === 0) return done();

  let scores = scoreSkills(task, skills, config.minScore);
  const embedder = "embedder" in dependencies ? dependencies.embedder : defaultEmbedder(config);
  if (embedder && config.embeddings.enabled && !input.fast) {
    const semantic = await taskSimilarity(
      embedder,
      // The digest of the task; with the earlier request when a short go-ahead borrowed it.
      usedEarlier
        ? taskDigest(task, config.embeddings.maxChars)
        : embeddedText(input.trigger, input.task, config.embeddings.maxChars),
      skills,
      config.embeddings.timeoutMs,
      now,
    ).catch(() => ({ similarity: undefined, note: "embeddings failed", embed: undefined }));
    if (semantic.embed) log.embed = semantic.embed;
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
    ...(log.embed
      ? {
          "autoload.embed_chars": log.embed.chars,
          "autoload.embed_source": log.embed.source,
          "autoload.embed_wait_ms": log.embed.waitMs,
        }
      : {}),
    "pinned.names": pinned?.names ?? [],
    "pinned.bytes": pinned?.bytes ?? 0,
    "pinned.truncated": pinned?.truncated ?? [],
    "pinned.omitted": pinned?.omitted ?? [],
  });
}
