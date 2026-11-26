/**
 * Fork: plan confirmation. See packages/contracts/src/plans/plans.ts for the design.
 *
 * Seams (each a no-op when the agent's mode is Never ask):
 * - planPromptState (run-assembly-records.ts): reads the chat's latest plan for this agent, matches
 *   the owner's message to it (approve / change / reject), binds an approved plan to the run, and
 *   returns what the prompt says (planInstruction, joined to the skills line).
 * - plan_propose tool (run-tools-messaging.ts): posts the card; a trusted workflow is approved at
 *   once (status auto) and bound to the proposing run.
 * - planGateCheck / planGateForMessageBot (message_bot): an owner-started run may send another agent
 *   a request only under an approved plan: the plan bound to it, or (FORK.md 1.22) a plan of this
 *   chat that is still live and involves that agent, so the owner's corrections and follow-ups in
 *   later messages need no new card. Requests sent under a plan are recorded on it (recipients).
 * - decidePlan (API plans/decide): the card's Approve / Change / Reject.
 *
 * Tables are raw SQL (migrations 20270125090000_plan_confirm, 20270126090000_plan_coverage); every
 * query runs in the caller's tenant context.
 */
import { randomUUID } from "node:crypto";
import type {
  MessageBlock,
  PlanBlock,
  PlanDecidedVia,
  PlanMode,
  PlanStatus,
  PlanStep,
  PlanTrust,
} from "@rakazo/contracts";
import { DEFAULT_PLAN_MODE, DEFAULT_PLAN_TRUST_THRESHOLD } from "@rakazo/contracts";
import { resolveBotAddress } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  appendEventInTransaction,
  changeMessageBlocks,
  createThreadMessageInTransaction,
  readMessageBlocks,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { PlanReplyIntent } from "./intent.js";
import { planReplyIntent } from "./intent.js";

type Sql = Pick<PrismaClient, "$queryRawUnsafe" | "$executeRawUnsafe">;
type Events = { notify(threadId: string, seq: number): Promise<void> };

export const PLAN_TRIGGERS = new Set(["user", "follow_up"]);
/**
 * A plan older than this no longer answers "yes" (the owner moved on), and an approved plan stops
 * covering follow-ups this long after it was approved.
 */
export const PLAN_LIVE_MS = 6 * 60 * 60_000;
const MAX_STEPS = 12;

export interface PlanRow {
  id: string;
  spaceId: string;
  botId: string;
  userId: string;
  threadId: string;
  runId: string | null;
  messageId: string | null;
  title: string;
  steps: PlanStep[];
  inputs: Array<{ label: string; value: string }>;
  spoken: string | null;
  workflow: string | null;
  skillId: string | null;
  revision: number;
  revisesId: string | null;
  status: PlanStatus;
  decidedVia: PlanDecidedVia | null;
  executingRunId: string | null;
  /** Ids of the agents that were sent a request under this plan (what the plan covers). */
  recipients: string[];
  createdAt: Date;
}

export interface TrustRow {
  botId: string;
  workflow: string;
  label: string;
  skillId: string | null;
  approvals: number;
  lastApprovedAt: Date | null;
  revokedAt: Date | null;
}

const MODES = new Set<PlanMode>(["always", "until_trusted", "notify", "never"]);
const workflowKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 200);

const asJsonArray = <T>(value: unknown): T[] => {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
};

const toPlan = (row: Record<string, unknown>): PlanRow => ({
  ...(row as unknown as PlanRow),
  steps: asJsonArray<PlanStep>(row.steps),
  inputs: asJsonArray<{ label: string; value: string }>(row.inputs),
  recipients: asJsonArray<unknown>(row.recipients).filter(
    (id): id is string => typeof id === "string",
  ),
});

export function createPlanStore(prisma: Sql) {
  const q = <T>(sql: string, ...values: unknown[]) => prisma.$queryRawUnsafe<T[]>(sql, ...values);
  const x = (sql: string, ...values: unknown[]) => prisma.$executeRawUnsafe(sql, ...values);
  return {
    async setting(botId: string): Promise<{ mode: PlanMode | null; threshold: number }> {
      const rows = await q<{ mode: string; threshold: number }>(
        `SELECT "mode", "threshold" FROM "plan_settings" WHERE "botId" = $1`,
        botId,
      );
      const row = rows[0];
      const mode = row && MODES.has(row.mode as PlanMode) ? (row.mode as PlanMode) : null;
      return { mode, threshold: row?.threshold ?? DEFAULT_PLAN_TRUST_THRESHOLD };
    },
    async setSetting(spaceId: string, botId: string, mode: PlanMode | null, threshold?: number) {
      if (mode === null && threshold === undefined) {
        await x(`DELETE FROM "plan_settings" WHERE "botId" = $1`, botId);
        return;
      }
      await x(
        `INSERT INTO "plan_settings" ("botId", "spaceId", "mode", "threshold", "updatedAt")
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT ("botId") DO UPDATE SET "mode" = EXCLUDED."mode",
           "threshold" = COALESCE($5, "plan_settings"."threshold"), "updatedAt" = now()`,
        botId,
        spaceId,
        mode ?? planDefaultMode(),
        threshold ?? DEFAULT_PLAN_TRUST_THRESHOLD,
        threshold ?? null,
      );
    },
    async latest(threadId: string, botId: string, since: Date): Promise<PlanRow | undefined> {
      const rows = await q<Record<string, unknown>>(
        `SELECT * FROM "agent_plans" WHERE "threadId" = $1 AND "botId" = $2 AND "createdAt" > $3
         ORDER BY "createdAt" DESC, "revision" DESC LIMIT 1`,
        threadId,
        botId,
        since,
      );
      return rows[0] ? toPlan(rows[0]) : undefined;
    },
    async get(id: string): Promise<PlanRow | undefined> {
      const rows = await q<Record<string, unknown>>(
        `SELECT * FROM "agent_plans" WHERE "id" = $1`,
        id,
      );
      return rows[0] ? toPlan(rows[0]) : undefined;
    },
    async boundTo(runId: string): Promise<PlanRow | undefined> {
      const rows = await q<Record<string, unknown>>(
        `SELECT * FROM "agent_plans" WHERE "executingRunId" = $1 AND "status" IN ('approved', 'auto')
         ORDER BY "createdAt" DESC LIMIT 1`,
        runId,
      );
      return rows[0] ? toPlan(rows[0]) : undefined;
    },
    /** Approved (or auto) plans of this chat whose approval is newer than `since`, newest first. */
    async liveApproved(threadId: string, botId: string, since: Date): Promise<PlanRow[]> {
      const rows = await q<Record<string, unknown>>(
        `SELECT * FROM "agent_plans" WHERE "threadId" = $1 AND "botId" = $2
           AND "status" IN ('approved', 'auto') AND COALESCE("decidedAt", "createdAt") > $3
         ORDER BY "createdAt" DESC, "revision" DESC LIMIT 10`,
        threadId,
        botId,
        since,
      );
      return rows.map(toPlan);
    },
    /** Records that a request went to `recipientBotId` under this plan (once per agent). */
    async addRecipient(id: string, recipientBotId: string): Promise<void> {
      await x(
        `UPDATE "agent_plans" SET "recipients" = "recipients" || to_jsonb($2::text), "updatedAt" = now()
         WHERE "id" = $1 AND NOT ("recipients" @> to_jsonb($2::text))`,
        id,
        recipientBotId,
      );
    },
    async insert(row: Omit<PlanRow, "createdAt" | "messageId" | "recipients">): Promise<void> {
      await x(
        `INSERT INTO "agent_plans" ("id", "spaceId", "botId", "userId", "threadId", "runId", "title", "steps",
           "inputs", "spoken", "workflow", "skillId", "revision", "revisesId", "status", "decidedVia",
           "decidedAt", "executingRunId")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14, $15, $16,
           CASE WHEN $16::text IS NULL THEN NULL ELSE now() END, $17)`,
        row.id,
        row.spaceId,
        row.botId,
        row.userId,
        row.threadId,
        row.runId,
        row.title,
        JSON.stringify(row.steps),
        JSON.stringify(row.inputs),
        row.spoken,
        row.workflow,
        row.skillId,
        row.revision,
        row.revisesId,
        row.status,
        row.decidedVia,
        row.executingRunId,
      );
    },
    async setMessage(id: string, messageId: string) {
      await x(
        `UPDATE "agent_plans" SET "messageId" = $2, "updatedAt" = now() WHERE "id" = $1`,
        id,
        messageId,
      );
    },
    /** Moves a plan from one of `from` to `status`; false when it was not in one of them. */
    async decide(
      id: string,
      from: PlanStatus[],
      status: PlanStatus,
      via: PlanDecidedVia | null,
      executingRunId?: string,
    ): Promise<boolean> {
      const changed = await x(
        `UPDATE "agent_plans" SET "status" = $2, "decidedVia" = COALESCE($3, "decidedVia"),
           "decidedAt" = now(), "executingRunId" = COALESCE($4, "executingRunId"), "updatedAt" = now()
         WHERE "id" = $1 AND "status" = ANY($5::text[])`,
        id,
        status,
        via,
        executingRunId ?? null,
        from,
      );
      return changed > 0;
    },
    /** Binds an approved plan to the run carrying it out (once). */
    async bind(id: string, runId: string): Promise<boolean> {
      const changed = await x(
        `UPDATE "agent_plans" SET "executingRunId" = $2, "updatedAt" = now()
         WHERE "id" = $1 AND "status" IN ('approved', 'auto') AND ("executingRunId" IS NULL OR "executingRunId" = $2)`,
        id,
        runId,
      );
      return changed > 0;
    },
    async trust(botId: string, workflow: string): Promise<TrustRow | undefined> {
      const rows = await q<TrustRow>(
        `SELECT * FROM "plan_trust" WHERE "botId" = $1 AND "workflow" = $2`,
        botId,
        workflowKey(workflow),
      );
      return rows[0];
    },
    async trustOf(
      spaceId: string,
      botId?: string,
    ): Promise<Array<TrustRow & { botName: string | null }>> {
      return q<TrustRow & { botName: string | null }>(
        `SELECT t.*, b."name" AS "botName" FROM "plan_trust" t LEFT JOIN "bots" b ON b."id" = t."botId"
         WHERE t."spaceId" = $1 ${botId ? `AND t."botId" = $2` : ""} ORDER BY t."updatedAt" DESC`,
        ...(botId ? [spaceId, botId] : [spaceId]),
      );
    },
    async approve(spaceId: string, botId: string, workflow: string, skillId: string | null) {
      await x(
        `INSERT INTO "plan_trust" ("botId", "workflow", "spaceId", "label", "skillId", "approvals", "lastApprovedAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, 1, now(), now())
         ON CONFLICT ("botId", "workflow") DO UPDATE SET "approvals" = "plan_trust"."approvals" + 1,
           "lastApprovedAt" = now(), "revokedAt" = NULL, "label" = EXCLUDED."label",
           "skillId" = COALESCE(EXCLUDED."skillId", "plan_trust"."skillId"), "updatedAt" = now()`,
        botId,
        workflowKey(workflow),
        spaceId,
        workflow.trim().slice(0, 200),
        skillId,
      );
    },
    async reset(spaceId: string, botId: string, workflow: string, revoked = false) {
      await x(
        `INSERT INTO "plan_trust" ("botId", "workflow", "spaceId", "label", "approvals", "revokedAt", "updatedAt")
         VALUES ($1, $2, $3, $4, 0, CASE WHEN $5 THEN now() ELSE NULL END, now())
         ON CONFLICT ("botId", "workflow") DO UPDATE SET "approvals" = 0,
           "revokedAt" = CASE WHEN $5 THEN now() ELSE "plan_trust"."revokedAt" END, "updatedAt" = now()`,
        botId,
        workflowKey(workflow),
        spaceId,
        workflow.trim().slice(0, 200),
        revoked,
      );
    },
  };
}
export type PlanStore = ReturnType<typeof createPlanStore>;

/**
 * FORK.md 1.25: the mode of an agent with no setting of its own. The deployment chooses it with
 * PLAN_DEFAULT_MODE (always | until_trusted | notify | never); unset or unreadable = Ask until
 * trusted, as before.
 */
export function planDefaultMode(env: NodeJS.ProcessEnv = process.env): PlanMode {
  const value = (env.PLAN_DEFAULT_MODE ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return MODES.has(value as PlanMode) ? (value as PlanMode) : DEFAULT_PLAN_MODE;
}

/** The agent's own choice wins; otherwise the deployment default. */
export function effectivePlanMode(
  mode: PlanMode | null,
  env: NodeJS.ProcessEnv = process.env,
): PlanMode {
  return mode ?? planDefaultMode(env);
}

export function workflowTrusted(
  mode: PlanMode,
  threshold: number,
  trust: Pick<TrustRow, "approvals"> | undefined,
): boolean {
  return mode === "until_trusted" && (trust?.approvals ?? 0) >= threshold;
}

// --- Cards ---------------------------------------------------------------------------------

export function planBlock(
  row: PlanRow,
  trust?: { approvals: number; threshold: number },
): PlanBlock {
  return {
    kind: "plan",
    planId: row.id,
    title: row.title,
    steps: row.steps,
    ...(row.inputs.length ? { inputs: row.inputs } : {}),
    ...(row.workflow
      ? {
          workflow: {
            name: row.workflow,
            ...(row.skillId ? { skillId: row.skillId } : {}),
            approvals: trust?.approvals ?? 0,
            threshold: trust?.threshold ?? DEFAULT_PLAN_TRUST_THRESHOLD,
          },
        }
      : {}),
    revision: row.revision,
    ...(row.spoken ? { spoken: row.spoken } : {}),
    status: row.status,
    ...(row.decidedVia ? { decidedVia: row.decidedVia } : {}),
  };
}

async function postCard(
  prisma: PrismaClient,
  events: Events | undefined,
  row: PlanRow,
  block: PlanBlock,
  run?: { id: string; lease?: unknown },
): Promise<string> {
  const { message, event } = await prisma.$transaction(async (tx) => {
    const message = await createThreadMessageInTransaction(tx, {
      threadId: row.threadId,
      role: "bot",
      botId: row.botId,
      blocks: [block],
      clientNonce: `plan:${row.id}`,
      ...(run ? { runId: run.id, ...(run.lease ? { lease: run.lease as never } : {}) } : {}),
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: row.spaceId,
      threadId: row.threadId,
      botId: row.botId,
      type: "thread.message.created",
      ...(run ? { runId: run.id, ...(run.lease ? { lease: run.lease as never } : {}) } : {}),
      payload: { messageId: message.id, role: "bot", blocks: [block] },
    });
    return { message, event };
  });
  await events?.notify(row.threadId, event.seq).catch(() => undefined);
  return message.id;
}

export async function updatePlanCard(
  prisma: PrismaClient,
  events: Events | undefined,
  row: PlanRow,
  block: PlanBlock,
): Promise<void> {
  if (!row.messageId) return;
  const seq = await prisma.$transaction(async (tx) => {
    const message = await tx.message.findFirst({
      where: { id: row.messageId!, threadId: row.threadId },
      select: { id: true, blocks: true, botId: true },
    });
    if (!message) return undefined;
    const changed = changeMessageBlocks(message, (existing: MessageBlock) =>
      existing.kind === "plan" && existing.planId === row.id ? block : existing,
    );
    if (!changed) return undefined;
    await tx.message.update({ where: { id: message.id }, data: { blocks: changed.stored } });
    const event = await appendEventInTransaction(tx, {
      spaceId: row.spaceId,
      threadId: row.threadId,
      botId: message.botId ?? row.botId,
      type: "thread.message.updated",
      payload: { messageId: message.id, role: "bot", blocks: changed.blocks },
    });
    return event.seq;
  });
  if (seq !== undefined) await events?.notify(row.threadId, seq).catch(() => undefined);
}

async function refreshCard(prisma: PrismaClient, events: Events | undefined, id: string) {
  const store = createPlanStore(prisma);
  const row = await store.get(id);
  if (!row) return undefined;
  const { threshold } = await store.setting(row.botId);
  const trust = row.workflow ? await store.trust(row.botId, row.workflow) : undefined;
  const block = planBlock(row, { approvals: trust?.approvals ?? 0, threshold });
  await updatePlanCard(prisma, events, row, block);
  return block;
}

/** Owner's decision, wherever it came from: card, voice, typed reply. Trust follows it. */
export async function applyPlanDecision(
  prisma: PrismaClient,
  events: Events | undefined,
  row: PlanRow,
  decision: Exclude<PlanReplyIntent, "other">,
  via: PlanDecidedVia,
  executingRunId?: string,
): Promise<boolean> {
  const store = createPlanStore(prisma);
  const status: PlanStatus =
    decision === "approve" ? "approved" : decision === "change" ? "changes" : "rejected";
  const moved = await store.decide(row.id, ["pending"], status, via, executingRunId);
  if (!moved) return false;
  if (row.workflow) {
    // A clean approval of the workflow as proposed counts; asking for changes or saying no is a
    // correction, which starts the count again.
    if (decision === "approve" && row.revision === 1)
      await store.approve(row.spaceId, row.botId, row.workflow, row.skillId);
    else if (decision !== "approve") await store.reset(row.spaceId, row.botId, row.workflow);
  }
  getLogger().info("plan.decided", {
    "plan.id": row.id,
    "plan.decision": decision,
    "plan.via": via,
    "plan.workflow": row.workflow ?? "",
    "plan.revision": row.revision,
    "run.id": executingRunId ?? "",
  });
  await refreshCard(prisma, events, row.id);
  return true;
}

// --- Run assembly ----------------------------------------------------------------------------

export interface PlanPromptState {
  mode: PlanMode;
  threshold: number;
  /** Plan this run carries out (approved now or earlier). */
  approved?: PlanRow;
  /** The owner's message asked to change it / said no. */
  changing?: PlanRow;
  rejected?: PlanRow;
  /** Still waiting; the owner's message was about something else. */
  pending?: PlanRow;
  /**
   * An approved plan of this chat, carried out by an earlier run and still live: this run may send
   * its agents follow-ups (Always ask: corrections with replaces only) without a new plan.
   */
  covering?: { plan: PlanRow; agents: string[] };
  trusted: string[];
}

export interface PlanRun {
  id: string;
  spaceId: string;
  threadId: string;
  botId: string;
  userId: string;
  trigger: string;
  sourceMessageId: string | null;
}

function sourceText(blocks: readonly unknown[]): string {
  return (blocks as Array<Record<string, unknown>>)
    .filter((block) => block.kind === "text" && typeof block.text === "string")
    .map((block) => String(block.text))
    .join("\n")
    .trim();
}

/**
 * Read once per run during assembly. For an owner-started chat run it also settles the chat's
 * pending plan from the owner's message (typed or spoken) and binds an approved plan to the run.
 * Never throws; undefined = no plan line.
 */
export async function planPromptState(
  prisma: PrismaClient,
  run: PlanRun,
  options: { ownerStartedRun: boolean; messagingChannelRun?: boolean; events?: Events },
): Promise<PlanPromptState | undefined> {
  try {
    const store = createPlanStore(prisma);
    const setting = await store.setting(run.botId);
    const mode = effectivePlanMode(setting.mode);
    if (mode === "never") return undefined;
    const trustRows = await store.trustOf(run.spaceId, run.botId);
    const trusted = trustRows
      .filter((row) => workflowTrusted(mode, setting.threshold, row))
      .map((row) => row.label);
    const state: PlanPromptState = { mode, threshold: setting.threshold, trusted };
    if (!options.ownerStartedRun || options.messagingChannelRun || !PLAN_TRIGGERS.has(run.trigger))
      return state;
    const since = new Date(Date.now() - PLAN_LIVE_MS);
    const plan = await store.latest(run.threadId, run.botId, since);
    if (!plan) return withCoveringPlan(prisma, store, run, state, since);
    if (plan.executingRunId === run.id) return { ...state, approved: plan };
    if ((plan.status === "approved" || plan.status === "auto") && !plan.executingRunId) {
      if (await store.bind(plan.id, run.id))
        return { ...state, approved: { ...plan, executingRunId: run.id } };
      return state;
    }
    if (plan.status !== "pending" && plan.status !== "changes")
      return withCoveringPlan(prisma, store, run, state, since);
    if (plan.status !== "pending" || !run.sourceMessageId) return state;
    const source = await prisma.message.findFirst({
      where: { id: run.sourceMessageId, threadId: run.threadId },
      select: { id: true, role: true, blocks: true, clientNonce: true, createdAt: true },
    });
    if (!source || source.role !== "user" || source.createdAt < plan.createdAt)
      return { ...state, pending: plan };
    const text = sourceText(readMessageBlocks(source as never).blocks);
    const intent = planReplyIntent(text);
    if (intent === "other") return { ...state, pending: plan };
    const via: PlanDecidedVia = source.clientNonce?.startsWith("call:") ? "voice" : "text";
    const applied = await applyPlanDecision(
      prisma,
      options.events,
      plan,
      intent,
      via,
      intent === "approve" ? run.id : undefined,
    );
    if (!applied) return state;
    if (intent === "approve")
      return { ...state, approved: { ...plan, status: "approved", executingRunId: run.id } };
    if (intent === "change") return { ...state, changing: plan };
    return { ...state, rejected: plan };
  } catch (error) {
    getLogger().warn("plan.prompt_state_failed", { error: String(error) });
    return undefined;
  }
}

/** Adds the live approved plan an earlier run carried out, with the agents it involves by name. */
async function withCoveringPlan(
  prisma: PrismaClient,
  store: PlanStore,
  run: PlanRun,
  state: PlanPromptState,
  since: Date,
): Promise<PlanPromptState> {
  const [plan] = await store.liveApproved(run.threadId, run.botId, since);
  if (!plan) return state;
  const sent = plan.recipients.length
    ? await prisma.bot.findMany({
        where: { id: { in: plan.recipients }, spaceId: run.spaceId, archivedAt: null },
        select: { name: true },
      })
    : [];
  const agents = [
    ...new Set([
      ...sent.map((bot) => bot.name),
      ...plan.steps.flatMap((step) => (step.agent?.trim() ? [step.agent.trim()] : [])),
    ]),
  ];
  return agents.length ? { ...state, covering: { plan, agents } } : state;
}

function stepsText(plan: Pick<PlanRow, "steps">): string {
  return plan.steps
    .map((step, i) => `${i + 1}. ${step.agent ? `${step.agent}: ` : ""}${step.text}`)
    .join(" ");
}

/** The prompt line (joined to the skills line). */
export function planInstruction(state: PlanPromptState | undefined): string | undefined {
  if (!state) return undefined;
  const cover =
    "An approved plan covers the whole task for the agents it involves: the owner's corrections and follow-ups about it, in this message or his next ones, go to those agents with message_bot without a new plan. Only new work, or an agent the plan does not involve, needs a new plan.";
  const correcting =
    'To correct a request you already sent another agent, use message_bot with replaces (its request id or "latest"): that stops or cancels the old one and starts the corrected one at once; if the old one has already finished, the correction is delivered as a new request.';
  const what =
    "before you hand work to another agent with message_bot (a request) or start a task of several steps the owner asked for, call plan_propose: numbered steps, who does each, and the inputs exactly as he gave them (titles, names, links, where to look).";
  const workflowHint =
    "If the request matches one of your skills (a known workflow), put its name in plan_propose's workflow field and build the steps from it. Questions, lookups and one-step replies need no plan.";
  const lines = [
    state.mode === "notify"
      ? // FORK.md 1.25: the plan is a notice. The agent works like a colleague who says what he is doing.
        `Plans (notify, no approval needed): ${what} The plan is posted for the owner as a notice and is approved at once: carry it out in the same turn, step by step, starting right after plan_propose returns. Do NOT ask whether to go ahead, do not wait for an answer and do not end your turn for approval; the owner reads the plan and corrects you afterwards if he wants something different. message_bot requests are refused only until the plan is posted. ${workflowHint} ${cover} ${correcting}`
      : `Plans (${state.mode === "always" ? "always ask" : "ask until trusted"}): ${what} Then end your turn with one short question asking whether to go ahead; nothing else happens until he approves on the card or says yes. message_bot requests are refused until a plan is approved. ${workflowHint} ${
          state.mode === "always"
            ? "An approved plan is one hand-off: a new request needs a new plan, a correction of a request you already sent does not."
            : cover
        } ${correcting}`,
  ];
  if (state.trusted.length)
    lines.push(
      `Trusted workflows (approved ${state.threshold} times; plan_propose approves them at once and posts the plan as a notice, then carry it out): ${state.trusted.join(", ")}.`,
    );
  if (state.approved)
    lines.push(
      `The owner approved plan ${state.approved.id} "${state.approved.title}" (revision ${state.approved.revision}). Carry it out now exactly as written, step by step: ${stepsText(state.approved)} Do not propose it again.`,
    );
  if (state.covering)
    lines.push(
      state.mode === "always"
        ? `Plan ${state.covering.plan.id} "${state.covering.plan.title}" is approved: to correct a request you sent under it (${state.covering.agents.join(", ")}), use message_bot with replaces; no new plan is needed for that. Any other request needs a new plan.`
        : `Plan ${state.covering.plan.id} "${state.covering.plan.title}" is approved and still covers this task for: ${state.covering.agents.join(", ")}. If the owner's message corrects or follows up on it, send it to them with message_bot now (replaces "latest" when it corrects your earlier request); do not propose a new plan for that and do not ask again. New work or another agent needs a new plan.`,
    );
  if (state.changing)
    lines.push(
      `The owner asked for changes to plan ${state.changing.id} "${state.changing.title}" (${stepsText(state.changing)}). Apply his changes and call plan_propose again with revises="${state.changing.id}", then ${
        state.mode === "notify"
          ? "carry the revised plan out in the same turn"
          : "end your turn and wait for his approval"
      }.`,
    );
  if (state.rejected)
    lines.push(
      `The owner said no to plan ${state.rejected.id} "${state.rejected.title}". Do not carry it out; if it is unclear what he wants instead, ask him.`,
    );
  if (state.pending)
    lines.push(
      `Plan ${state.pending.id} "${state.pending.title}" is still waiting for the owner's approval. Answer his message; do not carry the plan out and do not propose it again unless he asks for a change.`,
    );
  return lines.join(" ");
}

// --- plan_propose ----------------------------------------------------------------------------

export interface ProposeInput {
  title?: unknown;
  steps?: unknown;
  inputs?: unknown;
  workflow?: unknown;
  spoken?: unknown;
  revises?: unknown;
}

function cleanSteps(raw: unknown): PlanStep[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (typeof item === "string") return { text: item.trim().slice(0, 500) };
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        const text = String(record.text ?? record.step ?? "")
          .trim()
          .slice(0, 500);
        const agent = String(record.agent ?? record.who ?? "")
          .trim()
          .slice(0, 80);
        return { text, ...(agent ? { agent } : {}) };
      }
      return { text: "" };
    })
    .filter((step) => step.text)
    .slice(0, MAX_STEPS);
}

function cleanInputs(raw: unknown): Array<{ label: string; value: string }> {
  if (!Array.isArray(raw)) return [];
  return raw
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      const label = String(record.label ?? record.name ?? "")
        .trim()
        .slice(0, 80);
      const value = String(record.value ?? "")
        .trim()
        .slice(0, 500);
      return label ? [{ label, value }] : [];
    })
    .slice(0, 10);
}

export function spokenPlan(title: string, steps: PlanStep[]): string {
  const parts = steps
    .slice(0, 4)
    .map(
      (step, i) =>
        `${i + 1}, ${step.agent ? `${step.agent} ` : ""}${step.text.replace(/[.]+$/, "")}`,
    );
  return `My plan for ${title.replace(/[.]+$/, "")}: ${parts.join("; ")}${steps.length > 4 ? "; and more on the card" : ""}. Shall I go ahead?`.slice(
    0,
    600,
  );
}

/**
 * What a call says for a plan posted as a notice: a statement, never a question. The agent's own
 * short version is used without a closing question such as "Shall I go ahead?".
 */
export function spokenNotice(title: string, steps: PlanStep[], own = ""): string {
  const given = own
    .trim()
    .replace(/\s*[^.!?]*\?\s*$/u, "")
    .trim();
  const base =
    given ||
    spokenPlan(title, steps)
      .replace(/\s*Shall I go ahead\?\s*$/u, "")
      .trim();
  return `${base.replace(/[.\s]+$/u, "")}. I am starting now.`.slice(0, 600);
}

export async function proposePlan(
  deps: { prisma: PrismaClient; events?: Events },
  run: PlanRun & { lease?: unknown },
  input: ProposeInput,
): Promise<Record<string, unknown>> {
  const store = createPlanStore(deps.prisma);
  const setting = await store.setting(run.botId);
  const mode = effectivePlanMode(setting.mode);
  const title = String(input.title ?? "")
    .trim()
    .slice(0, 160);
  const steps = cleanSteps(input.steps);
  if (!title) return { error: "title is required" };
  if (!steps.length) return { error: "steps are required: numbered, who does each" };
  if (mode === "never")
    return {
      ok: true,
      posted: false,
      note: "Plans are off for you (Never ask): go ahead with the work.",
    };
  const workflow =
    String(input.workflow ?? "")
      .trim()
      .slice(0, 200) || null;
  const revisesId = String(input.revises ?? "").trim() || null;
  let revision = 1;
  if (revisesId) {
    const old = await store.get(revisesId);
    if (!old || old.threadId !== run.threadId || old.botId !== run.botId)
      return { error: `no plan ${revisesId} of yours in this chat` };
    revision = old.revision + 1;
    if (await store.decide(old.id, ["pending", "changes"], "replaced", null))
      await refreshCard(deps.prisma, deps.events, old.id);
  } else {
    // A new plan replaces any plan of this chat still waiting, so "yes" answers the newest one.
    const open = await store.latest(run.threadId, run.botId, new Date(Date.now() - PLAN_LIVE_MS));
    if (open && (open.status === "pending" || open.status === "changes"))
      if (await store.decide(open.id, ["pending", "changes"], "replaced", null))
        await refreshCard(deps.prisma, deps.events, open.id);
  }
  let skillId: string | null = null;
  if (workflow) {
    const skill = await deps.prisma.agentSkill
      .findFirst({
        where: { name: { equals: workflow, mode: "insensitive" } },
        select: { id: true },
      })
      .catch(() => null);
    skillId = skill?.id ?? null;
  }
  const trust = workflow ? await store.trust(run.botId, workflow) : undefined;
  const trusted =
    Boolean(workflow) && revision === 1 && workflowTrusted(mode, setting.threshold, trust);
  // FORK.md 1.25: under Notify every plan is a notice, approved as it is posted. It is not a
  // "clean approval" by the owner, so the workflow's trust counter is left alone.
  const notify = mode === "notify";
  const auto = trusted || notify;
  const spoken = notify
    ? spokenNotice(title, steps, String(input.spoken ?? ""))
    : String(input.spoken ?? "")
        .trim()
        .slice(0, 600) || spokenPlan(title, steps);
  const row: Omit<PlanRow, "createdAt" | "messageId" | "recipients"> = {
    id: randomUUID(),
    spaceId: run.spaceId,
    botId: run.botId,
    userId: run.userId,
    threadId: run.threadId,
    runId: run.id,
    title,
    steps,
    inputs: cleanInputs(input.inputs),
    spoken: trusted ? `Running the trusted workflow ${workflow}: ${title}.` : spoken,
    workflow,
    skillId,
    revision,
    revisesId,
    status: auto ? "auto" : "pending",
    decidedVia: trusted ? "trust" : notify ? "notify" : null,
    executingRunId: auto ? run.id : null,
  };
  await store.insert(row);
  const full: PlanRow = { ...row, messageId: null, recipients: [], createdAt: new Date() };
  const messageId = await postCard(
    deps.prisma,
    deps.events,
    full,
    planBlock(full, { approvals: trust?.approvals ?? 0, threshold: setting.threshold }),
    { id: run.id, lease: run.lease },
  );
  await store.setMessage(row.id, messageId);
  getLogger().info("plan.proposed", {
    "run.id": run.id,
    "plan.id": row.id,
    "plan.revision": revision,
    "plan.workflow": workflow ?? "",
    "plan.auto": auto,
    "plan.via": trusted ? "trust" : notify ? "notify" : "",
    "plan.steps": steps.length,
  });
  if (notify && !trusted)
    return {
      ok: true,
      planId: row.id,
      status: "auto",
      note: "The plan is posted for the owner as a notice (on a call its short version is read out) and is approved. Carry it out NOW in this same turn, step by step; message_bot requests go through. Do not ask whether to go ahead and do not end your turn to wait; he will tell you if he wants a change.",
    };
  if (auto)
    return {
      ok: true,
      planId: row.id,
      status: "auto",
      note: `Trusted workflow "${workflow}" (approved ${trust?.approvals ?? 0} times): the plan is posted as a notice and approved. Carry it out now, step by step.`,
    };
  return {
    ok: true,
    planId: row.id,
    status: "pending",
    note: "The plan card is in the chat (on a call its short version is read out). End your turn now with ONE short question asking whether to go ahead; do not repeat the steps, do not carry them out and do not message other agents until the owner approves.",
  };
}

// --- message_bot gate --------------------------------------------------------------------------

export const PLAN_REQUIRED_NOTE =
  "Not sent: no approved plan covers this request. An approved plan covers corrections and follow-ups to the agents it involves; new work, or an agent it does not involve, needs its own plan. Call plan_propose with the steps (who does what, and the inputs exactly as he gave them), end your turn with a short question, and send it after he approves.";

/** Notify mode: nothing waits on the owner, the plan only has to be posted before the hand-off. */
export const PLAN_NOTICE_FIRST_NOTE =
  "Not sent yet: post the plan first. Call plan_propose with the steps (who does what, and the inputs exactly as he gave them); it is approved at once as a notice. Then send this request again in the same turn. Do not ask the owner anything.";

const agentKey = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Does the plan involve this agent? Yes when a request already went to it under the plan, or when
 * a step names it as who does the step (by name or id).
 */
export function planInvolves(
  plan: Pick<PlanRow, "steps" | "recipients">,
  agent: { id: string; name: string },
): boolean {
  if (plan.recipients.includes(agent.id)) return true;
  const name = agentKey(agent.name);
  return plan.steps.some((step) => {
    const who = agentKey(step.agent ?? "");
    if (!who) return false;
    if (who === name || who === agent.id.toLowerCase()) return true;
    // "Worker (the subtitles agent)" still names Worker; "Networker" does not.
    return name.length >= 3 && ` ${who.replace(/[^\p{L}\p{N}]+/gu, " ")} `.includes(` ${name} `);
  });
}

export interface PlanGateResult {
  /** Why the request is not sent (PLAN_REQUIRED_NOTE); absent = allowed. */
  refused?: string;
  /** The plan the request goes out under, to record its recipient on. */
  planId?: string;
  /**
   * bound = the run carrying the plan out; follow_up / correction = a later message of the owner
   * about the same plan.
   */
  basis?: "bound" | "follow_up" | "correction";
}

export interface PlanGateOptions {
  ownerStartedRun: boolean;
  messagingChannelRun?: boolean;
  intent?: string;
  replaces?: string;
  /** Who the request is for, as message_bot was given it. */
  recipient?: { botId?: string; name?: string };
}

/**
 * An owner-started chat run may send another agent a request only under an approved plan:
 * 1. the plan bound to this run (or an approved plan of this chat still unbound, e.g. he clicked
 *    Approve while this run was going), for any agent, as before;
 * 2. a plan of this chat approved less than PLAN_LIVE_MS ago that involves the recipient
 *    (`planInvolves`): the owner's corrections and follow-ups in later messages. Under Always ask
 *    only a correction (`replaces`) is covered this way; a plain follow-up needs a new plan.
 * Nothing is covered while a newer plan of the chat still waits for his answer.
 */
export async function planGateCheck(
  prisma: PrismaClient,
  run: PlanRun,
  options: PlanGateOptions,
): Promise<PlanGateResult> {
  if ((options.intent ?? "request") !== "request") return {};
  if (!options.ownerStartedRun || options.messagingChannelRun || !PLAN_TRIGGERS.has(run.trigger))
    return {};
  try {
    const store = createPlanStore(prisma);
    const mode = effectivePlanMode((await store.setting(run.botId)).mode);
    if (mode === "never") return {};
    const bound = await store.boundTo(run.id);
    if (bound) return { planId: bound.id, basis: "bound" };
    const since = new Date(Date.now() - PLAN_LIVE_MS);
    const latest = await store.latest(run.threadId, run.botId, since);
    if (
      latest &&
      (latest.status === "approved" || latest.status === "auto") &&
      !latest.executingRunId &&
      (await store.bind(latest.id, run.id))
    )
      return { planId: latest.id, basis: "bound" };
    const waiting = latest?.status === "pending" || latest?.status === "changes";
    if (!waiting) {
      const target = await gateRecipient(prisma, run, options.recipient);
      const basis = options.replaces ? "correction" : "follow_up";
      if (target && (basis === "correction" || mode !== "always")) {
        const plans = await store.liveApproved(run.threadId, run.botId, since);
        const covering = plans.find((plan) => planInvolves(plan, target));
        if (covering) {
          getLogger().info("plan.gate_covered", {
            "run.id": run.id,
            "plan.id": covering.id,
            "plan.basis": basis,
            "bot.id": target.id,
          });
          return { planId: covering.id, basis };
        }
      }
    }
    getLogger().info("plan.gate_refused", {
      "run.id": run.id,
      "plan.mode": mode,
      "plan.latest": latest?.id ?? "",
      "plan.latest_status": latest?.status ?? "",
      "plan.replaces": Boolean(options.replaces),
    });
    return { refused: mode === "notify" && !waiting ? PLAN_NOTICE_FIRST_NOTE : PLAN_REQUIRED_NOTE };
  } catch (error) {
    // A broken plan table must never stop delegation.
    getLogger().warn("plan.gate_failed", { error: String(error) });
    return {};
  }
}

async function gateRecipient(
  prisma: PrismaClient,
  run: PlanRun,
  recipient: PlanGateOptions["recipient"],
): Promise<{ id: string; name: string } | undefined> {
  if (!recipient?.botId && !recipient?.name) return undefined;
  const bots = await prisma.bot.findMany({
    where: { spaceId: run.spaceId, archivedAt: null },
    select: { id: true, name: true },
  });
  const target = resolveBotAddress(bots, recipient);
  return target && target.id !== run.botId ? target : undefined;
}

/** The gate's refusal note, or undefined when the request may go. */
export async function planGateForMessageBot(
  prisma: PrismaClient,
  run: PlanRun,
  options: PlanGateOptions,
): Promise<string | undefined> {
  return (await planGateCheck(prisma, run, options)).refused;
}

/** After a request went out under a plan: the plan now covers follow-ups to that agent. */
export async function recordPlanRecipient(
  prisma: PrismaClient,
  gate: PlanGateResult,
  recipientBotId: string,
): Promise<void> {
  if (!gate.planId) return;
  try {
    await createPlanStore(prisma).addRecipient(gate.planId, recipientBotId);
  } catch (error) {
    getLogger().warn("plan.recipient_record_failed", { error: String(error) });
  }
}

// --- Owner API ---------------------------------------------------------------------------------

export class PlanNotFoundError extends Error {}

export async function trustList(
  prisma: PrismaClient,
  spaceId: string,
  botId?: string,
): Promise<PlanTrust[]> {
  const store = createPlanStore(prisma);
  const rows = await store.trustOf(spaceId, botId);
  const settings = new Map<string, { mode: PlanMode; threshold: number }>();
  const out: PlanTrust[] = [];
  for (const row of rows) {
    if (!settings.has(row.botId)) {
      const s = await store.setting(row.botId);
      settings.set(row.botId, { mode: effectivePlanMode(s.mode), threshold: s.threshold });
    }
    const s = settings.get(row.botId)!;
    out.push({
      botId: row.botId,
      botName: row.botName,
      workflow: row.label,
      skillId: row.skillId,
      approvals: row.approvals,
      threshold: s.threshold,
      trusted: workflowTrusted(s.mode, s.threshold, row),
      revoked: Boolean(row.revokedAt),
      lastApprovedAt: row.lastApprovedAt ? new Date(row.lastApprovedAt).toISOString() : null,
    });
  }
  return out;
}

/** The card's buttons. Returns the plan's card block and whether the owner's message should go. */
export async function decidePlan(
  deps: { prisma: PrismaClient; events?: Events },
  actor: { spaceId: string; userId: string },
  input: { planId: string; decision: "approve" | "change" | "reject"; via?: "click" | "voice" },
): Promise<{ block: PlanBlock; plan: PlanRow; changed: boolean }> {
  const store = createPlanStore(deps.prisma);
  const plan = await store.get(input.planId);
  if (!plan || plan.spaceId !== actor.spaceId) throw new PlanNotFoundError();
  const changed = await applyPlanDecision(
    deps.prisma,
    deps.events,
    plan,
    input.decision,
    input.via ?? "click",
  );
  const fresh = (await store.get(plan.id)) ?? plan;
  const { threshold } = await store.setting(plan.botId);
  const trust = fresh.workflow ? await store.trust(fresh.botId, fresh.workflow) : undefined;
  return {
    block: planBlock(fresh, { approvals: trust?.approvals ?? 0, threshold }),
    plan: fresh,
    changed,
  };
}
