import type { PrismaClient } from "@rakazo/db";
import { readMessageBlocks } from "@rakazo/db";
import { DUPLICATE_THRESHOLD, textSimilarity } from "../memory/notice-ledger.js";

/** A bot's work queue is its open runs: what it is doing now and what waits behind it. */
export type QueueItem = {
  id: string;
  status: string;
  trigger: string;
  lane: string | null;
  ageSeconds: number;
  from: string;
  summary: string;
  text: string;
};

const OPEN = ["queued", "leased", "running", "waiting_input", "waiting_takeover"];
const SUMMARY_CHARS = 120;

export async function loadBotQueue(
  prisma: Pick<PrismaClient, "run">,
  input: { botId: string; now: Date; limit?: number },
): Promise<QueueItem[]> {
  const rows = await prisma.run.findMany({
    where: {
      botId: input.botId,
      status: { in: OPEN },
      trigger: { in: ["bot_message", "webhook", "routine", "user", "follow_up", "tickets"] },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: input.limit ?? 25,
    select: {
      id: true,
      status: true,
      trigger: true,
      lane: true,
      createdAt: true,
      sourceMessage: { select: { id: true, role: true, blocks: true } },
    },
  });
  return rows.map((row) => {
    let text = "";
    let from = row.trigger === "user" || row.trigger === "follow_up" ? "user" : row.trigger;
    if (row.sourceMessage) {
      const { blocks } = readMessageBlocks(row.sourceMessage as never);
      for (const block of blocks as Array<Record<string, unknown>>) {
        if (block.kind === "bot_message_received") {
          text = String(block.text ?? "");
          from = String(block.fromBotName ?? "a bot");
        } else if (block.kind === "text" && !text) {
          text = String(block.text ?? "");
        }
      }
    }
    return {
      id: row.id,
      status: row.status,
      trigger: row.trigger,
      lane: row.lane,
      ageSeconds: Math.max(0, Math.round((input.now.getTime() - row.createdAt.getTime()) / 1000)),
      from,
      summary: text.replace(/\s+/g, " ").trim().slice(0, SUMMARY_CHARS),
      text,
    };
  });
}

/** An open bot_message request that already says the same thing. */
export function findQueuedDuplicate(
  message: string,
  queue: readonly QueueItem[],
  lane: string | null = null,
): QueueItem | undefined {
  const wanted = message.replace(/\s+/g, " ").trim();
  if (!wanted) return undefined;
  return queue.find((item) => {
    if (item.trigger !== "bot_message" || !item.text) return false;
    const have = item.text.replace(/\s+/g, " ").trim();
    if (have === wanted) return true;
    // Near-identical text counts only inside the same lane: another lane is other work.
    return (
      lane !== null &&
      item.lane === lane &&
      wanted.length >= 30 &&
      textSimilarity(wanted, have) >= DUPLICATE_THRESHOLD
    );
  });
}

export function describeQueueItem(item: QueueItem): string {
  const mins = Math.round(item.ageSeconds / 60);
  return `${item.status === "queued" ? "waiting" : "working"} ${mins} min, ${item.lane ? `lane ${item.lane}, ` : ""}from ${item.from}`;
}
