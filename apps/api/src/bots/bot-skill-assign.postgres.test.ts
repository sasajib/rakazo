import { randomUUID } from "node:crypto";
import {
  BUILTIN_AGENT_SKILLS,
  botSkillsFromTool,
  listAgentSkillRecords,
  resolveNewBotSkills,
  spawnBot,
  writeBotSkillSelection,
} from "@rakazo/adapters";
import { formatSkillsCatalogInstruction } from "@rakazo/core";
import {
  asSystem,
  createDb,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { createAgentSkillsService } from "./agent-skills.js";
import { createBotSkillsService } from "./bot-skills.js";

const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe
    : describe.skip;

/** Fork: the bot_skills tool and spawn_bot's skills, under row-level security. */
describePostgres("a bot assigns skills to another bot (PostgreSQL, fork)", () => {
  it("adds, removes, sets and lists as the settings screen would, within its space and owner", async () => {
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
        data: { id: organizationId, slug: organizationId, name: "Skills", createdAt: new Date() },
      });
      const space = await fixtures.space.create({
        data: { id: randomUUID(), organizationId, name: "Space" },
      });
      const otherSpace = await fixtures.space.create({
        data: { id: randomUUID(), organizationId, name: "Other space" },
      });
      const bot = (name: string, spaceId = space.id, owner = userId) =>
        fixtures.bot.create({ data: { spaceId, userId: owner, name, color: "gray" } });
      const chief = await bot("Chief");
      const child = await fixtures.bot.create({
        data: { spaceId: space.id, userId, name: "Child", color: "gray", parentBotId: chief.id },
      });
      await fixtures.thread.createMany({
        data: [chief, child].map((row) => ({ spaceId: space.id, botId: row.id, userId })),
      });
      const teammates = await bot("Teammates", space.id, otherUserId);
      const elsewhere = await bot("Elsewhere", otherSpace.id);
      const actor = { spaceId: space.id, userId, email, isDeploymentOwner: false };
      const skills = createAgentSkillsService(db.prisma);
      const service = createBotSkillsService(db.prisma);
      const run = {
        spaceId: space.id,
        userId,
        botId: chief.id,
        groupId: null,
        threadId: "thread",
        runId: "run",
      };
      const tool = (args: Record<string, unknown>) =>
        botSkillsFromTool({ prisma: db.prisma }, run, args);
      const catalogOf = async (botId: string) =>
        formatSkillsCatalogInstruction(
          await listAgentSkillRecords(db.prisma, { spaceId: space.id, userId, botId }),
        ) ?? "";
      const firstBuiltin = BUILTIN_AGENT_SKILLS[0]!;

      await runAsTenant(actor, async () => {
        const x = await skills.create(actor, { name: "Skill X", description: "X", body: "MARK-X" });
        const y = await skills.create(actor, { name: "Skill Y", description: "Y", body: "MARK-Y" });
        // As bee creates every new agent: a selection with no stored skill.
        await service.setForBot(actor, {
          botId: child.id,
          all: false,
          skillIds: BUILTIN_AGENT_SKILLS.map((skill) => `builtin:${skill.name}`),
        });
        expect(await catalogOf(child.id)).not.toContain("Skill X");

        // add: by name (any case) and by id.
        const added = await tool({ action: "add", bot_name: "Child", skills: ["skill x", y.id] });
        expect(added).toMatchObject({
          ok: true,
          botId: child.id,
          allSpaceSkills: false,
          added: ["Skill X", "Skill Y"],
          removed: [],
        });
        expect(
          (await fixtures.botSkill.findMany({ where: { botId: child.id } }))
            .map((row) => row.skillId)
            .sort(),
        ).toEqual([x.id, y.id].sort());
        expect(await catalogOf(child.id)).toContain("Skill X");
        expect(await catalogOf(child.id)).toContain(firstBuiltin.name);
        // The settings screen reads the same rows.
        expect((await service.forBot(actor, { botId: child.id })).skillIds).toEqual(
          expect.arrayContaining([x.id, y.id]),
        );

        // remove: a stored skill by name and a built-in as builtin:<name>.
        const removed = await tool({
          action: "remove",
          bot_id: child.id,
          skills: ["Skill Y", `builtin:${firstBuiltin.name}`],
        });
        expect(removed).toMatchObject({ ok: true, added: [] });
        expect((removed.removed as string[]).sort()).toEqual([firstBuiltin.name, "Skill Y"].sort());
        expect(await catalogOf(child.id)).not.toContain("Skill Y");
        expect(await catalogOf(child.id)).not.toContain(`- ${firstBuiltin.name}:`);
        expect(
          (await fixtures.botSkillSelection.findUniqueOrThrow({ where: { botId: child.id } }))
            .excludedBuiltins,
        ).toEqual([firstBuiltin.name]);

        // list: the bot's skills, and the space's with built-ins marked.
        const listed = (await tool({ action: "list", bot_id: child.id })) as {
          skills: Array<{ name: string }>;
          available: Array<{ name: string; builtin?: boolean; assigned: boolean }>;
        };
        expect(listed.skills.map((skill) => skill.name)).toContain("Skill X");
        expect(listed.skills.map((skill) => skill.name)).not.toContain("Skill Y");
        expect(listed.available.find((skill) => skill.name === "Skill Y")).toMatchObject({
          assigned: false,
          description: "Y",
        });
        expect(listed.available.find((skill) => skill.name === firstBuiltin.name)).toMatchObject({
          builtin: true,
          assigned: false,
        });
        expect(JSON.stringify(listed)).not.toContain("MARK-");

        // set: replaces the stored skills; built-ins stay as they were unless asked.
        const set = await tool({ action: "set", bot_id: child.id, skills: ["Skill Y"] });
        expect(set).toMatchObject({ ok: true, added: ["Skill Y"], removed: ["Skill X"] });
        expect(
          (await fixtures.botSkillSelection.findUniqueOrThrow({ where: { botId: child.id } }))
            .excludedBuiltins,
        ).toEqual([firstBuiltin.name]);
        const exact = (await tool({
          action: "set",
          bot_id: child.id,
          skills: ["Skill Y", `builtin:${firstBuiltin.name}`],
          exact_builtins: true,
        })) as { skills: Array<{ name: string }> };
        expect(exact.skills.map((skill) => skill.name).sort()).toEqual(
          ["Skill Y", firstBuiltin.name].sort(),
        );

        // set all: back to every skill of the space; adding to it does not narrow it.
        expect(await tool({ action: "set", bot_id: child.id, all: true })).toMatchObject({
          ok: true,
          allSpaceSkills: true,
        });
        expect(await fixtures.botSkillSelection.count({ where: { botId: child.id } })).toBe(0);
        expect(await tool({ action: "add", bot_id: child.id, skills: ["Skill X"] })).toMatchObject({
          ok: true,
          allSpaceSkills: true,
          added: [],
        });
        expect(await fixtures.botSkillSelection.count({ where: { botId: child.id } })).toBe(0);
        // Removing from "all" starts a selection of everything else.
        await tool({ action: "remove", bot_id: child.id, skills: ["Skill X"] });
        expect(await catalogOf(child.id)).toContain("Skill Y");
        expect(await catalogOf(child.id)).not.toContain("Skill X");

        // Unknown name: nothing changes, close matches are named.
        const before = await fixtures.botSkill.count({ where: { botId: child.id } });
        const unknown = await tool({
          action: "add",
          bot_id: child.id,
          skills: ["Skill X", "Skil Z"],
        });
        expect(unknown.error).toMatch(/No skill in this space matches "Skil Z" \(did you mean /);
        expect(unknown.error).toContain("Skill X");
        expect(await fixtures.botSkill.count({ where: { botId: child.id } })).toBe(before);

        // Bad requests.
        expect((await tool({ action: "grant", bot_id: child.id })).error).toMatch(/action must be/);
        expect((await tool({ action: "add", bot_id: child.id })).error).toMatch(/Pass skills/);
        expect((await tool({ action: "set", bot_id: child.id })).error).toMatch(/set needs skills/);
        expect((await tool({ action: "add", skills: ["Skill X"] })).error).toMatch(
          /bot_id or bot_name/,
        );

        // Another member's bot in the same space, and a bot of another space.
        expect(
          (await tool({ action: "add", bot_id: teammates.id, skills: ["Skill X"] })).error,
        ).toMatch(/belongs to another member/);
        expect((await tool({ action: "list", bot_id: teammates.id })).error).toMatch(
          /belongs to another member/,
        );
        expect(
          (await tool({ action: "add", bot_id: elsewhere.id, skills: ["Skill X"] })).error,
        ).toMatch(/No bot with id/);
        expect(await fixtures.botSkillSelection.count({ where: { botId: teammates.id } })).toBe(0);
        expect(await fixtures.botSkillSelection.count({ where: { botId: elsewhere.id } })).toBe(0);

        // On itself: a managing bot is one of the bots of its space.
        expect(await tool({ action: "set", bot_id: chief.id, skills: ["Skill X"] })).toMatchObject({
          ok: true,
          botId: chief.id,
        });
      });
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

  it("spawn_bot's skills are stored with the new bot, before its first run is created", async () => {
    const db = createDb(runtimeUrl!);
    const fixtures = asSystem(db.prisma);
    const previous = process.env.RAKAZO_NEW_BOT_SKILLS;
    // A member with a space of their own: createBot checks the membership.
    const member = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(db.prisma, {
        provider: "sendblue",
        address: `+1555${String(Date.now()).slice(-7)}`,
      }),
    );
    const { userId } = member;
    const space = { id: member.spaceId };
    const email = `${userId}@rakazo.test`;
    try {
      const chief = await fixtures.bot.create({
        data: { spaceId: space.id, userId, name: "Chief", color: "gray" },
      });
      const chiefThread = await fixtures.thread.create({
        data: { spaceId: space.id, botId: chief.id, userId },
      });
      const task = await fixtures.task.create({
        data: {
          spaceId: space.id,
          botId: chief.id,
          threadId: chiefThread.id,
          userId,
          prompt: "spawn",
          status: "queued",
        },
      });
      const sourceRun = await fixtures.run.create({
        data: {
          spaceId: space.id,
          botId: chief.id,
          threadId: chiefThread.id,
          taskId: task.id,
          userId,
          status: "running",
          trigger: "user",
        },
      });
      const actor = { spaceId: space.id, userId, email, isDeploymentOwner: false };
      const owner = { spaceId: space.id, userId };
      const skills = createAgentSkillsService(db.prisma);
      const jobs = { enqueue: async () => {} } as never;

      for (const setting of ["builtins", undefined]) {
        if (setting) process.env.RAKAZO_NEW_BOT_SKILLS = setting;
        else delete process.env.RAKAZO_NEW_BOT_SKILLS;
        await runAsTenant(actor, async () => {
          const suffix = setting ?? "default";
          const x = await skills.create(actor, {
            name: `Skill X ${suffix}`,
            description: "X",
            body: "MARK-X",
          });
          await skills.create(actor, {
            name: `Skill Y ${suffix}`,
            description: "Y",
            body: "MARK-Y",
          });

          const wrong = await resolveNewBotSkills(db.prisma, owner, ["Skill Q"]);
          expect(wrong).toMatchObject({ ok: false });

          const resolved = await resolveNewBotSkills(db.prisma, owner, [`skill x ${suffix}`]);
          if (!resolved.ok) throw new Error(resolved.error);
          expect(resolved.storedIds).toEqual([x.id]);
          const spawned = await spawnBot(
            { prisma: db.prisma, jobs },
            {
              spawnedBy: { id: chief.id, name: "Chief", spaceId: space.id, userId },
              runId: sourceRun.id,
              spawnKey: `spawn-${suffix}-${randomUUID()}`,
              name: `Scout ${suffix}`,
              prompt: "Start on the assigned work.",
              seed: (tx, botId) =>
                writeBotSkillSelection(tx, {
                  ...owner,
                  botId,
                  storedIds: resolved.storedIds,
                  excludedBuiltins: [],
                }),
            },
          );
          if ("error" in spawned) throw new Error(spawned.error);
          const firstRun = await fixtures.run.findFirstOrThrow({
            where: { botId: spawned.botId },
            orderBy: { createdAt: "asc" },
          });
          expect(firstRun.trigger).toBe("spawn");
          const selection = await fixtures.botSkillSelection.findUniqueOrThrow({
            where: { botId: spawned.botId },
            include: { skills: true },
          });
          expect(selection.skills.map((row) => row.skillId)).toEqual([x.id]);
          expect(selection.excludedBuiltins).toEqual([]);
          expect(selection.createdAt.getTime()).toBeLessThanOrEqual(firstRun.createdAt.getTime());
          // What that run's prompt catalog is built from.
          const catalog =
            formatSkillsCatalogInstruction(
              await listAgentSkillRecords(db.prisma, { ...owner, botId: spawned.botId }),
            ) ?? "";
          expect(catalog).toContain(`Skill X ${suffix}`);
          expect(catalog).not.toContain(`Skill Y ${suffix}`);
          expect(catalog).toContain(BUILTIN_AGENT_SKILLS[0]!.name);
        });
      }
    } finally {
      if (previous === undefined) delete process.env.RAKAZO_NEW_BOT_SKILLS;
      else process.env.RAKAZO_NEW_BOT_SKILLS = previous;
      try {
        await fixtures.space.deleteMany({ where: { id: space.id } });
        await fixtures.user.deleteMany({ where: { id: userId } });
      } finally {
        await db.prisma.$disconnect();
        await db.pool.end();
      }
    }
  });
});
