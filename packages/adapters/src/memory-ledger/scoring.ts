/**
 * Decides what one proposed fact does to the ledger. Pure: no database, no model.
 *
 * The owner is asked only when the answer is not obvious: a new fact contradicts a CONFIRMED one
 * without being an explicit correction, or the extraction itself is unsure. Everything else is
 * saved, merged or superseded silently.
 */
import {
  contentWords,
  holdsSecret,
  isCorrection,
  isExplicitAsk,
  isHedged,
  overlap,
  quoteSources,
  sameText,
  sentenceAround,
  stem,
} from "./text.js";
import type { Fact, FactCandidate, FactStatus, OwnerMessage } from "./types.js";
import { FACT_AREAS, FACT_QUOTE_MAX_CHARS, FACT_TEXT_MAX_CHARS } from "./types.js";

/** Below this a proposal is noise and dropped silently. */
export const DROP_BELOW = 0.35;
/** Below this (and above DROP_BELOW) a new fact is kept tentative and the owner is asked once. */
export const ASK_BELOW = 0.6;
/** A correction this sure replaces even a confirmed fact without asking. */
export const OBVIOUS_CORRECTION = 0.75;
/** Content-word overlap at which two texts count as the same fact. */
export const DUPLICATE_OVERLAP = 0.8;

const SUBJECT_WORDS = new Set(["owner", "owner's", "user", "user's"]);

export type Rejection = "invalid" | "quote" | "secret" | "low_confidence" | "already_decided";

export type Decision =
  | { kind: "reject"; reason: Rejection }
  /** Same fact said again: more evidence, maybe confirmed now. */
  | {
      kind: "reinforce";
      fact: Fact;
      sourceMessageId: string;
      newSource: boolean;
      confirm: boolean;
      confidence: number;
    }
  /** A new fact. `supersedes` are retired silently (newer wins), `conflicts` go to the owner. */
  | {
      kind: "insert";
      status: FactStatus;
      confidence: number;
      sourceMessageId: string;
      supersedes: Fact[];
      conflicts: Fact[];
      /** Extraction was unsure: ask the owner once whether it is right. */
      askUnsure: boolean;
    };

export interface DecisionInput {
  candidate: FactCandidate;
  messages: readonly OwnerMessage[];
  /** Live facts the candidate may repeat or change (same subject, cited ids, close text). */
  existing: readonly Fact[];
  /** Pairs already put to the owner and answered: `${oldId}|${foldedNewText}` that lost. */
  decidedAgainst?: ReadonlySet<string>;
  /** The owner explicitly asked to remember (cue, or a bot's remember call on their message). */
  explicit?: boolean;
}

export function decisionKey(oldId: string, text: string): string {
  return `${oldId}|${contentWords(text).join(" ")}`;
}

/** The candidate's confidence after rule-based checks on the words that support it. */
export function scoreCandidate(
  candidate: FactCandidate,
  source: OwnerMessage,
  explicit: boolean,
): number {
  let score = Number.isFinite(candidate.confidence) ? candidate.confidence : 0.6;
  score = Math.min(1, Math.max(0, score));
  const sentence = sentenceAround(source.text, candidate.quote);
  if (explicit || isExplicitAsk(sentence)) score += 0.2;
  if (candidate.origin === "stated") score += 0.05;
  // A question does not state a fact; a hedge does not settle one.
  if (/\?\s*$/.test(sentence.trim())) score -= 0.3;
  if (isHedged(sentence)) score -= 0.2;
  // The text should be about the quoted words, not invented beside them.
  // "Owner lives in Dhaka" is supported by "I live in Dhaka": the subject word and endings aside.
  const textWords = contentWords(candidate.text)
    .filter((word) => !SUBJECT_WORDS.has(word))
    .map(stem);
  const quoteWords = new Set(contentWords(candidate.quote).map(stem));
  if (textWords.length) {
    const supported = textWords.filter((word) => quoteWords.has(word)).length / textWords.length;
    if (supported < 0.2) score -= 0.25;
    else if (supported < 0.4) score -= 0.1;
  }
  return Math.round(Math.min(1, Math.max(0, score)) * 100) / 100;
}

export function decide(input: DecisionInput): Decision {
  const { candidate, messages, existing } = input;
  const text = candidate.text.trim();
  const quote = candidate.quote.trim();
  if (
    !FACT_AREAS.includes(candidate.area) ||
    !text ||
    !quote ||
    text.length > FACT_TEXT_MAX_CHARS ||
    quote.length > FACT_QUOTE_MAX_CHARS
  )
    return { kind: "reject", reason: "invalid" };

  const sources = quoteSources(quote, messages, candidate.message);
  // The run's own message is the new evidence; an earlier one only repeats what was counted.
  const source = sources.find((message) => message.current) ?? sources[0];
  if (!source) return { kind: "reject", reason: "quote" };
  if (holdsSecret(text, quote, ...candidate.entities)) return { kind: "reject", reason: "secret" };

  const explicit = Boolean(input.explicit) || isExplicitAsk(sentenceAround(source.text, quote));
  const confidence = scoreCandidate(candidate, source, explicit);
  if (confidence < DROP_BELOW) return { kind: "reject", reason: "low_confidence" };

  const duplicate = existing.find(
    (fact) => sameText(fact.text, text) || overlap(fact.text, text) >= DUPLICATE_OVERLAP,
  );
  if (duplicate) {
    const newSource = !duplicate.sourceMessageIds.includes(source.id);
    const mentions = duplicate.mentions + (newSource ? 1 : 0);
    return {
      kind: "reinforce",
      fact: duplicate,
      sourceMessageId: source.id,
      newSource,
      // Repeated in another message, or asked for explicitly. A disputed fact stays disputed:
      // only the owner's answer settles it.
      confirm: duplicate.status === "tentative" && (explicit || (newSource && mentions >= 2)),
      confidence: Math.max(duplicate.confidence, confidence),
    };
  }

  const replaced = new Set(candidate.replaces ?? []);
  const targets = existing.filter(
    (fact) =>
      replaced.has(fact.id) ||
      (candidate.subject && fact.subject && fact.subject === candidate.subject),
  );
  if (
    input.decidedAgainst &&
    targets.some((fact) => input.decidedAgainst!.has(decisionKey(fact.id, text)))
  )
    return { kind: "reject", reason: "already_decided" };

  const baseStatus: FactStatus = explicit ? "confirmed" : "tentative";
  const confirmed = targets.filter((fact) => fact.status === "confirmed");
  const softer = targets.filter((fact) => fact.status !== "confirmed");
  const obviousCorrection =
    candidate.origin === "stated" &&
    confidence >= OBVIOUS_CORRECTION &&
    (Boolean(candidate.correction) || isCorrection(sentenceAround(source.text, quote)));

  if (confirmed.length && !obviousCorrection) {
    // Never replace what the owner confirmed on a guess: both are kept as disputed until the
    // owner answers the card.
    return {
      kind: "insert",
      status: "disputed",
      confidence,
      sourceMessageId: source.id,
      supersedes: softer,
      conflicts: confirmed,
      askUnsure: false,
    };
  }
  return {
    kind: "insert",
    // An obvious correction of a confirmed fact is itself confirmed.
    status: confirmed.length ? "confirmed" : baseStatus,
    confidence,
    sourceMessageId: source.id,
    supersedes: targets,
    conflicts: [],
    askUnsure: !explicit && confidence < ASK_BELOW,
  };
}
