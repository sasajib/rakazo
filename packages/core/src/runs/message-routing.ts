/**
 * Fork (FORK.md 1.42): what a person's message into a chat with work in flight means.
 *
 * A message typed while the agent works used to become steering of the one working run, and a
 * message while it waited on a question retired that question and cancelled the run. Now every
 * such message is routed to one of four intents:
 *   - override: it changes, corrects, cancels or replaces what a task in flight is doing; that
 *     task is stopped and the message is worked on in its place;
 *   - addition: it adds a requirement or a remark to a task in flight; the task keeps going and
 *     reads it at its next step;
 *   - answer: it answers the question a waiting task asked;
 *   - new_task: it asks for separate work; a run of its own starts beside the others.
 *
 * Meaning decides, so a small model judges every message ({@link ROUTING_JUDGE_INSTRUCTIONS}).
 * Only certainties skip it ({@link certainRoute}): a reply to (or quote of) the open question's
 * card, or the open question's own option typed back. Anything the judge does not settle with
 * confidence (low confidence, timeout, error, switched off) is an ADDITION to the most recent task:
 * work is never aborted on a guess. This file is pure; the adapters call the model and act.
 */

export const ROUTE_INTENTS = ["override", "addition", "answer", "new_task"] as const;
export type RouteIntent = (typeof ROUTE_INTENTS)[number];

/** How a route was decided, for the `message.routed` log line. */
export type RouteBasis =
  | "reply_to_question"
  | "question_option"
  | "judge"
  | "judge_low_confidence"
  | "judge_invalid"
  | "judge_timeout"
  | "judge_error"
  | "judge_off"
  | "late";

/** A task of the agent in flight in the chat, as the router sees it. */
export interface RouteTask {
  runId: string;
  taskId: string;
  /** working = queued to run soon or running; the others wait on the person. */
  state: "working" | "queued" | "waiting_question" | "waiting_approval" | "waiting_takeover";
  /** Short name of the task (first line of its request). */
  title: string;
  /** What the person (or another agent) asked, cut to a few hundred characters. */
  request: string;
  /** The latest line the agent wrote for this task, if any. */
  progress?: string | undefined;
  /** The open question of a waiting task. */
  question?: { messageId: string; text: string; options: string[] } | undefined;
  /** Message ids the task wrote (its replies, cards); a reply to one of them targets the task. */
  messageIds?: readonly string[] | undefined;
  /** The task's run can take steering (a conversational run). */
  steerable: boolean;
  createdAt: Date;
}

/**
 * How an override acts. `redirect` changes the criteria, details or format of the running task
 * while its goal stands: it is steered at once and keeps its progress, nothing is stopped.
 * `replace` abandons the task (another target or subject, cancelled, or what it made is unwanted):
 * it is stopped and the message runs in its place. Only a sure `replace` is destructive.
 */
export type OverrideAction = "redirect" | "replace";

export interface RouteDecision {
  intent: RouteIntent;
  /** For an override: steer the task (redirect) or stop it and start again (replace). */
  action?: OverrideAction | undefined;
  /** The task the message is about; null only for a new task. */
  targetRunId: string | null;
  basis: RouteBasis;
  confidence?: number | undefined;
  /** For an addition: it asks for more work (recorded as an open item), not a remark. */
  addsRequirement: boolean;
  /** One short line from the judge, never the message itself. */
  reason?: string | undefined;
}

/** What the judge answered, parsed. */
export interface RouteJudgeAnswer {
  intent: RouteIntent;
  task: string | null;
  confidence: number;
  addsRequirement: boolean;
  /** For an override: what the judge thinks it does to the task. */
  overrideKind: OverrideAction;
  reason: string;
}

/** The model answer failed or was not asked for. */
export type RouteJudgeFailure = "timeout" | "error" | "off" | "invalid";

/** Below this the judge's answer is not acted on (ADDITION instead). */
export const DEFAULT_ROUTE_MIN_CONFIDENCE = 0.6;

/** An override needs more certainty than an addition, even one that only redirects the task. */
export const DEFAULT_OVERRIDE_MIN_CONFIDENCE = 0.7;

/** A replace stops work, so it needs the most certainty; below it the task is redirected. */
export const DEFAULT_REPLACE_MIN_CONFIDENCE = 0.85;

function normalized(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s"'`“”‘’.,!?;:()[\]{}…。！？]+/g, " ")
    .trim();
}

/** The most recent task, which an unsure message is added to. */
export function mostRecentTask(tasks: readonly RouteTask[]): RouteTask | undefined {
  return [...tasks].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.runId.localeCompare(a.runId),
  )[0];
}

/**
 * Certainties that need no model: a reply to the open question's card, or one of its options
 * typed back. Undefined means the judge decides.
 */
export function certainRoute(input: {
  text: string;
  replyToMessageId?: string | undefined;
  tasks: readonly RouteTask[];
}): RouteDecision | undefined {
  const waiting = input.tasks.filter((task) => task.question);
  if (input.replyToMessageId) {
    const asked = waiting.find((task) => task.question?.messageId === input.replyToMessageId);
    if (asked && input.text.trim())
      return {
        intent: "answer",
        targetRunId: asked.runId,
        basis: "reply_to_question",
        addsRequirement: false,
      };
  }
  const said = normalized(input.text);
  if (!said) return undefined;
  for (const task of waiting) {
    const options = task.question?.options ?? [];
    if (options.some((option) => normalized(option) === said))
      return {
        intent: "answer",
        targetRunId: task.runId,
        basis: "question_option",
        addsRequirement: false,
      };
  }
  return undefined;
}

/** The task a reply or quote names, if the person replied to one of a task's messages. */
export function repliedTask(
  tasks: readonly RouteTask[],
  replyToMessageId: string | undefined,
): RouteTask | undefined {
  if (!replyToMessageId) return undefined;
  return tasks.find(
    (task) =>
      task.question?.messageId === replyToMessageId ||
      (task.messageIds ?? []).includes(replyToMessageId),
  );
}

/** Task keys the judge sees (T1 = oldest), so it never has to copy an id. */
export function taskKeys(tasks: readonly RouteTask[]): Map<string, RouteTask> {
  const ordered = [...tasks].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.runId.localeCompare(b.runId),
  );
  return new Map(ordered.map((task, index) => [`T${index + 1}`, task]));
}

/** The instructions of the routing judge. Kept here so the eval set and the product share them. */
export const ROUTING_JUDGE_INSTRUCTIONS = [
  "You route one new chat message that a person sent to an AI agent while the agent already has",
  "tasks in flight in this chat. Decide what the person means, by meaning, not by keywords.",
  "",
  "Intents:",
  '- "override": the message changes, corrects, narrows, cancels or replaces what an in-flight task',
  "  is doing or is about to deliver, so that task's current direction is no longer what the person",
  '  wants. Corrections are often indirect and only make sense about that task: "actually make it',
  '  shorter", "use the other logo", "no, I meant the March numbers", "wrong file", "not that one",',
  '  "make it formal instead", "send it to Omar, not Sara", "skip the intro", "forget it", "scrap that",',
  '  "never mind", "hold off on that". A changed value, target, format, scope or choice for the task',
  '  is an override, even when phrased politely or as a wish ("could you rather...", "I\'d prefer...").',
  "  Say which kind of override it is in override_kind:",
  '  - "redirect": the task keeps its goal and what it did so far is still useful; the message',
  "    changes a criterion, preference, detail, style, length or format the task can adjust while",
  '    it goes on ("keep it under a page", "warmer tone", "a table rather than a list", "price',
  '    matters more than speed"). A stated preference that loosens or ranks the options ("either',
  '    is fine", "whichever is quicker") is a redirect at most, often an addition.',
  '  - "replace": the work done so far is wrong or no longer wanted: another subject, target, period',
  '    or destination ("it\'s about the Q2 launch, not Q1", "send it to the Chittagong office',
  '    instead"), the task is',
  '    cancelled or paused ("forget it", "never mind", "hold off", "don\'t send it"), or what it made',
  "    must be thrown away and made again. Only a clear replacement is replace.",
  '- "addition": the message keeps the task as it is and adds a further requirement, detail or',
  '  deliverable ("also add a summary", "and email it to me when done", "include last year too"),',
  "  or it is a remark or question about the task that changes nothing (thanks, ok, great, how is it",
  "  going, are you done yet, take your time). Set adds_requirement true only when it asks for more",
  "  work.",
  '- "answer": the message answers the open question that a waiting task asked (it gives the',
  "  information, choice or confirmation the question asked for). Only a task with an",
  "  open_question can be answered.",
  '- "new_task": the message asks for separate work or a separate question whose goal is not part of',
  "  any in-flight task (another topic, another deliverable, a quick unrelated question, small talk",
  "  that asks something). It does not depend on what the tasks are doing.",
  "",
  "How to decide:",
  "- Compare the message with each task's request, latest progress and open question. Pick the task",
  '  it is about. Recent turns of the chat show what "it", "that", "the other one" refer to.',
  "- Override versus addition: if doing the task as it is now going would no longer satisfy the",
  "  person, it is an override; if the task as it is going still stands and something is added on",
  "  top, it is an addition.",
  "- Answer versus override: replying to the open question with a choice or a value is an answer,",
  "  even when it differs from what the agent suggested.",
  "- A message that could be read both as an override and as an addition is an addition with low",
  "  confidence; one that could be a redirect or a replace is a redirect. Never call chit-chat,",
  "  thanks, or a progress question an override.",
  "- If the person refers to a task's result or subject (the report, the logo, the email, those",
  "  numbers), it is about that task: not a new_task.",
  "- confidence is how sure you are, from 0.0 to 1.0.",
  "",
  'Reply with JSON only: {"intent": "override|addition|answer|new_task", "task": "T1", "confidence":',
  '0.0, "override_kind": "redirect|replace", "adds_requirement": false, "reason": "one short line in',
  'your own words, never quoting the message"}. For new_task set "task" to null. Give override_kind',
  "only for an override.",
].join("\n");

const MAX_TEXT = 600;

function cut(text: string | undefined, max = MAX_TEXT): string | undefined {
  const value = text?.replace(/\s+/g, " ").trim();
  if (!value) return undefined;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** The judge's user message: the new message, the tasks and recent turns, as JSON. */
export function routingJudgeInput(input: {
  message: string;
  replyTo?: { taskKey?: string | undefined; text?: string | undefined } | undefined;
  tasks: readonly RouteTask[];
  recentTurns?: ReadonlyArray<{ role: "person" | "agent"; text: string }> | undefined;
}): string {
  const keys = taskKeys(input.tasks);
  return JSON.stringify({
    new_message: cut(input.message, 2_000),
    ...(input.replyTo
      ? { replies_to: { task: input.replyTo.taskKey, text: cut(input.replyTo.text, 300) } }
      : {}),
    tasks: [...keys].map(([key, task]) => ({
      task: key,
      state: task.state,
      title: cut(task.title, 120),
      request: cut(task.request),
      latest_progress: cut(task.progress, 300),
      ...(task.question
        ? {
            open_question: cut(task.question.text, 400),
            ...(task.question.options.length ? { options: task.question.options.slice(0, 8) } : {}),
          }
        : {}),
    })),
    recent_turns: (input.recentTurns ?? []).slice(-8).map((turn) => ({
      from: turn.role,
      text: cut(turn.text, 300),
    })),
  });
}

/** Parse the judge's JSON (tolerating a code fence or text around it). */
export function parseRouteJudgeAnswer(raw: unknown): RouteJudgeAnswer | undefined {
  if (typeof raw !== "string") return undefined;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const intent = String(record.intent ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (!(ROUTE_INTENTS as readonly string[]).includes(intent)) return undefined;
  const confidence = Number(record.confidence);
  const task = typeof record.task === "string" && record.task.trim() ? record.task.trim() : null;
  return {
    intent: intent as RouteIntent,
    task: task ? task.toUpperCase() : null,
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
    addsRequirement: record.adds_requirement === true,
    overrideKind:
      String(record.override_kind ?? "").toLowerCase() === "replace" ? "replace" : "redirect",
    reason: String(record.reason ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160),
  };
}

/**
 * The route for a message, from a certainty, the judge's answer, or the safe default. A task the
 * judge names must exist; an override must clear its own bar; an answer needs an open question.
 */
export function decideMessageRoute(input: {
  tasks: readonly RouteTask[];
  certain?: RouteDecision | undefined;
  judged?: RouteJudgeAnswer | RouteJudgeFailure | undefined;
  /** A reply to one of a task's messages pins the task the message is about. */
  pinnedRunId?: string | undefined;
  minConfidence?: number | undefined;
  overrideMinConfidence?: number | undefined;
  replaceMinConfidence?: number | undefined;
}): RouteDecision {
  if (input.certain) return input.certain;
  const pinned = input.pinnedRunId
    ? input.tasks.find((task) => task.runId === input.pinnedRunId)
    : undefined;
  const fallback = pinned ?? mostRecentTask(input.tasks);
  const addition = (basis: RouteBasis, extra: Partial<RouteDecision> = {}): RouteDecision => ({
    intent: "addition",
    targetRunId: fallback?.runId ?? null,
    basis,
    addsRequirement: false,
    ...extra,
  });
  const judged = input.judged ?? "off";
  if (typeof judged === "string") {
    return addition(
      judged === "timeout"
        ? "judge_timeout"
        : judged === "error"
          ? "judge_error"
          : judged === "invalid"
            ? "judge_invalid"
            : "judge_off",
    );
  }
  const keys = taskKeys(input.tasks);
  const named = judged.task ? keys.get(judged.task) : undefined;
  const target = pinned ?? named ?? (judged.intent === "new_task" ? undefined : fallback);
  const minimum = input.minConfidence ?? DEFAULT_ROUTE_MIN_CONFIDENCE;
  const overrideMinimum = Math.max(
    minimum,
    input.overrideMinConfidence ?? DEFAULT_OVERRIDE_MIN_CONFIDENCE,
  );
  const sure = judged.confidence >= (judged.intent === "override" ? overrideMinimum : minimum);
  const common = { confidence: judged.confidence, reason: judged.reason };
  if (!sure) {
    // An unsure addition still says whether it asks for more work.
    return addition("judge_low_confidence", {
      ...common,
      targetRunId: (target ?? fallback)?.runId ?? null,
      addsRequirement: judged.intent === "addition" ? judged.addsRequirement : false,
    });
  }
  switch (judged.intent) {
    case "new_task":
      // A reply to a task's own message is about that task, whatever the judge thought.
      if (pinned) return addition("judge_low_confidence", { ...common, targetRunId: pinned.runId });
      return {
        intent: "new_task",
        targetRunId: null,
        basis: "judge",
        addsRequirement: false,
        ...common,
      };
    case "answer": {
      const asked = target?.question ? target : input.tasks.find((task) => task.question);
      if (!asked)
        return addition("judge_invalid", { ...common, targetRunId: target?.runId ?? null });
      return {
        intent: "answer",
        targetRunId: asked.runId,
        basis: "judge",
        addsRequirement: false,
        ...common,
      };
    }
    case "override": {
      if (!target) return addition("judge_invalid", common);
      const replaceMinimum = Math.max(
        overrideMinimum,
        input.replaceMinConfidence ?? DEFAULT_REPLACE_MIN_CONFIDENCE,
      );
      // Destructive only when it is clearly a replacement; anything less steers the task.
      const action: OverrideAction =
        judged.overrideKind === "replace" && judged.confidence >= replaceMinimum
          ? "replace"
          : "redirect";
      return {
        intent: "override",
        action,
        targetRunId: target.runId,
        basis: "judge",
        addsRequirement: false,
        ...common,
      };
    }
    default:
      return {
        intent: "addition",
        targetRunId: target?.runId ?? null,
        basis: "judge",
        addsRequirement: judged.addsRequirement,
        ...common,
      };
  }
}

/** The first line of a request, as a task's title. */
export function taskTitle(request: string, max = 80): string {
  const line =
    request
      .split(/\r?\n/)
      .map((part) => part.trim())
      .find(Boolean) ?? "";
  const clean = line.replace(/\s+/g, " ");
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean || "(no text)";
}

/** One line the person reads when a task was stopped for their message. */
export function overrideNotice(stoppedTitle: string): string {
  return `Stopped "${stoppedTitle}" for your new instruction; working on that now.`;
}

/** One line the person reads when a new task waits for a free slot. */
export function queuedTaskNotice(position: number, running: number): string {
  return `Queued as task ${position} in line: ${running} ${running === 1 ? "task is" : "tasks are"} already working here. It starts by itself when one finishes.`;
}

/**
 * The prompt line that tells a run which task it serves and what else is in flight in the chat,
 * so replies do not mix tasks. Empty when the run is the only task.
 */
export function chatTasksInstruction(input: {
  ownTitle: string;
  others: ReadonlyArray<{ title: string; state: string }>;
}): string | undefined {
  if (input.others.length === 0) return undefined;
  const others = input.others
    .slice(0, 6)
    .map((task) => `"${task.title}" (${task.state})`)
    .join("; ");
  return [
    `Tasks in this chat: this run serves the task "${input.ownTitle}".`,
    `Other tasks are in flight here, each handled by its own run: ${others}.`,
    "Work and report only on your own task; do not redo, finish or answer for the others. Your",
    "replies are shown as answers to the message that started your task.",
  ].join(" ");
}
