/**
 * Fork: the skill curator's entry points, one per upstream seam. Each is a no-op unless
 * SKILL_CURATOR is on, and none can fail or slow a run.
 *
 * - scheduleSkillCuration: the run-finished hook (run-complete.ts via run-hooks.ts).
 * - skillLearningPromptState + skillLearningInstruction: one line in the skills part of the
 *   prompt (run-assembly-records.ts / run-assembly-context.ts).
 */
import type { SkillLearningMode } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { runAsTenant } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { ledgerEnabled } from "../memory-ledger/config.js";
import { loadOwnerMessages } from "../memory-ledger/seams.js";
import type { CuratorConfig } from "./config.js";
import { curatorConfig } from "./config.js";
import type { CurateResult, CuratorDeps } from "./curator.js";
import {
  botRepliesSince,
  curate,
  effectiveMode,
  ownerMessagesSince,
  priorToolCalls,
} from "./curator.js";
import type { OutlineStep } from "./outline.js";
import type { CuratorJob, CuratorStore } from "./store.js";
import { createCuratorStore } from "./store.js";
import { classifyRun, teachingTask } from "./triggers.js";

export interface CuratedRun {
  runId: string;
  spaceId: string;
  userId: string;
  threadId: string;
  botId: string;
  botName: string | null;
  trigger: string;
  sourceMessageId: string | null;
  ownerStartedRun: boolean;
  messagingChannelRun: boolean;
}

const CURATED_TRIGGERS = new Set(["user", "follow_up"]);
const CATCH_UP_AFTER_MS = 10 * 60_000;
/** How long the curator waits for the ledger writer of the same run (dedupe needs its facts). */
const LEDGER_WAIT_MS = 45_000;

/** Owner-started chat runs with a message of his own; never routines, channels or talk runs. */
export function curatesFrom(run: CuratedRun): boolean {
  return (
    run.ownerStartedRun &&
    !run.messagingChannelRun &&
    Boolean(run.sourceMessageId) &&
    CURATED_TRIGGERS.has(run.trigger)
  );
}

export async function modeFor(
  store: CuratorStore,
  spaceId: string,
  botId: string | null,
): Promise<SkillLearningMode> {
  return effectiveMode(await store.modes(spaceId, botId));
}

async function waitForLedger(prisma: PrismaClient, spaceId: string, runId: string) {
  if (!ledgerEnabled()) return;
  const until = Date.now() + LEDGER_WAIT_MS;
  while (Date.now() < until) {
    const rows = await prisma
      .$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT "status" FROM "memory_ledger_jobs" WHERE "spaceId" = $1 AND "runId" = $2`,
        spaceId,
        runId,
      )
      .catch(() => [] as Array<{ status: string }>);
    const status = rows[0]?.status;
    if (status === "done" || status === "failed") return;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
}

/**
 * The run-finished hook: classify the run and, when it is worth it, queue and run the curator in
 * this process (tenant context). Returns at once and never throws.
 */
export function scheduleSkillCuration(
  deps: CuratorDeps,
  run: CuratedRun,
  outline: OutlineStep[],
  env: Record<string, string | undefined> = process.env,
): void {
  const config = curatorConfig(env);
  if (!config.enabled || !curatesFrom(run)) return;
  void runAsTenant({ spaceId: run.spaceId, userId: run.userId }, async () => {
    const store = createCuratorStore(deps.prisma);
    const mode = await modeFor(store, run.spaceId, run.botId);
    if (mode === "off") return;
    const source = await deps.prisma.message.findFirst({
      where: { id: run.sourceMessageId!, threadId: run.threadId },
      select: { seq: true },
    });
    if (!source) return;
    const owner = await loadOwnerMessages(deps.prisma, {
      threadId: run.threadId,
      userId: run.userId,
      sourceMessageId: run.sourceMessageId!,
    });
    const current = owner.filter((message) => message.current).map((message) => message.text);
    const teaching = await store.activeTeaching(run.spaceId, run.threadId, run.botId);
    const classification = classifyRun({
      current,
      toolCalls: outline.length,
      priorToolCalls: await priorToolCalls(deps.prisma, {
        threadId: run.threadId,
        botId: run.botId,
        beforeSeq: source.seq,
      }),
      minToolCalls: config.minToolCalls,
      teaching: Boolean(teaching),
    });
    if (classification.kind === "teach_start") {
      const session = await store.startTeaching({
        spaceId: run.spaceId,
        threadId: run.threadId,
        botId: run.botId,
        userId: run.userId,
        task: classification.task,
        startSeq: source.seq,
      });
      getLogger().info("skill.curator.teaching_started", {
        "run.id": run.runId,
        "skill.curator.session": session.id,
      });
    } else if (classification.kind === "teach_cancel" && teaching) {
      await store.endTeaching(run.spaceId, teaching.id, "cancelled");
      getLogger().info("skill.curator.teaching_cancelled", { "run.id": run.runId });
    } else if (classification.kind === "curate") {
      if (
        await store.claimJob({
          runId: run.runId,
          spaceId: run.spaceId,
          threadId: run.threadId,
          botId: run.botId,
          userId: run.userId,
          reason: classification.reason,
          outline,
        })
      ) {
        await runCuratorJob(
          deps,
          store,
          config,
          { ...run, reason: classification.reason, outline, attempts: 0 },
          run.botName,
        );
      }
    } else {
      getLogger().debug?.("skill.curator.skipped", { "run.id": run.runId });
    }
    for (const stale of await store.staleJobs(run.spaceId, CATCH_UP_AFTER_MS, 2)) {
      if (stale.userId !== run.userId || stale.runId === run.runId) continue;
      await runCuratorJob(deps, store, config, stale, null);
    }
  }).catch((error) => getLogger().error("skill.curator.schedule_failed", error));
}

/** One curator job: read its stretch of the chat, ask the model, apply. Marks the job. */
export async function runCuratorJob(
  deps: CuratorDeps,
  store: CuratorStore,
  config: CuratorConfig,
  job: CuratorJob,
  botName: string | null,
): Promise<CurateResult | undefined> {
  if (!job.botId) return undefined;
  if (!(await store.startJob(job.spaceId, job.runId))) return undefined;
  const started = Date.now();
  try {
    const mode = await modeFor(store, job.spaceId, job.botId);
    const name =
      botName ??
      (await deps.prisma.bot.findFirst({ where: { id: job.botId }, select: { name: true } }))
        ?.name ??
      null;
    const teaching =
      job.reason === "teach_done"
        ? await store.activeTeaching(job.spaceId, job.threadId, job.botId)
        : undefined;
    const run = await deps.prisma.run.findFirst({
      where: { id: job.runId },
      select: { sourceMessageId: true },
    });
    let messages: Awaited<ReturnType<typeof ownerMessagesSince>>;
    let fromSeq: number;
    if (teaching) {
      fromSeq = teaching.startSeq;
      messages = await ownerMessagesSince(deps.prisma, {
        threadId: job.threadId,
        userId: job.userId,
        fromSeq,
      });
    } else {
      if (!run?.sourceMessageId) {
        await store.finishJob(job.spaceId, job.runId, "failed", "source message gone");
        return undefined;
      }
      const owner = await loadOwnerMessages(deps.prisma, {
        threadId: job.threadId,
        userId: job.userId,
        sourceMessageId: run.sourceMessageId,
      });
      messages = owner.map(({ text, at, current }) => ({ text, at, current }));
      const source = await deps.prisma.message.findFirst({
        where: { id: run.sourceMessageId },
        select: { seq: true },
      });
      fromSeq = Math.max(0, (source?.seq ?? 0) - 6);
    }
    await waitForLedger(deps.prisma, job.spaceId, job.runId);
    const replies = await botRepliesSince(deps.prisma, {
      threadId: job.threadId,
      botId: job.botId,
      fromSeq,
      limit: teaching ? 12 : 4,
    });
    const result = await curate(deps, store, config, {
      job,
      botName: name,
      mode,
      messages,
      replies,
      ...(teaching ? { teachingTask: teaching.task } : {}),
    });
    if (teaching && result.outcome !== "failed")
      await store.endTeaching(job.spaceId, teaching.id, "saved");
    await store.finishJob(
      job.spaceId,
      job.runId,
      result.outcome === "failed" ? "failed" : "done",
      result.outcome === "failed" ? result.why : undefined,
    );
    getLogger().info("skill.curator.decided", {
      "run.id": job.runId,
      "skill.curator.reason": job.reason,
      "skill.curator.mode": mode,
      "skill.curator.outcome": result.outcome,
      "skill.curator.why": result.why ?? "",
      "skill.curator.action": result.action ?? "",
      "skill.curator.proposal": result.proposalId ?? "",
      "skill.curator.skill": result.skillId ?? "",
      "skill.curator.outline": job.outline.length,
      "skill.curator.messages": messages.length,
      "skill.curator.used_model": result.usedModel,
      "skill.curator.ms": Date.now() - started,
    });
    return result;
  } catch (error) {
    await store
      .finishJob(job.spaceId, job.runId, "failed", error instanceof Error ? error.message : "error")
      .catch(() => undefined);
    getLogger().error("skill.curator.failed", error, { "run.id": job.runId });
    return undefined;
  }
}

/**
 * "Save as skill" pressed in a teaching session: the same curator job, keyed by the session (no
 * run id of its own), run in the background. Returns false when no session is open.
 */
export async function saveTeachingAsSkill(
  deps: CuratorDeps,
  input: { spaceId: string; userId: string; threadId: string; botId: string },
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  const config = curatorConfig(env);
  const store = createCuratorStore(deps.prisma);
  const teaching = await store.activeTeaching(input.spaceId, input.threadId, input.botId);
  if (!teaching) return false;
  const job = {
    runId: `teach:${teaching.id}`,
    spaceId: input.spaceId,
    threadId: input.threadId,
    botId: input.botId,
    userId: input.userId,
    reason: "teach_done",
    outline: [] as OutlineStep[],
  };
  if (!(await store.claimJob(job))) return true;
  void runAsTenant({ spaceId: input.spaceId, userId: input.userId }, () =>
    runCuratorJob(deps, store, config, { ...job, attempts: 0 }, null),
  ).catch((error) => getLogger().error("skill.curator.teach_save_failed", error));
  return true;
}

// --- Prompt -------------------------------------------------------------------------------

export interface SkillLearningPromptState {
  mode: SkillLearningMode;
  teachingTask?: string;
}

/** Read once per run during assembly; undefined when the curator is off (no prompt change). */
export async function skillLearningPromptState(
  prisma: PrismaClient,
  run: { spaceId: string; threadId: string; botId: string },
  env: Record<string, string | undefined> = process.env,
): Promise<SkillLearningPromptState | undefined> {
  if (!curatorConfig(env).enabled) return undefined;
  try {
    const store = createCuratorStore(prisma);
    const [mode, teaching] = await Promise.all([
      modeFor(store, run.spaceId, run.botId),
      store.activeTeaching(run.spaceId, run.threadId, run.botId),
    ]);
    return { mode, ...(teaching ? { teachingTask: teaching.task } : {}) };
  } catch {
    return undefined;
  }
}

/**
 * The prompt line. Agents are told the curator exists (so they never claim a skill was saved
 * unless it was), and while a chat lesson is open (or this very message opens one) how to follow
 * it.
 */
export function skillLearningInstruction(
  state: SkillLearningPromptState | undefined,
  taskPrompt: string,
): string | undefined {
  if (!state) return undefined;
  const lines = [
    state.mode === "off"
      ? "Never say you saved something as a skill unless skill_create or skill_update succeeded in this run."
      : `Skill learning is on (${state.mode === "auto" ? "saved automatically" : "the owner keeps or discards each one on a card"}): after a run, the skill curator may write the owner's way of doing a task down as a skill. Say you saved a skill only when skill_create or skill_update succeeded in this run, or a "[skill curator: ... - saved]" line in this chat says so; never promise one.`,
  ];
  const task = state.teachingTask ?? (state.mode === "off" ? undefined : teachingTask(taskPrompt));
  if (task)
    lines.push(
      `The owner is teaching you how to ${JSON.stringify(task)} step by step in this chat. Do each step he gives with your tools, say briefly what you did, and ask only when a step is unclear. Do not write the skill yourself with skill_create: when he says he is done (for example "save as skill"), the skill curator turns this lesson into a skill for him to keep.`,
    );
  return lines.join(" ");
}
