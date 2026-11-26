/**
 * Fork: a correction replaces the request it corrects. `message_bot {replaces}` names an earlier
 * request this bot sent the same recipient (its request id from message_bot / bot_queue, an id
 * prefix, or "latest"); inside the delivery transaction the old request's run is cancelled when it
 * still waits, or stopped when it is already working (same mechanism as the owner's Stop: status
 * cancelled, the working run sees it within a second and stops; its computer work is torn down
 * after commit). The corrected request is then delivered as a new run that starts at once instead
 * of queueing behind the old one, and the recipient is told plainly which request it replaces.
 * Only the bot that sent the original request may replace it.
 *
 * FORK.md 1.22: when the named request has already finished (or none of this sender's is open),
 * the correction is not refused: it is delivered as a new request, and both the recipient and the
 * sender are told the earlier one had finished.
 */
import type { SandboxProvider } from "@rakazo/adapter-kit";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  appendEventInTransaction,
  clearEndedRunState,
  expireComputerExecutionLeases,
  readMessageBlocks,
  transientRunEventsWhere,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { cancelComputerRunWork } from "../computers/computer-idle.js";
import { screenLeaseIdForRun } from "../computers/computer-lifecycle.js";
import { toComputerRef } from "../computers/screens/computer-support.js";

const OPEN = ["queued", "leased", "running", "waiting_input", "waiting_takeover"];
const ENDED = ["completed", "failed", "cancelled"];

export interface SupersededRequest {
  runId: string;
  /** Was it already working (stopped) or still waiting (cancelled)? */
  wasRunning: boolean;
  summary: string;
  ageSeconds: number;
  leases: Array<{ computerId: string; botId: string; runId: string; fence: number }>;
  computers: Array<{ id: string; homeKey: string; kind: string; providerRef: string | null }>;
  eventSeq: number;
}

/** Finds the request `ref` names among the recipient's open bot_message runs sent by `senderId`. */
export async function findReplaceableRequest(
  tx: Pick<Prisma.TransactionClient, "run">,
  input: { targetBotId: string; senderId: string; ref: string },
): Promise<
  | { ok: true; run: { id: string; status: string; createdAt: Date }; summary: string }
  /** Nothing open to replace: the correction goes out as a new request. `run` = the finished one. */
  | { ok: true; finished: true; run?: { id: string; status: string }; summary: string }
  | { ok: false; error: string }
> {
  const ref = input.ref.trim();
  const load = async (statuses: string[]) => {
    const rows = await tx.run.findMany({
      where: { botId: input.targetBotId, trigger: "bot_message", status: { in: statuses } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 30,
      select: {
        id: true,
        status: true,
        createdAt: true,
        sourceMessageId: true,
        sourceMessage: { select: { id: true, role: true, blocks: true } },
      },
    });
    const mine = rows.flatMap((row) => {
      if (!row.sourceMessage) return [];
      const { blocks } = readMessageBlocks(row.sourceMessage as never);
      const received = (blocks as Array<Record<string, unknown>>).find(
        (block) => block.kind === "bot_message_received",
      );
      if (!received || received.fromBotId !== input.senderId) return [];
      return [{ row, text: String(received.text ?? "") }];
    });
    const matches = (row: { id: string; sourceMessageId: string | null }) =>
      row.id === ref || row.sourceMessageId === ref || (ref.length >= 6 && row.id.startsWith(ref));
    return {
      wanted: ref.toLowerCase() === "latest" ? mine[0] : mine.find(({ row }) => matches(row)),
      // The reference names a request of this recipient that someone else sent.
      foreign: rows.some((row) => matches(row)) && !mine.some(({ row }) => matches(row)),
    };
  };
  const summaryOf = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 100);
  const open = await load(OPEN);
  if (open.wanted) {
    const { row, text } = open.wanted;
    return {
      ok: true,
      run: { id: row.id, status: row.status, createdAt: row.createdAt },
      summary: summaryOf(text),
    };
  }
  const notYours =
    "Not replaced: that request was sent by another bot or by the owner; only its sender can replace it.";
  if (open.foreign) return { ok: false, error: notYours };
  const ended = await load(ENDED);
  if (ended.wanted) {
    const { row, text } = ended.wanted;
    return {
      ok: true,
      finished: true,
      run: { id: row.id, status: row.status },
      summary: summaryOf(text),
    };
  }
  if (ended.foreign) return { ok: false, error: notYours };
  // "latest" with nothing earlier to correct is still a request worth delivering.
  if (ref.toLowerCase() === "latest") return { ok: true, finished: true, summary: "" };
  return {
    ok: false,
    error: `Not replaced: no request of yours to this bot matches "${ref}". Look at bot_queue, use replaces "latest", or send it as a new request without replaces.`,
  };
}

/** Cancels (queued) or stops (working) the replaced request, in the delivery transaction. */
export async function cancelReplacedRequest(
  tx: Prisma.TransactionClient,
  input: {
    spaceId: string;
    targetThreadId: string;
    targetBotId: string;
    run: { id: string; status: string; createdAt: Date };
    summary: string;
    now?: Date;
  },
): Promise<SupersededRequest | undefined> {
  const now = input.now ?? new Date();
  const cancelled = await tx.run.updateMany({
    where: { id: input.run.id, status: { in: OPEN } },
    // botOutcomeReturnedAt: the replaced request reports nothing back; its replacement does.
    data: { status: "cancelled", completedAt: now, botOutcomeReturnedAt: now },
  });
  if (cancelled.count !== 1) return undefined;
  await clearEndedRunState(tx, [input.run.id]);
  await tx.steeringMessage.deleteMany({ where: { runId: input.run.id } }).catch(() => undefined);
  const leases = await tx.computerExecutionLease.findMany({
    where: { runId: input.run.id },
    select: { computerId: true, botId: true, runId: true, fence: true },
  });
  const computers = leases.length
    ? await tx.computer.findMany({
        where: { id: { in: [...new Set(leases.map((lease) => lease.computerId))] } },
        select: { id: true, homeKey: true, kind: true, providerRef: true },
      })
    : [];
  await tx.event.deleteMany({ where: { ...transientRunEventsWhere(), runId: input.run.id } });
  const event = await appendEventInTransaction(tx, {
    spaceId: input.spaceId,
    threadId: input.targetThreadId,
    botId: input.targetBotId,
    type: "run.cancelled",
    runId: input.run.id,
    payload: { supersededBy: "correction" },
  });
  return {
    runId: input.run.id,
    wasRunning: input.run.status !== "queued",
    summary: input.summary,
    ageSeconds: Math.max(0, Math.round((now.getTime() - input.run.createdAt.getTime()) / 1000)),
    leases: leases.map((lease) => ({ ...lease, fence: Number(lease.fence) })),
    computers: computers as SupersededRequest["computers"],
    eventSeq: event.seq,
  };
}

/** What the recipient (and the sender's chat) reads above the corrected request. */
export function replacesPreface(
  replaced: Pick<SupersededRequest, "runId" | "wasRunning" | "summary">,
): string {
  return `This replaces my earlier request ${replaced.runId.slice(0, 8)} ("${replaced.summary}${replaced.summary.length >= 100 ? "…" : ""}"), which I ${
    replaced.wasRunning ? "stopped while you were working on it" : "cancelled before you started it"
  }. Do only this corrected request; drop the earlier one.`;
}

/** What the recipient reads above a correction whose earlier request had already ended. */
export function followsFinishedPreface(finished: {
  run?: { id: string; status: string };
  summary: string;
}): string {
  if (!finished.run) return "This corrects what I asked you earlier. Do this corrected request.";
  const quoted = finished.summary
    ? ` ("${finished.summary}${finished.summary.length >= 100 ? "…" : ""}")`
    : "";
  return `This corrects my earlier request ${finished.run.id.slice(0, 8)}${quoted}, which you already ${
    finished.run.status === "completed" ? "finished" : "ended"
  }. Do this corrected request now; where it differs from the earlier one, this one counts.`;
}

/** After commit: tear down the stopped run's computer work, like the owner's Stop. */
export async function finishReplacedRequest(
  deps: { prisma: PrismaClient; sandbox?: SandboxProvider },
  actor: { spaceId: string; userId: string },
  replaced: SupersededRequest,
): Promise<void> {
  try {
    const byId = new Map(replaced.computers.map((computer) => [computer.id, computer]));
    if (deps.sandbox) {
      for (const lease of replaced.leases) {
        const computer = byId.get(lease.computerId);
        if (!computer?.providerRef) continue;
        const context = {
          operationId: "supersede",
          traceId: "supersede",
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId: lease.botId,
          runId: lease.runId,
          screenLeaseId: screenLeaseIdForRun(lease as never, lease.runId),
          cancelRunWork: true,
          signal: new AbortController().signal,
        };
        const ref = toComputerRef(computer as never);
        await cancelComputerRunWork(
          deps.sandbox,
          ref,
          computer.id,
          lease.runId,
          context as never,
        ).catch(() => undefined);
        await deps.sandbox.releaseScreen?.(ref, context as never).catch(() => undefined);
      }
    }
    await expireComputerExecutionLeases(deps.prisma, { runId: { in: [replaced.runId] } });
  } catch (error) {
    getLogger().warn("bot_message.supersede_teardown_failed", { error: String(error) });
  }
}
