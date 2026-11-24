import { randomUUID } from "node:crypto";
import { BUILTIN_AGENT_SKILLS, listAgentSkillRecords, skillReadFromTool } from "@rakazo/adapters";
import { formatSkillsCatalogInstruction } from "@rakazo/core";
import { asSystem, createDb, IsolationError, runAsTenant } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { createAgentSkillsService } from "./agent-skills.js";
import { createBotSkillsService } from "./bot-skills.js";

const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe
    : describe.skip;

describePostgres("per-agent skills under PostgreSQL row-level security (fork)", () => {
  it("shows and loads only the skills chosen for an agent, and cascades on delete", async () => {
    const db = createDb(runtimeUrl!);
    const fixtures = asSystem(db.prisma);
    const organizationId = randomUUID();
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const email = `${userId}@rakazo.test`;
    try {
      await fixtures.user.createMany({
        data: [
          { id: userId, name: "Owner", email },
          { id: otherUserId, name: "Other", email: `${otherUserId}@rakazo.test` },
        ],
      });
      await fixtures.organization.create({
        data: {
          id: organizationId,
          slug: organizationId,
          name: "Bot skills",
          createdAt: new Date(),
        },
      });
      const space = await fixtures.space.create({
        data: { id: randomUUID(), organizationId, name: "Space" },
      });
      const botA = await fixtures.bot.create({
        data: { spaceId: space.id, userId, name: "Agent A", color: "gray" },
      });
      const botB = await fixtures.bot.create({
        data: { spaceId: space.id, userId, name: "Agent B", color: "gray" },
      });
      const foreignBot = await fixtures.bot.create({
        data: { spaceId: space.id, userId: otherUserId, name: "Not yours", color: "gray" },
      });
      const actor = { spaceId: space.id, userId, email, isDeploymentOwner: false };
      const skills = createAgentSkillsService(db.prisma);
      const service = createBotSkillsService(db.prisma);
      const owner = (botId: string) => ({ spaceId: space.id, userId, botId });
      const firstBuiltin = BUILTIN_AGENT_SKILLS[0]!;

      await runAsTenant(actor, async () => {
        const x = await skills.create(actor, {
          name: "Skill X",
          description: "X steps",
          body: "MARK-X",
        });
        const y = await skills.create(actor, {
          name: "Skill Y",
          description: "Y steps",
          body: "MARK-Y",
        });

        // Default: no selection, every skill.
        expect(await service.forBot(actor, { botId: botA.id })).toEqual({
          botId: botA.id,
          all: true,
          skillIds: [],
        });

        const set = await service.setForBot(actor, {
          botId: botA.id,
          all: false,
          skillIds: [x.id, `builtin:${firstBuiltin.name}`],
        });
        expect(set.all).toBe(false);
        expect(set.skillIds.sort()).toEqual([x.id, `builtin:${firstBuiltin.name}`].sort());

        // The prompt catalog of A names X and the ticked built-in only; B's names both.
        const catalogA = formatSkillsCatalogInstruction(
          await listAgentSkillRecords(db.prisma, owner(botA.id)),
        );
        const catalogB = formatSkillsCatalogInstruction(
          await listAgentSkillRecords(db.prisma, owner(botB.id)),
        );
        expect(catalogA).toContain("Skill X");
        expect(catalogA).not.toContain("Skill Y");
        expect(catalogA).toContain(firstBuiltin.name);
        for (const builtin of BUILTIN_AGENT_SKILLS.slice(1)) {
          expect(catalogA).not.toContain(`- ${builtin.name}:`);
        }
        expect(catalogB).toContain("Skill X");
        expect(catalogB).toContain("Skill Y");

        // skill_read: A is refused Y by name and id, B reads it.
        const refused = await skillReadFromTool(db.prisma, owner(botA.id), { name: "Skill Y" });
        expect(refused.error).toMatch(/not assigned to this agent/);
        expect(JSON.stringify(refused)).not.toContain("MARK-Y");
        expect(
          (await skillReadFromTool(db.prisma, owner(botA.id), { skillId: y.id })).error,
        ).toMatch(/not assigned/);
        expect(
          (await skillReadFromTool(db.prisma, owner(botA.id), { name: "Skill X" })).content,
        ).toContain("MARK-X");
        expect(
          (await skillReadFromTool(db.prisma, owner(botB.id), { name: "Skill Y" })).content,
        ).toContain("MARK-Y");

        // The Skills window: which agents can use each skill.
        const agents = await service.agents(actor);
        const usedBy = (id: string) =>
          agents
            .find((entry) => entry.skillId === id)
            ?.bots.map((bot) => bot.name)
            .sort();
        expect(usedBy(x.id)).toEqual(expect.arrayContaining(["Agent A", "Agent B"]));
        expect(usedBy(y.id)).not.toContain("Agent A");
        expect(usedBy(y.id)).toContain("Agent B");

        // Only skills of the agent's space, only the owner's agents.
        await expect(
          service.setForBot(actor, { botId: botA.id, all: false, skillIds: ["no-such-skill"] }),
        ).rejects.toThrow(/not available/);
        await expect(service.forBot(actor, { botId: foreignBot.id })).rejects.toBeInstanceOf(
          IsolationError,
        );
        await expect(
          service.setForBot(actor, { botId: foreignBot.id, all: true }),
        ).rejects.toBeInstanceOf(IsolationError);

        // Deleting X removes it from A's choice; A stays restricted (does not widen to Y).
        await skills.remove(actor, x.id);
        const afterDelete = await service.forBot(actor, { botId: botA.id });
        expect(afterDelete.all).toBe(false);
        expect(afterDelete.skillIds).toEqual([`builtin:${firstBuiltin.name}`]);
        const namesA = (await listAgentSkillRecords(db.prisma, owner(botA.id))).map((s) => s.name);
        expect(namesA).not.toContain("Skill Y");

        // Back to all skills.
        expect((await service.setForBot(actor, { botId: botA.id, all: true })).all).toBe(true);
        const namesAll = (await listAgentSkillRecords(db.prisma, owner(botA.id))).map(
          (s) => s.name,
        );
        expect(namesAll).toContain("Skill Y");
      });

      // Deleting a bot removes its selection and chosen skills.
      await runAsTenant(actor, () =>
        service.setForBot(actor, { botId: botB.id, all: false, skillIds: [] }),
      );
      expect(await fixtures.botSkillSelection.count({ where: { botId: botB.id } })).toBe(1);
      await fixtures.bot.delete({ where: { id: botB.id } });
      expect(await fixtures.botSkillSelection.count({ where: { botId: botB.id } })).toBe(0);
    } finally {
      try {
        await fixtures.organization.deleteMany({ where: { id: organizationId } });
        await fixtures.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
      } finally {
        await db.prisma.$disconnect();
        await db.pool.end();
      }
    }
  });
});
