import { BACKGROUND_HELPER_TRIGGER, TALK_RUN_TRIGGER } from "@rakazo/core";
import { isUnattendedRun } from "../../memory/notice-ledger.js";

/**
 * Per-bot work queue admission. Concurrency used to be enforced only through the computer lease,
 * which upstream now takes on first computer use, so a bot working through MCP tools (the shared
 * browser) was never limited: four runs worked the same tabs at once and reported out of order.
 * A queued unattended run may now start only when:
 *  - the bot has a free slot (unattended work leaves one slot for people when concurrency >= 2),
 *  - for bot_message runs: no other active run holds its lane (no lane = its conversation), and no
 *    older queued bot_message run waits in the same lane (oldest first).
 * People's own runs, talk runs, helpers and call-end runs are never held.
 */
export type GateRun = {
  id: string;
  botId: string;
  threadId: string;
  trigger: string;
  lane: string | null;
  createdAt: Date;
};

const NEVER_HELD = new Set([TALK_RUN_TRIGGER, BACKGROUND_HELPER_TRIGGER, "call_end"]);

export function laneKey(run: Pick<GateRun, "lane" | "threadId">): string {
  return run.lane ? `lane:${run.lane}` : `thread:${run.threadId}`;
}

export function normalizeLane(raw: unknown): string | null {
  const lane = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return lane || null;
}

export function admissionBlock(
  candidate: GateRun,
  concurrency: number,
  active: readonly GateRun[],
  queued: readonly GateRun[],
): string | undefined {
  if (NEVER_HELD.has(candidate.trigger) || !isUnattendedRun(candidate.trigger)) return undefined;
  const others = active.filter((r) => r.id !== candidate.id && !NEVER_HELD.has(r.trigger));
  const slots = Math.max(1, Math.floor(concurrency));
  const limit = slots >= 2 ? slots - 1 : 1;
  if (others.length >= limit) return "no free slot";
  if (candidate.trigger !== "bot_message") return undefined;
  const key = laneKey(candidate);
  // Only other bots' requests hold a lane. A person's run in the same chat is the chat wait's
  // job (chat-wait.ts): holding it here too pushed the run's wake time back and queued a second
  // wake, so a reply waiting on the owner's run started late and out of order.
  if (others.some((r) => r.trigger === "bot_message" && laneKey(r) === key)) return "lane busy";
  const older = queued.find(
    (q) =>
      q.id !== candidate.id &&
      q.trigger === "bot_message" &&
      laneKey(q) === key &&
      (q.createdAt.getTime() < candidate.createdAt.getTime() ||
        (q.createdAt.getTime() === candidate.createdAt.getTime() && q.id < candidate.id)),
  );
  return older ? "older request first" : undefined;
}
