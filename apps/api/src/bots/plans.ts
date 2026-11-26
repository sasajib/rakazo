/**
 * Fork: plan confirmation for the web and the call agent (plans/decide, settings, trust). The plan
 * logic lives in @rakazo/adapters plans/.
 */
import { ORPCError } from "@orpc/server";
import {
  createPlanStore,
  decidePlan,
  effectivePlanMode,
  PlanNotFoundError,
  planDefaultMode,
  trustList,
} from "@rakazo/adapters";
import type { Actor, PlanBlock, PlanMode, PlanSettings, PlanTrust } from "@rakazo/contracts";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

type Deps = { prisma: PrismaClient; events?: Pick<ThreadEvents, "notify"> };
/** Sends the owner's message to the agent the way the composer does (starts its run). */
type SendAsOwner = (
  actor: Actor,
  input: { botId: string; text: string; clientNonce: string },
) => Promise<unknown>;

export function createPlansService(deps: Deps, sendAsOwner: SendAsOwner) {
  const store = createPlanStore(deps.prisma);

  async function ownedBot(actor: Actor, botId: string) {
    const bot = await deps.prisma.bot.findFirst({
      where: { id: botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
      select: { id: true },
    });
    if (!bot) throw new IsolationError();
    return bot;
  }

  async function settings(actor: Actor, botId: string): Promise<PlanSettings> {
    await ownedBot(actor, botId);
    const setting = await store.setting(botId);
    return {
      botId,
      mode: setting.mode,
      effective: effectivePlanMode(setting.mode),
      defaultMode: planDefaultMode(),
      threshold: setting.threshold,
      trust: await trustList(deps.prisma, actor.spaceId, botId),
    };
  }

  return {
    settings: (actor: Actor, input: { botId: string }) => settings(actor, input.botId),

    async setMode(
      actor: Actor,
      input: { botId: string; mode: PlanMode | null; threshold?: number | undefined },
    ): Promise<PlanSettings> {
      await ownedBot(actor, input.botId);
      await store.setSetting(actor.spaceId, input.botId, input.mode, input.threshold);
      return settings(actor, input.botId);
    },

    async decide(
      actor: Actor,
      input: {
        planId: string;
        decision: "approve" | "change" | "reject";
        text?: string | undefined;
        via?: "click" | "voice" | undefined;
      },
    ): Promise<PlanBlock> {
      const plan = await store.get(input.planId);
      if (!plan || plan.spaceId !== actor.spaceId) throw new IsolationError();
      await ownedBot(actor, plan.botId);
      if (input.decision === "change" && !input.text && input.via !== "voice")
        throw new ORPCError("BAD_REQUEST", { message: "Say what to change." });
      let result: Awaited<ReturnType<typeof decidePlan>>;
      try {
        result = await decidePlan(deps, actor, input);
      } catch (error) {
        if (error instanceof PlanNotFoundError) throw new IsolationError();
        throw error;
      }
      // The owner's decision goes to the agent as his message, which starts the run that carries
      // the plan out (or revises it). A spoken one is sent by the call agent itself.
      if (result.changed && input.via !== "voice" && input.decision !== "reject") {
        const text =
          input.decision === "approve"
            ? `Approved. Go ahead with the plan "${plan.title}".`
            : `Change the plan "${plan.title}":\n${input.text ?? ""}`;
        await sendAsOwner(actor, {
          botId: plan.botId,
          text,
          clientNonce: `plan:${plan.id}:${input.decision}:${plan.revision}`,
        }).catch((error: unknown) => {
          getLogger().error("plan.decision_send_failed", error);
          throw error;
        });
      }
      return result.block;
    },

    trust: (actor: Actor): Promise<PlanTrust[]> => trustList(deps.prisma, actor.spaceId),

    async revokeTrust(actor: Actor, input: { botId: string; workflow: string }) {
      await ownedBot(actor, input.botId);
      await store.reset(actor.spaceId, input.botId, input.workflow, true);
      getLogger().info("plan.trust_revoked", {
        "bot.id": input.botId,
        "plan.workflow": input.workflow,
      });
      return { ok: true as const };
    },
  };
}
