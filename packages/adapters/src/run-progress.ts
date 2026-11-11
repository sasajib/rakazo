import { messagingProgressJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import type { ToolStepOutcome } from "@rakazo/core";
import {
  appendTextSegment,
  appendToolCallSegment,
  createStreamingRedactor,
  endsSentence,
  isBackgroundRunTrigger,
  isConversationalRun,
  noteLastToolStep,
  redactSecrets,
  redactSecretsAfter,
  withToolStepOutcomes,
} from "@rakazo/core";
import type { Run } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor-deps.js";
import { IMAGE_RETURNING_COMPUTER_TOOLS } from "./model-vision.js";
import type { ReplyState, RunContext } from "./run-context.js";
import { publishMessage } from "./run-messages.js";
import {
  messageBlocksText,
  runAllowsSilentEmpty,
  runPromotesMidTurnNarration,
} from "./run-replies.js";
import { PAGE_BROWSER_TOOL_NAMES } from "./run-tool-selection.js";
import { couldBecomeNoResponse, isExactNoResponse, isPlaceholderText } from "./silent-reply.js";
import { USER_COMPUTER_SCREEN_TOOLS } from "./user-computer-tools.js";
import {
  clampUserProgressMessage,
  extractNarrationText,
  isUserProgressClientNonce,
  midTurnProgressBudgetAllows,
  narrationStatusLine,
  USER_PROGRESS_MESSAGE_MAX_LENGTH,
  userProgressClientNonce,
} from "./user-progress.js";

/** A fresh reply that knows the progress messages earlier attempts of this run posted. */
export async function createReplyState(
  deps: ExecutorDeps,
  run: Run,
  secrets: string[],
): Promise<ReplyState> {
  const reply: ReplyState = {
    assembled: "",
    currentTextSegment: "",
    messageSegments: [],
    publishedTerminalSubagent: false,
    publishedMidTurnUserMessage: false,
    discardedMidTurnNarration: false,
    lastDiscardedMidTurnNarration: "",
    explicitNoResponse: false,
    assistantTurnText: "",
    midTurnUserTexts: [],
    midTurnProgressCount: 0,
    turnStartedAtMs: run.startedAt?.getTime() ?? Date.now(),
    progressBudgetStart: 0,
    steeringReplyPending: false,
    computerTaskStarted: false,
    steeringResets: 0,
    lastSteeringResetAt: Number.NEGATIVE_INFINITY,
    workingNotes: [],
    textSinceLastStep: "",
    narrationSoFar: "",
    narrationStatusShowing: false,
    pendingToolNames: [],
    toolCalls: [],
    toolOutcomes: new Map(),
    pendingProgress: "",
    lastProgressAt: 0,
    hasStreamedText: false,
    assistantTurnBreakPending: false,
    redactor: createStreamingRedactor(secrets),
  };
  const priorProgress = await deps.prisma.message.findMany({
    where: { runId: run.id, role: "bot" },
    orderBy: { seq: "asc" },
    select: { blocks: true, clientNonce: true },
  });
  for (const message of priorProgress) {
    if (!isUserProgressClientNonce(message.clientNonce)) continue;
    const blocks = Array.isArray(message.blocks) ? (message.blocks as MessageBlock[]) : [];
    const text = messageBlocksText(blocks).trim();
    if (!text) continue;
    reply.midTurnUserTexts.push(text);
    reply.publishedMidTurnUserMessage = true;
    reply.midTurnProgressCount += 1;
  }
  return reply;
}

export function recordExplicitNoResponse(reply: ReplyState, text: string) {
  reply.explicitNoResponse ||= isExactNoResponse(text) || /\bNO_RESPONSE\b/.test(text);
}

/** Durable interim messages only on genuinely long turns, capped per run. */
export function canPublishDurableProgress(reply: ReplyState) {
  return (
    reply.steeringReplyPending ||
    midTurnProgressBudgetAllows(progressSinceBudgetStart(reply), Date.now() - reply.turnStartedAtMs)
  );
}

const BROWSER_AND_DESKTOP_TOOLS = new Set([
  ...IMAGE_RETURNING_COMPUTER_TOOLS,
  ...PAGE_BROWSER_TOOL_NAMES,
  ...USER_COMPUTER_SCREEN_TOOLS,
]);

export function noteComputerTaskStep(reply: ReplyState, toolName: string) {
  if (BROWSER_AND_DESKTOP_TOOLS.has(toolName)) reply.computerTaskStarted = true;
}

/**
 * Browser and desktop tasks often take minutes, so the run's first interim message may tell
 * the person so at once. Runs nobody is waiting on keep the fresh-turn rule.
 */
export function canPostLongTaskHeadsUp(ctx: RunContext) {
  const { reply } = ctx.state;
  return (
    reply.computerTaskStarted &&
    reply.midTurnProgressCount === 0 &&
    isConversationalRun(ctx.run.trigger) &&
    !runAllowsSilentEmpty(ctx.run.trigger)
  );
}

export function progressSinceBudgetStart(reply: ReplyState) {
  return reply.midTurnProgressCount - reply.progressBudgetStart;
}

/** The next interim message's nonce; it uses up the allowance for answering the person. */
function nextProgressNonce(ctx: RunContext) {
  const { reply } = ctx.state;
  reply.steeringReplyPending = false;
  return userProgressClientNonce(ctx.run.id, reply.midTurnProgressCount++);
}

/**
 * Posts an interim message. A chat app gets a run's messages when the run ends, so a 1:1 run it
 * started sends this one on at once. A group run posts once, when it ends.
 */
export async function publishInterimMessage(ctx: RunContext, text: string, markUnread?: boolean) {
  const { deps, run } = ctx;
  const { reply } = ctx.state;
  await publishMessage(
    deps,
    run,
    "bot",
    [{ kind: "text", text }],
    markUnread,
    nextProgressNonce(ctx),
  );
  reply.midTurnUserTexts.push(text);
  reply.publishedMidTurnUserMessage = true;
  if (run.trigger === "messaging" && !ctx.source.channelId) {
    await deps.jobs.enqueue(messagingProgressJob(run.id)).catch((error) => {
      getLogger().error("messaging progress enqueue error", error);
    });
  }
}

/** How long the restated task may be before it is cut. */
export const ACK_MAX_CHARS = 140;

// Speech-to-text keeps the caller's noises; repeating them back is not an acknowledgement.
const FILLERS = new Set([
  "uh",
  "uhh",
  "um",
  "umm",
  "ah",
  "ahh",
  "eh",
  "er",
  "erm",
  "hmm",
  "hm",
  "mm",
  "mhm",
  "like",
  "well",
  "so",
  "okay",
  "ok",
  "right",
]);

// Openers that carry no task: a greeting, or a request wrapper.
const OPENERS = [
  /^(?:hi|hey|hello|yo)[\s,]+(?:chief|bot|there)\b[\s,.:]*/i,
  /^(?:okay|ok|so|well|right|now)[\s,]+/i,
  /^(?:can|could|would|will)\s+you\s+(?:please\s+)?/i,
  /^(?:please|kindly)\s+/i,
  /^(?:i\s+(?:want|need)\s+you\s+to|i\s+need\s+you\s+to|i'd\s+like\s+you\s+to)\s+/i,
];

/**
 * The task in one short line, in the bot's words rather than the caller's.
 *
 * Speech to text keeps every "uh" and every repeated word, so quoting the transcript back reads as
 * a bad echo instead of a confirmation. This drops the noises and the request wrappers, and states
 * what is left as the thing being done.
 */
export function summariseRequest(requestText: string): string {
  let said = requestText.replace(/\s+/g, " ").trim();
  if (!said) return "";
  // Leading noise first ("uh, can you please …"), then the wrapper it was hiding.
  said = said.replace(/^(?:(?:uh|uhh|um|umm|ah|ahh|eh|er|erm|hmm|hm|mm|like|so|well|okay|ok)\b[,. ]*)+/i, "");
  for (const opener of OPENERS) said = said.replace(opener, "");
  // The wrapper can sit mid-sentence once the caller starts over: "…agent. can you please create…"
  said = said
    .replace(/\b(?:can|could|would|will)\s+you\s+(?:please\s+)?/gi, "")
    .replace(/\b(?:please|kindly)\b/gi, "");
  said = said.replace(/^(?:(?:uh|uhh|um|umm|ah|ahh|eh|er|erm|hmm|hm|mm|like|so|well|okay|ok)\b[,. ]*)+/i, "");
  // "we we we going" -> "we going"; repeat-words come from stuttering, not meaning.
  said = said.replace(/\b(\w+)(\s+\1\b)+/gi, "$1");
  const words = said
    .split(" ")
    .filter((word) => {
      const bare = word.toLowerCase().replace(/[^a-z']/g, "");
      return bare === "" || !FILLERS.has(bare);
    });
  said = words
    .join(" ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/,\s*,/g, ",")
    .replace(/^[\s,.;:!?-]+/, "")
    .trim();
  if (!said) return "";
  // A dictated request wanders: pick the clause that names the work, not the first one heard.
  const clauses = said
    .replace(/\.{2,}|\u2026/g, ",")
    .split(/[.!?,;]/)
    .map((clause) => clause.trim().replace(/^[\s,;:-]+|[\s,;:-]+$/g, ""))
    .filter((clause) => clause.split(/\s+/).length >= 2);
  said = clauses.length > 0 ? taskClause(clauses) : said;
  // "create a voice agent so we can run tests": the outcome follows, the task is before it.
  const head = (said.split(/\bsotha?t?\b|\bso\b/i)[0] ?? "").replace(/^[\s,;:-]+|[\s,;:-]+$/g, "");
  if (head.split(/\s+/).length >= 2) said = head;
  said = said.replace(/\s+/g, " ").trim();
  const clipped = said.length > ACK_MAX_CHARS ? `${said.slice(0, ACK_MAX_CHARS).trimEnd()}…` : said;
  return clipped.replace(/[?]+$/, "");
}

// Verbs that name work; the clause carrying one is the task, whatever the caller said around it.
const TASK_VERBS = new Set(
  (
    "add analyse analyze answer book build buy call cancel check clean close compare compile " +
    "connect copy create cut delete deploy describe design draft draw edit email export find " +
    "finish fix follow generate get give install list look make merge move open order organise " +
    "organize plan post prepare print publish read remove rename reply report research review " +
    "run save schedule search send set setup show sort start stop summarise summarize tell test " +
    "translate update upload write"
  ).split(" "),
);

/** The clause that names the work: the first with a task verb, else the longest. */
function taskClause(clauses: readonly string[]): string {
  for (const clause of clauses) {
    const words = clause
      .toLowerCase()
      .split(/\s+/)
      .map((word) => word.replace(/[^a-z]/g, ""));
    if (words.some((word) => TASK_VERBS.has(word))) return clause;
  }
  return clauses.reduce((longest, clause) =>
    clause.split(/\s+/).length > longest.split(/\s+/).length ? clause : longest,
  );
}

/**
 * The line a person's run says before it starts working: what it understood, and that it is on it.
 *
 * Deterministic on purpose. A model's own plan arrives whenever its first turn does — seconds, or
 * minutes if the turn starts with a long tool call — and a task that begins in silence reads as
 * ignored. This is posted before the runtime is asked for anything, and it restates the task rather
 * than repeating the transcript.
 */
export function acknowledgementFor(trigger: string, requestText: string): string | null {
  if (trigger !== "user" && trigger !== "follow_up") return null;
  const task = summariseRequest(requestText);
  if (!task) return null;
  return `Got it — ${task}. Working through it now; I'll tell you when it's finished.`;
}

/** Posts that line as an interim message, if this run is a person's turn. */
export async function publishTaskAcknowledgement(ctx: RunContext, requestText: string) {
  const text = acknowledgementFor(ctx.run.trigger, requestText);
  if (!text) return;
  await publishInterimMessage(ctx, text);
}

/** Whether text written before a step may be posted as an interim message at all. */
export function narrationBecomesMessages(ctx: RunContext) {
  return ctx.replyMode === "chat" && runPromotesMidTurnNarration(ctx.run.trigger);
}

export function canPublishDurableNarration(ctx: RunContext) {
  return narrationBecomesMessages(ctx) && canPublishDurableProgress(ctx.state.reply);
}

export function flushPendingTools(reply: ReplyState) {
  if (reply.currentTextSegment) {
    reply.messageSegments = appendTextSegment(reply.messageSegments, reply.currentTextSegment);
    reply.currentTextSegment = "";
  }
  for (const name of reply.pendingToolNames) {
    reply.messageSegments = appendToolCallSegment(reply.messageSegments, name);
  }
  reply.pendingToolNames = [];
}

/**
 * The reply's steps with how each call ended. Calls with no result yet count as `unfinished`
 * when given (a stopped run), otherwise they carry no outcome.
 */
export function withReplyToolOutcomes(
  reply: ReplyState,
  unfinished?: ToolStepOutcome,
): MessageBlock[] {
  return withToolStepOutcomes(
    reply.messageSegments,
    reply.toolCalls.map(({ label, executionId }) => ({
      label,
      outcome: reply.toolOutcomes.get(executionId) ?? unfinished,
    })),
  );
}

export function tryFlushPendingTools(reply: ReplyState) {
  if (reply.pendingToolNames.length > 0 && endsSentence(reply.currentTextSegment))
    flushPendingTools(reply);
}

/**
 * A member a group message named nobody for may answer with the silence sentinel, so what it
 * has written stays unseen while that is still possible. Once the text turns into a reply it
 * all shows.
 */
export function progressHeldForSilence(ctx: RunContext) {
  const { reply } = ctx.state;
  return !reply.hasStreamedText && mayBeSilentEnding(ctx, reply.pendingProgress);
}

/** Text a member a group message named nobody for may still turn into its silent ending. */
export function mayBeSilentEnding(ctx: Pick<RunContext, "groupReplyOptional">, text: string) {
  return ctx.groupReplyOptional && (couldBecomeNoResponse(text) || isPlaceholderText(text));
}

export async function flushProgress(ctx: RunContext) {
  const { deps, run, runId, bot, thread } = ctx;
  const { reply } = ctx.state;
  // Routines may finish silently. Do not leak narration or a partial silence
  // sentinel before the final outcome is known.
  if (
    ctx.scripted ||
    !reply.pendingProgress ||
    run.trigger === "routine" ||
    isBackgroundRunTrigger(run.trigger) ||
    progressHeldForSilence(ctx)
  )
    return;
  await deps.events.append({
    spaceId: run.spaceId,
    threadId: thread.id,
    botId: bot.id,
    type: "thread.progress",
    runId,
    // The first flush replaces the "working…" placeholder outright — a delta here
    // would otherwise get appended straight onto it with no separator.
    payload: reply.hasStreamedText
      ? { delta: reply.pendingProgress, streaming: true }
      : { text: reply.pendingProgress, streaming: true },
  });
  reply.hasStreamedText = true;
  reply.pendingProgress = "";
  reply.lastProgressAt = Date.now();
}

/**
 * Text the bot wrote before a step. It is posted as an interim message when the budget allows
 * and it fits; otherwise it is a note on that step, kept out of the reply. Returns the note so
 * the caller can show it as the working line.
 */
export async function publishMidTurnNarration(ctx: RunContext, beforeConnectCard = false) {
  const { run } = ctx;
  const { reply } = ctx.state;
  const extracted = extractNarrationText(reply.messageSegments, reply.currentTextSegment);
  reply.messageSegments = extracted.remaining;
  reply.currentTextSegment = "";
  const text = redactSecretsAfter(reply.narrationSoFar, extracted.text, ctx.secrets).trim();
  reply.narrationSoFar += extracted.text;
  if (!text) return undefined;
  reply.assembled = "";
  reply.hasStreamedText = false;
  reply.pendingProgress = "";
  // Text the redactor still holds back belongs to the text just taken out.
  reply.redactor.skip();
  const promotes = runPromotesMidTurnNarration(run.trigger);
  if (
    text.length <= USER_PROGRESS_MESSAGE_MAX_LENGTH &&
    (canPublishDurableNarration(ctx) || (beforeConnectCard && narrationBecomesMessages(ctx)))
  ) {
    reply.workingNotes.length = 0;
    reply.narrationStatusShowing = false;
    await publishInterimMessage(ctx, text);
    return undefined;
  }
  reply.discardedMidTurnNarration = true;
  reply.lastDiscardedMidTurnNarration = clampUserProgressMessage(text);
  if (promotes && !ctx.allowSilentEmptyRun) {
    reply.workingNotes.push(text);
    flushPendingTools(reply);
    reply.messageSegments = noteLastToolStep(reply.messageSegments, text);
  }
  return text;
}

/**
 * Text the bot wrote before asking is what the person needs to answer, and a paused run
 * never reaches the final reply that would bring held notes back. Posts it whole, ahead of
 * the question.
 */
export async function publishNarrationBeforeAsk(ctx: RunContext) {
  const { run } = ctx;
  const { reply } = ctx.state;
  if (!runPromotesMidTurnNarration(run.trigger)) return;
  const extracted = extractNarrationText(reply.messageSegments, reply.currentTextSegment);
  const pending = redactSecretsAfter(reply.narrationSoFar, extracted.text, ctx.secrets).trim();
  reply.narrationSoFar += extracted.text;
  // Messages mode shows only the latest text, as at the end of a turn.
  const held =
    ctx.replyMode === "chat" ? reply.workingNotes : pending ? [] : reply.workingNotes.slice(-1);
  // Held notes were redacted against the secrets known when they were held; check them again.
  const text = redactSecrets([...held, pending].filter(Boolean).join("\n\n"), ctx.secrets);
  if (!text) return;
  reply.messageSegments = extracted.remaining;
  reply.currentTextSegment = "";
  reply.workingNotes.length = 0;
  reply.narrationStatusShowing = false;
  reply.assembled = "";
  reply.hasStreamedText = false;
  reply.pendingProgress = "";
  reply.redactor.skip();
  await publishInterimMessage(ctx, text);
}

/**
 * Replaces the text streamed so far with the note as the working line. Runs that hold their
 * narration back (routines, peers, background work) keep their live view.
 */
export async function showNarrationStatus(ctx: RunContext, note: string | undefined) {
  const { deps, run, runId, bot, thread } = ctx;
  if (
    !note ||
    ctx.scripted ||
    !runPromotesMidTurnNarration(run.trigger) ||
    isBackgroundRunTrigger(run.trigger)
  )
    return;
  ctx.state.reply.narrationStatusShowing = true;
  await deps.events.append({
    spaceId: run.spaceId,
    threadId: thread.id,
    botId: bot.id,
    type: "thread.progress",
    runId,
    payload: { reset: true, text: narrationStatusLine(note), activity: true },
  });
}
