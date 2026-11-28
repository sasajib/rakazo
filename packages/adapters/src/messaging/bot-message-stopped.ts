import type { JobPublisher } from "@rakazo/adapter-kit";
import { stuckWorkStatusMessages } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { botMessageStoppedText } from "./bot-message-stopped.prompt.js";
import { returnBotMessageOutcome } from "./bot-messages.js";

/**
 * Fork (1.39): a delegated request that was stopped still answers its requester.
 *
 * Upstream returns an outcome for a delegated (`bot_message`) run that completed, failed, or was
 * cancelled as stuck work. A run cancelled any other way returned nothing: the user pressing
 * Stop, and, less visibly, the user typing a message in the chat while the run waits on a
 * question it asked (`retireWaitingQuestionInTransaction` marks the question answered, cancels
 * the waiting run and lets a new run take the message). The requester had been told "Paused
 * until the user responds" and then never heard again, so it kept a request open that no run
 * would ever finish.
 *
 * The reconciler now also returns a short status for those runs, with the same delivery key
 * (`auto-outcome:<runId>`) and retry as every other outcome. A request replaced by its sender is already marked returned
 * (`bot-supersede.ts`) and stays silent. Only runs that ended in the last day are looked at, so
 * a deploy does not send notices for old history.
 *
 * On unless BOT_MESSAGE_STOP_NOTICE is "0" (also "false" / "off"), which restores upstream.
 */
export const BOT_MESSAGE_STOP_NOTICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function botMessageStopNoticeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env.BOT_MESSAGE_STOP_NOTICE ?? "").trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "off");
}

/**
 * Returns the stopped notice for delegated runs that were cancelled without one. A delivery that
 * fails moves the run to the back of the queue (its `updatedAt`), so it is tried again at the
 * next pass and never lost; `returnBotMessageOutcome` marks it returned when the requester is
 * gone or the run already sent a result itself.
 */
export async function returnStoppedBotMessageOutcomes(
  deps: { prisma: PrismaClient; jobs: JobPublisher; events: ThreadEvents },
  options: { now: Date; batchSize: number; report: (label: string, error: unknown) => void },
): Promise<number> {
  if (!botMessageStopNoticeEnabled()) return 0;
  const runs = await deps.prisma.run.findMany({
    // Stuck-work cancels keep upstream's own text and query.
    where: {
      AND: [
        { trigger: "bot_message" },
        { status: "cancelled" },
        { botOutcomeReturnedAt: null },
        {
          completedAt: {
            gte: new Date(options.now.getTime() - BOT_MESSAGE_STOP_NOTICE_WINDOW_MS),
          },
        },
        { OR: [{ error: null }, { error: { notIn: [...stuckWorkStatusMessages()] } }] },
      ],
    },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: options.batchSize,
    select: {
      id: true,
      spaceId: true,
      threadId: true,
      botId: true,
      userId: true,
      sourceMessageId: true,
      bot: { select: { name: true } },
    },
  });
  let returned = 0;
  for (const run of runs) {
    const ok = await returnBotMessageOutcome(
      deps,
      run,
      { id: run.botId, name: run.bot.name },
      botMessageStoppedText(run.id),
      "status",
      { forceUnread: true },
    ).catch((error) => {
      options.report("stopped bot message outcome", error);
      return false;
    });
    if (ok) {
      returned += 1;
      getLogger().info("bot_message.stopped_notice", {
        "run.id": run.id,
        "bot.id": run.botId,
        "thread.id": run.threadId,
      });
    } else {
      await deps.prisma.run.updateMany({
        where: { id: run.id, botOutcomeReturnedAt: null },
        data: { updatedAt: new Date() },
      });
    }
  }
  return returned;
}
