/**
 * Fork: assigning skills to an agent. One implementation behind both the settings screen
 * (agentSkills/forBot and agentSkills/setForBot in the API) and the `bot_skills` tool, plus the
 * `skills` argument of `spawn_bot`, so a change made by a managing agent is the change the owner
 * would have made by hand.
 *
 * A selection is stored as the chosen stored skills plus the built-in skills switched off (see
 * bot-skill-access.ts); "every skill of the Space" is the absence of a selection.
 */
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import {
  BUILTIN_SKILL_ID_PREFIX,
  botMaySeeSkill,
  isBuiltinSkillId,
  loadBotSkillSelection,
} from "./bot-skill-access.js";
import type { FleetRun } from "./fleet-tools.js";
import { resolveBot } from "./fleet-tools.js";
import { listAgentSkillRecords } from "./skill-tools.js";

type SpaceOwner = { spaceId: string; userId: string };
type CatalogSkill = { id: string; name: string; description: string };
type SelectionWriter = Pick<PrismaClient, "botSkillSelection" | "botSkill">;

export const BOT_SKILLS_ACTIONS = ["list", "add", "remove", "set"] as const;
type BotSkillsAction = (typeof BOT_SKILLS_ACTIONS)[number];

/** Most skills one call may name; the settings screen has the same cap. */
export const BOT_SKILLS_MAX_REFS = 500;
const DESCRIPTION_PREVIEW_CHARS = 140;
const MAX_SUGGESTIONS = 3;

/** Ids that are not skills of the agent's Space. */
export class UnknownBotSkillsError extends Error {
  constructor(readonly unknown: string[]) {
    super("Some of those skills are not available in this agent's space.");
    this.name = "UnknownBotSkillsError";
  }
}

export type BotSkillsState = { botId: string; all: boolean; skillIds: string[] };

/** The Space's skills as the settings screen lists them: built-ins (`builtin:<name>`) and stored. */
export function listSpaceSkills(prisma: PrismaClient, owner: SpaceOwner) {
  return listAgentSkillRecords(prisma, { spaceId: owner.spaceId, userId: owner.userId });
}

/** What an agent may use: `all` when it has no selection, else the ids open to it. */
export async function readBotSkills(
  prisma: PrismaClient,
  owner: SpaceOwner,
  botId: string,
  catalog?: readonly CatalogSkill[],
): Promise<BotSkillsState> {
  const [selection, skills] = await Promise.all([
    loadBotSkillSelection(prisma, botId),
    catalog ?? listSpaceSkills(prisma, owner),
  ]);
  if (!selection) return { botId, all: true, skillIds: [] };
  return {
    botId,
    all: false,
    skillIds: skills.filter((skill) => botMaySeeSkill(selection, skill)).map((skill) => skill.id),
  };
}

/** The rows of a selection that opens exactly `skillIds` out of `catalog`. */
export function selectionRowsFor(
  catalog: readonly CatalogSkill[],
  skillIds: readonly string[],
): { storedIds: string[]; excludedBuiltins: string[] } {
  const known = new Set(catalog.map((skill) => skill.id));
  const wanted = [...new Set(skillIds)];
  const unknown = wanted.filter((id) => !known.has(id));
  if (unknown.length > 0) throw new UnknownBotSkillsError(unknown);
  const chosen = new Set(wanted);
  return {
    storedIds: wanted.filter((id) => !isBuiltinSkillId(id)),
    excludedBuiltins: catalog
      .filter((skill) => isBuiltinSkillId(skill.id) && !chosen.has(skill.id))
      .map((skill) => skill.name),
  };
}

/** Writes a selection; run it inside the caller's transaction. */
export async function writeBotSkillSelection(
  tx: SelectionWriter,
  input: SpaceOwner & { botId: string; storedIds: string[]; excludedBuiltins: string[] },
): Promise<void> {
  const { botId, spaceId, userId, storedIds, excludedBuiltins } = input;
  await tx.botSkillSelection.upsert({
    where: { botId },
    create: { botId, spaceId, userId, excludedBuiltins },
    update: { excludedBuiltins },
  });
  await tx.botSkill.deleteMany({ where: { botId } });
  if (storedIds.length > 0) {
    await tx.botSkill.createMany({
      data: storedIds.map((skillId) => ({ botId, skillId, spaceId, userId })),
    });
  }
}

/**
 * Replaces an agent's skills: `all` drops the selection (every skill of the Space), otherwise
 * exactly `skillIds` stay open. Throws UnknownBotSkillsError for an id outside the Space. The
 * caller has already checked that `owner` may change this agent.
 */
export async function setBotSkills(
  prisma: PrismaClient,
  owner: SpaceOwner,
  input: { botId: string; all: boolean; skillIds?: readonly string[] },
  catalog?: readonly CatalogSkill[],
): Promise<BotSkillsState> {
  if (input.all) {
    // Deleting the selection removes its chosen skills (bot_skills cascades).
    await prisma.botSkillSelection.deleteMany({ where: { botId: input.botId } });
    return readBotSkills(prisma, owner, input.botId, catalog);
  }
  const skills = catalog ?? (await listSpaceSkills(prisma, owner));
  const rows = selectionRowsFor(skills, input.skillIds ?? []);
  await prisma.$transaction((tx) =>
    writeBotSkillSelection(tx, { ...owner, botId: input.botId, ...rows }),
  );
  return readBotSkills(prisma, owner, input.botId, skills);
}

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length]!;
}

/** Names in the catalog close to a reference that matched nothing. */
export function closeSkillNames(catalog: readonly CatalogSkill[], ref: string): string[] {
  const needle = normalized(ref.startsWith(BUILTIN_SKILL_ID_PREFIX) ? ref.slice(8) : ref);
  if (!needle) return [];
  const scored: Array<{ name: string; score: number }> = [];
  for (const skill of catalog) {
    const name = normalized(skill.name);
    const distance = editDistance(needle, name);
    const contains = name.includes(needle) || needle.includes(name);
    if (!contains && distance > Math.max(2, Math.floor(Math.max(needle.length, name.length) / 3)))
      continue;
    scored.push({ name: skill.name, score: contains ? Math.min(distance, 1) : distance });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, MAX_SUGGESTIONS)
    .map((entry) => entry.name);
}

/**
 * Turns what a model wrote (a skill id, `builtin:<name>`, or a skill's name, any case) into
 * catalog ids. Nothing is guessed: a reference that matches no skill exactly is an error that
 * names the closest skills.
 */
export function resolveSkillRefs(
  catalog: readonly CatalogSkill[],
  refs: readonly string[],
): { ok: true; ids: string[] } | { ok: false; error: string } {
  const byId = new Map(catalog.map((skill) => [skill.id, skill]));
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const raw of refs) {
    const ref = raw.trim();
    if (!ref) continue;
    const exact = byId.get(ref);
    const named = normalized(ref.startsWith(BUILTIN_SKILL_ID_PREFIX) ? ref.slice(8) : ref);
    const match =
      exact ??
      catalog.find(
        (skill) =>
          normalized(skill.name) === named &&
          // `builtin:<name>` never reaches a stored skill that happens to share the name.
          (!ref.startsWith(BUILTIN_SKILL_ID_PREFIX) || isBuiltinSkillId(skill.id)),
      );
    if (!match) {
      const close = closeSkillNames(catalog, ref);
      unknown.push(close.length ? `"${ref}" (did you mean ${close.join(", ")}?)` : `"${ref}"`);
      continue;
    }
    if (!ids.includes(match.id)) ids.push(match.id);
  }
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `No skill in this space matches ${unknown.join("; ")}. Nothing was changed. Call bot_skills with action "list" for the exact names.`,
    };
  }
  return { ok: true, ids };
}

function refsFrom(value: unknown): string[] | { error: string } {
  if (value === undefined || value === null) return [];
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list)) return { error: "skills must be a list of skill names or ids." };
  if (list.length > BOT_SKILLS_MAX_REFS)
    return { error: `Name at most ${BOT_SKILLS_MAX_REFS} skills in one call.` };
  return list.map(String);
}

function preview(description: string): string {
  const line = description.replace(/\s+/g, " ").trim();
  return line.length > DESCRIPTION_PREVIEW_CHARS
    ? `${line.slice(0, DESCRIPTION_PREVIEW_CHARS - 1)}…`
    : line;
}

function describeSkills(catalog: readonly CatalogSkill[], open: ReadonlySet<string> | null) {
  return catalog
    .filter((skill) => !open || open.has(skill.id))
    .map((skill) => ({
      id: skill.id,
      name: skill.name,
      ...(isBuiltinSkillId(skill.id) ? { builtin: true } : {}),
    }));
}

/**
 * The stored rows for a new agent's `skills`: the named skills, with every built-in left on (a
 * new agent always starts with the built-ins). Resolved before the agent exists, so a wrong name
 * creates nothing.
 */
export async function resolveNewBotSkills(
  prisma: PrismaClient,
  owner: SpaceOwner,
  value: unknown,
): Promise<{ ok: true; storedIds: string[]; names: string[] } | { ok: false; error: string }> {
  const refs = refsFrom(value);
  if ("error" in refs) return { ok: false, error: refs.error };
  const catalog = await listSpaceSkills(prisma, owner);
  const resolved = resolveSkillRefs(catalog, refs);
  if (!resolved.ok) return resolved;
  const storedIds = resolved.ids.filter((id) => !isBuiltinSkillId(id));
  const chosen = new Set(storedIds);
  return {
    ok: true,
    storedIds,
    names: catalog.filter((skill) => chosen.has(skill.id)).map((skill) => skill.name),
  };
}

/**
 * `bot_skills`: lists or changes the skills of an agent in the caller's Space. The caller is a
 * run whose bot has bot management on (checked live before this runs, like every fleet tool);
 * this adds the settings screen's own rule, that the agent belongs to the run's member.
 */
export async function botSkillsFromTool(
  deps: { prisma: PrismaClient },
  run: FleetRun,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const action = String(args.action ?? "list")
    .trim()
    .toLowerCase() as BotSkillsAction;
  if (!BOT_SKILLS_ACTIONS.includes(action))
    return { error: `action must be one of ${BOT_SKILLS_ACTIONS.join(", ")}.` };
  const target = await resolveBot(deps.prisma, run, args);
  if ("error" in target) return { error: target.error };
  if (target.userId !== run.userId) {
    return {
      error: `${target.name} belongs to another member of this space; only they can change its skills.`,
    };
  }
  const owner = { spaceId: run.spaceId, userId: run.userId };
  const catalog = await listSpaceSkills(deps.prisma, owner);
  const before = await readBotSkills(deps.prisma, owner, target.id, catalog);
  const bot = { botId: target.id, botName: target.name };

  if (action === "list") {
    const open = before.all ? null : new Set(before.skillIds);
    return {
      ...bot,
      allSpaceSkills: before.all,
      skills: describeSkills(catalog, open),
      available: catalog.map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: preview(skill.description),
        ...(isBuiltinSkillId(skill.id) ? { builtin: true } : {}),
        assigned: !open || open.has(skill.id),
      })),
    };
  }

  const all = args.all === true || args.all === "true";
  const refs = refsFrom(args.skills);
  if ("error" in refs) return refs;
  if (all && action !== "set") return { error: 'all works only with action "set".' };
  if (all && refs.length > 0) return { error: "Pass all: true or skills, not both." };
  if (!all && refs.length === 0 && action !== "set")
    return { error: "Pass skills: the names or ids to change." };
  if (!all && action === "set" && !Array.isArray(args.skills) && typeof args.skills !== "string")
    return { error: "set needs skills (an empty list leaves only built-ins) or all: true." };
  const resolved = resolveSkillRefs(catalog, refs);
  if (!resolved.ok) return { error: resolved.error };

  // An agent with no selection has every skill; adding changes nothing and removing starts a
  // selection from everything it has now.
  const current = new Set(before.all ? catalog.map((skill) => skill.id) : before.skillIds);
  let next: Set<string>;
  if (action === "add") next = new Set([...current, ...resolved.ids]);
  else if (action === "remove") {
    next = new Set(current);
    for (const id of resolved.ids) next.delete(id);
  } else {
    next = new Set(resolved.ids);
    // As for a new agent, a built-in stays as it was unless the caller asks for the exact list.
    if (args.exact_builtins !== true) {
      for (const id of current) if (isBuiltinSkillId(id)) next.add(id);
    }
  }
  let after = before;
  if (all) after = await setBotSkills(deps.prisma, owner, { botId: target.id, all: true }, catalog);
  // Adding to an agent that already has every skill must not narrow it to a selection.
  else if (!(before.all && action === "add")) {
    after = await setBotSkills(
      deps.prisma,
      owner,
      { botId: target.id, all: false, skillIds: [...next] },
      catalog,
    );
  }

  const afterOpen = new Set(after.all ? catalog.map((skill) => skill.id) : after.skillIds);
  const added = [...afterOpen].filter((id) => !current.has(id));
  const removed = [...current].filter((id) => !afterOpen.has(id));
  const nameOf = new Map(catalog.map((skill) => [skill.id, skill.name]));
  const changed = added.length + removed.length > 0 || before.all !== after.all;
  // Counts only: skill names and text stay out of the log.
  if (changed) {
    getLogger().info("bot_skills.changed", {
      actorBotId: run.botId,
      targetBotId: target.id,
      spaceId: run.spaceId,
      runId: run.runId,
      action,
      all: after.all,
      added: added.length,
      removed: removed.length,
      total: afterOpen.size,
    });
  }
  return {
    ok: true,
    ...bot,
    allSpaceSkills: after.all,
    added: added.map((id) => nameOf.get(id) ?? id),
    removed: removed.map((id) => nameOf.get(id) ?? id),
    skills: describeSkills(catalog, after.all ? null : afterOpen),
    note: !changed
      ? "Nothing changed: the agent already had exactly these skills."
      : "Saved. It applies from the agent's next run; a run already in progress keeps the list it started with.",
  };
}
