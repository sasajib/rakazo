import { formatSkillsCatalogInstruction } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_AGENT_SKILLS } from "./builtin-skills.prompt.js";
import {
  listAgentSkillRecords,
  skillCreateFromTool,
  skillDeleteFromTool,
  skillReadFromTool,
} from "./skill-tools.js";

type Row = { id: string; name: string; description: string; content: string; source: string };

const SPACE = "space-1";
const USER = "user-1";

function skill(id: string, name: string): Row & { spaceId: string; userId: string } {
  return {
    id,
    name,
    description: `${name} steps`,
    content: `---\nname: ${name}\ndescription: ${name} steps\n---\n\nSECRET-${name}`,
    source: "user",
    spaceId: SPACE,
    userId: USER,
  };
}

/** Two stored skills; bot-a chose only "Alpha" and unticked the first built-in. */
function makePrisma() {
  const rows = [skill("s-alpha", "Alpha"), skill("s-beta", "Beta")];
  const selections = new Map<string, { excludedBuiltins: string[]; skillIds: Set<string> }>([
    [
      "bot-a",
      { excludedBuiltins: [BUILTIN_AGENT_SKILLS[0]!.name], skillIds: new Set(["s-alpha"]) },
    ],
  ]);
  const prisma = {
    agentSkill: {
      findMany: vi.fn(async () => rows.map((row) => ({ ...row }))),
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = rows.find((item) => item.id === where.id);
        return row ? { ...row, files: null } : null;
      }),
      create: vi.fn(async ({ data }: { data: Row & { spaceId: string; userId: string } }) => {
        const row = { ...data, id: `s-${data.name.toLowerCase()}` };
        rows.push(row);
        return row;
      }),
      deleteMany: vi.fn(async ({ where }: { where: { id: string } }) => {
        const index = rows.findIndex((row) => row.id === where.id);
        if (index < 0) return { count: 0 };
        rows.splice(index, 1);
        return { count: 1 };
      }),
    },
    botSkillSelection: {
      findUnique: vi.fn(async ({ where }: { where: { botId: string } }) => {
        const selection = selections.get(where.botId);
        if (!selection) return null;
        return {
          botId: where.botId,
          excludedBuiltins: selection.excludedBuiltins,
          skills: [...selection.skillIds].map((skillId) => ({ skillId })),
        };
      }),
    },
    botSkill: {
      upsert: vi.fn(async ({ create }: { create: { botId: string; skillId: string } }) => {
        selections.get(create.botId)?.skillIds.add(create.skillId);
        return create;
      }),
    },
  };
  return { prisma: prisma as never, selections, raw: prisma };
}

const ownerFor = (botId?: string) => ({ spaceId: SPACE, userId: USER, botId });

describe("per-agent skills (fork)", () => {
  it("leaves an agent with no selection every skill of its space", async () => {
    const { prisma } = makePrisma();
    const names = (await listAgentSkillRecords(prisma, ownerFor("bot-b"))).map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(["Alpha", "Beta", BUILTIN_AGENT_SKILLS[0]!.name]));
    const line = formatSkillsCatalogInstruction(
      await listAgentSkillRecords(prisma, ownerFor("bot-b")),
    );
    expect(line).toContain("Alpha");
    expect(line).toContain("Beta");
  });

  it("puts only the chosen skills, and the built-ins left ticked, in a restricted agent's catalog", async () => {
    const { prisma } = makePrisma();
    const records = await listAgentSkillRecords(prisma, ownerFor("bot-a"));
    const names = records.map((s) => s.name);
    expect(names).toContain("Alpha");
    expect(names).not.toContain("Beta");
    expect(names).not.toContain(BUILTIN_AGENT_SKILLS[0]!.name);
    for (const builtin of BUILTIN_AGENT_SKILLS.slice(1)) expect(names).toContain(builtin.name);
    const line = formatSkillsCatalogInstruction(records) ?? "";
    expect(line).toContain("Alpha");
    expect(line).not.toContain("Beta");
  });

  it("refuses skill_read of a skill the agent was not given, by name and by id", async () => {
    const { prisma } = makePrisma();
    const byName = await skillReadFromTool(prisma, ownerFor("bot-a"), { name: "Beta" });
    expect(byName.error).toMatch(/not assigned to this agent/);
    expect(JSON.stringify(byName)).not.toContain("SECRET-Beta");
    const byId = await skillReadFromTool(prisma, ownerFor("bot-a"), { skillId: "s-beta" });
    expect(byId.error).toMatch(/not assigned to this agent/);
    const builtin = await skillReadFromTool(prisma, ownerFor("bot-a"), {
      name: BUILTIN_AGENT_SKILLS[0]!.name,
    });
    expect(builtin.error).toMatch(/not assigned to this agent/);

    expect(
      (await skillReadFromTool(prisma, ownerFor("bot-a"), { name: "Alpha" })).content,
    ).toContain("SECRET-Alpha");
    expect(
      (await skillReadFromTool(prisma, ownerFor("bot-b"), { name: "Beta" })).content,
    ).toContain("SECRET-Beta");
  });

  it("does not let a restricted agent delete a skill it was not given", async () => {
    const { prisma, raw } = makePrisma();
    const result = await skillDeleteFromTool(prisma, ownerFor("bot-a"), { name: "Beta" });
    expect(result.error).toBe("Skill not found.");
    expect(raw.agentSkill.deleteMany).not.toHaveBeenCalled();
  });

  it("gives a restricted agent the skill it creates, and checks names across the whole space", async () => {
    const { prisma, selections } = makePrisma();
    const clash = await skillCreateFromTool(prisma, ownerFor("bot-a"), {
      name: "Beta",
      description: "dup",
    });
    expect(clash.error).toMatch(/already exists/);

    const created = await skillCreateFromTool(prisma, ownerFor("bot-a"), {
      name: "Gamma",
      description: "New steps",
      body: "Do it",
    });
    expect(created.ok).toBe(true);
    expect(selections.get("bot-a")?.skillIds.has(String(created.id))).toBe(true);
    const names = (await listAgentSkillRecords(prisma, ownerFor("bot-a"))).map((s) => s.name);
    expect(names).toContain("Gamma");
  });
});
