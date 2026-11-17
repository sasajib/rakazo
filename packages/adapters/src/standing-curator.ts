import { textSimilarity } from "./notice-ledger.js";
import type { StandingEntry } from "./standing-orders.js";
import { STANDING_ENTRY_MAX_CHARS } from "./standing-orders.js";

/**
 * Curator for the standing orders: points at what a person should look at, never edits.
 * Born from a real failure: a captcha procedure (r5) carried a hidden "on Upwork/Fiverr a block
 * needs Shakil" exception, so a bot reported "blocked" where the user expected the procedure.
 */
export type CuratorFinding = {
  kind: "exception" | "overlap" | "conflict" | "stale" | "oversize";
  keys: string[];
  message: string;
};

const EXCEPTION =
  /[^.;]*\b(except|exception|unless|but not|needs? (?:shakil|the user)|only (?:when|if|on))\b[^.;]*/i;
const NEGATIVE = /\b(never|do not|don't|must not|not allowed|no )\b/i;
const POSITIVE = /\b(always|must|do |use |click|solve)\b/i;
const STOP_WORDS = new Set([
  "that",
  "this",
  "with",
  "then",
  "when",
  "have",
  "from",
  "your",
  "will",
  "than",
  "into",
  "them",
  "they",
  "each",
  "only",
  "same",
  "other",
]);
export const STALE_DECISION_DAYS = 30;
const OVERLAP_SIMILARITY = 0.55;

function subjects(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 4 && !STOP_WORDS.has(w)),
  );
}

function daysBetween(from: string, to: string): number {
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function curateStanding(entries: readonly StandingEntry[], today: string): CuratorFinding[] {
  const findings: CuratorFinding[] = [];
  for (const e of entries) {
    const clause = EXCEPTION.exec(e.text)?.[0]?.trim();
    if (clause) {
      findings.push({
        kind: "exception",
        keys: [e.key],
        message: `${e.key} carries an exception: "${clause.slice(0, 140)}". An exception overrides the rule for that case, so the bot stops instead of trying. Confirm it is wanted and tells the bot to ask, not just stop.`,
      });
    }
    if (e.text.length > STANDING_ENTRY_MAX_CHARS * 0.85) {
      findings.push({
        kind: "oversize",
        keys: [e.key],
        message: `${e.key} is ${e.text.length} of ${STANDING_ENTRY_MAX_CHARS} characters; split it before the next edit hits the limit.`,
      });
    }
    if (e.kind === "decision" && daysBetween(e.date, today) > STALE_DECISION_DAYS) {
      findings.push({
        kind: "stale",
        keys: [e.key],
        message: `Decision ${e.key} was set ${e.date}; re-confirm it still holds or remove it.`,
      });
    }
  }
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i]!;
      const b = entries[j]!;
      if (textSimilarity(a.text, b.text) >= OVERLAP_SIMILARITY) {
        findings.push({
          kind: "overlap",
          keys: [a.key, b.key],
          message: `${a.key} and ${b.key} say almost the same thing. Keep one key so a change cannot leave the other behind.`,
        });
        continue;
      }
      const shared = [...subjects(a.text)].filter((w) => subjects(b.text).has(w));
      const clash =
        (NEGATIVE.test(a.text) && !NEGATIVE.test(b.text) && POSITIVE.test(b.text)) ||
        (NEGATIVE.test(b.text) && !NEGATIVE.test(a.text) && POSITIVE.test(a.text));
      if (shared.length >= 3 && clash) {
        findings.push({
          kind: "conflict",
          keys: [a.key, b.key],
          message: `${a.key} and ${b.key} talk about ${shared.slice(0, 4).join(", ")} and one forbids what the other asks. Possible conflict: decide which wins and say so in the newer one.`,
        });
      }
    }
  }
  return findings;
}

/** Findings that involve one key (what a bot shows right after saving it). */
export function findingsFor(findings: readonly CuratorFinding[], key: string): CuratorFinding[] {
  return findings.filter((f) => f.keys.includes(key));
}
