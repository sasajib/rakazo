import { randomUUID } from "node:crypto";
import { asSystem, createDb, IsolationError, runAsTenant } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSkillLearningService } from "./skill-learning.js";

const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe
    : describe.skip;

describePostgres("skill learning settings, chat lessons and taught skills (fork)", () => {
  const previous = process.env.SKILL_CURATOR;
  beforeEach(() => {
    process.env.SKILL_CURATOR = "1";
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.SKILL_CURATOR;
    else process.env.SKILL_CURATOR = previous;
  });

  it("keeps modes per agent and Space, runs lessons, converts taught skills, and refuses others", async () => {
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
        data: { id: organizationId, slug: organizationId, name: "Learning", createdAt: new Date() },
      });
      const space = await fixtures.space.create({
        data: { id: randomUUID(), organizationId, name: "Space" },
      });
      const bot = await fixtures.bot.create({
        data: { spaceId: space.id, userId, name: "Learner", color: "gray" },
      });
      const foreignBot = await fixtures.bot.create({
        data: { spaceId: space.id, userId: otherUserId, name: "Not yours", color: "gray" },
      });
      const thread = await fixtures.thread.create({
        data: { spaceId: space.id, botId: bot.id, userId },
      });
      const taught = await fixtures.taughtSkill.create({
        data: {
          spaceId: space.id,
          botId: bot.id,
          userId,
          name: "Export report",
          goal: "Export the weekly report",
          status: "saved",
          playbook: {
            whenToUse: "the owner asks for the weekly report",
            inputs: [],
            steps: ["Open the dashboard", "Click Export"],
            howToCheck: "A CSV is downloaded",
            whatToReturn: "",
            approvalBoundaries: "",
            failureHandling: "",
          },
        },
      });
      const actor = { spaceId: space.id, userId, email, isDeploymentOwner: false };
      const service = createSkillLearningService({
        prisma: db.prisma,
        secretStore: { load: async () => "" },
      });

      await runAsTenant(actor, async () => {
        expect(await service.settings(actor, { botId: bot.id })).toEqual({
          spaceMode: null,
          botMode: null,
          effective: "ask",
          available: true,
        });
        await service.setMode(actor, { mode: "auto" });
        expect((await service.settings(actor, { botId: bot.id })).effective).toBe("auto");
        const off = await service.setMode(actor, { botId: bot.id, mode: "off" });
        expect(off).toMatchObject({ spaceMode: "auto", botMode: "off", effective: "off" });
        await service.setMode(actor, { botId: bot.id, mode: null });
        expect((await service.settings(actor, { botId: bot.id })).botMode).toBeNull();

        // Someone else's agent is not reachable.
        await expect(service.settings(actor, { botId: foreignBot.id })).rejects.toBeInstanceOf(
          IsolationError,
        );
        await expect(
          service.setMode(actor, { botId: foreignBot.id, mode: "off" }),
        ).rejects.toBeInstanceOf(IsolationError);

        // A chat lesson: start, see it, cancel.
        const started = await service.teach(actor, {
          botId: bot.id,
          threadId: thread.id,
          action: "start",
          task: "file receipts",
        });
        expect(started).toMatchObject({ active: true, task: "file receipts" });
        expect(await service.teaching(actor, { botId: bot.id, threadId: thread.id })).toMatchObject(
          { active: true },
        );
        expect(
          await service.teach(actor, { botId: bot.id, threadId: thread.id, action: "cancel" }),
        ).toEqual({ active: false });

        // Save with no lesson open is refused.
        await expect(
          service.teach(actor, { botId: bot.id, threadId: thread.id, action: "save" }),
        ).rejects.toThrow(/No lesson/);

        // A screen-taught skill becomes a regular, learned agent skill; the taught one stays.
        const converted = await service.fromTaught(actor, { taughtSkillId: taught.id });
        expect(converted.name).toBe("Export report");
        const skill = await db.prisma.agentSkill.findFirstOrThrow({
          where: { id: converted.skillId },
        });
        expect(skill.description).toBe("Use when the owner asks for the weekly report");
        expect(skill.content).toContain("2. Click Export");
        expect(await db.prisma.taughtSkill.count({ where: { id: taught.id } })).toBe(1);
        const learned = await service.learned(actor);
        expect(learned).toHaveLength(1);
        expect(learned[0]).toMatchObject({ skillId: skill.id, taught: true, botName: "Learner" });

        // A proposal of another person cannot be decided.
        await expect(
          service.decide(actor, { proposalId: "missing", decision: "keep" }),
        ).rejects.toBeInstanceOf(IsolationError);
      });
    } finally {
      await fixtures.organization.deleteMany({ where: { id: organizationId } }).catch(() => 0);
      await fixtures.user
        .deleteMany({ where: { id: { in: [userId, otherUserId] } } })
        .catch(() => 0);
      await db.prisma.$disconnect();
    }
  });
});
