import type { RunStatus } from "@rakazo/contracts";

/**
 * Determinism, for the part of the system that can actually be deterministic.
 *
 * A language model cannot be made to always do the work. What *can* be made deterministic is the
 * supervision around it: every task either runs, or is continued automatically, or ends with a
 * failure the person is told about. This module is that rule, as a pure function over facts the
 * executor already has when a run finishes.
 */

/** Verbs that name work a person asked for, not information they asked for. */
const WORK_VERBS = new Set(
  (
    "add build buy call cancel check clean close compare compile connect copy create cut delete " +
    "deploy design draft edit email export find fix generate install make merge move open order " +
    "organise organize plan post prepare publish remove rename reply report research review run " +
    "save schedule search send set setup sort start stop summarise summarize test translate update " +
    "upload write"
  ).split(" "),
);

/** Asking to be told something is a question, not a task. */
const INFORMATIONAL = new Set(["tell", "show", "describe", "explain", "list", "read", "answer"]);
/** A turn that opens by asking to be told something is a question, whatever nouns follow. */
const ASKS_TO_BE_TOLD = /^(?:tell|show|describe|explain|list|read|answer|walk me through)\b/i;

const FACT_QUESTION = /^(?:what|why|how|when|where|who|which|whose|is|are|was|were|do|does|did)\b/i;
const NOISE = /^(?:(?:uh|um|ah|er|hmm|okay|ok|so|well|like)\b[,.\s]*)+/i;
const GREETING = /^(?:hi|hey|hello|yo)[\s,]+(?:chief|bot|there)?\b[\s,.:]*/i;

/** Whether a message asks for work to be done (as opposed to information). */
export function requestsWork(text: string | null | undefined): boolean {
  const said = (text ?? "").trim().replace(NOISE, "").replace(GREETING, "");
  if (!said) return false;
  if (FACT_QUESTION.test(said)) return false;
  if (ASKS_TO_BE_TOLD.test(said)) return false;
  const words = said.toLowerCase().split(/\s+/).map((word) => word.replace(/[^a-z]/g, ""));
  return words.some((word) => WORK_VERBS.has(word) && !INFORMATIONAL.has(word));
}

/** Runs that answer a person, and can therefore leave work undone. */
const SUPERVISED_TRIGGERS = new Set(["user", "follow_up"]);

/** Below this, a reply is a sentence of intent rather than the result of work. */
export const CONTINUATION_TEXT_MAX = 240;
/** One automatic continuation. A second would be a loop. */
export const MAX_CONTINUATIONS = 1;

export const CONTINUATION_MARKER = "[continuation]";

/**
 * Whether a finished run asked for work and produced none, so the platform must continue it.
 *
 * The rule reads only facts: the trigger, whether any tool ran, what the person actually asked for,
 * and whether this run is itself a continuation. It never asks a model whether work was done.
 */
export function needsContinuation(input: {
  trigger: string;
  /** The person's own words: the run's source message, or the task prompt for a follow-up. */
  request: string;
  /** How many tools the run called (0 means it did nothing). */
  toolCallCount: number;
  /** The text the run produced. */
  replyText: string;
  /** The prompt of a run that is already a continuation. */
  taskPrompt?: string | null;
  status?: RunStatus | string;
}): boolean {
  if (input.status && input.status !== "completed") return false;
  if (!SUPERVISED_TRIGGERS.has(input.trigger)) return false;
  if ((input.taskPrompt ?? "").startsWith(CONTINUATION_MARKER)) return false;
  if (!requestsWork(input.request)) return false;
  if (input.toolCallCount > 0) return false;
  return input.replyText.trim().length <= CONTINUATION_TEXT_MAX;
}

/** The prompt an automatic continuation carries, so the run cannot mistake it for a new request. */
export function continuationPrompt(request: string): string {
  const said = request.trim().replace(/\s+/g, " ");
  return `${CONTINUATION_MARKER} Continue the task you were given and do it now: ${said}`;
}
