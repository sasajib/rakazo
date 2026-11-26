import { randomUUID } from "node:crypto";
import { asSystem, createDb, runAsTenant } from "@rakazo/db";
import { afterEach, describe, expect, it } from "vitest";
import { spawnBot } from "../bots/child-bots.js";
import type { ExecutorDeps } from "../runs/executor/executor-deps.js";
import { findApprovedMcpServer } from "./mcp-server-reuse.js";
import { addMcpServerFromTool } from "./mcp-server-tool.js";

const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe
    : describe.skip;

const ENDPOINT = "https://team-mcp.example.test/mcp";

// FORK.md 1.29: the fork's reuse (1.23) beside an organization's server, which has no owner
// account and no Space. It is usable by every member's agents; the fork never assigns it.
describePostgres("an organization's MCP server and the fork's reuse (fork)", () => {
  const previous = process.env.MCP_REUSE_APPROVED_SERVERS;
  afterEach(() => {
    if (previous === undefined) delete process.env.MCP_REUSE_APPROVED_SERVERS;
    else process.env.MCP_REUSE_APPROVED_SERVERS = previous;
  });

  it("is never assigned by reuse; a member's own tool limit follows a spawned agent", async () => {
    delete process.env.MCP_REUSE_APPROVED_SERVERS;
    const db = createDb(runtimeUrl!);
    const fixtures = asSystem(db.prisma);
    const organizationId = randomUUID();
    const memberId = randomUUID();
    const adminId = randomUUID();
    try {
      await fixtures.organization.create({
        data: { id: organizationId, slug: organizationId, name: "Team", createdAt: new Date() },
      });
      for (const [id, role] of [
        [memberId, "member"],
        [adminId, "owner"],
      ] as const) {
        await fixtures.user.create({ data: { id, name: role, email: `${id}@rakazo.test` } });
        await fixtures.member.create({
          data: { id: randomUUID(), organizationId, userId: id, role, createdAt: new Date() },
        });
      }
      // After the members: a default Space created first would add their Space membership itself.
      const space = await fixtures.space.create({
        data: { id: randomUUID(), organizationId, name: "Team", isDefault: true },
      });
      for (const [id, role] of [
        [memberId, "member"],
        [adminId, "owner"],
      ] as const)
        await fixtures.spaceMember.create({
          data: {
            id: randomUUID(),
            spaceId: space.id,
            organizationId,
            userId: id,
            role,
            createdAt: new Date(),
          },
        });
      const home = { spaceId: space.id, userId: memberId };
      const makeBot = async (name: string, scope = home) => {
        const bot = await fixtures.bot.create({ data: { ...scope, name, color: "gray" } });
        const thread = await fixtures.thread.create({ data: { ...scope, botId: bot.id } });
        return { bot, thread };
      };
      const first = await makeBot("First");
      const adminBot = await makeBot("Admin bot", { spaceId: space.id, userId: adminId });
      const runFor = async (agent: Awaited<ReturnType<typeof makeBot>>) => {
        const task = await fixtures.task.create({
          data: {
            ...home,
            botId: agent.bot.id,
            threadId: agent.thread.id,
            prompt: "x",
            status: "running",
          },
        });
        const run = await fixtures.run.create({
          data: {
            ...home,
            botId: agent.bot.id,
            threadId: agent.thread.id,
            taskId: task.id,
            status: "running",
            trigger: "bot_message",
            startedAt: new Date(),
          },
        });
        return {
          id: run.id,
          ...home,
          threadId: agent.thread.id,
          botId: agent.bot.id,
          trigger: "bot_message",
        };
      };
      const deps = {
        prisma: db.prisma,
        events: { notify: async () => undefined },
        jobs: { enqueue: async () => undefined },
        secretHttp: { resolveHostname: async () => [{ address: "93.184.216.34", family: 4 }] },
        secretStore: { put: async () => ({ id: randomUUID(), ciphertext: "sealed" }) },
      } as unknown as ExecutorDeps;

      const shared = await fixtures.mcpServer.create({
        data: {
          organizationId,
          userId: null,
          spaceId: null,
          allBots: true,
          slug: "team-tools",
          name: "Team tools",
          transport: "streamable_http",
          endpoint: ENDPOINT,
          enabled: true,
        },
      });
      // The admin's agent has a row of its own on it; nothing below may copy or touch it.
      await fixtures.botMcpServer.create({
        data: { spaceId: space.id, userId: adminId, botId: adminBot.bot.id, serverId: shared.id },
      });

      // Reuse looks only at the run owner's own servers.
      expect(
        await runAsTenant(home, () => findApprovedMcpServer(db.prisma, home, ENDPOINT)),
      ).toBeUndefined();
      // add_mcp_server for the organization's address: upstream's answer, no server, no assignment.
      const run = await runFor(first);
      const result = (await runAsTenant(home, () =>
        addMcpServerFromTool(
          deps,
          run,
          first.bot.id,
          {
            transport: "streamable_http",
            name: "Mine",
            endpoint: "https://TEAM-MCP.example.test:443/mcp",
            secret: "s",
          },
          randomUUID(),
        ),
      )) as { ok?: boolean; reused?: boolean; error?: string };
      expect(result.ok).toBeUndefined();
      expect(result.reused).toBeUndefined();
      expect(result.error).toContain("Your organization already added this MCP server");
      expect(await fixtures.mcpServer.count({ where: { organizationId: null } })).toBe(0);
      expect(await fixtures.botMcpServer.count({ where: { userId: memberId } })).toBe(0);

      const spawn = async (name: string) => {
        const spawnRun = await runFor(first);
        const spawned = await runAsTenant(home, () =>
          spawnBot(
            { prisma: db.prisma, jobs: { enqueue: async () => undefined } as never },
            {
              spawnedBy: { id: first.bot.id, name: "First", ...home },
              runId: spawnRun.id,
              spawnKey: randomUUID(),
              name,
              inheritMcpServers: true,
            },
          ),
        );
        if (!("ok" in spawned)) throw new Error(JSON.stringify(spawned));
        return fixtures.botMcpServer.findMany({
          where: { botId: spawned.botId },
          select: { serverId: true, userId: true, allowAllTools: true, allowedTools: true },
        });
      };
      // No row of the member's own: the new agent gets none (it uses the server as every agent does).
      expect(await spawn("Plain child")).toEqual([]);

      // The member limited his agent to one tool of the organization's server: the limit follows.
      await fixtures.botMcpServer.create({
        data: {
          ...home,
          botId: first.bot.id,
          serverId: shared.id,
          allowAllTools: false,
          allowedTools: ["search"],
        },
      });
      expect(await spawn("Limited child")).toEqual([
        { serverId: shared.id, userId: memberId, allowAllTools: false, allowedTools: ["search"] },
      ]);
      // A server not open to every agent is never assigned by a copy.
      await fixtures.mcpServer.update({ where: { id: shared.id }, data: { allBots: false } });
      expect(await spawn("Not shared child")).toEqual([]);
      // The admin's row is as it was, and no server was created along the way.
      expect(await fixtures.botMcpServer.count({ where: { userId: adminId } })).toBe(1);
      expect(await fixtures.mcpServer.count()).toBe(1);
    } finally {
      await fixtures.space.deleteMany({ where: { organizationId } }).catch(() => undefined);
      await fixtures.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
      for (const id of [memberId, adminId])
        await fixtures.user.delete({ where: { id } }).catch(() => undefined);
      await db.prisma.$disconnect();
    }
  }, 120_000);
});
