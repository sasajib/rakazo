import type { MessageBlock } from "@rakazo/contracts";
import {
  displayName,
  isBackgroundRunTrigger,
  isNeedsPersonBlock,
  isOpenNeedsPersonBlock,
} from "@rakazo/core";
import { messageReplyExcerpt } from "@rakazo/core/message-quote";
import { storedMessageBlocks } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "../executor/executor-deps.js";
import { notifyRun } from "./run-notifications.js";

/**
 * Fork (1.21). A run the person did not start (another agent's request, a background run) ends
 * without a "finished" notification, and its chat is one the person is not looking at. When such a
 * run leaves a card that still waits on them (an approval, a connection, a plan, a choice, any
 * kind in core's NEEDS_PERSON list), tell them once, the same way a question does.
 */
export function runIsOutOfSight(trigger: string): boolean {
  return trigger === "bot_message" || isBackgroundRunTrigger(trigger);
}

/** The cards this run posted that nobody has answered yet. */
export function openOwnerCards(
  messages: ReadonlyArray<{ blocks: readonly MessageBlock[] }>,
): MessageBlock[] {
  return messages.flatMap((message) =>
    message.blocks.filter((block) => isNeedsPersonBlock(block) && isOpenNeedsPersonBlock(block)),
  );
}

export function ownerCardNotification(botName: string, cards: readonly MessageBlock[]) {
  const [first] = cards;
  const label = first ? messageReplyExcerpt([first], "bot") : "";
  const more = cards.length > 1 ? ` (+${cards.length - 1} more)` : "";
  return {
    title: `${displayName(botName, "Bot")} needs you`,
    body: label
      ? `A card is waiting for you in this chat: ${label}${more}`
      : `A card is waiting for you in this chat${more}`,
  };
}

export async function notifyOpenOwnerCards(
  deps: ExecutorDeps,
  run: {
    id: string;
    spaceId: string;
    userId: string;
    botId: string;
    threadId: string;
    trigger: string;
  },
  bot: { id: string; name: string },
): Promise<number> {
  if (!runIsOutOfSight(run.trigger)) return 0;
  try {
    const rows = await deps.prisma.message.findMany({
      where: { runId: run.id, threadId: run.threadId, role: "bot" },
      orderBy: { seq: "asc" },
      select: { id: true, blocks: true },
    });
    const cards = openOwnerCards(rows.map((row) => ({ blocks: storedMessageBlocks(row) })));
    if (cards.length === 0) return 0;
    getLogger().info("run.owner_card_waiting", {
      "run.id": run.id,
      "run.trigger": run.trigger,
      "bot.id": run.botId,
      "thread.id": run.threadId,
      "card.count": cards.length,
      "card.kinds": [...new Set(cards.map((card) => card.kind))].join(","),
    });
    await notifyRun(deps, run, {
      kind: "help",
      ...ownerCardNotification(bot.name, cards),
      botId: bot.id,
      threadId: run.threadId,
    });
    return cards.length;
  } catch (error) {
    getLogger().error("owner card notification", error);
    return 0;
  }
}
