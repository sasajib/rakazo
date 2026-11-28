import { routingConfig } from "./routing-config.js";

/**
 * Fork (FORK.md 1.42): how many tasks of one agent work at once in one chat.
 *
 * A message routed as a NEW TASK starts its own run (`runs.chatTask`) beside the agent's other work
 * in the chat. Up to `CHAT_CONCURRENT_TASKS_MAX` tasks work at once there; a task beyond that waits
 * queued, oldest first, and the admission gate (`run-lifecycle.ts` `admissionHold`) starts it when
 * one finishes. Only chat tasks are ever held here: the person's first run, talk runs, helpers and
 * every other trigger keep their own rules.
 */
export type ChatTaskGateRun = {
  id: string;
  botId: string;
  threadId: string;
  taskId: string;
  trigger: string;
  chatTask: boolean;
  createdAt: Date;
};

/** Triggers that count as a task working in the chat. */
const TASK_TRIGGERS = new Set(["user", "follow_up", "messaging", "reaction", "helper_result"]);

export function countsAsChatTask(run: Pick<ChatTaskGateRun, "trigger" | "chatTask">): boolean {
  return run.chatTask || TASK_TRIGGERS.has(run.trigger);
}

/**
 * Why a queued chat task may not start yet, or undefined when it may. `active` are the agent's
 * leased/running runs, `queued` its queued chat tasks (any order).
 */
export function chatTaskBlock(
  candidate: ChatTaskGateRun,
  max: number,
  active: readonly ChatTaskGateRun[],
  queued: readonly ChatTaskGateRun[],
): string | undefined {
  if (!candidate.chatTask) return undefined;
  const working = active.filter(
    (run) =>
      run.id !== candidate.id &&
      run.threadId === candidate.threadId &&
      run.taskId !== candidate.taskId &&
      countsAsChatTask(run),
  );
  if (working.length >= Math.max(1, max)) return "chat tasks full";
  const older = queued.find(
    (run) =>
      run.id !== candidate.id &&
      run.chatTask &&
      run.threadId === candidate.threadId &&
      (run.createdAt.getTime() < candidate.createdAt.getTime() ||
        (run.createdAt.getTime() === candidate.createdAt.getTime() && run.id < candidate.id)),
  );
  return older ? "older chat task first" : undefined;
}

/** Position (1 = next) a new chat task takes in its chat's line, and how many work now. */
export function chatTaskLine(input: { max: number; workingInChat: number; queuedBefore: number }): {
  queued: boolean;
  position: number;
} {
  const queued = input.workingInChat >= Math.max(1, input.max) || input.queuedBefore > 0;
  return { queued, position: queued ? input.queuedBefore + 1 : 0 };
}

/**
 * Whether two runs of one agent in one chat are separate tasks that may write it at the same time
 * (`acquireComputerExecutionLease`'s one-writer rule). Only when at least one of them was started
 * as its own task and they serve different tasks; `CHAT_CONCURRENT_TASKS=0` keeps one writer.
 */
export function separateChatTasks(
  self: { taskId: string; chatTask: boolean } | null | undefined,
  writer: { taskId: string; chatTask: boolean },
  enabled: boolean = routingConfig().concurrentTasks,
): boolean {
  if (!enabled || !self) return false;
  return self.taskId !== writer.taskId && (self.chatTask || writer.chatTask);
}
