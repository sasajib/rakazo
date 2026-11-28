import {
  ACTIVE_RUN_STATUSES,
  BACKGROUND_HELPER_TRIGGER,
  chatTasksInstruction,
  TALK_RUN_TRIGGER,
  taskTitle,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { routingConfig } from "./routing-config.js";

const STATE: Record<string, string> = {
  queued: "waiting to start",
  leased: "working",
  running: "working",
  waiting_input: "waiting on the person",
  waiting_takeover: "waiting on the person",
};

/**
 * Fork (FORK.md 1.42): the prompt line that names the task this run serves and the other tasks in
 * flight in its chat (titles only), so replies do not mix them up. Undefined with one task.
 */
export async function chatTasksPromptLine(
  prisma: Pick<PrismaClient, "run">,
  run: { id: string; threadId: string; botId: string; taskId: string },
  ownRequest: string,
): Promise<string | undefined> {
  if (!routingConfig().concurrentTasks) return undefined;
  const others = await prisma.run.findMany({
    where: {
      id: { not: run.id },
      threadId: run.threadId,
      botId: run.botId,
      taskId: { not: run.taskId },
      status: { in: [...ACTIVE_RUN_STATUSES] },
      trigger: { notIn: [TALK_RUN_TRIGGER, BACKGROUND_HELPER_TRIGGER] },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 6,
    select: { status: true, task: { select: { prompt: true } } },
  });
  return chatTasksInstruction({
    ownTitle: taskTitle(ownRequest),
    others: others.map((other) => ({
      title: taskTitle(other.task.prompt),
      state: STATE[other.status] ?? other.status,
    })),
  });
}
