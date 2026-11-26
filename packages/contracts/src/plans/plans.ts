/**
 * Fork: plan confirmation. Before an agent hands work to another agent (or starts multi-step
 * work) it writes a short plan card: numbered steps, who does each, the inputs it will use. The
 * owner approves it by a click, by saying or typing "yes / go ahead", or asks for changes; only an
 * approved plan lets the agent message another agent with a request. A plan that names a known
 * workflow (a skill) counts approvals per agent + skill: after `threshold` clean approvals the
 * agent may run that workflow without asking (Ask until trusted), still posting the plan as a
 * notice. Nothing waits on a card: the run that proposes a plan ends, the owner's answer starts
 * the next one.
 */
import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id } from "../ids.js";

/**
 * always / until_trusted: the plan card waits for the owner. notify (FORK.md 1.25): the card is
 * still posted (and its short version spoken on a call) but as a notice; it is approved at once
 * and the agent carries on in the same turn. never: no plan card at all.
 */
export const PlanModeSchema = z.enum(["always", "until_trusted", "notify", "never"]);
export type PlanMode = z.infer<typeof PlanModeSchema>;

/**
 * Mode used when the agent has no setting of its own and the deployment sets no PLAN_DEFAULT_MODE.
 */
export const DEFAULT_PLAN_MODE: PlanMode = "until_trusted";
/** Clean approvals of the same workflow before an agent may run it without asking. */
export const DEFAULT_PLAN_TRUST_THRESHOLD = 3;

export const PlanStatusSchema = z.enum([
  "pending",
  /** The owner approved it (click, voice or text). */
  "approved",
  /** Run without asking: a trusted workflow, or Notify mode. The card is a notice. */
  "auto",
  /** The owner asked for changes; a revised plan follows. */
  "changes",
  "rejected",
  /** A newer revision replaced it before it was decided. */
  "replaced",
]);
export type PlanStatus = z.infer<typeof PlanStatusSchema>;

/** trust = a trusted workflow; notify = the agent's mode posts plans as notices. */
export const PlanDecidedViaSchema = z.enum(["click", "voice", "text", "trust", "notify"]);
export type PlanDecidedVia = z.infer<typeof PlanDecidedViaSchema>;

export const PlanStepSchema = z.object({
  text: z.string().min(1).max(500),
  /** Who does this step: the agent's own name, or the agent it hands the step to. */
  agent: z.string().max(80).optional(),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const PlanInputSchema = z.object({
  label: z.string().min(1).max(80),
  value: z.string().max(500),
});

/** The chat card for one plan revision. */
export const PlanBlockSchema = z.object({
  kind: z.literal("plan"),
  planId: Id,
  title: z.string(),
  steps: z.array(PlanStepSchema),
  inputs: z.array(PlanInputSchema).optional(),
  /** The known workflow (skill) the plan follows, and how far it is from running unasked. */
  workflow: z
    .object({
      name: z.string(),
      skillId: z.string().optional(),
      approvals: z.number().int(),
      threshold: z.number().int(),
    })
    .optional(),
  revision: z.number().int(),
  /** One or two sentences, what a call says aloud. */
  spoken: z.string().optional(),
  status: PlanStatusSchema,
  decidedVia: PlanDecidedViaSchema.optional(),
});
export type PlanBlock = z.infer<typeof PlanBlockSchema>;

export const PlanTrustSchema = z.object({
  botId: Id,
  botName: z.string().nullable(),
  workflow: z.string(),
  skillId: z.string().nullable(),
  approvals: z.number().int(),
  threshold: z.number().int(),
  /** Runs without asking (approvals >= threshold under Ask until trusted, and not revoked). */
  trusted: z.boolean(),
  revoked: z.boolean(),
  lastApprovedAt: z.string().nullable(),
});
export type PlanTrust = z.infer<typeof PlanTrustSchema>;

export const PlanSettingsSchema = z.object({
  botId: Id,
  /** The agent's own choice (null = the default applies). */
  mode: PlanModeSchema.nullable(),
  effective: PlanModeSchema,
  /** What applies to an agent with no choice of its own (the deployment's PLAN_DEFAULT_MODE). */
  defaultMode: PlanModeSchema.optional(),
  threshold: z.number().int(),
  trust: z.array(PlanTrustSchema),
});
export type PlanSettings = z.infer<typeof PlanSettingsSchema>;

export const planProcedures = {
  /** One agent's plan setting and its trusted workflows. */
  settings: oc.input(z.object({ botId: Id })).output(PlanSettingsSchema),
  /** Always ask / Ask until trusted / Notify / Never ask (null = default), and the approvals needed. */
  setMode: oc
    .input(
      z.object({
        botId: Id,
        mode: PlanModeSchema.nullable(),
        threshold: z.number().int().min(1).max(20).optional(),
      }),
    )
    .output(PlanSettingsSchema),
  /** Approve, ask for changes (with the edited plan text) or reject a plan from its card. */
  decide: oc
    .input(
      z.object({
        planId: Id,
        decision: z.enum(["approve", "change", "reject"]),
        text: z.string().trim().min(1).max(8_000).optional(),
        /** "voice": the call agent heard it and sends the caller's words itself (no message here). */
        via: z.enum(["click", "voice"]).optional(),
      }),
    )
    .output(PlanBlockSchema),
  /** Trust counters of the Space's workflows (for the Skills window), all agents. */
  trust: oc.output(z.array(PlanTrustSchema)),
  /** Take back a workflow's trust: the agent asks again and the count starts from zero. */
  revokeTrust: oc
    .input(z.object({ botId: Id, workflow: z.string().min(1).max(200) }))
    .output(z.object({ ok: z.literal(true) })),
};
