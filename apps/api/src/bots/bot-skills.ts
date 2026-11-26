/**
 * Fork: per-agent skills. The owner of an agent chooses which of its space's skills it may use;
 * the runtime side (catalog in the prompt, skill_read) is in @rakazo/adapters bot-skill-access.ts.
 */
import { ORPCError } from "@orpc/server";
import {
  botMaySeeSkill,
  listAgentSkillRecords,
  readBotSkills,
  setBotSkills,
  UnknownBotSkillsError,
} from "@rakazo/adapters";
import type { Actor, BotSkills, SkillAgents } from "@rakazo/contracts";
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

    async agents(actor: Actor): Promise<SkillAgents> {
      const [catalog, bots] = await Promise.all([
        spaceCatalog(actor),
        prisma.bot.findMany({
          where: { spaceId: actor.spaceId, archivedAt: null },
          select: {
            id: true,
            name: true,
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
