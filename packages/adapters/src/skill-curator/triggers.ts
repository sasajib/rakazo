/**
 * Fork: when a finished run is worth the curator's time. Pure rules, tested on their own.
 *
 * - explicit:    the owner asked ("remember how to do this", "make this a skill").
 * - teach_done:  a chat teaching session is open and the owner says it is done / save as skill.
 * - correction:  the owner corrected HOW the work is done ("no, always check X first",
 *                "next time ...") in a run that did real work (tool calls).
 * - iterative:   the run made many tool calls (a procedure worth keeping).
 * Teaching start / cancel are not curator runs; they open or close the session.
 */

export type CuratorReason = "explicit" | "teach_done" | "correction" | "iterative";

export type RunClassification =
  | { kind: "curate"; reason: CuratorReason }
  | { kind: "teach_start"; task: string }
  | { kind: "teach_cancel" }
  | { kind: "skip" };

/** "let me teach you how to rename the report files" -> "rename the report files". */
const TEACH_START =
  /\b(?:let me|i(?:'ll| will| want to| wanna| am going to|'m going to)|can i)\s+(?:teach|show)\s+you\s+(?:how\s+)?(?:to\s+|i\s+)?([^\n.?!]{3,200})/i;

const TEACH_DONE =
  /\b(?:(?:save|keep|store)\s+(?:(?:this|it|that|the (?:steps|lesson))\s+)?as\s+(?:a\s+)?skill|make\s+(?:this|it|that)\s+(?:into\s+)?a\s+skill|turn\s+(?:this|it|that)\s+into\s+a\s+skill|(?:i'?m|we'?re|i am|we are)\s+done(?:\s+teaching)?|done teaching|that'?s (?:it|all)(?: for (?:the|this) lesson)?|lesson (?:is )?(?:over|done|finished)|end of (?:the )?lesson)\b/i;

const TEACH_CANCEL =
  /\b(?:cancel|stop|forget|abort)\s+(?:the\s+|this\s+)?(?:teaching|lesson)\b|\bdon'?t save (?:it|this|that) as a skill\b/i;

const EXPLICIT =
  /\b(?:remember how (?:to do|you did) (?:this|that|it)|(?:save|keep|store)\s+(?:this|that|it|the steps|how you did (?:it|this))\s+as\s+(?:a\s+)?skill|make\s+(?:this|that|it)\s+(?:into\s+)?a\s+skill|turn\s+(?:this|that|it)\s+into\s+a\s+skill|create\s+a\s+skill\s+(?:for|from)\s+(?:this|that)|learn (?:how to do )?this (?:as a skill|for next time))\b/i;

/** Words that say the owner is correcting how the work is done. */
const CORRECTION =
  /(?:^|[\s"'(])(?:no[,.!:]?\s+(?:do|use|always|first|you|it|not|that|don'?t|check|open|go|put|start)|not like that|that'?s (?:not (?:how|right|it)|wrong)|wrong way|do it like|the right way|next time|from now on|in future|in the future|always\s+\w+|never\s+\w+|you should (?:have|always|first)|(?:first|before)\s+(?:you\s+)?(?:need|have|must|should)\s+to|instead of\b|rather than\b|don'?t (?:ever|do it that way))/i;

export function teachingTask(text: string): string | undefined {
  const match = TEACH_START.exec(text);
  const task = match?.[1]?.trim().replace(/\s+/g, " ");
  return task && task.length >= 3 ? task.slice(0, 200) : undefined;
}

export const isTeachDone = (text: string) => TEACH_DONE.test(text);
export const isTeachCancel = (text: string) => TEACH_CANCEL.test(text);
export const isExplicitSkillAsk = (text: string) => EXPLICIT.test(text);
export const isProcedureCorrection = (text: string) => CORRECTION.test(text);

export interface ClassifyInput {
  /** The owner's messages this run answered (the current turn), oldest first. */
  current: readonly string[];
  toolCalls: number;
  /** Tool calls of the bot's recent earlier replies in this chat: a correction may come after. */
  priorToolCalls?: number;
  minToolCalls: number;
  /** A chat teaching session is open for this agent in this chat. */
  teaching: boolean;
}

export function classifyRun(input: ClassifyInput): RunClassification {
  const text = input.current.join("\n").trim();
  if (!text) return { kind: "skip" };
  if (input.teaching) {
    if (isTeachCancel(text)) return { kind: "teach_cancel" };
    if (isTeachDone(text) || isExplicitSkillAsk(text))
      return { kind: "curate", reason: "teach_done" };
    // While teaching, each step is just followed; the skill is written when he says done.
    return { kind: "skip" };
  }
  const task = teachingTask(text);
  if (task) return { kind: "teach_start", task };
  if (isExplicitSkillAsk(text)) return { kind: "curate", reason: "explicit" };
  if (input.toolCalls + (input.priorToolCalls ?? 0) >= 1 && isProcedureCorrection(text))
    return { kind: "curate", reason: "correction" };
  if (input.toolCalls >= input.minToolCalls) return { kind: "curate", reason: "iterative" };
  return { kind: "skip" };
}
