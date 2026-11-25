import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../database/client.js";
import { createDb } from "../database/client.js";
import { runAsSystem, runAsTenant } from "../database/row-security.js";
import { provisionMessagingIdentity } from "../messaging/messaging.js";
import { createRepos, newBotSkillsBuiltinsOnly } from "./bot-repository.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describe("new-agent skills default", () => {
  it("is built-ins only only when RAKAZO_NEW_BOT_SKILLS=builtins", () => {
    expect(newBotSkillsBuiltinsOnly({ RAKAZO_NEW_BOT_SKILLS: "builtins" })).toBe(true);
    expect(newBotSkillsBuiltinsOnly({ RAKAZO_NEW_BOT_SKILLS: " Builtins " })).toBe(true);
    expect(newBotSkillsBuiltinsOnly({})).toBe(false);
    expect(newBotSkillsBuiltinsOnly({ RAKAZO_NEW_BOT_SKILLS: "all" })).toBe(false);
  });
});

describePostgres("a new agent starts with only the built-in skills (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let owner: { userId: string; spaceId: string };
  const previous = process.env.RAKAZO_NEW_BOT_SKILLS;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    owner = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(prisma, {
        provider: "sendblue",
        address: `+1555${String(Date.now()).slice(-7)}`,
      }),
    );
  });

  afterAll(async () => {
    if (previous === undefined) delete process.env.RAKAZO_NEW_BOT_SKILLS;
    else process.env.RAKAZO_NEW_BOT_SKILLS = previous;
    await close();
  });

  const create = (name: string) =>
    runAsTenant(owner, () =>
      createRepos(prisma).createBot(
        {
          userId: owner.userId,
          spaceId: owner.spaceId,
          email: "skills-default@example.com",
          isDeploymentOwner: false,
        },
        { name, description: "", instructions: "", notifyOnFinish: true },
      ),
    );

  it("stores an empty selection for a new agent, so no stored skill is open to it", async () => {
    process.env.RAKAZO_NEW_BOT_SKILLS = "builtins";
    const bot = await create("Fresh");
    const selection = await runAsSystem("test check", () =>
      prisma.botSkillSelection.findUnique({
        where: { botId: bot.id },
        select: { excludedBuiltins: true, skills: { select: { skillId: true } } },
      }),
    );
    expect(selection).toEqual({ excludedBuiltins: [], skills: [] });
  });

  it("keeps upstream's behaviour (no selection = every skill) when the setting is off", async () => {
    delete process.env.RAKAZO_NEW_BOT_SKILLS;
    const bot = await create("Open");
    const selection = await runAsSystem("test check", () =>
      prisma.botSkillSelection.findUnique({ where: { botId: bot.id } }),
    );
    expect(selection).toBeNull();
  });
});
