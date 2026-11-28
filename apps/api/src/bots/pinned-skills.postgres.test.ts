import { randomUUID } from "node:crypto";
import {
  botSkillsFromTool,
  listAgentSkillRecords,
  loadPinnedSkillRefs,
  PINNED_SKILLS_MAX,
  pinnedAmong,
  renderPinnedSkills,
  skillReadFromTool,
} from "@rakazo/adapters";
import {
  asSystem,
  createDb,
  createRepos,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSkillsService } from "./agent-skills.js";
import { createBotSkillsService } from "./bot-skills.js";

const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe
    : describe.skip;

/**
 * Fork (1.32): skills pinned for every agent of a Space member, under row-level security. Set by
 * the owner (agentSkills/pin) or by an agent that manages agents (bot_skills pin/unpin); read by
 * run assembly for every agent, existing and created later, whatever its own selection.
 */
describePostgres("Space-pinned skills (PostgreSQL, fork)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("pins for every agent, existing and future, within one member's Space", async () => {
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
        data: { id: organizationId, slug: organizationId, name: "Pinned", createdAt: new Date() },
      });
      const space = await fixtures.space.create({
        data: { id: randomUUID(), organizationId, name: "Space" },
      });
      const otherSpace = await fixtures.space.create({
        data: { id: randomUUID(), organizationId, name: "Other space" },
      });
      const manager = await fixtures.bot.create({
        data: { spaceId: space.id, userId, name: "Manager", color: "gray" },
      });
      const worker = await fixtures.bot.create({
        data: { spaceId: space.id, userId, name: "Worker", color: "gray" },
      });
      const actor = { spaceId: space.id, userId, email, isDeploymentOwner: false };
      const otherMember = {
        spaceId: space.id,
        userId: otherUserId,
        email: `${otherUserId}@rakazo.test`,
        isDeploymentOwner: false,
      };
      const elsewhere = { ...actor, spaceId: otherSpace.id };
      const skills = createAgentSkillsService(db.prisma);
      const service = createBotSkillsService(db.prisma);
      const access = (botId: string) => ({ spaceId: space.id, userId, botId });
      const run = {
        spaceId: space.id,
        userId,
        botId: manager.id,
        groupId: null,
        threadId: "thread",
        runId: "run",
      };
      const tool = (args: Record<string, unknown>) =>
        botSkillsFromTool({ prisma: db.prisma }, run, args);
      const pinnedBlock = async (botId: string) =>
        renderPinnedSkills(
          pinnedAmong(
            await listAgentSkillRecords(db.prisma, access(botId)),
            await loadPinnedSkillRefs(db.prisma, { spaceId: space.id, userId }),
          ),
          16 * 1024,
        ).text ?? "";

      const made = await runAsTenant(actor, async () => {
        const house = await skills.create(actor, {
          name: "House Rules",
          description: "Rules every agent follows",
          body: "MARK-HOUSE",
        });
        const extra = await skills.create(actor, {
          name: "Extra Steps",
          description: "Optional steps",
          body: "MARK-EXTRA",
        });
        // The worker is limited to no stored skill at all (the built-ins-only shape).
        await service.setForBot(actor, { botId: worker.id, all: false, skillIds: [] });
        expect(
          (await skillReadFromTool(db.prisma, access(worker.id), { name: "House Rules" })).error,
        ).toMatch(/not assigned/);
        expect(await service.pinned(actor)).toMatchObject({ skillIds: [], enabled: true });

        // 1. The owner pins through the RPC.
        const pinned = await service.pin(actor, { skillId: house.id, pinned: true });
        expect(pinned.skillIds).toEqual([house.id]);
        expect(pinned.bytes).toBe(Buffer.byteLength("MARK-HOUSE"));
        expect(pinned.overBudget).toEqual([]);

        // Every agent now has it: in its list, readable, and in the pinned block.
        for (const bot of [manager, worker]) {
          const names = (await listAgentSkillRecords(db.prisma, access(bot.id))).map((s) => s.name);
          expect(names, bot.name).toContain("House Rules");
          expect(await pinnedBlock(bot.id), bot.name).toContain("MARK-HOUSE");
        }
        expect(
          (await skillReadFromTool(db.prisma, access(worker.id), { name: "House Rules" })).content,
        ).toContain("MARK-HOUSE");
        // The unpinned skill stays closed to the limited agent.
        expect(
          (await listAgentSkillRecords(db.prisma, access(worker.id))).map((s) => s.name),
        ).not.toContain("Extra Steps");
        // The Skills window counts the limited agent among the pinned skill's users.
        const usedBy = (await service.agents(actor)).find((entry) => entry.skillId === house.id);
        expect(usedBy?.bots.map((bot) => bot.name).sort()).toEqual(["Manager", "Worker"]);
        return { house, extra };
      });

      // The "fresh" agent stands for one limited to no stored skill (a later test creates a real one).
      const fresh = await fixtures.bot.create({
        data: { spaceId: space.id, userId, name: "Fresh", color: "gray" },
      });
      await runAsTenant(actor, async () => {
        await service.setForBot(actor, { botId: fresh.id, all: false, skillIds: [] });
        expect(await pinnedBlock(fresh.id)).toContain("MARK-HOUSE");

        // 3. An agent that manages agents pins, lists and unpins through bot_skills.
        const listed = await tool({ action: "list_pinned" });
        expect(listed.pinned).toEqual([{ id: made.house.id, name: "House Rules" }]);
        const added = await tool({ action: "pin", skills: ["extra steps"] });
        expect(added).toMatchObject({ ok: true, added: ["Extra Steps"], removed: [] });
        expect((added.pinned as Array<{ name: string }>).map((s) => s.name)).toEqual([
          "House Rules",
          "Extra Steps",
        ]);
        expect(await pinnedBlock(fresh.id)).toContain("MARK-EXTRA");
        expect(await tool({ action: "pin", skills: ["Extra Steps"] })).toMatchObject({
          added: [],
          note: expect.stringContaining("Nothing changed"),
        });
        // Nothing is guessed, nothing changes on a wrong name, and a bot target is refused.
        const wrong = await tool({ action: "pin", skills: ["House Rulez"] });
        expect(wrong.error).toMatch(/No skill in this space matches "House Rulez" \(did you mean/);
        expect(
          (await tool({ action: "pin", skills: ["Extra Steps"], bot_name: "Worker" })).error,
        ).toMatch(/every bot/);
        expect((await tool({ action: "pin" })).error).toMatch(/Pass skills/);
        const removed = await tool({ action: "unpin", skills: [made.extra.id] });
        expect(removed).toMatchObject({ ok: true, removed: ["Extra Steps"] });
        expect(await pinnedBlock(fresh.id)).not.toContain("MARK-EXTRA");
        expect((await service.pinned(actor)).skillIds).toEqual([made.house.id]);

        // The switch: stored pins stay listed, but no run reads them.
        vi.stubEnv("SKILL_PINNED", "0");
        expect(await loadPinnedSkillRefs(db.prisma, { spaceId: space.id, userId })).toEqual([]);
        expect(await service.pinned(actor)).toMatchObject({
          skillIds: [made.house.id],
          enabled: false,
        });
        expect(
          (await skillReadFromTool(db.prisma, access(worker.id), { name: "House Rules" })).error,
        ).toMatch(/not assigned/);
        vi.unstubAllEnvs();

        // A skill that is not the caller's own in this Space cannot be pinned.
        await expect(
          service.pin(actor, { skillId: "no-such-skill", pinned: true }),
        ).rejects.toThrow(/not available/);
      });

      // Another member of the Space, and the same member in another Space, see nothing of it.
      await runAsTenant(otherMember, async () => {
        expect((await service.pinned(otherMember)).skillIds).toEqual([]);
        await expect(
          service.pin(otherMember, { skillId: made.house.id, pinned: true }),
        ).rejects.toThrow(/not available/);
      });
      await runAsTenant(elsewhere, async () => {
        expect((await service.pinned(elsewhere)).skillIds).toEqual([]);
        // Row security: the other Space's tenant cannot read this Space's rows at all.
        expect(
          await db.prisma.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM "space_pinned_skills"`),
        ).toEqual([]);
      });

      // The cap: each pinned skill is in every prompt.
      await runAsTenant(actor, async () => {
        const many = [];
        for (let index = 0; index < PINNED_SKILLS_MAX; index++) {
          many.push(
            await skills.create(actor, {
              name: `Filler ${index}`,
              description: "Filler",
              body: "x",
            }),
          );
        }
        const over = await tool({ action: "pin", skills: many.map((skill) => skill.id) });
        expect(over.error).toMatch(new RegExp(`At most ${PINNED_SKILLS_MAX} skills`));
        expect((await service.pinned(actor)).skillIds).toEqual([made.house.id]);

        // Deleting a pinned skill removes its pin.
        await skills.remove(actor, made.house.id);
        expect((await service.pinned(actor)).skillIds).toEqual([]);
      });
      expect(
        await fixtures.$queryRawUnsafe<unknown[]>(
          `SELECT 1 FROM "space_pinned_skills" WHERE "spaceId" = $1`,
          space.id,
        ),
      ).toEqual([]);
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

  it("an agent created later, with built-in skills only, follows what was pinned before it existed", async () => {
    const db = createDb(runtimeUrl!);
    const address = `pinned-skills-${randomUUID()}`;
    // A member with a Space of their own, as sign-up makes one.
    const owner = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(db.prisma, { provider: "test", address }),
    );
    const actor = { ...owner, email: "pinned@example.test", isDeploymentOwner: false };
    try {
      const skills = createAgentSkillsService(db.prisma);
      const service = createBotSkillsService(db.prisma);
      await runAsTenant(actor, async () => {
        const house = await skills.create(actor, {
          name: "House Rules",
          description: "Rules every agent follows",
          body: "MARK-HOUSE",
        });
        await skills.create(actor, { name: "Extra Steps", description: "Optional", body: "x" });
        await service.pin(actor, { skillId: house.id, pinned: true });
      });
      // Every creation path goes through createBot; with this setting it stores an empty selection.
      vi.stubEnv("RAKAZO_NEW_BOT_SKILLS", "builtins");
      const fresh = await runAsTenant(actor, () =>
        createRepos(db.prisma).createBot(actor, {
          name: "Fresh",
          description: "",
          instructions: "",
          notifyOnFinish: true,
        }),
      );
      vi.unstubAllEnvs();
      expect(
        await asSystem(db.prisma).botSkillSelection.findUnique({
          where: { botId: fresh.id },
          select: { excludedBuiltins: true, skills: { select: { skillId: true } } },
        }),
      ).toEqual({ excludedBuiltins: [], skills: [] });
      await runAsTenant(actor, async () => {
        const access = { spaceId: owner.spaceId, userId: owner.userId, botId: fresh.id };
        const open = await listAgentSkillRecords(db.prisma, access);
        expect(open.map((skill) => skill.name)).toContain("House Rules");
        expect(open.map((skill) => skill.name)).not.toContain("Extra Steps");
        const block = renderPinnedSkills(
          pinnedAmong(open, await loadPinnedSkillRefs(db.prisma, owner)),
          16 * 1024,
        );
        expect(block.text).toContain("MARK-HOUSE");
        expect(block.skills.map((skill) => skill.name)).toEqual(["House Rules"]);
        expect(
          (await skillReadFromTool(db.prisma, access, { name: "House Rules" })).content,
        ).toContain("MARK-HOUSE");
        expect((await skillReadFromTool(db.prisma, access, { name: "Extra Steps" })).error).toMatch(
          /not assigned/,
        );
      });
    } finally {
      try {
        await asSystem(db.prisma).user.deleteMany({ where: { id: owner.userId } });
      } finally {
        await db.prisma.$disconnect();
        await db.pool.end();
      }
    }
  });

  it("a built-in skill can be pinned, and a Space's pins go with the Space", async () => {
    const db = createDb(runtimeUrl!);
    const fixtures = asSystem(db.prisma);
    const organizationId = randomUUID();
    const userId = randomUUID();
    const email = `${userId}@rakazo.test`;
    try {
      await fixtures.user.create({ data: { id: userId, name: "Owner", email } });
      await fixtures.organization.create({
        data: { id: organizationId, slug: organizationId, name: "Pinned", createdAt: new Date() },
      });
      const space = await fixtures.space.create({
        data: { id: randomUUID(), organizationId, name: "Space" },
      });
      const bot = await fixtures.bot.create({
        data: { spaceId: space.id, userId, name: "Agent", color: "gray" },
      });
      const actor = { spaceId: space.id, userId, email, isDeploymentOwner: false };
      const service = createBotSkillsService(db.prisma);
      await runAsTenant(actor, async () => {
        const builtin = (await listAgentSkillRecords(db.prisma, actor)).find((skill) =>
          skill.id.startsWith("builtin:"),
        )!;
        // The agent has that built-in unticked.
        await service.setForBot(actor, { botId: bot.id, all: false, skillIds: [] });
        const open = async () =>
          (await listAgentSkillRecords(db.prisma, { ...actor, botId: bot.id })).map((s) => s.id);
        expect(await open()).not.toContain(builtin.id);
        await service.pin(actor, { skillId: builtin.id, pinned: true });
        expect(await open()).toContain(builtin.id);
      });
      await fixtures.space.delete({ where: { id: space.id } });
      expect(
        await fixtures.$queryRawUnsafe<unknown[]>(
          `SELECT 1 FROM "space_pinned_skills" WHERE "spaceId" = $1`,
          space.id,
        ),
      ).toEqual([]);
    } finally {
      try {
        await fixtures.organization.deleteMany({ where: { id: organizationId } });
        await fixtures.user.deleteMany({ where: { id: userId } });
      } finally {
        await db.prisma.$disconnect();
        await db.pool.end();
      }
    }
  });
});
