/**
 * Fork (FORK.md 1.33, A3/A4): "open work" supervision.
 *
 * A run that ends while its own declared work is still open used to be final: the agent said
 * "I'm continuing with the next part" and nothing ran until a person asked. What can be made
 * deterministic is the supervision around the model, so this module is the rule, as pure
 * functions over facts the executor has when a run finishes:
 *
 *   work is open  (the agent keeps open items for this chat, or its last words promise more work)
 *   and nothing else will wake the agent  (no helper, run, job, schedule, card or request pending)
 *   => the platform continues it, inside a limit, while each continuation makes progress;
 *   when the chain ends with work still open, or the agent parks its work, the owner is told once.
 */
import {
  BACKGROUND_HELPER_TRIGGER,
  isBackgroundRunTrigger,
  TALK_RUN_TRIGGER,
} from "./run-state.js";
import { CONTINUATION_MARKER } from "./run-supervision.js";

/** The clientNonce prefix of a continuation this rule started; the rest is the run it follows. */
export const OPEN_WORK_NONCE_PREFIX = "open-work:";

/**
 * Runs the rule never follows: a helper reports to its parent (which is followed), a talk run and
 * the creation intro do no work, a background run stays out of the chat, a call's closing turn is
 * followed by the chat's own runs, and a connected chat's reply goes to a channel a continuation
 * could not reach.
 */
const UNFOLLOWED_TRIGGERS = new Set<string>([
  BACKGROUND_HELPER_TRIGGER,
  TALK_RUN_TRIGGER,
  "created",
  "call_end",
  "messaging",
  "reaction",
]);

export function runIsFollowedForOpenWork(trigger: string | null | undefined): boolean {
  const value = trigger ?? "";
  return !UNFOLLOWED_TRIGGERS.has(value) && !isBackgroundRunTrigger(value);
}

/** How much of a reply's end is read: a promise that matters is in its closing lines. */
const CLOSING_CHARS = 700;

/** The closing lines of a reply, lower-cased, apostrophes straightened. */
export function replyClosing(reply: string): string {
  const text = reply.trim();
  if (!text) return "";
  const tail = text.length > CLOSING_CHARS ? text.slice(-CLOSING_CHARS) : text;
  // Start at a sentence or line boundary when the cut fell inside one.
  const cut = text.length > CLOSING_CHARS ? tail.search(/[.!?\n]\s/) : -1;
  return (cut >= 0 ? tail.slice(cut + 1) : tail)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[*_`#>]/g, "")
    .trim()
    .toLowerCase();
}

function sentences(closing: string): string[] {
  return closing
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/** The reply ends by asking the person something: the next move is theirs. */
export function replyAsksThePerson(reply: string): boolean {
  const last = sentences(replyClosing(reply)).at(-1) ?? "";
  return /\?["')\]]*$/.test(last) || OFFER.test(last);
}

/** An offer or a condition on the person: no work is promised until they answer. */
const OFFER =
  /\b(?:if you(?:'d| would)? (?:like|want|prefer|need)|would you like|do you want|want me to|shall i|should i|let me know|just say|tell me (?:if|when|which|what)|once you|when you(?:'re| are| have|'ve)?\b|after you|as soon as you|waiting (?:for|on) (?:you|your))/;

const I = "(?:i|we)";
const AM = `(?:${I}\\s+am|${I}'m|im|we\\s+are|we're)`;
const WILL = `(?:${I}\\s+will|${I}'ll|${I}\\s+shall|${AM}\\s+going\\s+to|${AM}\\s+about\\s+to)`;
const GOING_ON =
  "(?:continu\\w*|proceed\\w*|mov\\w+\\s+on|carry\\w*\\s+on|go\\w*\\s+ahead|start\\w*|begin\\w*|resum\\w*|keep\\w*\\s+(?:going|working|writing|at\\s+it)|work\\w*\\s+on|writ\\w+|draft\\w*|finish\\w*|tackl\\w*|pick\\w*\\s+up)";

/** First-person statements that more work of the agent's own follows this run. */
const PROMISES: RegExp[] = [
  // "I'm continuing with chapter 6", "I am now moving on to the next file"
  new RegExp(`\\b${AM}\\s+(?:now\\s+|still\\s+|already\\s+)?${GOING_ON}\\b`),
  // "I'll continue with…", "I will now start…"
  new RegExp(`\\b${WILL}\\s+(?:now\\s+|then\\s+|next\\s+|also\\s+)?${GOING_ON}\\b`),
  // "Next I'll…", "Now I will…", "Then I'm going to…"
  new RegExp(`\\b(?:next|now|then|after that|afterwards)[,:]?\\s+${WILL}\\b`),
  // "Continuing with chapter 6." / "Moving on to part two." as a sentence of its own
  /(?:^|[.!?:;]\s+|\n)(?:now\s+)?(?:continuing|proceeding|moving on|carrying on|starting|resuming)\s+(?:with|to|on|now)\b/,
  // "I'll report back when it's done", "I will update you once the build finishes"
  new RegExp(
    `\\b${WILL}\\s+(?:report|update|let|send|share|deliver|post|get back|come back|ping|notify|message)\\b[^.!?\\n]{0,60}\\b(?:when|once|as soon as|after|shortly|soon)\\b`,
  ),
  // "the next part is on its way", "more to follow"
  /\b(?:more|rest|remaining \w+|next \w+) (?:is|are) (?:coming|on (?:its|their|the) way|to follow|underway|in progress)\b/,
];

/** Future-tense first person that is not clearly a promise of work: left to the judge. */
const MAYBE = new RegExp(
  `\\b(?:${WILL}|let\\s+me)\\b|\\b(?:in\\s+progress|underway|still\\s+(?:working|running|writing)|to\\s+be\\s+continued|stay\\s+tuned|hang\\s+tight|bear\\s+with\\s+me|working\\s+on\\s+it)\\b`,
);

export type OpenWorkPromise = "promise" | "unclear" | "none";

/**
 * Whether a reply's closing lines promise further work of the agent's own.
 * `promise`: a first-person statement that work follows. `unclear`: future-tense wording, or a
 * closing in a script these patterns cannot read, for a model to judge. `none`: everything else,
 * including an offer or a question, which hands the next move to the person.
 */
export function declaresFurtherWork(reply: string): OpenWorkPromise {
  const closing = replyClosing(reply);
  if (!closing) return "none";
  const parts = sentences(closing);
  // The last word is the person's when the reply ends with a question or an offer.
  if (replyAsksThePerson(reply)) return "none";
  let unclear = false;
  for (const sentence of parts) {
    if (OFFER.test(sentence)) continue;
    if (PROMISES.some((pattern) => pattern.test(sentence))) return "promise";
    if (MAYBE.test(sentence)) unclear = true;
  }
  if (unclear) return "unclear";
  // Mostly non-Latin letters: the patterns above cannot read it.
  const letters = closing.replace(/[\s\d\p{P}\p{S}]/gu, "");
  const foreign = letters.replace(/\p{Script=Latin}/gu, "");
  return letters.length >= 12 && foreign.length / letters.length > 0.5 ? "unclear" : "none";
}

/** The sentence that carries the promise, for the continuation's brief and the owner's notice. */
export function promisedWork(reply: string): string {
  const text = reply.trim().replace(/[*_`#>]/g, "");
  const tail = text.length > CLOSING_CHARS ? text.slice(-CLOSING_CHARS) : text;
  const original = tail
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const promising = original.find((sentence) => {
    const lower = sentence.replace(/[\u2018\u2019]/g, "'").toLowerCase();
    return !OFFER.test(lower) && PROMISES.some((pattern) => pattern.test(lower));
  });
  return (promising ?? original.at(-1) ?? "").replace(/\s+/g, " ").slice(0, 300);
}

export interface OpenWorkItem {
  id: string;
  title: string;
}

/** Everything that would bring the agent back to this chat without the platform's help. */
export interface OpenWorkWakers {
  /** Helpers of this chat still working, or finished with their result not handed back yet. */
  helpers: number;
  /** Helpers of this chat waiting for a slot. */
  queuedHelpers: number;
  /** Other queued, working or waiting runs of this agent in this chat. */
  runs: number;
  /** Background jobs of this chat still running, or ended with their result not handed back. */
  jobs: number;
  /** One-time schedules the agent set for itself that are still due. */
  schedules: number;
  /** Cards of this agent in this chat that wait on the person. */
  cards: number;
  /** Requests this agent sent to other agents whose outcome has not come back. */
  requests: number;
}

export function pendingWakers(wakers: OpenWorkWakers): Array<keyof OpenWorkWakers> {
  return (Object.keys(wakers) as Array<keyof OpenWorkWakers>).filter((key) => wakers[key] > 0);
}

export interface OpenWorkFacts {
  /** OPEN_WORK_CONTINUATION. */
  enabled: boolean;
  status: string;
  trigger: string;
  replyText: string;
  toolCallCount: number;
  /** Open items the agent keeps for this chat (not parked, not done). */
  openItems: readonly OpenWorkItem[];
  /** Items of this chat the agent added, changed or closed during this run. */
  itemsTouchedInRun: number;
  /** Items of this chat the agent parked during this run, with its reason. */
  parkedInRun: ReadonlyArray<OpenWorkItem & { notes: string }>;
  /** `declaresFurtherWork`, after a model settled an unclear one. */
  promise: "promise" | "none";
  /**
   * Fork (1.3 + 1.33, L5): the older rule's fact, decided here with everything else. The person
   * asked for work, the run called no tool, and its short reply does not complete the request
   * (`needsContinuation`). One decision path: it starts at most the one continuation this
   * function allows, and never beside or after a continuation for open items or a promise.
   */
  announced?: boolean;
  /** This run is itself a continuation the rule started. */
  isContinuation: boolean;
  /** Continuations already started for this task (since the person's last own message). */
  continuationsSoFar: number;
  maxContinuations: number;
  wakers: OpenWorkWakers;
}

export type OpenWorkDecision =
  | { action: "none"; reason: string }
  | { action: "continue"; basis: "items" | "promise" | "announced" }
  | {
      action: "stalled";
      reason: "limit" | "no_progress" | "blocked";
      /** Open items when there are any; otherwise 1 for the promised work. */
      openCount: number;
    };

/**
 * What the platform does when a run ends. Reads only facts; no model is asked here (an unclear
 * promise is settled before, with a safe default of "none").
 */
export function decideOpenWork(facts: OpenWorkFacts): OpenWorkDecision {
  if (!facts.enabled) return { action: "none", reason: "disabled" };
  if (facts.status !== "completed") return { action: "none", reason: "not_completed" };
  if (!runIsFollowedForOpenWork(facts.trigger)) return { action: "none", reason: "trigger" };
  const waking = pendingWakers(facts.wakers);
  // A status report while helpers work, a question on a card, a job still running: the agent
  // comes back by itself, and continuing now would only repeat the report.
  if (waking.length > 0) return { action: "none", reason: `will_wake:${waking.join(",")}` };
  const hasItems = facts.openItems.length > 0;
  // A continuation is never continued for having only announced: one such run per task, as the
  // older rule had it. What it leaves open (items, a promise) is judged like any run's.
  const announced = facts.announced === true && !facts.isContinuation;
  if (!hasItems && facts.promise !== "promise" && !announced) {
    // Nothing left to do. A continuation that parked its work instead of doing it is blocked.
    if (facts.isContinuation && facts.parkedInRun.length > 0)
      return { action: "stalled", reason: "blocked", openCount: facts.parkedInRun.length };
    return { action: "none", reason: "no_open_work" };
  }
  // The agent handed the next move to the person in its last words.
  if (replyAsksThePerson(facts.replyText)) return { action: "none", reason: "asked_person" };
  const openCount = hasItems ? facts.openItems.length : 1;
  if (facts.isContinuation) {
    // No-progress rule: with items kept, a continuation must have moved one of them (added,
    // changed or closed: that takes a tool call); on a promise alone, it must have called a tool.
    const progressed = hasItems ? facts.itemsTouchedInRun > 0 : facts.toolCallCount > 0;
    if (!progressed) return { action: "stalled", reason: "no_progress", openCount };
  }
  const basis = hasItems ? "items" : facts.promise === "promise" ? "promise" : "announced";
  if (facts.continuationsSoFar >= facts.maxContinuations)
    // Nothing is known to be open after a bare announcement, so there is nothing to tell.
    return basis === "announced"
      ? { action: "none", reason: "limit" }
      : { action: "stalled", reason: "limit", openCount };
  return { action: "continue", basis };
}

const clean = (text: string) => text.replace(/\s+/g, " ").trim();

/** The brief of a continuation run. Item titles and the quoted promise are the agent's own data. */
export function openWorkContinuationPrompt(input: {
  basis: "items" | "promise";
  items: readonly OpenWorkItem[];
  promised: string;
  attempt: number;
  maxContinuations: number;
  /** Item titles and quotes pass through here (escapePromptData). */
  escape: (text: string) => string;
}): string {
  const shown = input.items.slice(0, 12);
  const work =
    input.basis === "items"
      ? [
          "Your open items for this chat:",
          ...shown.map((item) => `- ${input.escape(clean(item.title))} (id: ${item.id})`),
          ...(input.items.length > shown.length
            ? [`…and ${input.items.length - shown.length} more (scratchpad_list).`]
            : []),
          "Do the next one now, in this run, and complete it with scratchpad_complete when it is done.",
        ]
      : [
          `Your last message said more work of yours would follow: "${input.escape(clean(input.promised))}"`,
          "Do that work now, in this run.",
        ];
  return [
    `${CONTINUATION_MARKER} No person sent this. Your last run in this chat ended with work of your own still open, and nothing else was going to start you again, so the platform did (continuation ${input.attempt} of ${input.maxContinuations}).`,
    ...work,
    "Work with your tools; do not answer with a plan or a status report. If the work cannot go on without a person or an outside event, set its item to parked with the reason in the notes (scratchpad_update) and say what you need in one sentence. End this run only when the work is done, is handed to a helper or a job that reports back by itself, or is parked. Never end by saying you are continuing.",
  ].join("\n");
}

const REASONS: Record<"limit" | "no_progress" | "blocked", string> = {
  limit: "it reached the limit of automatic continuations for one task",
  no_progress: "its last automatic continuation made no progress",
  blocked: "it cannot go on by itself",
};

/** The one line the owner gets in the chat and as a notification when a task stops moving. */
export function stalledNotice(input: {
  botName: string;
  reason: "limit" | "no_progress" | "blocked";
  /** Open items, or the parked ones when the agent is blocked. */
  items: ReadonlyArray<OpenWorkItem & { notes?: string }>;
  promised: string;
}): { title: string; body: string; chat: string } {
  const names = input.items.slice(0, 3).map((item) => clean(item.title).slice(0, 80));
  const more =
    input.items.length > names.length ? ` (+${input.items.length - names.length} more)` : "";
  const blockedWhy =
    input.reason === "blocked" ? clean(input.items.find((item) => item.notes)?.notes ?? "") : "";
  const what =
    input.items.length > 0
      ? `${input.items.length} ${input.items.length === 1 ? "item" : "items"} ${input.reason === "blocked" ? "parked" : "open"}: ${names.join("; ")}${more}`
      : `promised work not done: "${clean(input.promised).slice(0, 160)}"`;
  const why = blockedWhy
    ? `${REASONS.blocked}: ${blockedWhy.slice(0, 200)}`
    : REASONS[input.reason];
  const body = `${what}. Nothing is running for this task now, because ${why}.`;
  return {
    title: `${input.botName} ${input.reason === "blocked" ? "is blocked" : "stalled"}`,
    body,
    chat: `${input.reason === "blocked" ? "Blocked" : "Stalled"}: ${body} A message here starts it again.`,
  };
}

/** What a small model is asked when the closing lines are unclear. */
export const OPEN_WORK_JUDGE_INSTRUCTIONS = [
  "You read the closing lines of a message an AI agent wrote to the person it works for, at the end of a work session. After this message the agent stops running.",
  'Answer whether the message says the agent itself is going to do MORE work on the task after this message (for example "I\'m continuing with the next part", "next I will fix the tests", "I\'ll report when it is done"), in any language.',
  "Answer false when the work is reported as finished, when the agent offers something or asks a question and waits for the person, when it waits for another party or a scheduled time, or when it only describes what was done.",
  'Reply with JSON only: {"more_work": true} or {"more_work": false}.',
].join("\n");
