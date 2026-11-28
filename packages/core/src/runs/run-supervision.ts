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

/**
 * Work whose whole result is text: a reply can be the finished work. A short, complete reply to
 * "summarise this" is the summary, not an announcement (it was being answered twice).
 */
const TEXT_WORK = new Set([
  "summarise",
  "summarize",
  "translate",
  "draft",
  "write",
  "compare",
  "review",
]);

/**
 * Words after which a work word is the thing to do: "please send", "need to fix", "and deploy",
 * "can you check". Apostrophes are already dropped ("let's" is "lets").
 */
const BEFORE_A_VERB = new Set(
  (
    "to please and then or you we i lets can could would will should must need go also just now " +
    "kindly dont not never always gonna wanna first next again"
  ).split(" "),
);

/** Wanting a thing is asking for it, noun or verb: "I need a report on last week's sales". */
const WANTS = /\b(?:i|we)\s+(?:(?:really|just|also|still)\s+)?(?:need|want|would like|d like)\b/;

/**
 * The work words a request uses as verbs. The same words are everyday nouns ("this is a safe
 * test", "thanks for the update", "good call"), and a statement about a thing asks for nothing:
 * a work word counts where it opens a clause or follows a word that takes a verb, never after a
 * determiner or an adjective.
 */
function workVerbs(text: string): string[] {
  const said = text.trim().replace(NOISE, "").replace(GREETING, "").toLowerCase();
  const tokens = said.split(/\s+/).map((raw) => ({
    word: raw.replace(/[^a-z]/g, ""),
    // Punctuation after a word ends its clause; the next word opens one.
    endsClause: /[,.;:!?\u2014)\]-]["']?$/.test(raw),
  }));
  const wants = WANTS.test(said.replace(/['\u2019]/g, ""));
  const verbs: string[] = [];
  tokens.forEach(({ word }, at) => {
    if (!WORK_VERBS.has(word) || INFORMATIONAL.has(word)) return;
    let before = at - 1;
    // "can you quickly fix it": an adverb sits between the verb and what licenses it.
    while (before >= 0 && !tokens[before]!.endsClause && /ly$/.test(tokens[before]!.word))
      before -= 1;
    const prior = tokens[before];
    if (wants || !prior || prior.endsClause || !prior.word || BEFORE_A_VERB.has(prior.word))
      verbs.push(word);
  });
  return verbs;
}

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
  return workVerbs(said).length > 0;
}

/**
 * Fork (1.3, L5): a request whose work is the reply itself: "reply with the single word ready",
 * "reply yes or no". Whatever the run then says, it has replied; running it again only produces
 * a second reply. "Reply to <someone else>" is sending something and is not this.
 */
const REPLIES_ELSEWHERE =
  /\brepl(?:y|ies|ying)\s+to\s+(?!me\b|this\b|that\b|my\s+(?:message|question)\b)/i;

export function replyIsTheWork(request: string | null | undefined): boolean {
  const said = request ?? "";
  const verbs = workVerbs(said);
  return (
    verbs.length > 0 && verbs.every((verb) => verb === "reply") && !REPLIES_ELSEWHERE.test(said)
  );
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
  /**
   * The run stopped for the person (takeover, question, approval) and went on from their answer.
   * Handing a step to the person is an action, whether or not the runtime reported it as a tool
   * call, and whether or not the resumed attempt still has the steps of the paused one.
   */
  pausedForPerson?: boolean;
  /**
   * Fork (L5): false restores the first rule, which never asked whether the reply was the work.
   * By default a reply that completes the request ends it (see {@link replyIsTheWork}).
   */
  replyCompletes?: boolean;
}): boolean {
  if (input.status && input.status !== "completed") return false;
  if (!SUPERVISED_TRIGGERS.has(input.trigger)) return false;
  if ((input.taskPrompt ?? "").startsWith(CONTINUATION_MARKER)) return false;
  if (!requestsWork(input.request)) return false;
  if (input.toolCallCount > 0) return false;
  if (input.pausedForPerson) return false;
  const reply = input.replyText.trim();
  if (reply.length > CONTINUATION_TEXT_MAX) return false;
  // Asked only to reply, and it replied.
  if (input.replyCompletes !== false && reply && replyIsTheWork(input.request)) return false;
  // Text-only work answered with complete sentences is done.
  const verbs = workVerbs(input.request);
  if (verbs.length && verbs.every((verb) => TEXT_WORK.has(verb)) && /[.!?"')\]]$/.test(reply))
    return false;
  return true;
}

/**
 * Events a run leaves when it stops for the person. A run that has one did not merely announce
 * work (see `pausedForPerson`).
 */
export const PAUSED_FOR_PERSON_EVENT_TYPES = [
  "computer.takeover.requested",
  "computer.takeover.released",
  "run.waiting_input",
] as const;

/** The prompt an automatic continuation carries, so the run cannot mistake it for a new request. */
export function continuationPrompt(request: string): string {
  const said = request.trim().replace(/\s+/g, " ");
  return `${CONTINUATION_MARKER} Continue the task you were given and do it now: ${said}`;
}
