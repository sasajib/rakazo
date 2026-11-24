/**
 * Fork: which skills one agent may use. `all: true` = every skill of the agent's space (the
 * default, as upstream). `all: false` = only `skillIds`; built-in skills are listed by their
 * `builtin:<name>` id like any other, and a built-in left out of the list is switched off for
 * the agent while built-ins added later stay on.
 */
import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id } from "../ids.js";

export const BotSkillsSchema = z.object({
  botId: Id,
  all: z.boolean(),
  /** The skills open to the agent when `all` is false (empty when it is true). */
  skillIds: z.array(Id),
});
export type BotSkills = z.infer<typeof BotSkillsSchema>;

export const SetBotSkillsInput = z.object({
  botId: Id,
  all: z.boolean(),
  skillIds: z.array(Id.max(200)).max(500).default([]),
});
export type SetBotSkillsInputValue = z.input<typeof SetBotSkillsInput>;

/** For the Skills window: the agents that can use each skill. */
export const SkillAgentsSchema = z.array(
  z.object({
    skillId: Id,
    bots: z.array(z.object({ id: Id, name: z.string() })),
  }),
);
export type SkillAgents = z.infer<typeof SkillAgentsSchema>;

export const botSkillsProcedures = {
  /** The skills one of the caller's agents may use. */
  forBot: oc.input(z.object({ botId: Id })).output(BotSkillsSchema),
  /** Choose the skills one of the caller's agents may use. */
  setForBot: oc.input(SetBotSkillsInput).output(BotSkillsSchema),
  /** Which of the space's agents can use each skill. */
  agents: oc.output(SkillAgentsSchema),
};
