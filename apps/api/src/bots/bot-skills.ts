/**
 * Fork: per-agent skills. The owner of an agent chooses which of its space's skills it may use;
 * the runtime side (catalog in the prompt, skill_read) is in @rakazo/adapters bot-skill-access.ts.
 */
import { ORPCError } from "@orpc/server";
import {
  botMaySeeSkill,
  changePinnedSkills,
  listAgentSkillRecords,
  loadPinnedSkillRefs,
  pinnedSkillsEnabled,
  readBotSkills,
  readPinnedSkills,
  setBotSkills,
  TooManyPinnedSkillsError,
  UnknownBotSkillsError,
} from "@rakazo/adapters";
import type { Actor, BotSkills, PinnedSkills, SkillAgents } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";

export function createBotSkillsService(prisma: PrismaClient) {
  /** Only the agent's owner, in the space it belongs to, reads or changes its skills. */
  async function ownedBot(actor: Actor, botId: string) {
    const bot = await prisma.bot.findFirst({
      where: { id: botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
      select: { id: true },
    });
    if (!bot) throw new IsolationError();
    return bot;
  }

  function spaceCatalog(actor: Actor) {
    return listAgentSkillRecords(prisma, { spaceId: actor.spaceId, userId: actor.userId });
  }

  return {
    async forBot(actor: Actor, input: { botId: string }): Promise<BotSkills> {
      await ownedBot(actor, input.botId);
      return readBotSkills(prisma, actor, input.botId);
    },

    // The write itself is shared with the bot_skills tool (adapters bot-skill-assign.ts).
    async setForBot(
      actor: Actor,
      input: { botId: string; all: boolean; skillIds?: string[] },
    ): Promise<BotSkills> {
      await ownedBot(actor, input.botId);
      try {
        return await setBotSkills(prisma, actor, input);
      } catch (error) {
        if (error instanceof UnknownBotSkillsError)
          throw new ORPCError("BAD_REQUEST", { message: error.message });
        throw error;
      }
    },

    // Fork (1.32): skills pinned for every agent of the caller in the Space. The set is the
    // caller's own (skills belong to the account that added them), so no agent is named.
    async pinned(actor: Actor): Promise<PinnedSkills> {
      const { skillIds, bytes, budgetBytes, overBudget } = await readPinnedSkills(prisma, actor);
      return { skillIds, bytes, budgetBytes, overBudget, enabled: pinnedSkillsEnabled() };
    },

    // The write is shared with the bot_skills tool (adapters bot-skill-assign.ts).
    async pin(actor: Actor, input: { skillId: string; pinned: boolean }): Promise<PinnedSkills> {
      try {
        const { skillIds, bytes, budgetBytes, overBudget } = await changePinnedSkills(
          prisma,
          actor,
          { skillIds: [input.skillId], pinned: input.pinned },
          { botId: null, runId: null, action: input.pinned ? "pin" : "unpin" },
        );
        return { skillIds, bytes, budgetBytes, overBudget, enabled: pinnedSkillsEnabled() };
      } catch (error) {
        if (error instanceof UnknownBotSkillsError || error instanceof TooManyPinnedSkillsError)
          throw new ORPCError("BAD_REQUEST", { message: error.message });
        throw error;
      }
    },

    async agents(actor: Actor): Promise<SkillAgents> {
      const pinned = new Set(await loadPinnedSkillRefs(prisma, actor));
      const [catalog, bots] = await Promise.all([
        spaceCatalog(actor),
        prisma.bot.findMany({
          where: { spaceId: actor.spaceId, archivedAt: null },
          select: {
            id: true,
            name: true,
            userId: true,
            skillSelection: {
              select: { excludedBuiltins: true, skills: { select: { skillId: true } } },
            },
          },
          orderBy: [{ position: "asc" }, { createdAt: "asc" }],
        }),
      ]);
      const selections = bots.map((bot) => ({
        bot: { id: bot.id, name: bot.name },
        selection: bot.skillSelection
          ? {
              skillIds: new Set(bot.skillSelection.skills.map((skill) => skill.skillId)),
              excludedBuiltins: new Set(bot.skillSelection.excludedBuiltins ?? []),
              // A pinned skill is open to the caller's own agents whatever was chosen for them.
              ...(bot.userId === actor.userId ? { pinned } : {}),
            }
          : null,
      }));
      return catalog.map((skill) => ({
        skillId: skill.id,
        bots: selections
          .filter(({ selection }) => botMaySeeSkill(selection, skill))
          .map(({ bot }) => bot),
      }));
    },
  };
}

export type BotSkillsService = ReturnType<typeof createBotSkillsService>;
