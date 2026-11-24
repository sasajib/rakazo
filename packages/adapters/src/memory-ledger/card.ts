/**
 * The one place the owner is asked: a single chat message after the run, never a blocking ask.
 * Each conflict pair or unsure fact is put to the owner once; an unanswered question leaves the
 * facts disputed (or tentative) and bots are told so.
 */
import type { Fact, FactLink } from "./types.js";

export type Question =
  | { kind: "conflict"; link: FactLink; older: Fact; newer: Fact }
  | { kind: "unsure"; fact: Fact };

export type Answer = "yes" | "no";

/** The card lists conflicts first, then unsure facts, each in id order: answers use the same order. */
export function orderQuestions<T extends Question>(questions: readonly T[]): T[] {
  const key = (question: Question) =>
    `${question.kind === "conflict" ? 0 : 1}:${question.kind === "conflict" ? question.link.id : question.fact.id}`;
  return [...questions].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

const day = (date: Date) =>
  date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

const clip = (text: string, max = 160) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export const MAX_CARD_QUESTIONS = 5;

export function renderCard(questions: readonly Question[]): string {
  const ordered = orderQuestions(questions).slice(0, MAX_CARD_QUESTIONS);
  const single = ordered.length === 1;
  const lines = ordered.map((question, index) => {
    const number = single ? "" : `${index + 1}. `;
    const reply = (yes: string, no: string) =>
      single
        ? `Reply "${yes}" or "${no}".`
        : `Reply "${index + 1} ${yes}" or "${index + 1} ${no}".`;
    if (question.kind === "conflict")
      return `${number}On ${day(question.older.validFrom)} you said: "${clip(question.older.text)}". Now: "${clip(question.newer.text)}". Use the new one? ${reply("new", "old")}`;
    return `${number}I noted: "${clip(question.fact.text)}". Is that right? ${reply("yes", "no")}`;
  });
  return [
    single
      ? "Memory check — one quick question, nothing is waiting on it:"
      : "Memory check — a few quick questions, nothing is waiting on them:",
    ...lines,
  ].join("\n");
}

const YES = /^(?:yes|yep|yeah|y|new|use (?:the )?new(?: one)?|correct|right|true)$/i;
const NO = /^(?:no|nope|n|old|keep(?: the)? old(?: one)?|keep|wrong|false|incorrect)$/i;

function word(value: string): Answer | undefined {
  const trimmed = value.trim().replace(/[.!]+$/, "");
  if (YES.test(trimmed)) return "yes";
  if (NO.test(trimmed)) return "no";
  return undefined;
}

/**
 * Answers in an owner reply, by question number (1-based). A bare "yes"/"new" answers a
 * one-question card; "all new"/"all yes" answers every question. Anything else answers nothing,
 * so a normal message after the card leaves the questions open.
 */
export function parseAnswers(reply: string, count: number): Map<number, Answer> {
  const answers = new Map<number, Answer>();
  const text = reply.trim();
  if (!text || count < 1) return answers;
  const all = /^(?:all|both)\s+(.+)$/i.exec(text);
  if (all?.[1]) {
    const answer = word(all[1]);
    if (answer) for (let index = 1; index <= count; index += 1) answers.set(index, answer);
    return answers;
  }
  if (count === 1) {
    const answer = word(text.split(/[\n,;]/)[0] ?? "");
    if (answer) answers.set(1, answer);
  }
  const numbered =
    /(\d+)\s*[:.)-]?\s*(yes|yep|yeah|y|new|no|nope|n|old|keep(?: the)? old|keep|correct|wrong|right)\b/gi;
  for (const match of text.matchAll(numbered)) {
    const index = Number(match[1]);
    const answer = word(match[2] ?? "");
    if (answer && index >= 1 && index <= count) answers.set(index, answer);
  }
  return answers;
}
