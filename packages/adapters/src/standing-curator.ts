import { textSimilarity } from "./notice-ledger.js";
import type { StandingEntry } from "./standing-orders.js";
import { STANDING_ENTRY_MAX_CHARS, tierOf } from "./standing-orders.js";

/**
 * Curator for the standing orders: points at what a person should look at, never edits.
 * Born from a real failure: a captcha procedure (r5) carried a hidden "on Upwork/Fiverr a block
 * needs Shakil" exception, so a bot reported "blocked" where the user expected the procedure.
 */
export type CuratorFinding = {
  kind: "exception" | "overlap" | "conflict" | "stale" | "oversize" | "link";
  keys: string[];
  message: string;
};

// Only wording that carves a case OUT of a rule. "only if/when" are ordinary conditions and flag nothing.
const EXCEPTION = /[^.;]*\b(except|exception|unless|needs? (?:shakil|the user))\b[^.;]*/i;
const NEGATIVE = /\b(never|do not|don't|must not|not allowed)\b/i;
const POSITIVE = /\b(always|must|use|click|solve)\b/i;
// Words every rule shares; they say nothing about a common subject.
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
  "shakil",
  "message",
  "messages",
  "first",
  "report",
  "reports",
  "agent",
  "agents",
  "never",
  "always",
  "rule",
  "rules",
  "after",
  "before",
  "about",
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
    // An exception declared with ^key is visible to every bot; only wording-only exceptions are hidden ones.
    if (clause && !e.links?.exceptionOf.length) {
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
  findings.push(...linkFindings(entries));
  const linked = new Set<string>();
  for (const e of entries) {
    for (const k of [
      ...(e.links?.overrides ?? []),
      ...(e.links?.exceptionOf ?? []),
      ...(e.links?.dependsOn ?? []),
    ]) {
      linked.add([e.key, k].sort().join("|"));
    }
  }
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i]!;
      const b = entries[j]!;
      const resolved = linked.has([a.key, b.key].sort().join("|"));
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
      if (!resolved && shared.length >= 4 && clash) {
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

/** Problems in the typed links: targets that do not exist, override loops, a weaker tier beating a stronger one. */
function linkFindings(entries: readonly StandingEntry[]): CuratorFinding[] {
  const out: CuratorFinding[] = [];
  const byKey = new Map(entries.map((e) => [e.key, e]));
  for (const e of entries) {
    const targets: [string, string][] = [
      ...(e.links?.overrides ?? []).map((k) => [">", k] as [string, string]),
      ...(e.links?.exceptionOf ?? []).map((k) => ["^", k] as [string, string]),
      ...(e.links?.dependsOn ?? []).map((k) => ["+", k] as [string, string]),
    ];
    for (const [mark, k] of targets) {
      const target = byKey.get(k);
      if (!target) {
        out.push({
          kind: "link",
          keys: [e.key],
          message: `${e.key} links ${mark}${k}, but there is no entry ${k}. Fix the key or remove the link.`,
        });
      } else if (mark === ">" && tierOf(e) > tierOf(target)) {
        out.push({
          kind: "link",
          keys: [e.key, k],
          message: `${e.key} (p${tierOf(e)}) is set to win over ${k} (p${tierOf(target)}), a higher tier. A weaker rule cannot beat a stronger one; raise ${e.key} or drop the link.`,
        });
      }
    }
  }
  // override loops: A wins over B wins over ... A
  const color = new Map<string, number>();
  const visit = (key: string, path: string[]): void => {
    if (color.get(key) === 2) return;
    if (color.get(key) === 1) {
      const loop = [...path.slice(path.indexOf(key)), key];
      out.push({
        kind: "link",
        keys: [...new Set(loop)],
        message: `Override loop: ${loop.join(" > ")}. Two rules cannot each win over the other; remove one link.`,
      });
      return;
    }
    color.set(key, 1);
    for (const next of byKey.get(key)?.links?.overrides ?? [])
      if (byKey.has(next)) visit(next, [...path, key]);
    color.set(key, 2);
  };
  for (const e of entries) visit(e.key, []);
  return out;
}

/** Findings that involve one key (what a bot shows right after saving it). */
export function findingsFor(findings: readonly CuratorFinding[], key: string): CuratorFinding[] {
  return findings.filter((f) => f.keys.includes(key));
}
