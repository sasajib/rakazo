/**
 * Fork: the skill curator. Reads a finished run (or a chat teaching session), asks the curator
 * model for one proposal, passes it through the server's gates, then saves it (Auto) or posts a
 * Keep / Edit / Discard card (Ask). Nothing here blocks a run: the run-finished hook schedules it
 * in the background and every path catches.
 *
 * Rules the gates enforce:
 * - a proposal rests on the owner's own words (quote gate), except when he asked for a skill;
 * - nothing shaped like a secret is ever written;
 * - only user skills the agent can see are changed; Auto changes only skills the curator learned
 *   itself (learned_skills), so a skill the owner wrote is changed only after his Keep;
 * - one open card per skill; Off saves nothing.
 */
import type { SecretStore } from "@rakazo/adapter-kit";
import type { LearnedSkillBlock, MessageBlock, SkillLearningMode } from "@rakazo/contracts";
import { DEFAULT_SKILL_LEARNING_MODE } from "@rakazo/contracts";
import { blocksToAgentHistoryText, buildSkillMd, parseSkillMd } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  appendEventInTransaction,
  changeMessageBlocks,
  createThreadMessageInTransaction,
  storedMessageBlocks,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { parseStandingOrders, STANDING_ORDERS_PATH } from "../memory/standing-orders.js";
import { resolveModelEndpoint } from "../memory-ledger/connection.js";
import { holdsSecret, overlap, quoteSources } from "../memory-ledger/text.js";
import {
  listAgentSkillRecords,
  skillCreateFromTool,
  skillDeleteFromTool,
  skillUpdateFromTool,
} from "../tools/skill-tools.js";
import type { CuratorConfig } from "./config.js";
import type {
  CuratorInput,
  CuratorModel,
  CuratorOwnerMessage,
  CuratorProposal,
  CuratorSkillRef,
} from "./model.js";
import { createOpenAiCuratorModel } from "./model.js";
import type { OutlineStep } from "./outline.js";
import { skillsReadIn } from "./outline.js";
import type { CuratorJob, CuratorStore, ProposalRow } from "./store.js";
import type { CuratorReason } from "./triggers.js";

export type CuratorDeps = {
  prisma: PrismaClient;
  secretStore: Pick<SecretStore, "load">;
  events?: { notify(threadId: string, seq: number): Promise<void> };
};

const MAX_NAME = 60;
const MAX_DESCRIPTION = 300;
const MAX_BODY = 20_000;
/** Card copy of the proposed SKILL.md (Edit); the full text stays on the proposal row. */
const CARD_CONTENT_MAX = 12_000;

// --- Modes --------------------------------------------------------------------------------

export function effectiveMode(modes: {
  space: SkillLearningMode | null;
  bot: SkillLearningMode | null;
}): SkillLearningMode {
  return modes.bot ?? modes.space ?? DEFAULT_SKILL_LEARNING_MODE;
}

// --- Skill text ---------------------------------------------------------------------------

/** The body of a learned skill: steps in order, then the pitfalls (Hermes-style SKILL.md). */
export function learnedSkillBody(input: {
  name: string;
  steps: readonly string[];
  pitfalls: readonly string[];
}): string {
  const steps = input.steps.map(
    (step, index) => `${index + 1}. ${step.replace(/^\d+[.)]\s*/, "")}`,
  );
  const pitfalls = input.pitfalls.map((line) => `- ${line.replace(/^[-*]\s*/, "")}`);
  return [
    `# ${input.name}`,
    "",
    "## Steps",
    ...steps,
    ...(pitfalls.length ? ["", "## Pitfalls", ...pitfalls] : []),
    "",
  ].join("\n");
}

function cleanName(name: string): string {
  return name
    .replace(/["'`*_#/\\]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME)
    .trim();
}

/** Descriptions are triggers: they start with "Use when". */
export function cleanDescription(description: string): string {
  const flat = description.replace(/\s+/g, " ").trim();
  const text = /^use when\b/i.test(flat)
    ? `Use when${flat.slice(8)}`
    : /^when\b/i.test(flat)
      ? `Use when${flat.slice(4)}`
      : `Use when ${flat.charAt(0).toLowerCase()}${flat.slice(1)}`;
  return text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION - 1)}…` : text;
}

/** "+ added line" / "- removed line", at most `max` of each, for the patch card. */
export function diffSummary(before: string, after: string, max = 5): string {
  const lines = (text: string) =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  const old = new Set(lines(before));
  const next = new Set(lines(after));
  const added = [...next].filter((line) => !old.has(line));
  const removed = [...old].filter((line) => !next.has(line));
  const clip = (line: string) => (line.length > 140 ? `${line.slice(0, 139)}…` : line);
  const out = [
    ...added.slice(0, max).map((line) => `+ ${clip(line)}`),
    ...(added.length > max ? [`+ …${added.length - max} more`] : []),
    ...removed.slice(0, max).map((line) => `- ${clip(line)}`),
    ...(removed.length > max ? [`- …${removed.length - max} more`] : []),
  ];
  return out.join("\n");
}

// --- Gates (pure) -------------------------------------------------------------------------

export interface VisibleSkill {
  id: string;
  name: string;
  description: string;
  content: string;
  source: string;
  learned: boolean;
}

export type Plan =
  | { kind: "skip"; why: string }
  | {
      kind: "create";
      name: string;
      description: string;
      content: string;
      summary: string;
      quote: string;
    }
  | {
      kind: "patch";
      skill: VisibleSkill;
      content: string;
      summary: string;
      diff: string;
      quote: string;
      /** Auto may apply it: the curator wrote this skill itself. */
      autoAllowed: boolean;
    };

export interface PlanContext {
  reason: CuratorReason;
  messages: readonly CuratorOwnerMessage[];
  skills: readonly VisibleSkill[];
}

export function planProposal(proposal: CuratorProposal | undefined, ctx: PlanContext): Plan {
  if (!proposal) return { kind: "skip", why: "no_answer" };
  if (proposal.action === "none") return { kind: "skip", why: "none" };
  // He asked for a skill (or just taught one): his request is the evidence. Otherwise the
  // proposal must quote his own words, so web pages, tool output and bot replies never become
  // a skill on their own.
  const asked = ctx.reason === "explicit" || ctx.reason === "teach_done";
  const quoted =
    quoteSources(
      proposal.quote,
      ctx.messages.map((message, index) => ({
        id: String(index),
        text: message.text,
        at: message.at,
        current: message.current,
      })),
    ).length > 0;
  if (!asked && !quoted) return { kind: "skip", why: "quote" };
  const quote = quoted ? proposal.quote : (ctx.messages.findLast((m) => m.current)?.text ?? "");

  if (proposal.action === "create") {
    const name = cleanName(proposal.name);
    if (name.length < 3) return { kind: "skip", why: "name" };
    const description = cleanDescription(proposal.description);
    const steps = proposal.steps.filter((step) => step.trim());
    if (steps.length < 2) return { kind: "skip", why: "too_short" };
    const body = learnedSkillBody({ name, steps, pitfalls: proposal.pitfalls });
    if (body.length > MAX_BODY) return { kind: "skip", why: "too_long" };
    if (holdsSecret(name, description, body)) return { kind: "skip", why: "secret" };
    const clash = ctx.skills.find((skill) => skill.name.toLowerCase() === name.toLowerCase());
    if (clash) return { kind: "skip", why: "name_taken" };
    return {
      kind: "create",
      name,
      description,
      content: buildSkillMd({ name, description, body }),
      summary: proposal.summary.replace(/\s+/g, " ").trim().slice(0, 200),
      quote,
    };
  }

  const skill = ctx.skills.find((entry) => entry.id === proposal.skillId);
  if (!skill) return { kind: "skip", why: "unknown_skill" };
  if (skill.source !== "user" || skill.id.startsWith("builtin:"))
    return { kind: "skip", why: "read_only" };
  const prior = parseSkillMd(skill.content);
  if ("error" in prior) return { kind: "skip", why: "unparsable" };
  const body = proposal.body.trim();
  if (body.length > MAX_BODY) return { kind: "skip", why: "too_long" };
  const description = proposal.description
    ? cleanDescription(proposal.description)
    : skill.description;
  if (holdsSecret(description, body)) return { kind: "skip", why: "secret" };
  const content = buildSkillMd({
    name: skill.name,
    description,
    body: `\n${body}\n`,
    frontmatter: prior.frontmatter,
  });
  const diff = diffSummary(skill.content, content);
  if (!diff) return { kind: "skip", why: "unchanged" };
  return {
    kind: "patch",
    skill,
    content,
    summary: proposal.change.replace(/\s+/g, " ").trim().slice(0, 200),
    diff,
    quote,
    autoAllowed: skill.learned,
  };
}

// --- Inputs -------------------------------------------------------------------------------

function textOf(blocks: ReadonlyArray<{ kind: string; text?: unknown }>): string | undefined {
  if (blocks.some((block) => block.kind === "delivery" || block.kind === "channel_message"))
    return undefined;
  const text = blocks
    .filter((block) => block.kind === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim();
  return text || undefined;
}

/** The owner's own messages in a thread from `fromSeq` on (a teaching session), oldest first. */
export async function ownerMessagesSince(
  prisma: Pick<PrismaClient, "message">,
  input: { threadId: string; userId: string; fromSeq: number; limit?: number },
): Promise<CuratorOwnerMessage[]> {
  const rows = await prisma.message.findMany({
    where: {
      threadId: input.threadId,
      role: "user",
      authorUserId: input.userId,
      seq: { gte: input.fromSeq },
    },
    orderBy: { seq: "asc" },
    take: input.limit ?? 40,
    select: { id: true, seq: true, blocks: true, createdAt: true },
  });
  return rows.flatMap((row) => {
    const text = textOf(storedMessageBlocks(row) as Array<{ kind: string; text?: unknown }>);
    return text ? [{ text, at: row.createdAt, current: true }] : [];
  });
}

/** The bot's replies (with their tool steps) in a thread from `fromSeq` on, newest last. */
export async function botRepliesSince(
  prisma: Pick<PrismaClient, "message">,
  input: { threadId: string; botId: string; fromSeq: number; limit: number },
): Promise<string[]> {
  const rows = await prisma.message.findMany({
    where: {
      threadId: input.threadId,
      role: "bot",
      botId: input.botId,
      seq: { gte: input.fromSeq },
    },
    orderBy: { seq: "desc" },
    take: input.limit,
    select: { id: true, blocks: true },
  });
  return rows
    .reverse()
    .map((row) =>
      blocksToAgentHistoryText(
        storedMessageBlocks(row).filter((block) => block.kind !== "learned_skill"),
      ).trim(),
    )
    .filter(Boolean);
}

/** Tool calls in the bot's last few replies before `beforeSeq`: a correction may come after. */
export async function priorToolCalls(
  prisma: Pick<PrismaClient, "message">,
  input: { threadId: string; botId: string; beforeSeq: number },
): Promise<number> {
  const rows = await prisma.message.findMany({
    where: {
      threadId: input.threadId,
      role: "bot",
      botId: input.botId,
      seq: { lt: input.beforeSeq },
    },
    orderBy: { seq: "desc" },
    take: 4,
    select: { id: true, blocks: true },
  });
  let count = 0;
  for (const row of rows)
    for (const block of storedMessageBlocks(row))
      if (block.kind === "steps") for (const step of block.steps) count += Number(step.count) || 0;
  return count;
}

/** Standing orders and saved lesson/preference facts: what already binds the bot. */
async function knownRules(
  prisma: PrismaClient,
  input: { spaceId: string; userId: string; runId: string; threadId: string; since: Date },
): Promise<string[]> {
  const rules: string[] = [];
  const doc = await prisma.memoryDocument
    .findFirst({
      where: {
        spaceId: input.spaceId,
        userId: input.userId,
        scope: "user",
        path: STANDING_ORDERS_PATH,
      },
      select: { content: true },
    })
    .catch(() => null);
  if (doc?.content && !doc.content.startsWith("rkz1:"))
    for (const entry of parseStandingOrders(doc.content))
      if (entry.kind === "rule") rules.push(entry.text);
  // The ledger's facts from before this stretch of the chat. Facts the ledger wrote from the very
  // messages being read here are the same words, not an earlier rule: counting them made the
  // curator answer "already a rule" for every correction.
  const facts = await prisma
    .$queryRawUnsafe<Array<{ text: string }>>(
      `SELECT "text" FROM "memory_facts" WHERE "spaceId" = $1 AND "status" IN ('confirmed', 'tentative')
         AND "area" IN ('lessons', 'preferences') AND "sourceRunId" IS DISTINCT FROM $2
         AND NOT ("sourceThreadId" IS NOT DISTINCT FROM $3 AND "createdAt" >= $4::timestamp)
       ORDER BY "updatedAt" DESC LIMIT 30`,
      input.spaceId,
      input.runId,
      input.threadId,
      // Columns hold UTC without a zone.
      input.since.toISOString().replace("Z", ""),
    )
    .catch(() => [] as Array<{ text: string }>);
  for (const fact of facts) rules.push(fact.text);
  return rules;
}

async function visibleSkills(
  prisma: PrismaClient,
  store: CuratorStore,
  owner: { spaceId: string; userId: string; botId: string },
): Promise<VisibleSkill[]> {
  const records = await listAgentSkillRecords(prisma, owner);
  const learned = new Set(
    (
      await store.learned(
        owner.spaceId,
        records.map((record) => record.id),
      )
    ).map((row) => row.skillId),
  );
  return records.map((record) => ({
    id: record.id,
    name: record.name,
    description: record.description,
    content: record.content,
    source: record.source,
    learned: learned.has(record.id),
  }));
}

/** What the model sees of the skills: all names; bodies for the few it may change. */
export function skillRefs(
  skills: readonly VisibleSkill[],
  input: { read: readonly string[]; task?: string },
): CuratorSkillRef[] {
  const read = new Set(input.read.map((name) => name.toLowerCase()));
  const withBody = (skill: VisibleSkill) =>
    skill.source === "user" &&
    (read.has(skill.name.toLowerCase()) ||
      read.has(skill.id.toLowerCase()) ||
      (input.task !== undefined &&
        overlap(input.task, `${skill.name} ${skill.description}`) >= 0.3));
  let bodies = 0;
  return skills
    .filter((skill) => skill.source !== "plugin")
    .slice(0, 60)
    .map((skill) => {
      const body =
        bodies < 3 && withBody(skill)
          ? (() => {
              const parsed = parseSkillMd(skill.content);
              bodies += 1;
              return "error" in parsed ? undefined : parsed.body;
            })()
          : undefined;
      return {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        learned: skill.learned,
        ...(body ? { body } : {}),
      };
    });
}

// --- Cards --------------------------------------------------------------------------------

export function cardBlock(row: ProposalRow, extra: { diff?: string; error?: string } = {}) {
  return {
    kind: "learned_skill",
    proposalId: row.id,
    action: row.action,
    ...(row.skillId ? { skillId: row.skillId } : {}),
    name: row.name,
    description: row.description,
    summary: row.summary,
    ...(extra.diff ? { diff: extra.diff } : {}),
    content: row.content.slice(0, CARD_CONTENT_MAX),
    mode: row.mode,
    ...(row.reason === "teach_done" ? { taught: true } : {}),
    status: row.status as LearnedSkillBlock["status"],
    ...(extra.error ? { error: extra.error } : {}),
  } satisfies LearnedSkillBlock;
}

/** The card is an ordinary bot message after the run; nothing waits on it. */
async function postCard(deps: CuratorDeps, row: ProposalRow, block: LearnedSkillBlock) {
  const { message, event } = await deps.prisma.$transaction(async (tx) => {
    const message = await createThreadMessageInTransaction(tx, {
      threadId: row.threadId,
      role: "bot",
      botId: row.botId,
      blocks: [block],
      clientNonce: `skill-curator:${row.id}`,
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: row.spaceId,
      threadId: row.threadId,
      botId: row.botId,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "bot", blocks: [block] },
    });
    return { message, event };
  });
  await deps.events?.notify(row.threadId, event.seq).catch(() => undefined);
  return message.id;
}

/** Rewrites the card with the proposal's new state. */
async function updateCard(deps: CuratorDeps, row: ProposalRow, block: LearnedSkillBlock) {
  if (!row.messageId) return;
  const seq = await deps.prisma.$transaction(async (tx) => {
    const message = await tx.message.findFirst({
      where: { id: row.messageId!, threadId: row.threadId },
      select: { id: true, blocks: true, botId: true },
    });
    if (!message) return undefined;
    const changed = changeMessageBlocks(message, (existing: MessageBlock) =>
      existing.kind === "learned_skill" && existing.proposalId === row.id
        ? { ...block, ...(existing.diff && !block.diff ? { diff: existing.diff } : {}) }
        : existing,
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
  if (seq !== undefined) await deps.events?.notify(row.threadId, seq).catch(() => undefined);
}

// --- Ledger de-duplication ----------------------------------------------------------------

/**
 * A procedure the owner corrected belongs in the skill, not also in the fact ledger: the same
 * sentence saved by the ledger writer in this run as a lesson or preference is retracted once
 * the skill is saved. Earlier facts are never touched.
 */
async function retractDuplicateFacts(
  prisma: PrismaClient,
  input: {
    spaceId: string;
    runId: string | null;
    quote: string | null;
    reason?: string;
    threadId?: string;
    botId?: string;
  },
): Promise<number> {
  // A lesson's steps are the skill: what the ledger saved from the lesson's own messages goes.
  if (input.reason === "teach_done" && input.threadId && input.botId) {
    const rows = await prisma
      .$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT f."id" FROM "memory_facts" f
         JOIN LATERAL (
           SELECT "createdAt" FROM "skill_teaching_sessions"
           WHERE "spaceId" = $1 AND "threadId" = $2 AND "botId" = $3 AND "status" IN ('active', 'saved')
           ORDER BY "createdAt" DESC LIMIT 1
         ) s ON true
         WHERE f."spaceId" = $1 AND f."sourceThreadId" = $2 AND f."createdAt" >= s."createdAt"
           AND f."area" IN ('lessons', 'preferences') AND f."status" IN ('confirmed', 'tentative')`,
        input.spaceId,
        input.threadId,
        input.botId,
      )
      .catch(() => [] as Array<{ id: string }>);
    return retract(
      prisma,
      input.spaceId,
      rows.map((row) => row.id),
    );
  }
  if (!input.runId || !input.quote || input.quote.length < 8) return 0;
  const facts = await prisma
    .$queryRawUnsafe<Array<{ id: string; text: string; quote: string }>>(
      `SELECT "id", "text", "quote" FROM "memory_facts" WHERE "spaceId" = $1 AND "sourceRunId" = $2
         AND "area" IN ('lessons', 'preferences') AND "status" IN ('confirmed', 'tentative')`,
      input.spaceId,
      input.runId,
    )
    .catch(() => [] as Array<{ id: string; text: string; quote: string }>);
  const ids = facts
    .filter(
      (fact) =>
        overlap(fact.quote, input.quote!) >= 0.6 ||
        input.quote!.toLowerCase().includes(fact.quote.toLowerCase()) ||
        fact.quote.toLowerCase().includes(input.quote!.toLowerCase()),
    )
    .map((fact) => fact.id);
  return retract(prisma, input.spaceId, ids);
}

async function retract(prisma: PrismaClient, spaceId: string, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  await prisma.$executeRawUnsafe(
    `UPDATE "memory_facts" SET "status" = 'retracted', "validTo" = now(), "updatedAt" = now()
     WHERE "spaceId" = $1 AND "id" = ANY($2::text[])`,
    spaceId,
    ids,
  );
  getLogger().info("skill.curator.ledger_dedup", { "skill.curator.retracted": ids.length });
  return ids.length;
}

// --- Applying a plan ----------------------------------------------------------------------

export interface JobContext {
  job: CuratorJob;
  botName: string | null;
  mode: SkillLearningMode;
  messages: CuratorOwnerMessage[];
  replies: string[];
  teachingTask?: string;
}

export interface CurateResult {
  outcome: "skipped" | "proposed" | "saved" | "failed";
  why?: string;
  proposalId?: string;
  skillId?: string;
  action?: "create" | "patch";
  usedModel: boolean;
  /** What the model said when it chose nothing (its own words, bounded). */
  modelReason?: string;
}

export async function curate(
  deps: CuratorDeps,
  store: CuratorStore,
  config: CuratorConfig,
  input: JobContext,
  model?: CuratorModel,
): Promise<CurateResult> {
  const { job } = input;
  if (input.mode === "off" || !job.botId)
    return { outcome: "skipped", why: "off", usedModel: false };
  const owner = { spaceId: job.spaceId, userId: job.userId, botId: job.botId };
  const skills = await visibleSkills(deps.prisma, store, owner);
  const since = new Date(
    Math.min(Date.now(), ...input.messages.map((message) => message.at.getTime())),
  );
  const rules = await knownRules(deps.prisma, {
    ...owner,
    runId: job.runId,
    threadId: job.threadId,
    since,
  });
  const curatorModel =
    model ??
    (await resolveModelEndpoint(deps, job.userId, config.model).then((endpoint) =>
      endpoint
        ? createOpenAiCuratorModel(endpoint, { timeoutMs: config.model.timeoutMs })
        : undefined,
    ));
  if (!curatorModel) return { outcome: "failed", why: "no_model", usedModel: false };
  const reason = job.reason as CuratorReason;
  const modelInput: CuratorInput = {
    today: new Date().toISOString().slice(0, 10),
    reason,
    botName: input.botName,
    ...(input.teachingTask ? { teachingTask: input.teachingTask } : {}),
    messages: input.messages,
    replies: input.replies,
    outline: job.outline as OutlineStep[],
    skills: skillRefs(skills, {
      read: skillsReadIn(job.outline as OutlineStep[]),
      ...(input.teachingTask ? { task: input.teachingTask } : {}),
    }),
    rules,
  };
  const proposal = await curatorModel.propose(modelInput);
  if (!proposal) return { outcome: "failed", why: "model_unusable", usedModel: false };
  const plan = planProposal(proposal, { reason, messages: input.messages, skills });
  if (plan.kind === "skip")
    return {
      outcome: "skipped",
      why: plan.why,
      usedModel: true,
      ...(proposal.action === "none" && proposal.reason
        ? { modelReason: proposal.reason.slice(0, 200) }
        : {}),
    };

  const open = await store.openProposalFor(job.spaceId, job.botId, {
    skillId: plan.kind === "patch" ? plan.skill.id : null,
    name: plan.kind === "create" ? plan.name : plan.skill.name,
  });
  if (open) return { outcome: "skipped", why: "already_proposed", usedModel: true };

  const auto = input.mode === "auto" && (plan.kind === "create" || plan.autoAllowed);
  const base = {
    spaceId: job.spaceId,
    botId: job.botId,
    userId: job.userId,
    threadId: job.threadId,
    runId: job.runId,
    mode: (auto ? "auto" : "ask") as "auto" | "ask",
    reason,
    quote: plan.quote.slice(0, 400),
  };
  const diff = plan.kind === "patch" ? plan.diff : undefined;

  if (!auto) {
    const row = await store.insertProposal({
      ...base,
      action: plan.kind,
      skillId: plan.kind === "patch" ? plan.skill.id : null,
      name: plan.kind === "create" ? plan.name : plan.skill.name,
      description: plan.kind === "create" ? plan.description : plan.skill.description,
      summary: plan.summary,
      content: plan.content,
      previousContent: plan.kind === "patch" ? plan.skill.content : null,
      status: "pending",
    });
    const messageId = await postCard(deps, row, cardBlock(row, diff ? { diff } : {}));
    await store.setProposalMessage(job.spaceId, row.id, messageId);
    return {
      outcome: "proposed",
      proposalId: row.id,
      action: plan.kind,
      ...(row.skillId ? { skillId: row.skillId } : {}),
      usedModel: true,
    };
  }

  // Auto: save now, then post the notice (with Discard to undo).
  const applied = await applyContent(deps, store, {
    owner,
    action: plan.kind,
    skillId: plan.kind === "patch" ? plan.skill.id : undefined,
    expectedContent: plan.kind === "patch" ? plan.skill.content : undefined,
    content: plan.content,
    provenance: {
      botName: input.botName,
      runId: job.runId,
      threadId: job.threadId,
      taught: reason === "teach_done",
    },
  });
  if ("error" in applied) return { outcome: "failed", why: applied.error, usedModel: true };
  const row = await store.insertProposal({
    ...base,
    action: plan.kind,
    skillId: applied.skillId,
    name: plan.kind === "create" ? plan.name : plan.skill.name,
    description: plan.kind === "create" ? plan.description : plan.skill.description,
    summary: plan.summary,
    content: plan.content,
    previousContent: plan.kind === "patch" ? plan.skill.content : null,
    status: "saved",
  });
  const messageId = await postCard(deps, row, cardBlock(row, diff ? { diff } : {}));
  await store.setProposalMessage(job.spaceId, row.id, messageId);
  await retractDuplicateFacts(deps.prisma, {
    spaceId: job.spaceId,
    runId: job.runId,
    quote: base.quote,
    reason,
    threadId: job.threadId,
    botId: job.botId,
  });
  return {
    outcome: "saved",
    proposalId: row.id,
    skillId: applied.skillId,
    action: plan.kind,
    usedModel: true,
  };
}

/** Writes a proposal's SKILL.md: a new skill (added to the agent's own list) or a change. */
async function applyContent(
  deps: CuratorDeps,
  store: CuratorStore,
  input: {
    owner: { spaceId: string; userId: string; botId: string };
    action: "create" | "patch";
    skillId?: string | undefined;
    /** For a change: the skill must still read this (nobody edited it since). */
    expectedContent?: string | undefined;
    content: string;
    provenance: { botName: string | null; runId: string | null; threadId: string; taught: boolean };
  },
): Promise<{ skillId: string } | { error: string }> {
  if (input.action === "create") {
    const created = await skillCreateFromTool(deps.prisma, input.owner, { content: input.content });
    if (typeof created.error === "string") return { error: created.error };
    const skillId = String(created.id);
    await store.recordLearned({
      skillId,
      spaceId: input.owner.spaceId,
      botId: input.owner.botId,
      botName: input.provenance.botName,
      runId: input.provenance.runId,
      threadId: input.provenance.threadId,
      taught: input.provenance.taught,
    });
    return { skillId };
  }
  if (!input.skillId) return { error: "Skill not found." };
  if (input.expectedContent !== undefined) {
    const current = await deps.prisma.agentSkill.findFirst({
      where: { id: input.skillId },
      select: { content: true },
    });
    if (!current) return { error: "Skill not found." };
    if (current.content !== input.expectedContent)
      return { error: "The skill changed since this was proposed. Open it to edit it yourself." };
  }
  const updated = await skillUpdateFromTool(deps.prisma, input.owner, {
    skillId: input.skillId,
    content: input.content,
  });
  if (typeof updated.error === "string") return { error: updated.error };
  await store.notePatch(input.owner.spaceId, input.skillId);
  return { skillId: input.skillId };
}

// --- Owner decisions (the card's buttons) -------------------------------------------------

export class ProposalNotFoundError extends Error {
  constructor() {
    super("Proposal not found");
    this.name = "ProposalNotFoundError";
  }
}

/**
 * Keep or discard from the card. Keep on a pending proposal saves it (with the owner's edited
 * SKILL.md when given); Discard on a pending one drops it; Discard on an Auto notice undoes the
 * save while the skill still reads what the curator wrote.
 */
export async function decideProposal(
  deps: CuratorDeps,
  store: CuratorStore,
  actor: { spaceId: string; userId: string },
  input: { proposalId: string; decision: "keep" | "discard"; content?: string | undefined },
): Promise<LearnedSkillBlock> {
  const row = await store.getProposal(actor.spaceId, input.proposalId);
  if (!row || row.userId !== actor.userId) throw new ProposalNotFoundError();
  const owner = { spaceId: row.spaceId, userId: row.userId, botId: row.botId };
  const finish = async (
    status: string,
    extra: { skillId?: string; content?: string; error?: string } = {},
  ) => {
    const next: ProposalRow = {
      ...row,
      status,
      ...(extra.skillId ? { skillId: extra.skillId } : {}),
      ...(extra.content ? { content: extra.content } : {}),
    };
    const block = cardBlock(next, extra.error ? { error: extra.error } : {});
    await updateCard(deps, next, block).catch((error) =>
      getLogger().warn("skill.curator.card_update_failed", {
        "error.type": error instanceof Error ? error.name : "unknown",
      }),
    );
    getLogger().info("skill.curator.decision", {
      "skill.curator.proposal": row.id,
      "skill.curator.decision": input.decision,
      "skill.curator.status": status,
      "skill.curator.action": row.action,
    });
    return block;
  };

  if (input.decision === "keep") {
    if (row.status !== "pending") return cardBlock(row);
    const content = input.content?.trim() ? input.content : row.content;
    if (holdsSecret(content))
      return finish("pending", { error: "That text looks like it holds a secret." });
    const applied = await applyContent(deps, store, {
      owner,
      action: row.action,
      skillId: row.skillId ?? undefined,
      expectedContent: row.action === "patch" ? (row.previousContent ?? undefined) : undefined,
      content,
      provenance: {
        botName: null,
        runId: row.runId,
        threadId: row.threadId,
        taught: row.reason === "teach_done",
      },
    });
    if ("error" in applied) return finish("pending", { error: applied.error });
    if (row.action === "create") {
      const name = parseSkillMd(content);
      const bot = await deps.prisma.bot
        .findFirst({ where: { id: row.botId }, select: { name: true } })
        .catch(() => null);
      await deps.prisma
        .$executeRawUnsafe(
          `UPDATE "learned_skills" SET "botName" = $2 WHERE "skillId" = $1`,
          applied.skillId,
          bot?.name ?? null,
        )
        .catch(() => 0);
      if (!("error" in name)) row.name = name.name;
    }
    if (
      !(await store.decideProposal(row.spaceId, row.id, ["pending"], "kept", {
        skillId: applied.skillId,
        content,
      }))
    )
      return cardBlock((await store.getProposal(row.spaceId, row.id)) ?? row);
    await retractDuplicateFacts(deps.prisma, {
      spaceId: row.spaceId,
      runId: row.runId,
      quote: row.quote,
      reason: row.reason,
      threadId: row.threadId,
      botId: row.botId,
    });
    return finish("kept", { skillId: applied.skillId, content });
  }

  // Discard.
  if (row.status === "pending") {
    await store.decideProposal(row.spaceId, row.id, ["pending"], "discarded");
    return finish("discarded");
  }
  if (row.status !== "saved" || !row.skillId) return cardBlock(row);
  const current = await deps.prisma.agentSkill.findFirst({
    where: { id: row.skillId },
    select: { content: true },
  });
  if (!current) {
    await store.decideProposal(row.spaceId, row.id, ["saved"], "reverted");
    return finish("reverted");
  }
  if (current.content !== row.content)
    return finish("saved", {
      error: "The skill was edited since; change it in the Skills window.",
    });
  if (row.action === "create") {
    const removed = await skillDeleteFromTool(deps.prisma, owner, { skillId: row.skillId });
    if (typeof removed.error === "string") return finish("saved", { error: removed.error });
  } else if (row.previousContent) {
    const restored = await skillUpdateFromTool(deps.prisma, owner, {
      skillId: row.skillId,
      content: row.previousContent,
    });
    if (typeof restored.error === "string") return finish("saved", { error: restored.error });
  }
  await store.decideProposal(row.spaceId, row.id, ["saved"], "reverted");
  return finish("reverted");
}

// --- Screen-taught skill -> agent skill ---------------------------------------------------

export interface TaughtPlaybook {
  whenToUse: string;
  inputs: string[];
  steps: string[];
  howToCheck: string;
  whatToReturn: string;
  approvalBoundaries: string;
  failureHandling: string;
}

/** A taught (screen-recorded) skill's playbook as a regular SKILL.md. No model involved. */
export function taughtSkillMd(input: { name: string; goal: string; playbook: TaughtPlaybook }): {
  name: string;
  description: string;
  content: string;
} {
  const name = cleanName(input.name || input.goal) || "Taught task";
  const description = cleanDescription(input.playbook.whenToUse || input.goal);
  const lines = [
    `# ${name}`,
    "",
    input.goal ? `Goal: ${input.goal}` : "",
    ...(input.playbook.inputs.length
      ? ["", "## Inputs", ...input.playbook.inputs.map((item) => `- ${item}`)]
      : []),
    "",
    "## Steps",
    ...input.playbook.steps.map((step, index) => `${index + 1}. ${step}`),
    ...(input.playbook.howToCheck ? ["", "## How to check", input.playbook.howToCheck] : []),
    ...(input.playbook.whatToReturn ? ["", "## What to return", input.playbook.whatToReturn] : []),
    ...(input.playbook.approvalBoundaries || input.playbook.failureHandling
      ? [
          "",
          "## Pitfalls",
          ...(input.playbook.approvalBoundaries
            ? [`- Ask first: ${input.playbook.approvalBoundaries}`]
            : []),
          ...(input.playbook.failureHandling
            ? [`- If it fails: ${input.playbook.failureHandling}`]
            : []),
        ]
      : []),
    "",
  ].filter((line, index, all) => !(line === "" && all[index - 1] === ""));
  return {
    name,
    description,
    content: buildSkillMd({ name, description, body: lines.join("\n") }),
  };
}
