import { randomUUID } from "node:crypto";
import type { MessageBlock } from "@rakazo/contracts";
import { asSystem, createDb, runAsTenant, storedMessageBlocks } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { skillCreateFromTool } from "../tools/skill-tools.js";
import { curatorConfig } from "./config.js";
import { curate, decideProposal } from "./curator.js";
import type { CuratorModel, CuratorProposal } from "./model.js";
import { createCuratorStore } from "./store.js";

const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe
    : describe.skip;

const fixed = (
  proposal: CuratorProposal | ((input: unknown) => CuratorProposal),
): CuratorModel => ({
  propose: async (input) => (typeof proposal === "function" ? proposal(input) : proposal),
});

describePostgres("skill curator under PostgreSQL row-level security (fork)", () => {
  it("proposes, keeps, auto-saves, patches only its own skills, and undoes", async () => {
    const db = createDb(runtimeUrl!);
    const fixtures = asSystem(db.prisma);
    const organizationId = randomUUID();
    const userId = randomUUID();
    const email = `${userId}@rakazo.test`;
    try {
      await fixtures.user.create({ data: { id: userId, name: "Owner", email } });
      await fixtures.organization.create({
        data: { id: organizationId, slug: organizationId, name: "Curator", createdAt: new Date() },
      });
      const space = await fixtures.space.create({
        data: { id: randomUUID(), organizationId, name: "Space" },
      });
      const otherSpace = await fixtures.space.create({
        data: { id: randomUUID(), organizationId, name: "Other" },
      });
      const bot = await fixtures.bot.create({
        data: { spaceId: space.id, userId, name: "Learner", color: "gray" },
      });
      const thread = await fixtures.thread.create({
        data: { spaceId: space.id, botId: bot.id, userId },
      });
      const actor = { spaceId: space.id, userId };
      const store = createCuratorStore(db.prisma);
      const config = curatorConfig({ SKILL_CURATOR: "1" });
      const deps = { prisma: db.prisma, secretStore: { load: async () => "" } };
      const messages = [
        {
          text: "No, always check the inbox folder first, then move the files.",
          at: new Date(),
          current: true,
        },
      ];
      const job = (runId: string) => ({
        runId,
        spaceId: space.id,
        threadId: thread.id,
        botId: bot.id,
        userId,
        reason: "correction",
        outline: [{ n: 1, tool: "shell", label: "Shell", args: '{"command":"ls"}' }],
        attempts: 0,
      });
      const create: CuratorProposal = {
        action: "create",
        name: "Tidy Report Files",
        description: "Use when the owner asks to tidy report files",
        steps: ["Check the inbox folder first", "Move files into reports/"],
        pitfalls: ["Never delete originals"],
        summary: "Tidies report files the owner's way",
        quote: "always check the inbox folder first",
      };
      const cardsIn = async () => {
        const rows = await db.prisma.message.findMany({
          where: { threadId: thread.id, role: "bot" },
          orderBy: { seq: "asc" },
          select: { id: true, blocks: true },
        });
        return rows.flatMap((row) =>
          storedMessageBlocks(row).filter(
            (block): block is Extract<MessageBlock, { kind: "learned_skill" }> =>
              block.kind === "learned_skill",
          ),
        );
      };

      await runAsTenant(actor, async () => {
        // The agent has its own skill list: a kept skill joins it.
        await db.prisma.botSkillSelection.upsert({
          where: { botId: bot.id },
          create: { botId: bot.id, spaceId: space.id, userId, excludedBuiltins: [] },
          update: {},
        });

        // Default mode is Ask: a pending card, no skill yet.
        expect(await store.modes(space.id, bot.id)).toEqual({ space: null, bot: null });
        const asked = await curate(
          deps,
          store,
          config,
          {
            job: job("run-1"),
            botName: "Learner",
            mode: "ask",
            messages,
            replies: [],
          },
          fixed(create),
        );
        expect(asked.outcome).toBe("proposed");
        expect(await db.prisma.agentSkill.count({ where: { spaceId: space.id } })).toBe(0);
        const [card] = await cardsIn();
        expect(card).toMatchObject({ status: "pending", mode: "ask", name: "Tidy Report Files" });

        // A second proposal for the same skill does not post a second card.
        const again = await curate(
          deps,
          store,
          config,
          {
            job: job("run-1b"),
            botName: "Learner",
            mode: "ask",
            messages,
            replies: [],
          },
          fixed(create),
        );
        expect(again).toMatchObject({ outcome: "skipped", why: "already_proposed" });

        // Keep: the skill exists, is the agent's, and is marked learned.
        const kept = await decideProposal(deps, store, actor, {
          proposalId: asked.proposalId!,
          decision: "keep",
        });
        expect(kept.status).toBe("kept");
        const skill = await db.prisma.agentSkill.findFirstOrThrow({
          where: { id: kept.skillId! },
        });
        expect(skill.content).toContain("1. Check the inbox folder first");
        expect(
          await db.prisma.botSkill.count({ where: { botId: bot.id, skillId: skill.id } }),
        ).toBe(1);
        expect((await store.learned(space.id)).map((row) => row.skillId)).toEqual([skill.id]);
        expect((await cardsIn())[0]).toMatchObject({ status: "kept", skillId: skill.id });

        // Auto may patch a skill it learned: saved at once, notice card.
        const patch: CuratorProposal = {
          action: "patch",
          skillId: skill.id,
          body: "## Steps\n1. Check the inbox folder first\n2. Sort by date\n3. Move files into reports/\n",
          change: "Sort by date before moving",
          quote: "always check the inbox folder first",
        };
        const auto = await curate(
          deps,
          store,
          config,
          {
            job: job("run-2"),
            botName: "Learner",
            mode: "auto",
            messages,
            replies: [],
          },
          fixed(patch),
        );
        expect(auto).toMatchObject({ outcome: "saved", action: "patch", skillId: skill.id });
        const patched = await db.prisma.agentSkill.findFirstOrThrow({ where: { id: skill.id } });
        expect(patched.content).toContain("2. Sort by date");
        expect((await store.learned(space.id))[0]?.patches).toBe(1);

        // Undo on the notice restores the previous text.
        const undone = await decideProposal(deps, store, actor, {
          proposalId: auto.proposalId!,
          decision: "discard",
        });
        expect(undone.status).toBe("reverted");
        expect(
          (await db.prisma.agentSkill.findFirstOrThrow({ where: { id: skill.id } })).content,
        ).toBe(skill.content);

        // A skill the owner wrote is never changed in Auto mode: it becomes an Ask card.
        const ownSkill = await skillCreateFromTool(
          db.prisma,
          { spaceId: space.id, userId, botId: bot.id },
          { name: "Owner Skill", description: "Use when x", body: "## Steps\n1. Do x\n" },
        );
        const ownPatch = await curate(
          deps,
          store,
          config,
          {
            job: job("run-3"),
            botName: "Learner",
            mode: "auto",
            messages,
            replies: [],
          },
          fixed({
            ...patch,
            skillId: String(ownSkill.id),
            body: "## Steps\n1. Check inbox\n2. Do x\n",
          }),
        );
        expect(ownPatch).toMatchObject({ outcome: "proposed", action: "patch" });
        expect(
          (await db.prisma.agentSkill.findFirstOrThrow({ where: { id: String(ownSkill.id) } }))
            .content,
        ).toContain("1. Do x");

        // Off saves nothing.
        expect(
          await curate(
            deps,
            store,
            config,
            {
              job: job("run-4"),
              botName: "Learner",
              mode: "off",
              messages,
              replies: [],
            },
            fixed({ ...create, name: "Other Skill" }),
          ),
        ).toMatchObject({ outcome: "skipped", why: "off" });

        // Teaching sessions: one open per chat and agent.
        const first = await store.startTeaching({
          spaceId: space.id,
          threadId: thread.id,
          botId: bot.id,
          userId,
          task: "file receipts",
          startSeq: 0,
        });
        const second = await store.startTeaching({
          spaceId: space.id,
          threadId: thread.id,
          botId: bot.id,
          userId,
          task: "other",
          startSeq: 1,
        });
        expect(second.id).toBe(first.id);
        expect(await store.endTeaching(space.id, first.id, "cancelled")).toBe(true);
        expect(await store.activeTeaching(space.id, thread.id, bot.id)).toBeUndefined();

        await store.setMode(space.id, bot.id, "auto");
        await store.setMode(space.id, null, "off");
        expect(await store.modes(space.id, bot.id)).toEqual({ space: "off", bot: "auto" });

        // Ledger facts from the very stretch of chat being read are not "earlier rules"; facts
        // from elsewhere are. A lesson saved as a skill takes the ledger's copies of its steps.
        const fact = async (id: string, threadId: string | null, createdAt: Date) =>
          db.prisma.$executeRawUnsafe(
            `INSERT INTO "memory_facts" ("id","spaceId","area","text","quote","origin","status","sourceThreadId","createdAt")
             VALUES ($1,$2,'preferences',$3,$3,'stated','tentative',$4,$5::timestamp)`,
            id,
            space.id,
            `fact ${id}`,
            threadId,
            createdAt.toISOString().replace("Z", ""),
          );
        const lessonStart = new Date(Date.now() - 60_000);
        await fact("f-old", null, new Date(Date.now() - 3_600_000));
        const session = await store.startTeaching({
          spaceId: space.id,
          threadId: thread.id,
          botId: bot.id,
          userId,
          task: "file receipts",
          startSeq: 0,
        });
        await db.prisma.$executeRawUnsafe(
          `UPDATE "skill_teaching_sessions" SET "createdAt" = $2::timestamp WHERE "id" = $1`,
          session.id,
          lessonStart.toISOString().replace("Z", ""),
        );
        await fact("f-lesson", thread.id, new Date());
        let seenRules: readonly string[] = [];
        const lesson = await curate(
          deps,
          store,
          config,
          {
            job: { ...job("teach-1"), reason: "teach_done" },
            botName: "Learner",
            mode: "auto",
            messages: [
              {
                text: "Step 1: open receipts. Done, save as skill.",
                at: lessonStart,
                current: true,
              },
            ],
            replies: [],
          },
          {
            propose: async (input) => {
              seenRules = input.rules;
              return { ...create, name: "File Receipts", quote: "open receipts" };
            },
          },
        );
        expect(lesson.outcome).toBe("saved");
        expect(seenRules).toContain("fact f-old");
        expect(seenRules).not.toContain("fact f-lesson");
        const statuses = await db.prisma.$queryRawUnsafe<Array<{ id: string; status: string }>>(
          `SELECT "id", "status" FROM "memory_facts" WHERE "spaceId" = $1 ORDER BY "id"`,
          space.id,
        );
        expect(statuses).toEqual([
          { id: "f-lesson", status: "retracted" },
          { id: "f-old", status: "tentative" },
        ]);
      });

      // Row security: another Space sees none of it.
      await runAsTenant({ spaceId: otherSpace.id, userId }, async () => {
        expect(await store.learned(space.id)).toEqual([]);
        expect(await store.modes(space.id, bot.id)).toEqual({ space: null, bot: null });
        const rows = await db.prisma.$queryRawUnsafe<unknown[]>(
          `SELECT 1 FROM "skill_learning_proposals"`,
        );
        expect(rows).toEqual([]);
      });

      // Deleting the agent removes its settings and proposals; learned skills stay (the owner's).
      await fixtures.bot.delete({ where: { id: bot.id } });
      const left = await fixtures.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT (SELECT count(*) FROM "skill_learning_settings" WHERE "botId" = $1)::int
              + (SELECT count(*) FROM "skill_learning_proposals" WHERE "botId" = $1)::int AS n`,
        bot.id,
      );
      expect(left[0]?.n).toBe(0);
    } finally {
      await fixtures.organization.deleteMany({ where: { id: organizationId } }).catch(() => 0);
      await fixtures.user.deleteMany({ where: { id: userId } }).catch(() => 0);
      await db.prisma.$disconnect();
    }
  });
});
