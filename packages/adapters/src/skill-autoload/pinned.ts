/**
 * Fork (1.32): Space-pinned skills, the "hard rules for every agent". A pinned skill is in the
 * prompt of every agent of its member in the Space, existing and future, in full and marked as
 * binding, whatever the agent's own skill selection says (bot-skill-access.ts) and whatever
 * RAKAZO_NEW_BOT_SKILLS gives a new agent. Table `space_pinned_skills` (raw SQL, no Prisma model;
 * migration 20270129090000_space_pinned_skills); every query runs in the caller's tenant context.
 *
 * Skills belong to the account that added them (see db/spaces/availability.ts), so the set is
 * kept per member of the Space: it reaches every agent that member owns there.
 */
import { byteLength } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { skillAutoloadConfig } from "./config.js";
import type { LoadableSkill } from "./skill-autoload.prompt.js";
import { renderPinnedSkills, skillBody } from "./skill-autoload.prompt.js";

type Sql = Pick<PrismaClient, "$queryRawUnsafe" | "$executeRawUnsafe">;
type SpaceOwner = { spaceId: string; userId: string };

const BUILTIN_PREFIX = "builtin:";
/** Most skills one Space member may pin; each is in every prompt, so the list stays short. */
export const PINNED_SKILLS_MAX = 20;

export function pinnedSkillsEnabled(env: Record<string, string | undefined> = process.env) {
  return skillAutoloadConfig(env).pinned.enabled;
}

/**
 * The pinned skill refs (stored id or `builtin:<name>`) of a member's agents in a Space, in the
 * order they were pinned. Never throws: a database that does not have the table yet, or a test
 * double without raw SQL, means nothing is pinned.
 */
export async function loadPinnedSkillRefs(
  prisma: Partial<Sql>,
  owner: SpaceOwner,
  options: { ignoreSwitch?: boolean } = {},
): Promise<string[]> {
  if (!options.ignoreSwitch && !pinnedSkillsEnabled()) return [];
  if (typeof prisma.$queryRawUnsafe !== "function") return [];
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ skillRef: string }>>(
      `SELECT "skillRef" FROM "space_pinned_skills" WHERE "spaceId" = $1 AND "userId" = $2 ORDER BY "position" ASC, "createdAt" ASC, "skillRef" ASC`,
      owner.spaceId,
      owner.userId,
    );
    return Array.isArray(rows)
      ? rows.map((row) => row?.skillRef).filter((ref): ref is string => typeof ref === "string")
      : [];
  } catch (error) {
    getLogger().warn("skills.pinned.unavailable", {
      "space.id": owner.spaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Replaces the pinned set with `refs`, in that order. The caller has resolved every ref against
 * the member's skills of the Space and checked that it may change them.
 */
export async function writePinnedSkillRefs(
  prisma: Sql,
  owner: SpaceOwner,
  refs: readonly string[],
  pinnedByBotId: string | null,
): Promise<void> {
  const wanted = [...new Set(refs)];
  await prisma.$executeRawUnsafe(
    `DELETE FROM "space_pinned_skills" WHERE "spaceId" = $1 AND "userId" = $2 AND NOT ("skillRef" = ANY($3::text[]))`,
    owner.spaceId,
    owner.userId,
    wanted,
  );
  for (const [position, ref] of wanted.entries()) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "space_pinned_skills" ("spaceId", "userId", "skillRef", "skillId", "pinnedByBotId", "position")
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT ("spaceId", "userId", "skillRef") DO UPDATE SET "position" = EXCLUDED."position"`,
      owner.spaceId,
      owner.userId,
      ref,
      ref.startsWith(BUILTIN_PREFIX) ? null : ref,
      pinnedByBotId,
      position,
    );
  }
}

/** The pinned skills among `skills`, in pinned order. A ref whose skill is gone is skipped. */
export function pinnedAmong<T extends { id: string }>(
  skills: readonly T[],
  refs: readonly string[],
): T[] {
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  return refs.flatMap((ref) => {
    const skill = byId.get(ref);
    return skill ? [skill] : [];
  });
}

export interface PinnedSkillsState {
  skillIds: string[];
  /** Bytes of the pinned bodies, and the budget they share in every run. */
  bytes: number;
  budgetBytes: number;
  /** Pinned skills that do not fit the budget in full (cut, or named only). */
  overBudget: string[];
}

/** What the settings screen and the bot_skills tool report about the pinned set. */
export function pinnedSkillsState(
  catalog: readonly LoadableSkill[],
  refs: readonly string[],
): PinnedSkillsState {
  const pinned = pinnedAmong(catalog, refs);
  const budgetBytes = skillAutoloadConfig().pinned.maxBytes;
  const block = renderPinnedSkills(pinned, budgetBytes);
  return {
    skillIds: pinned.map((skill) => skill.id),
    bytes: pinned.reduce((sum, skill) => sum + byteLength(skillBody(skill)), 0),
    budgetBytes,
    overBudget: [
      ...block.skills.filter((skill) => skill.truncated).map((skill) => skill.name),
      ...block.omitted,
    ],
  };
}

/** Counts only: skill names and text stay out of the log. */
export function logPinnedSkillsChanged(input: {
  spaceId: string;
  userId: string;
  actorBotId: string | null;
  runId: string | null;
  action: string;
  added: number;
  removed: number;
  total: number;
}): void {
  getLogger().info("skills.pinned_changed", input);
}
