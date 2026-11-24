/**
 * The writer: turns the owner's own messages into ledger facts. Runs after an owner-started run
 * (and for a bot's remember call), never inside the model's turn, and never throws into a run.
 */
import type { Answer, Question } from "./card.js";
import { MAX_CARD_QUESTIONS, orderQuestions, parseAnswers, renderCard } from "./card.js";
import type { LedgerConfig } from "./config.js";
import { cueCandidates, hintCandidates } from "./cues.js";
import type { Embedder } from "./embeddings.js";
import type { MemoryModel } from "./model.js";
import type { Decision, Rejection } from "./scoring.js";
import { decide, decisionKey } from "./scoring.js";
import type { LedgerStore } from "./store.js";
import { overlap } from "./text.js";
import type { Fact, FactCandidate, FactLink, OwnerMessage } from "./types.js";

/** Cosine similarity at which two facts get a `related` link. */
export const RELATED_SIMILARITY = 0.6;
const MAX_CANDIDATES = 12;
const MAX_LINKS_PER_FACT = 5;

export interface LedgerServices {
  store: LedgerStore;
  model?: MemoryModel | undefined;
  embedder?: Embedder | undefined;
  config: Pick<LedgerConfig, "model">;
  now?: () => Date;
  /** Posts the card in the thread; returns the message id, or undefined when it could not. */
  postCard?: (input: {
    threadId: string;
    botId: string | null;
    text: string;
  }) => Promise<string | undefined>;
}

export interface LearnInput {
  spaceId: string;
  userId: string;
  threadId: string;
  runId?: string | undefined;
  botId?: string | null | undefined;
  botName?: string | null | undefined;
  /** The owner's own messages only, oldest first; `current` marks the run's own. */
  messages: readonly OwnerMessage[];
  /** A bot's remember text: a hint for the model, and evidence only where it quotes the owner. */
  hint?: string | undefined;
  /** The owner asked for this to be kept (remember tool on their message). */
  explicit?: boolean | undefined;
  /** Post a card for questions (false for the remember tool: the run's own reply covers it). */
  ask?: boolean | undefined;
}

export interface LearnResult {
  saved: Fact[];
  reinforced: Fact[];
  superseded: Fact[];
  disputed: Fact[];
  rejected: Partial<Record<Rejection, number>>;
  asked: number;
  resolved: number;
  usedModel: boolean;
}

function emptyResult(): LearnResult {
  return {
    saved: [],
    reinforced: [],
    superseded: [],
    disputed: [],
    rejected: {},
    asked: 0,
    resolved: 0,
    usedModel: false,
  };
}

export async function learnFromMessages(
  services: LedgerServices,
  input: LearnInput,
): Promise<LearnResult> {
  const { store } = services;
  const now = services.now ?? (() => new Date());
  const result = emptyResult();
  const current = input.messages.filter((message) => message.current);
  if (!current.length) return result;

  result.resolved = await resolveAnswers(services, input, now());

  const known = await store.findLive(input.spaceId, { texts: current.map((m) => m.text) }, 30);
  let candidates: FactCandidate[] | undefined;
  if (services.model) {
    candidates = await services.model.extract({
      today: now().toISOString().slice(0, 10),
      messages: input.messages,
      known,
      hint: input.hint,
    });
    result.usedModel = candidates !== undefined;
  }
  // No model, or it failed: the owner's explicit "remember …" sentences, and a bot's remember
  // text where it repeats the owner's words.
  candidates ??= [
    ...cueCandidates(input.messages),
    ...(input.hint ? hintCandidates(input.hint, input.messages) : []),
  ];

  const questions: Question[] = [];
  const seen = new Map(known.map((fact) => [fact.id, fact]));
  for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
    const nearby = await store.findLive(
      input.spaceId,
      {
        subjects: candidate.subject ? [candidate.subject] : [],
        ids: candidate.replaces ?? [],
        texts: [candidate.text],
      },
      10,
    );
    for (const fact of nearby) seen.set(fact.id, fact);
    const existing = [...seen.values()].filter((fact) =>
      ["tentative", "confirmed", "disputed"].includes(fact.status),
    );
    const decidedAgainst = await losingStatements(store, input.spaceId, existing);
    const decision = decide({
      candidate,
      messages: input.messages,
      existing,
      decidedAgainst,
      explicit: input.explicit,
    });
    const applied = await apply(services, input, candidate, decision, existing, now());
    if (!applied) {
      if (decision.kind === "reject")
        result.rejected[decision.reason] = (result.rejected[decision.reason] ?? 0) + 1;
      continue;
    }
    for (const fact of applied.changed) seen.set(fact.id, fact);
    if (applied.saved) {
      seen.set(applied.saved.id, applied.saved);
      result.saved.push(applied.saved);
    }
    if (applied.reinforced) result.reinforced.push(applied.reinforced);
    result.superseded.push(...applied.superseded);
    result.disputed.push(...applied.disputed);
    questions.push(...applied.questions);
  }

  if (input.ask !== false && questions.length && services.postCard)
    result.asked = await ask(services, input, questions, now());
  await backfillEmbeddings(services, input.spaceId);
  return result;
}

/** Statements the owner already turned down: `${oldId}|words` for each "keep old" answer. */
async function losingStatements(
  store: LedgerStore,
  spaceId: string,
  existing: readonly Fact[],
): Promise<Set<string>> {
  const answered = await store.answeredConflicts(
    spaceId,
    existing.map((fact) => fact.id),
  );
  const keys = new Set<string>();
  const kept = answered.filter((link) => link.resolution === "keep_old");
  if (!kept.length) return keys;
  const losers = await store.getFacts(
    spaceId,
    kept.map((link) => link.fromId),
  );
  const byId = new Map(losers.map((fact) => [fact.id, fact]));
  for (const link of kept) {
    const loser = byId.get(link.fromId);
    if (loser) keys.add(decisionKey(link.toId, loser.text));
  }
  return keys;
}

type Applied = {
  saved?: Fact;
  reinforced?: Fact;
  superseded: Fact[];
  disputed: Fact[];
  changed: Fact[];
  questions: Question[];
};

async function apply(
  services: LedgerServices,
  input: LearnInput,
  candidate: FactCandidate,
  decision: Decision,
  existing: readonly Fact[],
  now: Date,
): Promise<Applied | undefined> {
  const { store } = services;
  if (decision.kind === "reject") return undefined;
  if (decision.kind === "reinforce") {
    const { fact } = decision;
    const sourceMessageIds = decision.newSource
      ? [...fact.sourceMessageIds, decision.sourceMessageId].slice(-10)
      : fact.sourceMessageIds;
    const patch = {
      mentions: fact.mentions + (decision.newSource ? 1 : 0),
      sourceMessageIds,
      confidence: decision.confidence,
      ...(decision.confirm ? { status: "confirmed" as const } : {}),
    };
    await store.updateFact(input.spaceId, fact.id, patch);
    const updated = { ...fact, ...patch };
    return { reinforced: updated, superseded: [], disputed: [], changed: [updated], questions: [] };
  }

  const vector = await services.embedder?.embed(candidate.text);
  const saved = await store.insertFact(
    {
      spaceId: input.spaceId,
      area: candidate.area,
      subject: candidate.subject ?? null,
      text: candidate.text.trim(),
      quote: candidate.quote.trim(),
      origin: candidate.origin,
      status: decision.status,
      confidence: decision.confidence,
      mentions: 1,
      sourceMessageIds: [decision.sourceMessageId],
      entities: [...new Set(candidate.entities)].slice(0, 12),
      sourceThreadId: input.threadId,
      sourceRunId: input.runId ?? null,
      writtenByBotId: input.botId ?? null,
      writtenByBotName: input.botName ?? null,
      userId: input.userId,
      validFrom: now,
      validTo: null,
      supersedesId: decision.supersedes[0]?.id ?? null,
    },
    vector,
  );
  const superseded: Fact[] = [];
  const disputed: Fact[] = [];
  const changed: Fact[] = [];
  const questions: Question[] = [];
  for (const old of decision.supersedes) {
    await store.updateFact(input.spaceId, old.id, { status: "superseded", validTo: now });
    await store.addLink({
      spaceId: input.spaceId,
      fromId: saved.id,
      toId: old.id,
      kind: "supersedes",
    });
    const retired = { ...old, status: "superseded" as const, validTo: now };
    superseded.push(retired);
    changed.push(retired);
  }
  for (const old of decision.conflicts) {
    await store.updateFact(input.spaceId, old.id, { status: "disputed" });
    const link = await store.addLink({
      spaceId: input.spaceId,
      fromId: saved.id,
      toId: old.id,
      kind: "contradicts",
    });
    const marked = { ...old, status: "disputed" as const };
    disputed.push(marked, saved);
    changed.push(marked);
    if (link && !link.askedAt) questions.push({ kind: "conflict", link, older: old, newer: saved });
  }
  if (decision.kind === "insert" && decision.askUnsure)
    questions.push({ kind: "unsure", fact: saved });
  await linkRelated(services, input.spaceId, saved, candidate, existing, vector);
  return { saved, superseded, disputed, changed, questions };
}

/**
 * `related` links: what the model named, facts that share a named entity, and (with
 * embeddings) the nearest facts by meaning. Supersede/contradict links come from decide().
 */
async function linkRelated(
  services: LedgerServices,
  spaceId: string,
  fact: Fact,
  candidate: FactCandidate,
  existing: readonly Fact[],
  vector: readonly number[] | undefined,
): Promise<FactLink[]> {
  const { store } = services;
  const skip = new Set<string>([fact.id, fact.supersedesId ?? ""]);
  const targets = new Map<string, { kind: FactLink["kind"]; score: number | null }>();
  const known = new Set(existing.map((item) => item.id));
  for (const id of candidate.related ?? [])
    if (known.has(id) && !skip.has(id)) targets.set(id, { kind: "related", score: null });
  const entities = new Set(fact.entities.map((entity) => entity.toLowerCase()));
  if (entities.size)
    for (const other of existing) {
      if (skip.has(other.id) || targets.has(other.id)) continue;
      if (other.entities.some((entity) => entities.has(entity.toLowerCase())))
        targets.set(other.id, {
          kind: other.area === "people" || fact.area === "people" ? "about_person" : "related",
          score: Math.round(overlap(fact.text, other.text) * 100) / 100,
        });
    }
  if (vector) {
    const near = await store.searchVector(spaceId, vector, MAX_LINKS_PER_FACT + 2);
    for (const { id, similarity } of near)
      if (!skip.has(id) && !targets.has(id) && similarity >= RELATED_SIMILARITY)
        targets.set(id, { kind: "related", score: Math.round(similarity * 100) / 100 });
  }
  const links: FactLink[] = [];
  for (const [toId, { kind, score }] of [...targets].slice(0, MAX_LINKS_PER_FACT)) {
    const link = await store.addLink({ spaceId, fromId: fact.id, toId, kind, score });
    if (link) links.push(link);
  }
  return links;
}

async function ask(
  services: LedgerServices,
  input: LearnInput,
  questions: Question[],
  now: Date,
): Promise<number> {
  const { store } = services;
  const ordered = orderQuestions(questions).slice(0, MAX_CARD_QUESTIONS);
  const messageId = await services.postCard!({
    threadId: input.threadId,
    botId: input.botId ?? null,
    text: renderCard(ordered),
  });
  if (!messageId) return 0;
  const asked = { askedAt: now, askedThreadId: input.threadId, askedMessageId: messageId };
  for (const question of ordered) {
    if (question.kind === "conflict")
      await store.updateLink(input.spaceId, question.link.id, asked);
    else await store.updateFact(input.spaceId, question.fact.id, asked);
  }
  return ordered.length;
}

/**
 * Reads the owner's reply to the latest card in this thread. Only messages sent after the card
 * count, and only an answer that parses settles anything.
 */
async function resolveAnswers(
  services: LedgerServices,
  input: LearnInput,
  now: Date,
): Promise<number> {
  const { store } = services;
  const open = await store.openQuestions(input.spaceId, input.threadId);
  if (!open.conflicts.length && !open.unsure.length) return 0;
  const cardIds = [
    ...open.conflicts.map((link) => ({ id: link.askedMessageId, at: link.askedAt })),
    ...open.unsure.map((fact) => ({ id: fact.askedMessageId, at: fact.askedAt })),
  ].sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));
  const latest = cardIds[0];
  if (!latest?.id || !latest.at) return 0;
  const conflictLinks = open.conflicts.filter((link) => link.askedMessageId === latest.id);
  const unsure = open.unsure.filter((fact) => fact.askedMessageId === latest.id);
  const involved = await store.getFacts(input.spaceId, [
    ...conflictLinks.flatMap((link) => [link.fromId, link.toId]),
  ]);
  const byId = new Map(involved.map((fact) => [fact.id, fact]));
  const questions = orderQuestions<Question>([
    ...conflictLinks.flatMap((link) => {
      const newer = byId.get(link.fromId);
      const older = byId.get(link.toId);
      return newer && older ? [{ kind: "conflict" as const, link, older, newer }] : [];
    }),
    ...unsure.map((fact) => ({ kind: "unsure" as const, fact })),
  ]);
  const replies = input.messages.filter(
    (message) => message.current && message.at.getTime() > latest.at!.getTime(),
  );
  let answers = new Map<number, Answer>();
  for (const reply of replies) {
    answers = parseAnswers(reply.text, questions.length);
    if (answers.size) break;
  }
  let resolved = 0;
  for (const [number, answer] of answers) {
    const question = questions[number - 1];
    if (!question) continue;
    if (question.kind === "unsure") {
      await store.updateFact(input.spaceId, question.fact.id, {
        status: answer === "yes" ? "confirmed" : "retracted",
        ...(answer === "no" ? { validTo: now } : {}),
      });
    } else if (answer === "yes") {
      await store.updateFact(input.spaceId, question.newer.id, {
        status: "confirmed",
        supersedesId: question.older.id,
      });
      await store.updateFact(input.spaceId, question.older.id, {
        status: "superseded",
        validTo: now,
      });
      await store.addLink({
        spaceId: input.spaceId,
        fromId: question.newer.id,
        toId: question.older.id,
        kind: "supersedes",
      });
      await store.updateLink(input.spaceId, question.link.id, {
        resolvedAt: now,
        resolution: "use_new",
      });
    } else {
      await store.updateFact(input.spaceId, question.older.id, { status: "confirmed" });
      await store.updateFact(input.spaceId, question.newer.id, {
        status: "retracted",
        validTo: now,
      });
      await store.updateLink(input.spaceId, question.link.id, {
        resolvedAt: now,
        resolution: "keep_old",
      });
    }
    resolved += 1;
  }
  return resolved;
}

async function backfillEmbeddings(services: LedgerServices, spaceId: string): Promise<void> {
  if (!services.embedder) return;
  const missing = await services.store.missingEmbeddings(spaceId, 5);
  for (const fact of missing) {
    const vector = await services.embedder.embed(fact.text);
    if (!vector) return;
    await services.store.setEmbedding(spaceId, fact.id, vector);
  }
}
