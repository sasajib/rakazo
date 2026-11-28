/**
 * Fork (FORK.md 1.32, L2): the part of a task that is sent to the embeddings endpoint.
 *
 * The endpoint's time grows with the text: measured on bee (bge-m3) 60 characters 65-160 ms,
 * 400 about 190 ms, 600 270-530 ms, 3000 1.6-4.1 s. The whole task (up to 8000 characters) was
 * sent with a 700 ms limit, so every helper brief, delegated request and continuation brief
 * waited the full limit and then matched by words only. What a task is about is said at its
 * start and in its headings, so that is what is embedded: at most TASK_DIGEST_MAX_CHARS.
 *
 *   - a task that fits is sent whole, unchanged;
 *   - otherwise its opening lines (about two thirds of the digest), then its signposts in order: headings, the
 *     line a label introduces ("Task:" + the next line), and the start of each list item.
 * Lines that are only markup are skipped. Pure: the same text always gives the same digest, so
 * the vector can be cached by it.
 */
import { BACKGROUND_HELPER_TRIGGER } from "@rakazo/core";
import { helperTaskOf } from "../tasks/background-helpers.prompt.js";

export const TASK_DIGEST_MAX_CHARS = 400;
/** The opening's share of the digest; the rest is for signposts further down. */
const OPENING_SHARE = 0.65;
const SIGNPOST_CHARS = 90;

const ONLY_MARKUP = /^(?:[-=*_`~#>|\s]+|<\/?[\w:-]+(?:\s[^>]*)?>)$/;
const HEADING = /^#{1,6}\s+(.+)$/;
const BOLD_LINE = /^\*\*(.+?)\*\*:?$/;
const LIST_ITEM = /^(?:\d+[.)]|[-*\u2022])\s+(.+)$/;
const LABEL = /^.{2,80}:$/;

/** Cuts at a word boundary when one is near the limit. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const space = head.lastIndexOf(" ");
  return (space > max * 0.6 ? head.slice(0, space) : head).trimEnd();
}

export function taskDigest(task: string, max = TASK_DIGEST_MAX_CHARS): string {
  const text = task.trim();
  if (text.length <= max) return text;
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !ONLY_MARKUP.test(line));
  const parts: string[] = [];
  let used = 0;
  const add = (piece: string, limit: number): boolean => {
    const room = Math.min(limit, max - used - (parts.length ? 1 : 0));
    if (room < 12) return false;
    const taken = cut(piece, room);
    if (!taken) return false;
    parts.push(taken);
    used += taken.length + (parts.length > 1 ? 1 : 0);
    return true;
  };
  const opening = Math.round(max * OPENING_SHARE);
  let index = 0;
  while (index < lines.length && used < opening) {
    if (!add(lines[index]!, opening - used)) break;
    index += 1;
  }
  let afterLabel = false;
  for (; index < lines.length && used < max; index += 1) {
    const line = lines[index]!;
    const signpost =
      HEADING.exec(line)?.[1] ?? BOLD_LINE.exec(line)?.[1] ?? LIST_ITEM.exec(line)?.[1];
    if (signpost) add(signpost, SIGNPOST_CHARS);
    else if (afterLabel) add(line, SIGNPOST_CHARS);
    afterLabel = LABEL.test(line);
  }
  return parts.join("\n");
}

/**
 * The part of a run's task that states the work, when the platform wrapped it: a helper's task
 * opens with the same paragraphs for every helper and names the work last.
 */
export function taskFocus(trigger: string, task: string): string {
  return trigger === BACKGROUND_HELPER_TRIGGER ? helperTaskOf(task) : task;
}
