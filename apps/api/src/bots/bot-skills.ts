/**
 * Fork: per-agent skills. The owner of an agent chooses which of its space's skills it may use;
 * the runtime side (catalog in the prompt, skill_read) is in @rakazo/adapters bot-skill-access.ts.
 */
import { ORPCError } from "@orpc/server";
import {
  botMaySeeSkill,
  isBuiltinSkillId,
  listAgentSkillRecords,
  loadBotSkillSelection,
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

  async function read(actor: Actor, botId: string): Promise<BotSkills> {
    const [selection, catalog] = await Promise.all([
      loadBotSkillSelection(prisma, botId),
      spaceCatalog(actor),
    ]);
    if (!selection) return { botId, all: true, skillIds: [] };
    return {
      botId,
      all: false,
      skillIds: catalog.filter((skill) => botMaySeeSkill(selection, skill)).map((s) => s.id),
    };
  }

  return {
    async forBot(actor: Actor, input: { botId: string }): Promise<BotSkills> {
      await ownedBot(actor, input.botId);
      return read(actor, input.botId);
    },

    async setForBot(
      actor: Actor,
      input: { botId: string; all: boolean; skillIds?: string[] },
    ): Promise<BotSkills> {
      await ownedBot(actor, input.botId);
      if (input.all) {
        // Deleting the selection removes its chosen skills (bot_skills cascades).
        await prisma.botSkillSelection.deleteMany({ where: { botId: input.botId } });
        return read(actor, input.botId);
      }
      const catalog = await spaceCatalog(actor);
      const byId = new Map(catalog.map((skill) => [skill.id, skill]));
      const wanted = [...new Set(input.skillIds ?? [])];
      const unknown = wanted.filter((id) => !byId.has(id));
      if (unknown.length > 0) {
        throw new ORPCError("BAD_REQUEST", {
          message: "Some of those skills are not available in this agent's space.",
        });
      }
      const chosen = new Set(wanted);
      const storedIds = wanted.filter((id) => !isBuiltinSkillId(id));
      const excludedBuiltins = catalog
        .filter((skill) => isBuiltinSkillId(skill.id) && !chosen.has(skill.id))
        .map((skill) => skill.name);
      await prisma.$transaction(async (tx) => {
        await tx.botSkillSelection.upsert({
          where: { botId: input.botId },
          create: {
            botId: input.botId,
            spaceId: actor.spaceId,
            userId: actor.userId,
            excludedBuiltins,
          },
          update: { excludedBuiltins },
        });
        await tx.botSkill.deleteMany({ where: { botId: input.botId } });
        if (storedIds.length > 0) {
          await tx.botSkill.createMany({
            data: storedIds.map((skillId) => ({
              botId: input.botId,
              skillId,
              spaceId: actor.spaceId,
              userId: actor.userId,
            })),
          });
        }
      });
      return read(actor, input.botId);
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
