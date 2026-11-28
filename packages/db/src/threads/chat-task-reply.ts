import type { ReplyPreview } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import { messageReplyPreview } from "@rakazo/core/message-quote";
import type { Prisma } from "../database/client.js";
import { readMessageBlocks } from "./message-blocks.js";
import { loadMessageAuthor } from "./messages.js";

/** `CHAT_CONCURRENT_TASKS=0` (FORK.md 1.42) turns the reply tags off with the concurrent tasks. */
function concurrentTasksOn(): boolean {
  const flag = process.env.CHAT_CONCURRENT_TASKS?.trim().toLowerCase();
  return !(flag === "0" || flag === "false" || flag === "off" || flag === "no");
}

/**
 * Fork (FORK.md 1.42): while two or more tasks of the agent work in one chat, each reply of a task's
 * run is shown as an answer to the person's message that started that task, so the chat shows which
 * task each reply belongs to. Nothing changes for a chat with one task.
 */
export async function chatTaskReplyTag(
  tx: Prisma.TransactionClient,
  run: { id: string; threadId: string; botId: string },
): Promise<{ replyToMessageId: string; replyPreview: ReplyPreview | null } | undefined> {
  if (!concurrentTasksOn()) return undefined;
  // Hand-rolled transaction doubles in unit tests carry no run delegate.
  if (typeof tx.run?.findUnique !== "function") return undefined;
  const own = await tx.run.findUnique({
    where: { id: run.id },
    select: { chatTask: true, taskId: true, sourceMessageId: true },
  });
  if (!own?.sourceMessageId) return undefined;
  const beside =
    own.chatTask ||
    (await tx.run.findFirst({
      where: {
        id: { not: run.id },
        threadId: run.threadId,
        botId: run.botId,
        chatTask: true,
        taskId: { not: own.taskId },
        status: { in: [...ACTIVE_RUN_STATUSES] },
      },
      select: { id: true },
    })) !== null;
  if (!beside) return undefined;
  const source = await tx.message.findFirst({
    where: { id: own.sourceMessageId, threadId: run.threadId, role: "user" },
    select: { id: true, blocks: true, authorUserId: true },
  });
  if (!source) return undefined;
  const { blocks, intact } = readMessageBlocks(source);
  const author = source.authorUserId ? await loadMessageAuthor(tx, source.authorUserId) : undefined;
  return {
    replyToMessageId: source.id,
    replyPreview: intact
      ? messageReplyPreview(blocks, "user", undefined, author ?? undefined)
      : null,
  };
}
