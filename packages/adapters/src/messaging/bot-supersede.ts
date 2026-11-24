/**
 * Fork: a correction replaces the request it corrects. `message_bot {replaces}` names an earlier
 * request this bot sent the same recipient (its request id from message_bot / bot_queue, an id
 * prefix, or "latest"); inside the delivery transaction the old request's run is cancelled when it
 * still waits, or stopped when it is already working (same mechanism as the owner's Stop: status
 * cancelled, the working run sees it within a second and stops; its computer work is torn down
 * after commit). The corrected request is then delivered as a new run that starts at once instead
 * of queueing behind the old one, and the recipient is told plainly which request it replaces.
 * Only the bot that sent the original request may replace it.
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
  | { ok: false; error: string }
> {
  const ref = input.ref.trim();
  const rows = await tx.run.findMany({
    where: { botId: input.targetBotId, trigger: "bot_message", status: { in: OPEN } },
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
  const wanted =
    ref.toLowerCase() === "latest"
      ? mine[0]
      : mine.find(
          ({ row }) =>
            row.id === ref ||
            row.sourceMessageId === ref ||
            (ref.length >= 6 && row.id.startsWith(ref)),
        );
  if (!wanted) {
    const others = rows.some(
      (row) => row.id === ref || (ref.length >= 6 && row.id.startsWith(ref)),
    );
    return {
      ok: false,
      error: others
        ? "Not replaced: that request was sent by another bot or by the owner; only its sender can replace it."
        : `Not replaced: no open request of yours to this bot matches "${ref}" (it may have finished). Look at bot_queue, or send the correction as a new request.`,
    };
  }
  return {
    ok: true,
    run: { id: wanted.row.id, status: wanted.row.status, createdAt: wanted.row.createdAt },
    summary: wanted.text.replace(/\s+/g, " ").trim().slice(0, 100),
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
