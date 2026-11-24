/**
 * Fork: auto-learned skills. After a non-trivial owner run, a correction ("no, always do X
 * first") or a chat teaching session, a background curator proposes a new skill or a change to
 * one. Per agent (and as a Space default) the owner picks Off, Ask (a Keep / Edit / Discard card
 * in the chat) or Auto (saved at once with a short notice; Auto never changes a skill the owner
 * wrote himself).
 */
import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id } from "../ids.js";

export const SkillLearningModeSchema = z.enum(["off", "ask", "auto"]);
export type SkillLearningMode = z.infer<typeof SkillLearningModeSchema>;

/** Mode used when neither the agent nor its Space chose one. */
export const DEFAULT_SKILL_LEARNING_MODE: SkillLearningMode = "ask";

export const LearnedSkillStatusSchema = z.enum([
  "pending",
  "kept",
  "discarded",
  "saved",
  "reverted",
  "failed",
]);
export type LearnedSkillStatus = z.infer<typeof LearnedSkillStatusSchema>;

/** The chat card for one proposal. */
export const LearnedSkillBlockSchema = z.object({
  kind: z.literal("learned_skill"),
  proposalId: Id,
  action: z.enum(["create", "patch"]),
  /** The skill it created or changes (absent until a new skill is kept). */
  skillId: Id.optional(),
  name: z.string(),
  description: z.string(),
  /** One line: what the skill does, or what the change is. */
  summary: z.string(),
  /** For a change: short "+ line" / "- line" summary of what differs. */
  diff: z.string().optional(),
  /** The proposed SKILL.md (bounded), for Edit. */
  content: z.string().optional(),
  /** Ask = waiting on Keep / Discard; Auto = saved already, the card is a notice. */
  mode: z.enum(["ask", "auto"]),
  /** Learned from a chat teaching session. */
  taught: z.boolean().optional(),
  status: LearnedSkillStatusSchema,
  error: z.string().optional(),
});
export type LearnedSkillBlock = z.infer<typeof LearnedSkillBlockSchema>;

export const SkillLearningSettingsSchema = z.object({
  /** The Space default (null = not set, DEFAULT_SKILL_LEARNING_MODE applies). */
  spaceMode: SkillLearningModeSchema.nullable(),
  /** The agent's own choice (null = follows the Space). Absent when no botId was asked for. */
  botMode: SkillLearningModeSchema.nullable().optional(),
  /** What applies to the agent (or to new agents when no botId was asked for). */
  effective: SkillLearningModeSchema,
  /** The curator runs on this server (SKILL_CURATOR=1). */
  available: z.boolean(),
});
export type SkillLearningSettings = z.infer<typeof SkillLearningSettingsSchema>;

export const LearnedSkillInfoSchema = z.object({
  skillId: Id,
  botId: Id.nullable(),
  botName: z.string().nullable(),
  runId: z.string().nullable(),
  taught: z.boolean(),
  patches: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LearnedSkillInfo = z.infer<typeof LearnedSkillInfoSchema>;

export const TeachingStateSchema = z.object({
  active: z.boolean(),
  sessionId: Id.optional(),
  task: z.string().optional(),
  startedAt: z.string().optional(),
});
export type TeachingState = z.infer<typeof TeachingStateSchema>;

export const skillLearningProcedures = {
  /** The Learning mode of one agent (botId) or the Space default (no botId). */
  settings: oc.input(z.object({ botId: Id.optional() })).output(SkillLearningSettingsSchema),
  /** Set an agent's mode (botId) or the Space default; mode null clears the choice. */
  setMode: oc
    .input(z.object({ botId: Id.optional(), mode: SkillLearningModeSchema.nullable() }))
    .output(SkillLearningSettingsSchema),
  /** Keep (optionally with edited SKILL.md content) or discard a proposal from its card. */
  decide: oc
    .input(
      z.object({
        proposalId: Id,
        decision: z.enum(["keep", "discard"]),
        content: z.string().min(1).max(100_000).optional(),
      }),
    )
    .output(LearnedSkillBlockSchema),
  /** Provenance of the Space's learned skills, for the Skills window. */
  learned: oc.output(z.array(LearnedSkillInfoSchema)),
  /** The chat teaching session of one agent in one chat. */
  teaching: oc.input(z.object({ botId: Id, threadId: Id })).output(TeachingStateSchema),
  /** Start, save (turn into a skill draft) or cancel a chat teaching session. */
  teach: oc
    .input(
      z.object({
        botId: Id,
        threadId: Id,
        action: z.enum(["start", "save", "cancel"]),
        task: z.string().trim().min(1).max(300).optional(),
      }),
    )
    .output(TeachingStateSchema),
  /** Copy a saved screen-taught skill into a regular agent skill (the taught one stays). */
  fromTaught: oc
    .input(z.object({ taughtSkillId: Id }))
    .output(z.object({ skillId: Id, name: z.string() })),
};
