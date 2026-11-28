/**
 * Fork (FORK.md 1.42): route a person's message into a chat where the agent has work in flight.
 *
 * Inside the send transaction (`holdMessageForRouting`): the message is saved as steering of the
 * most recent task (what an unsure message defaults to), held (`steering_messages.routeHeldUntil`)
 * so no run reads it yet, and nothing is retired or cancelled. After the commit
 * (`routeHeldMessage`, not awaited by the send): the judge decides what the message means and the
 * route is applied in one transaction:
 *   - addition: the hold is lifted (the task reads it at its next step) and, when it asks for more
 *     work, an open-work item is recorded for the task's chat (1.33), so it is not lost if the run
 *     ends first; a talk run answers beside a busy run as before;
 *   - answer: the waiting question is answered with the message and its run resumes;
 *   - override: the task is stopped (the supersede machinery of 1.20) and the message starts a run
 *     in its place; the person is told in one line what was stopped;
 *   - new task: a run of its own (`runs.chatTask`) starts beside the others, or waits in line when
 *     the chat already has `CHAT_CONCURRENT_TASKS_MAX` tasks working (the person is told).
 * Every decision is logged as `message.routed` (intent, basis, ms, run ids, never text).
 */
import type { JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import type { RoutingConfig } from "@rakazo/adapters";
import {
  cancelReplacedRequest,
  finishReplacedRequest,
  judgeMessageRoute,
  routingConfig,
  wakeRun,
} from "@rakazo/adapters";
import type { Actor, MessageBlock } from "@rakazo/contracts";
import type { RouteDecision, RouteTask } from "@rakazo/core";
import {
  ACTIVE_RUN_STATUSES,
  BACKGROUND_HELPER_TRIGGER,
  certainRoute,
  decideMessageRoute,
  isConversationalRun,
  overrideNotice,
  queuedTaskNotice,
  repliedTask,
  routingJudgeInput,
  TALK_RUN_TRIGGER,
  taskKeys,
  taskTitle,
} from "@rakazo/core";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  answerWaitingRunWithTextInTransaction,
  appendEventInTransaction,
  contentEncryptionOf,
  createThreadMessageInTransaction,
  eligibleWaitingTextAnswer,
  pendingQuestionOf,
  readMessageBlocks,
  retireWaitingQuestionInTransaction,
  THREAD_LOCK_TRANSACTION_OPTIONS,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/** Runs of the sender's that count as tasks in flight in the chat. */
export type InFlightRun = {
  id: string;
  taskId: string;
  status: string;
  trigger: string;
  userId: string;
  startedAt: Date | null;
  createdAt: Date;
};

/** A run that is a task the person's message may be about. */
export function isRoutableTask(run: InFlightRun, actor: Pick<Actor, "userId">): boolean {
  return (
    run.userId === actor.userId &&
    (ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status) &&
    run.trigger !== TALK_RUN_TRIGGER &&
    run.trigger !== BACKGROUND_HELPER_TRIGGER &&
    run.trigger !== "created"
  );
}

function textOf(blocks: readonly MessageBlock[]): string {
  return blocks
    .flatMap((block) => (block.kind === "text" ? [block.text] : []))
    .join("\n")
    .trim();
}

function stateOf(
  run: InFlightRun,
  question: Awaited<ReturnType<typeof pendingQuestionOf>>,
): RouteTask["state"] {
  if (run.status === "waiting_input")
    return question?.kind === "question" ? "waiting_question" : "waiting_approval";
  if (run.status === "waiting_takeover") return "waiting_takeover";
  return run.status === "queued" && !run.startedAt ? "queued" : "working";
}

/** The tasks in flight, as the router and the judge see them. */
export async function loadRouteTasks(
  tx: Prisma.TransactionClient | PrismaClient,
  input: { threadId: string; runs: readonly InFlightRun[] },
): Promise<RouteTask[]> {
  if (!input.runs.length) return [];
  const tasks = await tx.task.findMany({
    where: { id: { in: input.runs.map((run) => run.taskId) } },
    select: { id: true, prompt: true },
  });
  const prompts = new Map(tasks.map((task) => [task.id, task.prompt]));
  const out: RouteTask[] = [];
  for (const run of input.runs) {
    const question =
      run.status === "waiting_input"
        ? await pendingQuestionOf(tx as Prisma.TransactionClient, {
            threadId: input.threadId,
            runId: run.id,
          })
        : null;
    const written = await tx.message.findMany({
      where: { threadId: input.threadId, runId: run.id, role: "bot" },
      orderBy: { seq: "desc" },
      take: 20,
      select: { id: true, blocks: true },
    });
    const progress = written
      .map((message) => textOf(readMessageBlocks(message).blocks))
      .find(Boolean);
    const request = prompts.get(run.taskId) ?? "";
    out.push({
      runId: run.id,
      taskId: run.taskId,
      state: stateOf(run, question),
      title: taskTitle(request),
      request,
      progress: progress ? progress.split(/\r?\n/).filter(Boolean).slice(-1)[0] : undefined,
      question:
        question?.kind === "question"
          ? { messageId: question.messageId, text: question.text, options: question.options }
          : undefined,
      messageIds: written.map((message) => message.id),
      steerable: isConversationalRun(run.trigger),
      createdAt: run.createdAt,
    });
  }
  return out;
}

/** What the send transaction saved for the router to finish. */
export interface HeldRoute {
  messageId: string;
  text: string;
  replyToMessageId?: string | undefined;
  /** The task the message waits on until it is routed (the safe default). */
  defaultRunId: string;
  /** The run's prompt if the message starts a task of its own (the send's prompt). */
  prompt: string;
  hasAttachments: boolean;
  heldUntil: Date;
  /**
   * The waiting task this message would answer by upstream's own rule (the message right after
   * its question): what an unsettled route falls back to instead of an addition, since that only
   * resumes the task with the person's words.
   */
  fallbackAnswerRunId?: string | undefined;
}

/**
 * Inside the send transaction: decide the certainties, else save the message as held steering of
 * the most recent task. Returns the certain answer (the caller answers it as before) or the hold.
 */
export async function holdMessageForRouting(
  tx: Prisma.TransactionClient,
  input: {
    actor: Actor;
    botId: string;
    threadId: string;
    message: { id: string; seq: number };
    text: string;
    replyToMessageId?: string | undefined;
    runs: readonly InFlightRun[];
    prompt: string;
    hasAttachments: boolean;
    config?: RoutingConfig;
  },
): Promise<
  | { kind: "certain"; decision: RouteDecision; questionMessageId?: string | undefined }
  | { kind: "held"; held: HeldRoute; run: InFlightRun }
  | null
> {
  const config = input.config ?? routingConfig();
  // Hand-rolled transaction doubles in unit tests carry only the delegates the old path used;
  // a real client always has these, so routing never skips itself in the product.
  if (
    typeof tx.task?.findMany !== "function" ||
    typeof tx.message?.findMany !== "function" ||
    typeof tx.steeringMessage?.create !== "function"
  )
    return null;
  // A run waiting on an approval, a secret or a login card is never a task a chat message reaches
  // (the card is answered on the card); with one of those only, the send keeps its old path,
  // where the message starts a run of its own and the card stays.
  const tasks = (await loadRouteTasks(tx, { threadId: input.threadId, runs: input.runs })).filter(
    (task) => task.state !== "waiting_approval",
  );
  if (!tasks.length) return null;
  const certain = certainRoute({
    text: input.text,
    replyToMessageId: input.replyToMessageId,
    tasks,
  });
  if (certain) {
    const asked = tasks.find((task) => task.runId === certain.targetRunId);
    return { kind: "certain", decision: certain, questionMessageId: asked?.question?.messageId };
  }
  const pinned = repliedTask(tasks, input.replyToMessageId);
  const fallback =
    pinned ??
    [...tasks].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.runId.localeCompare(a.runId),
    )[0];
  const run = fallback
    ? input.runs.find((candidate) => candidate.id === fallback.runId)
    : undefined;
  if (!fallback || !run) return null;
  const heldUntil = new Date(Date.now() + config.judgeTimeoutMs + 2_000);
  let fallbackAnswerRunId: string | undefined;
  for (const task of tasks) {
    if (!task.question || fallbackAnswerRunId) continue;
    const eligible = await eligibleWaitingTextAnswer(tx, {
      spaceId: input.actor.spaceId,
      threadId: input.threadId,
      runId: task.runId,
      answeredByUserId: input.actor.userId,
      answer: input.text,
      beforeMessageSeq: input.message.seq,
      answerMessageId: input.message.id,
    });
    if (eligible) fallbackAnswerRunId = task.runId;
  }
  await tx.steeringMessage.create({
    data: {
      messageId: input.message.id,
      botId: input.botId,
      userId: input.actor.userId,
      // A run that cannot take steering (another agent's request, a routine) leaves it pending for
      // the conversation that follows it, as before.
      runId: fallback.steerable ? fallback.runId : null,
      routeHeldUntil: heldUntil,
    },
  });
  return {
    kind: "held",
    run,
    held: {
      messageId: input.message.id,
      text: input.text,
      replyToMessageId: input.replyToMessageId,
      defaultRunId: fallback.runId,
      prompt: input.prompt,
      hasAttachments: input.hasAttachments,
      heldUntil,
      fallbackAnswerRunId,
    },
  };
}

/** Routes still being decided, so tests (and a graceful shutdown) can wait for them. */
const pendingRoutes = new Set<Promise<unknown>>();

export async function settleMessageRoutes(): Promise<void> {
  while (pendingRoutes.size) await Promise.allSettled([...pendingRoutes]);
}

export interface RouteDeps {
  prisma: PrismaClient;
  events: ThreadEvents;
  jobs: JobPublisher;
  sandbox?: SandboxProvider;
}

export interface RouteResult {
  decision: RouteDecision;
  /** Runs the route started or resumed. */
  startedRunIds: string[];
  stoppedRunId?: string | undefined;
  queuedPosition?: number | undefined;
  /** For a talk run beside an addition: created by the caller's hook. */
  ms: number;
}

/** After the commit: judge the held message and apply the route. Never throws. */
export function scheduleMessageRoute(
  deps: RouteDeps,
  input: Parameters<typeof routeHeldMessage>[1],
  hooks: Parameters<typeof routeHeldMessage>[2] = {},
): Promise<RouteResult | undefined> {
  const routed = routeHeldMessage(deps, input, hooks).catch((error: unknown) => {
    getLogger().error("message.route_failed", error, {
      "message.id": input.held.messageId,
      "thread.id": input.threadId,
    });
    return undefined;
  });
  pendingRoutes.add(routed);
  void routed.finally(() => pendingRoutes.delete(routed));
  return routed;
}

async function recentTurns(prisma: PrismaClient, threadId: string, beforeMessageId: string) {
  const rows = await prisma.message.findMany({
    where: { threadId, role: { in: ["user", "bot"] }, id: { not: beforeMessageId } },
    orderBy: { seq: "desc" },
    take: 8,
    select: { id: true, role: true, blocks: true },
  });
  return rows
    .reverse()
    .map((row) => ({
      role: row.role === "user" ? ("person" as const) : ("agent" as const),
      text: textOf(readMessageBlocks(row).blocks),
    }))
    .filter((turn) => turn.text);
}

export async function routeHeldMessage(
  deps: RouteDeps,
  input: {
    actor: Actor;
    botId: string;
    threadId: string;
    held: HeldRoute;
    config?: RoutingConfig;
    /** Test seam: the judge's answer. */
    judge?: typeof judgeMessageRoute;
  },
  hooks: {
    /** Answer beside a busy task, as the send did before routing (thread-target's talk lane). */
    talkBeside?: (tx: Prisma.TransactionClient, run: InFlightRun) => Promise<{ id: string } | null>;
    releaseTakeover?: (runId: string) => Promise<void>;
  } = {},
): Promise<RouteResult | undefined> {
  const started = Date.now();
  const config = input.config ?? routingConfig();
  const { actor, held } = input;
  await contentEncryptionOf(deps.prisma)?.ring.all(actor.spaceId);
  const runs = await deps.prisma.run.findMany({
    where: {
      threadId: input.threadId,
      botId: input.botId,
      userId: actor.userId,
      status: { in: [...ACTIVE_RUN_STATUSES] },
    },
    select: {
      id: true,
      taskId: true,
      status: true,
      trigger: true,
      userId: true,
      startedAt: true,
      createdAt: true,
    },
  });
  const inFlight = runs.filter((run) => isRoutableTask(run, actor));
  const tasks = await loadRouteTasks(deps.prisma, { threadId: input.threadId, runs: inFlight });
  const pinned = repliedTask(tasks, held.replyToMessageId);
  const keys = taskKeys(tasks);
  const keyOf = (runId: string | undefined) =>
    [...keys].find(([, task]) => task.runId === runId)?.[0];
  const replyText = held.replyToMessageId
    ? await deps.prisma.message
        .findFirst({
          where: { id: held.replyToMessageId, threadId: input.threadId },
          select: { id: true, blocks: true },
        })
        .then((row) => (row ? textOf(readMessageBlocks(row).blocks) : undefined))
    : undefined;
  const judged = tasks.length
    ? await (input.judge ?? judgeMessageRoute)(
        routingJudgeInput({
          message: held.text,
          replyTo: held.replyToMessageId
            ? { taskKey: keyOf(pinned?.runId), text: replyText }
            : undefined,
          tasks,
          recentTurns: await recentTurns(deps.prisma, input.threadId, held.messageId),
        }),
        config,
      )
    : { answer: "off" as const, ms: 0 };
  const decision = tasks.length
    ? decideMessageRoute({
        tasks,
        judged: judged.answer,
        pinnedRunId: pinned?.runId,
        minConfidence: config.minConfidence,
        overrideMinConfidence: config.overrideMinConfidence,
        replaceMinConfidence: config.replaceMinConfidence,
      })
    : ({
        intent: "addition",
        targetRunId: held.defaultRunId,
        basis: "judge_off",
        addsRequirement: false,
      } satisfies RouteDecision);
  // Nothing settled it, and it is the reply right after a waiting question: it answers that
  // question, as it always did (the task resumes with it; nothing is stopped).
  const unsettled = [
    "judge_off",
    "judge_timeout",
    "judge_error",
    "judge_invalid",
    "judge_low_confidence",
  ];
  const settled: RouteDecision =
    held.fallbackAnswerRunId && unsettled.includes(decision.basis) && decision.intent === "addition"
      ? {
          ...decision,
          intent: "answer",
          targetRunId: held.fallbackAnswerRunId,
          basis: decision.basis,
          addsRequirement: false,
        }
      : decision;
  const applied = await applyRoute(deps, input, settled, tasks, inFlight, hooks);
  const ms = Date.now() - started;
  getLogger().info("message.routed", {
    "message.id": held.messageId,
    "thread.id": input.threadId,
    "bot.id": input.botId,
    "route.intent": applied.decision.intent,
    "route.action": applied.decision.action,
    "route.basis": applied.decision.basis,
    "route.confidence": applied.decision.confidence,
    "route.reason": applied.decision.reason,
    "route.target_run_id": applied.decision.targetRunId ?? undefined,
    "route.default_run_id": held.defaultRunId,
    "route.started_run_ids": applied.startedRunIds.join(",") || undefined,
    "route.stopped_run_id": applied.stoppedRunId,
    "route.queued_position": applied.queuedPosition,
    "route.tasks": tasks.length,
    "route.judge_ms": judged.ms,
    "route.judge_model": "model" in judged ? judged.model : undefined,
    "route.ms": ms,
  });
  for (const id of applied.wake) await wakeRun(deps.jobs, id);
  if (applied.releaseTakeoverRunId && hooks.releaseTakeover)
    await hooks.releaseTakeover(applied.releaseTakeoverRunId).catch(() => undefined);
  if (applied.superseded)
    await finishReplacedRequest(
      { prisma: deps.prisma, sandbox: deps.sandbox },
      actor,
      applied.superseded,
    );
  if (applied.eventSeq !== undefined) {
    await deps.events.notify(input.threadId, applied.eventSeq);
    await deps.events.publishSpaceChange?.(actor.spaceId, "runs");
  }
  return {
    decision: applied.decision,
    startedRunIds: applied.startedRunIds,
    stoppedRunId: applied.stoppedRunId,
    queuedPosition: applied.queuedPosition,
    ms,
  };
}

async function postSystemLine(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; threadId: string; botId: string; text: string },
) {
  const blocks: MessageBlock[] = [{ kind: "meta", text: input.text }];
  const message = await createThreadMessageInTransaction(tx, {
    threadId: input.threadId,
    role: "system",
    blocks,
    botId: input.botId,
    markUnread: false,
  });
  return appendEventInTransaction(tx, {
    spaceId: input.spaceId,
    threadId: input.threadId,
    botId: input.botId,
    type: "thread.message.created",
    payload: { messageId: message.id, role: "system", blocks },
  });
}

/** The prompt of the run that replaces an overridden task: what was stopped, then the message. */
export function overridePrompt(stopped: Pick<RouteTask, "title" | "request">, prompt: string) {
  const request = stopped.request.replace(/\s+/g, " ").trim().slice(0, 1_500);
  return [
    `[The person changed the task "${stopped.title}" with this message, so its run was stopped. Do the`,
    "task again as the message now asks: start from what that task already did where it still",
    `fits, and redo what the message changes. The task's request was: ${request}]`,
    "",
    prompt,
  ].join("\n");
}

async function applyRoute(
  deps: RouteDeps,
  input: Parameters<typeof routeHeldMessage>[1],
  decided: RouteDecision,
  tasks: readonly RouteTask[],
  inFlight: readonly InFlightRun[],
  hooks: Parameters<typeof routeHeldMessage>[2],
) {
  const config = input.config ?? routingConfig();
  const { actor, held } = input;
  type Applied = {
    decision: RouteDecision;
    startedRunIds: string[];
    wake: string[];
    stoppedRunId?: string;
    queuedPosition?: number;
    eventSeq?: number;
    releaseTakeoverRunId?: string;
    superseded?: Awaited<ReturnType<typeof cancelReplacedRequest>>;
  };
  const commit = () =>
    deps.prisma.$transaction(async (tx): Promise<Applied> => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
      let decision = decided;
      const steering = await tx.steeringMessage.findUnique({
        where: { messageId_botId: { messageId: held.messageId, botId: input.botId } },
        select: { id: true, runId: true, claimedAt: true },
      });
      // Already read by a run (the hold ran out first), or the chat was stopped or cleared: it
      // stays where it went, as an addition.
      if (!steering || steering.claimedAt) {
        return {
          decision: { ...decision, intent: "addition", basis: "late" },
          startedRunIds: [],
          wake: [],
        };
      }
      const target = tasks.find((task) => task.runId === decision.targetRunId);
      const targetRun = inFlight.find((run) => run.id === decision.targetRunId);
      const live = target
        ? await tx.run.findUnique({ where: { id: target.runId }, select: { status: true } })
        : null;
      const targetLive = live && (ACTIVE_RUN_STATUSES as readonly string[]).includes(live.status);
      // A task that ended while the judge thought: an override or an answer has nothing to act on,
      // so the message starts its own run (it is the person's latest word on that task).
      if (
        (decision.intent === "override" || decision.intent === "answer") &&
        (!target || !targetLive)
      ) {
        decision = { ...decision, intent: "new_task", basis: "late" };
      }
      // An override that only redirects the task steers it (nothing stopped); a task waiting on a
      // question takes it as the answer, so it resumes with the new direction.
      const redirect = decision.intent === "override" && decision.action !== "replace";
      if (
        (decision.intent === "answer" || redirect) &&
        target?.question &&
        live?.status === "waiting_input"
      ) {
        const answered = await answerWaitingRunWithTextInTransaction(tx, {
          spaceId: actor.spaceId,
          threadId: input.threadId,
          runId: target.runId,
          answeredByUserId: actor.userId,
          answer: held.text,
          messageId: target.question.messageId,
          answerMessageId: held.messageId,
        });
        if (answered) {
          await tx.message.update({ where: { id: held.messageId }, data: { runId: target.runId } });
          if (held.hasAttachments)
            await tx.steeringMessage.update({
              where: { id: steering.id },
              data: { runId: target.runId, routeHeldUntil: null },
            });
          else await tx.steeringMessage.delete({ where: { id: steering.id } });
          return {
            decision,
            startedRunIds: [target.runId],
            wake: [target.runId],
            eventSeq: answered.seq,
          };
        }
        if (!redirect) decision = { ...decision, intent: "addition", basis: "judge_invalid" };
      }
      if (decision.intent === "addition" || decision.intent === "answer" || redirect) {
        const steerTo = target?.steerable && targetLive ? target.runId : steering.runId;
        await tx.steeringMessage.update({
          where: { id: steering.id },
          data: { runId: steerTo, routeHeldUntil: null },
        });
        if (steerTo)
          await tx.message.update({ where: { id: held.messageId }, data: { runId: steerTo } });
        let eventSeq: number | undefined;
        if (config.additionOpenItem && decision.addsRequirement && target && targetLive) {
          const run = await tx.run.findUnique({
            where: { id: target.runId },
            select: { spaceId: true, botId: true, userId: true },
          });
          if (run) {
            await tx.scratchpadItem.create({
              data: {
                spaceId: run.spaceId,
                botId: run.botId,
                userId: run.userId,
                threadId: input.threadId,
                title: `Added to "${target.title}": ${taskTitle(held.text, 120)}`,
                notes: `The person added this to the task in message ${held.messageId.slice(0, 8)}; close it when done.`,
                status: "open",
              },
            });
          }
        }
        // A busy task, or one waiting on its question, answers the person beside it at once.
        const talk =
          targetRun &&
          hooks?.talkBeside &&
          targetLive &&
          (target?.state === "working" || target?.state === "waiting_question")
            ? await hooks.talkBeside(tx, targetRun)
            : null;
        return {
          decision,
          startedRunIds: talk ? [talk.id] : [],
          wake: talk ? [talk.id] : [],
          eventSeq,
          releaseTakeoverRunId:
            target?.state === "waiting_takeover" && steerTo === target.runId
              ? target.runId
              : undefined,
        };
      }
      // A new run for the message: an override's replacement or a new task.
      let superseded: Applied["superseded"];
      let stoppedRunId: string | undefined;
      let prompt = held.prompt;
      if (decision.intent === "override" && target) {
        const now = new Date();
        const question = target.question;
        const retired =
          question && live?.status === "waiting_input"
            ? await retireWaitingQuestionInTransaction(tx, {
                spaceId: actor.spaceId,
                threadId: input.threadId,
                botId: input.botId,
                runId: target.runId,
                answer: held.text,
                answerMessageId: held.messageId,
              })
            : false;
        if (!retired) {
          const run = await tx.run.findUnique({
            where: { id: target.runId },
            select: { id: true, status: true, createdAt: true, trigger: true },
          });
          if (run)
            superseded = await cancelReplacedRequest(tx, {
              spaceId: actor.spaceId,
              targetThreadId: input.threadId,
              targetBotId: input.botId,
              run,
              summary: target.title,
              now,
            });
          // A stopped request from another agent still tells that agent (1.39).
          if (superseded && run?.trigger === "bot_message")
            await tx.run.update({
              where: { id: run.id },
              data: { botOutcomeReturnedAt: null },
            });
        }
        stoppedRunId = retired || superseded ? target.runId : undefined;
        if (stoppedRunId) {
          await tx.task.updateMany({
            where: {
              id: target.taskId,
              runs: { none: { status: { in: [...ACTIVE_RUN_STATUSES] } } },
            },
            data: { status: "cancelled" },
          });
          await postSystemLine(tx, {
            spaceId: actor.spaceId,
            threadId: input.threadId,
            botId: input.botId,
            text: overrideNotice(target.title),
          });
        }
        prompt = overridePrompt(target, held.prompt);
      }
      // Others still in flight: this run is a task beside them, quoted in its replies.
      const others = await tx.run.findMany({
        where: {
          threadId: input.threadId,
          botId: input.botId,
          status: { in: [...ACTIVE_RUN_STATUSES] },
          trigger: { notIn: [TALK_RUN_TRIGGER, BACKGROUND_HELPER_TRIGGER] },
          ...(stoppedRunId ? { id: { not: stoppedRunId } } : {}),
        },
        select: { id: true, status: true, startedAt: true, chatTask: true, createdAt: true },
      });
      const concurrent = config.concurrentTasks && others.length > 0;
      const working = others.filter((run) => run.status === "leased" || run.status === "running");
      const queuedBefore = others.filter((run) => run.status === "queued" && run.chatTask).length;
      const lineFull =
        concurrent && (working.length >= config.concurrentTasksMax || queuedBefore > 0);
      // The supersede above already cleared the stopped run's steering, this row with it.
      await tx.steeringMessage.deleteMany({ where: { id: steering.id } });
      const task = await tx.task.create({
        data: {
          spaceId: actor.spaceId,
          botId: input.botId,
          threadId: input.threadId,
          userId: actor.userId,
          prompt,
          status: "queued",
        },
      });
      const run = await tx.run.create({
        data: {
          spaceId: actor.spaceId,
          botId: input.botId,
          threadId: input.threadId,
          taskId: task.id,
          userId: actor.userId,
          status: "queued",
          trigger: "user",
          clientNonce: `route:${held.messageId}`,
          sourceMessageId: held.messageId,
          // Without concurrent tasks (switch off) it waits as a plain run of the chat.
          chatTask: concurrent,
        },
        select: { id: true },
      });
      await tx.message.update({ where: { id: held.messageId }, data: { runId: run.id } });
      const queuedPosition = lineFull ? queuedBefore + 1 : undefined;
      const lastEvent = lineFull
        ? await postSystemLine(tx, {
            spaceId: actor.spaceId,
            threadId: input.threadId,
            botId: input.botId,
            text: queuedTaskNotice(queuedBefore + 1, working.length),
          })
        : await appendEventInTransaction(tx, {
            spaceId: actor.spaceId,
            threadId: input.threadId,
            botId: input.botId,
            type: "thread.meta",
            runId: run.id,
            payload: { activity: { thinking: false } },
          }).catch(() => undefined);
      if (lineFull)
        getLogger().info("run.chat_task_queued", {
          "run.id": run.id,
          "thread.id": input.threadId,
          "bot.id": input.botId,
          "chat_tasks.position": queuedPosition,
          "chat_tasks.working": working.length,
        });
      return {
        decision,
        startedRunIds: [run.id],
        wake: [run.id],
        stoppedRunId,
        queuedPosition,
        eventSeq: lastEvent?.seq,
        superseded,
      };
    }, THREAD_LOCK_TRANSACTION_OPTIONS);
  return withTransactionRetry(commit);
}
