/**
 * Fork: auto-learned skills (skill curator) and chat teaching, for the web. The curator itself
 * lives in @rakazo/adapters skill-curator/.
 */
import { ORPCError } from "@orpc/server";
import {
  createCuratorStore,
  curatorEnabled,
  decideProposal,
  ProposalNotFoundError,
  saveTeachingAsSkill,
  skillCreateFromTool,
  taughtSkillMd,
} from "@rakazo/adapters";
import type {
  Actor,
  LearnedSkillBlock,
  LearnedSkillInfo,
  SkillLearningMode,
  SkillLearningSettings,
  TeachingState,
} from "@rakazo/contracts";
import { DEFAULT_SKILL_LEARNING_MODE } from "@rakazo/contracts";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";

type Deps = {
  prisma: PrismaClient;
  secretStore: { load(ciphertext: string, id: string): Promise<string> };
  events?: Pick<ThreadEvents, "notify">;
};

export function createSkillLearningService(deps: Deps) {
  const store = createCuratorStore(deps.prisma);

  async function ownedBot(actor: Actor, botId: string) {
    const bot = await deps.prisma.bot.findFirst({
      where: { id: botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
      select: { id: true },
    });
    if (!bot) throw new IsolationError();
    return bot;
  }

  async function settings(actor: Actor, botId?: string): Promise<SkillLearningSettings> {
    const modes = await store.modes(actor.spaceId, botId ?? null);
    return {
      spaceMode: modes.space,
      ...(botId ? { botMode: modes.bot } : {}),
      effective: (botId ? modes.bot : null) ?? modes.space ?? DEFAULT_SKILL_LEARNING_MODE,
      available: curatorEnabled(),
    };
  }

  async function teachingState(
    actor: Actor,
    botId: string,
    threadId: string,
  ): Promise<TeachingState> {
    const open = await store.activeTeaching(actor.spaceId, threadId, botId);
    return open
      ? {
          active: true,
          sessionId: open.id,
          task: open.task,
          startedAt: new Date(open.createdAt).toISOString(),
        }
      : { active: false };
  }

  /** The thread must be one of this Space's chats with the agent. */
  async function ownedThread(actor: Actor, botId: string, threadId: string) {
    const thread = await deps.prisma.thread.findFirst({
      where: { id: threadId, spaceId: actor.spaceId },
      select: { id: true, nextMessageSeq: true },
    });
    if (!thread) throw new IsolationError();
    await ownedBot(actor, botId);
    return thread;
  }

  return {
    settings: (actor: Actor, input: { botId?: string | undefined }) =>
      input.botId
        ? ownedBot(actor, input.botId).then(() => settings(actor, input.botId))
        : settings(actor),

    async setMode(
      actor: Actor,
      input: { botId?: string | undefined; mode: SkillLearningMode | null },
    ): Promise<SkillLearningSettings> {
      if (input.botId) await ownedBot(actor, input.botId);
      await store.setMode(actor.spaceId, input.botId ?? null, input.mode);
      return settings(actor, input.botId);
    },

    async decide(
      actor: Actor,
      input: { proposalId: string; decision: "keep" | "discard"; content?: string | undefined },
    ): Promise<LearnedSkillBlock> {
      try {
        return await decideProposal(deps, store, actor, input);
      } catch (error) {
        if (error instanceof ProposalNotFoundError) throw new IsolationError();
        throw error;
      }
    },

    async learned(actor: Actor): Promise<LearnedSkillInfo[]> {
      const rows = await store.learned(actor.spaceId);
      return rows.map((row) => ({
        skillId: row.skillId,
        botId: row.botId,
        botName: row.botName,
        runId: row.runId,
        taught: row.taught,
        patches: row.patches,
        createdAt: new Date(row.createdAt).toISOString(),
        updatedAt: new Date(row.updatedAt).toISOString(),
      }));
    },

    async teaching(actor: Actor, input: { botId: string; threadId: string }) {
      await ownedThread(actor, input.botId, input.threadId);
      return teachingState(actor, input.botId, input.threadId);
    },

    async teach(
      actor: Actor,
      input: {
        botId: string;
        threadId: string;
        action: "start" | "save" | "cancel";
        task?: string | undefined;
      },
    ): Promise<TeachingState> {
      const thread = await ownedThread(actor, input.botId, input.threadId);
      if (!curatorEnabled())
        throw new ORPCError("BAD_REQUEST", { message: "Skill learning is off on this server." });
      const open = await store.activeTeaching(actor.spaceId, input.threadId, input.botId);
      if (input.action === "start") {
        if (!open) {
          await store.startTeaching({
            spaceId: actor.spaceId,
            threadId: input.threadId,
            botId: input.botId,
            userId: actor.userId,
            task: input.task ?? "the task I show you",
            // The lesson is what he writes from now on.
            startSeq: thread.nextMessageSeq,
          });
        }
      } else if (input.action === "cancel") {
        if (open) await store.endTeaching(actor.spaceId, open.id, "cancelled");
      } else {
        const mode = (await settings(actor, input.botId)).effective;
        if (mode === "off")
          throw new ORPCError("BAD_REQUEST", {
            message: "Learning is off for this agent. Turn it on in the agent's settings.",
          });
        if (!(await saveTeachingAsSkill(deps, { ...actor, ...input })))
          throw new ORPCError("BAD_REQUEST", { message: "No lesson is open in this chat." });
        // The session closes when the draft is posted; report it as closing now.
        return { active: false };
      }
      return teachingState(actor, input.botId, input.threadId);
    },

    /** A saved screen-taught skill as a regular skill of its agent; the taught one stays. */
    async fromTaught(actor: Actor, input: { taughtSkillId: string }) {
      const taught = await deps.prisma.taughtSkill.findFirst({
        where: { id: input.taughtSkillId, spaceId: actor.spaceId },
        select: { id: true, botId: true, name: true, goal: true, status: true, playbook: true },
      });
      if (!taught) throw new IsolationError();
      await ownedBot(actor, taught.botId);
      if (taught.status !== "saved" && taught.status !== "draft")
        throw new ORPCError("BAD_REQUEST", { message: "Finish the recording first." });
      const playbook = (taught.playbook ?? {}) as Record<string, unknown>;
      const list = (value: unknown) =>
        Array.isArray(value)
          ? value.filter((item): item is string => typeof item === "string")
          : [];
      const text = (value: unknown) => (typeof value === "string" ? value : "");
      const md = taughtSkillMd({
        name: taught.name,
        goal: taught.goal,
        playbook: {
          whenToUse: text(playbook.whenToUse),
          inputs: list(playbook.inputs),
          steps: list(playbook.steps),
          howToCheck: text(playbook.howToCheck),
          whatToReturn: text(playbook.whatToReturn),
          approvalBoundaries: text(playbook.approvalBoundaries),
          failureHandling: text(playbook.failureHandling),
        },
      });
      const created = await skillCreateFromTool(
        deps.prisma,
        { spaceId: actor.spaceId, userId: actor.userId, botId: taught.botId },
        { content: md.content },
      );
      if (typeof created.error === "string")
        throw new ORPCError("BAD_REQUEST", { message: created.error });
      const skillId = String(created.id);
      const bot = await deps.prisma.bot.findFirst({
        where: { id: taught.botId },
        select: { name: true },
      });
      await store.recordLearned({
        skillId,
        spaceId: actor.spaceId,
        botId: taught.botId,
        botName: bot?.name ?? null,
        runId: null,
        threadId: null,
        taught: true,
      });
      return { skillId, name: md.name };
    },
  };
}

export type SkillLearningService = ReturnType<typeof createSkillLearningService>;
