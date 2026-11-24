/**
 * Fork: the skill curator's tables (raw SQL, no Prisma models; migration
 * 20270120090000_skill_learning). Every query runs in the caller's tenant context, so row
 * security keeps it inside one Space.
 */
import { randomUUID } from "node:crypto";
import type { SkillLearningMode } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import type { OutlineStep } from "./outline.js";

type Sql = Pick<PrismaClient, "$queryRawUnsafe" | "$executeRawUnsafe">;

export interface CuratorJob {
  runId: string;
  spaceId: string;
  threadId: string;
  botId: string | null;
  userId: string;
  reason: string;
  outline: OutlineStep[];
  attempts: number;
}

export interface ProposalRow {
  id: string;
  spaceId: string;
  botId: string;
  userId: string;
  threadId: string;
  runId: string | null;
  messageId: string | null;
  action: "create" | "patch";
  skillId: string | null;
  name: string;
  description: string;
  summary: string;
  content: string;
  previousContent: string | null;
  mode: "ask" | "auto";
  reason: string;
  quote: string | null;
  status: string;
  createdAt: Date;
}

export interface LearnedRow {
  skillId: string;
  spaceId: string;
  botId: string | null;
  botName: string | null;
  runId: string | null;
  threadId: string | null;
  taught: boolean;
  patches: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface TeachingRow {
  id: string;
  spaceId: string;
  threadId: string;
  botId: string;
  userId: string;
  task: string;
  startSeq: number;
  status: string;
  createdAt: Date;
}

const MODES = new Set(["off", "ask", "auto"]);
const asMode = (value: unknown): SkillLearningMode | null =>
  typeof value === "string" && MODES.has(value) ? (value as SkillLearningMode) : null;

export const spaceSettingId = (spaceId: string) => `space:${spaceId}`;

export function createCuratorStore(prisma: Sql) {
  const q = <T>(sql: string, ...values: unknown[]) => prisma.$queryRawUnsafe<T[]>(sql, ...values);
  const x = (sql: string, ...values: unknown[]) => prisma.$executeRawUnsafe(sql, ...values);

  return {
    // --- Modes ---------------------------------------------------------------------------
    async modes(
      spaceId: string,
      botId: string | null,
    ): Promise<{ space: SkillLearningMode | null; bot: SkillLearningMode | null }> {
      const ids = botId ? [spaceSettingId(spaceId), botId] : [spaceSettingId(spaceId)];
      const rows = await q<{ id: string; mode: string }>(
        `SELECT "id", "mode" FROM "skill_learning_settings" WHERE "spaceId" = $1 AND "id" = ANY($2::text[])`,
        spaceId,
        ids,
      );
      const byId = new Map(rows.map((row) => [row.id, asMode(row.mode)]));
      return {
        space: byId.get(spaceSettingId(spaceId)) ?? null,
        bot: botId ? (byId.get(botId) ?? null) : null,
      };
    },

    async setMode(spaceId: string, botId: string | null, mode: SkillLearningMode | null) {
      const id = botId ?? spaceSettingId(spaceId);
      if (!mode) {
        await x(
          `DELETE FROM "skill_learning_settings" WHERE "id" = $1 AND "spaceId" = $2`,
          id,
          spaceId,
        );
        return;
      }
      await x(
        `INSERT INTO "skill_learning_settings" ("id", "spaceId", "botId", "mode", "updatedAt")
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT ("id") DO UPDATE SET "mode" = EXCLUDED."mode", "updatedAt" = now()`,
        id,
        spaceId,
        botId,
        mode,
      );
    },

    // --- Jobs ----------------------------------------------------------------------------
    /** Records a run for the curator. False when it was already recorded. */
    async claimJob(job: Omit<CuratorJob, "attempts">): Promise<boolean> {
      const count = await x(
        `INSERT INTO "skill_learning_jobs" ("runId", "spaceId", "threadId", "botId", "userId", "reason", "outline")
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) ON CONFLICT ("runId") DO NOTHING`,
        job.runId,
        job.spaceId,
        job.threadId,
        job.botId,
        job.userId,
        job.reason,
        JSON.stringify(job.outline),
      );
      return count > 0;
    },

    /** Moves a pending (or failed, under 3 attempts) job to running; false if another took it. */
    async startJob(spaceId: string, runId: string): Promise<boolean> {
      const count = await x(
        `UPDATE "skill_learning_jobs" SET "status" = 'running', "attempts" = "attempts" + 1, "updatedAt" = now()
         WHERE "runId" = $1 AND "spaceId" = $2 AND ("status" = 'pending' OR ("status" = 'failed' AND "attempts" < 3))`,
        runId,
        spaceId,
      );
      return count > 0;
    },

    async finishJob(spaceId: string, runId: string, status: "done" | "failed", error?: string) {
      await x(
        `UPDATE "skill_learning_jobs" SET "status" = $3, "error" = $4, "updatedAt" = now() WHERE "runId" = $1 AND "spaceId" = $2`,
        runId,
        spaceId,
        status,
        error?.slice(0, 500) ?? null,
      );
    },

    /** Jobs that never finished (process exit) or failed, older than `olderThanMs`. */
    async staleJobs(spaceId: string, olderThanMs: number, limit: number): Promise<CuratorJob[]> {
      return q<CuratorJob>(
        `SELECT "runId", "spaceId", "threadId", "botId", "userId", "reason", "outline", "attempts"
         FROM "skill_learning_jobs"
         WHERE "spaceId" = $1 AND "updatedAt" < now() - ($2::int * interval '1 millisecond')
           AND ("status" IN ('pending', 'running') OR ("status" = 'failed' AND "attempts" < 3))
         ORDER BY "createdAt" ASC LIMIT $3`,
        spaceId,
        olderThanMs,
        limit,
      );
    },

    // --- Proposals -----------------------------------------------------------------------
    async insertProposal(
      row: Omit<ProposalRow, "id" | "createdAt" | "messageId" | "status"> & { status: string },
    ): Promise<ProposalRow> {
      const id = randomUUID();
      const [stored] = await q<ProposalRow>(
        `INSERT INTO "skill_learning_proposals"
           ("id", "spaceId", "botId", "userId", "threadId", "runId", "action", "skillId", "name", "description",
            "summary", "content", "previousContent", "mode", "reason", "quote", "status", "decidedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::text, CASE WHEN $17::text = 'pending' THEN NULL ELSE now() END)
         RETURNING *`,
        id,
        row.spaceId,
        row.botId,
        row.userId,
        row.threadId,
        row.runId,
        row.action,
        row.skillId,
        row.name,
        row.description,
        row.summary,
        row.content,
        row.previousContent,
        row.mode,
        row.reason,
        row.quote,
        row.status,
      );
      if (!stored) throw new Error("proposal not stored");
      return stored;
    },

    async getProposal(spaceId: string, id: string): Promise<ProposalRow | undefined> {
      const [row] = await q<ProposalRow>(
        `SELECT * FROM "skill_learning_proposals" WHERE "id" = $1 AND "spaceId" = $2`,
        id,
        spaceId,
      );
      return row;
    },

    async setProposalMessage(spaceId: string, id: string, messageId: string) {
      await x(
        `UPDATE "skill_learning_proposals" SET "messageId" = $3 WHERE "id" = $1 AND "spaceId" = $2`,
        id,
        spaceId,
        messageId,
      );
    },

    /** Moves a proposal from `from` to `to`; false when it was no longer in `from`. */
    async decideProposal(
      spaceId: string,
      id: string,
      from: readonly string[],
      to: string,
      patch: { skillId?: string; content?: string } = {},
    ): Promise<boolean> {
      const count = await x(
        `UPDATE "skill_learning_proposals"
         SET "status" = $4, "decidedAt" = now(),
             "skillId" = COALESCE($5, "skillId"), "content" = COALESCE($6, "content")
         WHERE "id" = $1 AND "spaceId" = $2 AND "status" = ANY($3::text[])`,
        id,
        spaceId,
        [...from],
        to,
        patch.skillId ?? null,
        patch.content ?? null,
      );
      return count > 0;
    },

    /** Open (pending) proposals for one skill name or id in a thread: no second card for the same. */
    async openProposalFor(
      spaceId: string,
      botId: string,
      key: { skillId?: string | null; name?: string },
    ): Promise<ProposalRow | undefined> {
      const [row] = await q<ProposalRow>(
        `SELECT * FROM "skill_learning_proposals"
         WHERE "spaceId" = $1 AND "botId" = $2 AND "status" = 'pending'
           AND (("skillId" IS NOT NULL AND "skillId" = $3) OR lower("name") = lower($4))
         ORDER BY "createdAt" DESC LIMIT 1`,
        spaceId,
        botId,
        key.skillId ?? null,
        key.name ?? "",
      );
      return row;
    },

    // --- Learned skills ------------------------------------------------------------------
    async recordLearned(row: Omit<LearnedRow, "createdAt" | "updatedAt" | "patches">) {
      await x(
        `INSERT INTO "learned_skills" ("skillId", "spaceId", "botId", "botName", "runId", "threadId", "taught")
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT ("skillId") DO NOTHING`,
        row.skillId,
        row.spaceId,
        row.botId,
        row.botName,
        row.runId,
        row.threadId,
        row.taught,
      );
    },

    async notePatch(spaceId: string, skillId: string) {
      await x(
        `UPDATE "learned_skills" SET "patches" = "patches" + 1, "updatedAt" = now() WHERE "skillId" = $1 AND "spaceId" = $2`,
        skillId,
        spaceId,
      );
    },

    async learned(spaceId: string, skillIds?: readonly string[]): Promise<LearnedRow[]> {
      return skillIds
        ? q<LearnedRow>(
            `SELECT * FROM "learned_skills" WHERE "spaceId" = $1 AND "skillId" = ANY($2::text[])`,
            spaceId,
            [...skillIds],
          )
        : q<LearnedRow>(
            `SELECT * FROM "learned_skills" WHERE "spaceId" = $1 ORDER BY "createdAt" DESC`,
            spaceId,
          );
    },

    // --- Teaching sessions ---------------------------------------------------------------
    async activeTeaching(
      spaceId: string,
      threadId: string,
      botId: string,
    ): Promise<TeachingRow | undefined> {
      const [row] = await q<TeachingRow>(
        `SELECT * FROM "skill_teaching_sessions" WHERE "spaceId" = $1 AND "threadId" = $2 AND "botId" = $3 AND "status" = 'active' LIMIT 1`,
        spaceId,
        threadId,
        botId,
      );
      return row;
    },

    /** Opens a session unless one is open; returns the open one. */
    async startTeaching(
      row: Pick<TeachingRow, "spaceId" | "threadId" | "botId" | "userId" | "task" | "startSeq">,
    ): Promise<TeachingRow> {
      await x(
        `INSERT INTO "skill_teaching_sessions" ("id", "spaceId", "threadId", "botId", "userId", "task", "startSeq")
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        randomUUID(),
        row.spaceId,
        row.threadId,
        row.botId,
        row.userId,
        row.task.slice(0, 300),
        row.startSeq,
      );
      const open = await this.activeTeaching(row.spaceId, row.threadId, row.botId);
      if (!open) throw new Error("teaching session not stored");
      return open;
    },

    async endTeaching(
      spaceId: string,
      id: string,
      status: "saved" | "cancelled",
    ): Promise<boolean> {
      const count = await x(
        `UPDATE "skill_teaching_sessions" SET "status" = $3, "endedAt" = now() WHERE "id" = $1 AND "spaceId" = $2 AND "status" = 'active'`,
        id,
        spaceId,
        status,
      );
      return count > 0;
    },
  };
}

export type CuratorStore = ReturnType<typeof createCuratorStore>;
