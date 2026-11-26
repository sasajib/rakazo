import { randomUUID } from "node:crypto";
import { asSystem, createDb, runAsTenant, storedMessageBlocks } from "@rakazo/db";
import { afterEach, describe, expect, it } from "vitest";
import { spawnBot } from "../bots/child-bots.js";
import type { ExecutorDeps } from "../runs/executor/executor-deps.js";
import { addMcpServerFromTool } from "./mcp-server-tool.js";

const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe
    : describe.skip;

const ENDPOINT = "https://mcp.example.test/mcp";

// FORK.md 1.23. On the code before it, add_mcp_server always registered a second server and
// posted a card, and a spawned agent started with none of its creator's servers.
describePostgres("an approved MCP server is reused, not approved again (fork)", () => {
  const previous = process.env.MCP_REUSE_APPROVED_SERVERS;
  afterEach(() => {
    if (previous === undefined) delete process.env.MCP_REUSE_APPROVED_SERVERS;
    else process.env.MCP_REUSE_APPROVED_SERVERS = previous;
  });

  it("assigns the existing server, inside the owner + Space boundary only", async () => {
    delete process.env.MCP_REUSE_APPROVED_SERVERS;
    const db = createDb(runtimeUrl!);
    const fixtures = asSystem(db.prisma);
    const organizationId = randomUUID();
    const userId = randomUUID();
    const strangerId = randomUUID();
    try {
      for (const [id, name] of [
        [userId, "Owner"],
        [strangerId, "Stranger"],
      ] as const)
        await fixtures.user.create({ data: { id, name, email: `${id}@rakazo.test` } });
      await fixtures.organization.create({
        data: { id: organizationId, slug: organizationId, name: "Reuse", createdAt: new Date() },
      });
      const space = await fixtures.space.create({
        data: { id: randomUUID(), organizationId, name: "Space" },
      });
      const otherSpace = await fixtures.space.create({
        data: { id: randomUUID(), organizationId, name: "Other" },
      });
      // The owner is a member of the Space (creating an agent checks it).
      await fixtures.member.create({
        data: { id: randomUUID(), organizationId, userId, role: "owner", createdAt: new Date() },
      });
      await fixtures.spaceMember.create({
        data: {
          id: randomUUID(),
          spaceId: space.id,
          organizationId,
          userId,
          role: "owner",
          createdAt: new Date(),
        },
      });
      type Scope = { spaceId: string; userId: string };
      const home: Scope = { spaceId: space.id, userId };
      const makeBot = async (name: string, scope: Scope = home) => {
        const bot = await fixtures.bot.create({ data: { ...scope, name, color: "gray" } });
        const thread = await fixtures.thread.create({ data: { ...scope, botId: bot.id } });
        return { bot, thread };
      };
      type Agent = Awaited<ReturnType<typeof makeBot>>;
      const first = await makeBot("First");
      const second = await makeBot("Second");
      const third = await makeBot("Third");
      const elsewhere = await makeBot("Elsewhere", { spaceId: otherSpace.id, userId });
      const foreign = await makeBot("Foreign", { spaceId: space.id, userId: strangerId });
      const runFor = async (agent: Agent, scope: Scope = home) => {
        const task = await fixtures.task.create({
          data: {
            ...scope,
            botId: agent.bot.id,
            threadId: agent.thread.id,
            prompt: "x",
            status: "running",
          },
        });
        const run = await fixtures.run.create({
          data: {
            ...scope,
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
          ...scope,
          threadId: agent.thread.id,
          botId: agent.bot.id,
          trigger: "bot_message",
        };
      };
      const stored: unknown[] = [];
      const deps = {
        prisma: db.prisma,
        events: { notify: async () => undefined },
        jobs: { enqueue: async () => undefined },
        secretHttp: { resolveHostname: async () => [{ address: "93.184.216.34", family: 4 }] },
        secretStore: {
          put: async (value: string) => {
            stored.push(value);
            return { id: randomUUID(), ciphertext: "sealed" };
          },
        },
      } as unknown as ExecutorDeps;
      const add = async (
        agent: Agent,
        args: Record<string, unknown>,
        scope: Scope = home,
        options?: { catalogSearchTool?: string; catalogExecuteTool?: string },
      ) => {
        const run = await runFor(agent, scope);
        const result = await runAsTenant(scope, () =>
          addMcpServerFromTool(
            deps,
            run,
            agent.bot.id,
            { transport: "streamable_http", ...args },
            randomUUID(),
            options,
          ),
        );
        return result as { ok?: boolean; reused?: boolean; server_id?: string; next_step?: string };
      };
      const serverCount = () => fixtures.mcpServer.count();
      const cards = async (threadId: string) =>
        (
          await fixtures.message.findMany({
            where: { threadId },
            select: { id: true, blocks: true },
          })
        ).flatMap((row) =>
          storedMessageBlocks(row).filter((block) => block.kind === "mcp_approval"),
        );
      const assignment = (botId: string, serverId: string) =>
        fixtures.botMcpServer.findUnique({ where: { botId_serverId: { botId, serverId } } });

      // The owner approved a server for one agent, with a narrowed tool list.
      const approved = await fixtures.mcpServer.create({
        data: {
          ...home,
          slug: "design-tools",
          name: "Design tools",
          transport: "streamable_http",
          endpoint: ENDPOINT,
          enabled: true,
        },
      });
      await fixtures.botMcpServer.create({
        data: {
          ...home,
          botId: first.bot.id,
          serverId: approved.id,
          allowAllTools: false,
          allowedTools: ["read"],
        },
      });

      // Another agent asks for the same endpoint under another name, spelled differently, with
      // a credential of its own: the approved server is assigned, nothing new is registered.
      const reused = await add(second, {
        name: "Design tools for Second",
        endpoint: "https://MCP.example.test:443/mcp/",
        secret: "call-supplied-credential",
      });
      expect(reused).toMatchObject({ ok: true, reused: true, server_id: approved.id });
      expect(reused.next_step).toContain("from your next turn");
      expect(await serverCount()).toBe(1);
      expect(await cards(second.thread.id)).toHaveLength(0);
      expect(stored).toHaveLength(0);
      expect(await assignment(second.bot.id, approved.id)).toMatchObject({
        allowAllTools: true,
        spaceId: space.id,
        userId,
      });
      // Asking again changes nothing, and the first agent's narrowed list is left alone.
      const again = await add(first, { name: "Design tools", endpoint: ENDPOINT }, home, {
        catalogSearchTool: "connectors_search_tools",
        catalogExecuteTool: "connectors_execute_tool",
      });
      expect(again).toMatchObject({ ok: true, reused: true, server_id: approved.id });
      expect(again.next_step).toContain("available now: find them with connectors_search_tools");
      expect(await assignment(first.bot.id, approved.id)).toMatchObject({
        allowAllTools: false,
        allowedTools: ["read"],
      });
      expect(await fixtures.botMcpServer.count({ where: { serverId: approved.id } })).toBe(2);

      // Boundary: another Space of the same owner does not see it.
      const inOtherSpace = await add(
        elsewhere,
        { name: "Design tools", endpoint: ENDPOINT },
        { spaceId: otherSpace.id, userId },
      );
      expect(inOtherSpace.ok).toBe(true);
      expect(inOtherSpace.reused).toBeUndefined();
      expect(await cards(elsewhere.thread.id)).toHaveLength(1);
      // Boundary: another owner in the same Space does not get the owner's server.
      const byStranger = await add(
        foreign,
        { name: "Design tools", endpoint: ENDPOINT },
        { spaceId: space.id, userId: strangerId },
      );
      expect(byStranger.ok).toBe(true);
      expect(byStranger.reused).toBeUndefined();
      expect(await assignment(foreign.bot.id, approved.id)).toBeNull();
      expect(await serverCount()).toBe(3);

      // A server that is registered but still waits on its card is not "approved": no reuse.
      const pending = await add(second, {
        name: "Pending one",
        endpoint: "https://p.example.test/mcp",
      });
      expect(pending.reused).toBeUndefined();
      const pendingAgain = await add(third, {
        name: "Pending two",
        endpoint: "https://p.example.test/mcp",
      });
      expect(pendingAgain.reused).toBeUndefined();
      expect(await cards(third.thread.id)).toHaveLength(1);
      // A disabled server is not reused either.
      await fixtures.mcpServer.update({ where: { id: approved.id }, data: { enabled: false } });
      const whileDisabled = await add(third, { name: "Design again", endpoint: ENDPOINT });
      expect(whileDisabled.reused).toBeUndefined();
      await fixtures.mcpServer.update({ where: { id: approved.id }, data: { enabled: true } });
      // A server every agent may use needs no assignment row.
      const shared = await fixtures.mcpServer.create({
        data: {
          ...home,
          slug: "shared",
          name: "Shared",
          transport: "sse",
          endpoint: "https://shared.example.test/sse",
          enabled: true,
          allBots: true,
        },
      });
      const viaShared = await add(third, {
        name: "Shared copy",
        transport: "sse",
        endpoint: "https://shared.example.test/sse",
      });
      expect(viaShared).toMatchObject({ reused: true, server_id: shared.id });
      expect(await assignment(third.bot.id, shared.id)).toBeNull();

      // MCP_REUSE_APPROVED_SERVERS=0 restores the old behaviour: a new server and a card.
      process.env.MCP_REUSE_APPROVED_SERVERS = "0";
      const before = await serverCount();
      const old = await add(third, { name: "Design tools copy", endpoint: ENDPOINT });
      expect(old.reused).toBeUndefined();
      expect(old.next_step).toContain("approval card");
      expect(await serverCount()).toBe(before + 1);
      delete process.env.MCP_REUSE_APPROVED_SERVERS;

      // spawn_bot: a specialist created during an owner-started run gets its creator's approved
      // remote servers with the same tool limits; a local (stdio) server is never passed on.
      const local = await fixtures.mcpServer.create({
        data: {
          ...home,
          slug: "local",
          name: "Local",
          transport: "stdio",
          command: "node",
          enabled: true,
        },
      });
      await fixtures.botMcpServer.create({
        data: { ...home, botId: first.bot.id, serverId: local.id },
      });
      const spawn = async (name: string, inheritMcpServers: boolean) => {
        const run = await runFor(first);
        const result = await runAsTenant(home, () =>
          spawnBot(
            { prisma: db.prisma, jobs: { enqueue: async () => undefined } as never },
            {
              spawnedBy: { id: first.bot.id, name: "First", ...home },
              runId: run.id,
              spawnKey: randomUUID(),
              name,
              inheritMcpServers,
            },
          ),
        );
        if (!("ok" in result)) throw new Error(JSON.stringify(result));
        return fixtures.botMcpServer.findMany({
          where: { botId: result.botId },
          select: { serverId: true, allowAllTools: true, allowedTools: true },
        });
      };
      expect(await spawn("Specialist", true)).toEqual([
        { serverId: approved.id, allowAllTools: false, allowedTools: ["read"] },
      ]);
      // Not from a run the owner did not start, and not with the switch off.
      expect(await spawn("Delegated child", false)).toEqual([]);
      process.env.MCP_REUSE_APPROVED_SERVERS = "0";
      expect(await spawn("Switched off", true)).toEqual([]);
    } finally {
      await fixtures.space.deleteMany({ where: { organizationId } }).catch(() => undefined);
      await fixtures.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
      for (const id of [userId, strangerId])
        await fixtures.user.delete({ where: { id } }).catch(() => undefined);
      await db.prisma.$disconnect();
    }
  }, 120_000);
});
