/**
 * Fork: per-agent skills. A bot with no selection row sees every skill of its space, as upstream
 * does. A bot with one sees only the stored skills chosen for it plus every built-in skill the
 * owner has not unticked; built-ins that ship later therefore stay on until unticked.
 *
 * Everything that shows a run its skills (the catalog in the prompt, `/name` expansion, routine
 * mentions, the task catalog) and everything that loads one (skill_read, skill_update,
 * skill_delete) goes through listAgentSkillRecords / skillReadFromTool, which call this filter
 * when the owner names a bot.
 */
import type { PrismaClient } from "@rakazo/db";
import { loadPinnedSkillRefs } from "../skill-autoload/pinned.js";

export const BUILTIN_SKILL_ID_PREFIX = "builtin:";

export type BotSkillSelection = {
  /** Stored (user or plugin) skill ids chosen for the bot. */
  skillIds: ReadonlySet<string>;
  /** Built-in skill names the owner unticked for the bot. */
  excludedBuiltins: ReadonlySet<string>;
  /**
   * Fork (1.32): skills pinned for every agent of the Space (stored id or `builtin:<name>`). They
   * stay open to the bot whatever was chosen or unticked for it.
   */
  pinned?: ReadonlySet<string>;
};

type SelectionClient = Pick<PrismaClient, "botSkillSelection">;

/** The bot's skill selection, or null when it uses every skill of its space. */
export async function loadBotSkillSelection(
  prisma: SelectionClient,
  botId: string | undefined | null,
): Promise<BotSkillSelection | null> {
  if (!botId) return null;
  // Test doubles of the Prisma client often omit this fork delegate: no delegate = no selection.
  const delegate = (prisma as Partial<SelectionClient>).botSkillSelection;
  if (!delegate?.findUnique) return null;
  const row = await delegate.findUnique({
    where: { botId },
    select: { excludedBuiltins: true, skills: { select: { skillId: true } } },
  });
  if (!row) return null;
  return {
    skillIds: new Set(row.skills.map((skill) => skill.skillId)),
    excludedBuiltins: new Set(row.excludedBuiltins ?? []),
  };
}

/**
 * What a run of the bot may use: its own selection plus the skills pinned for the Space. Null
 * when the bot has no selection (it uses every skill, so a pin adds nothing to the list).
 */
export async function loadBotSkillAccess(
  prisma: SelectionClient,
  owner: { spaceId: string; userId: string; botId?: string | null },
): Promise<BotSkillSelection | null> {
  const selection = await loadBotSkillSelection(prisma, owner.botId);
  if (!selection) return null;
  const pinned = await loadPinnedSkillRefs(prisma as never, owner);
  return pinned.length > 0 ? { ...selection, pinned: new Set(pinned) } : selection;
}

export function isBuiltinSkillId(id: string): boolean {
  return id.startsWith(BUILTIN_SKILL_ID_PREFIX);
}

/** Whether one skill (builtin `builtin:<name>` id or stored id) is open to the bot. */
export function botMaySeeSkill(
  selection: BotSkillSelection | null,
  skill: { id: string; name: string },
): boolean {
  if (!selection) return true;
  if (selection.pinned?.has(skill.id)) return true;
  if (isBuiltinSkillId(skill.id)) return !selection.excludedBuiltins.has(skill.name);
  return selection.skillIds.has(skill.id);
}

/** Keeps the skills open to the bot; every skill when it has no selection. */
export function filterSkillsForBot<T extends { id: string; name: string }>(
  selection: BotSkillSelection | null,
  skills: readonly T[],
): T[] {
  if (!selection) return [...skills];
  return skills.filter((skill) => botMaySeeSkill(selection, skill));
}

/**
 * A skill the bot itself created joins its selection, so a restricted bot can use what it just
 * wrote. A bot with no selection already sees it.
 */
export async function addSkillToBotSelection(
  prisma: Pick<PrismaClient, "botSkillSelection" | "botSkill">,
  input: { botId: string; skillId: string; spaceId: string; userId: string },
): Promise<boolean> {
  const delegate = (prisma as Partial<Pick<PrismaClient, "botSkillSelection">>).botSkillSelection;
  if (!delegate?.findUnique) return false;
  const selection = await delegate.findUnique({
    where: { botId: input.botId },
    select: { botId: true },
  });
  if (!selection) return false;
  await prisma.botSkill.upsert({
    where: { botId_skillId: { botId: input.botId, skillId: input.skillId } },
    create: {
      botId: input.botId,
      skillId: input.skillId,
      spaceId: input.spaceId,
      userId: input.userId,
    },
    update: {},
  });
  return true;
}
