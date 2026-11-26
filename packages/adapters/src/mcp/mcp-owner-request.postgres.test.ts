import { randomUUID } from "node:crypto";
import { asSystem, createDb, runAsTenant, storedMessageBlocks } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "../runs/executor/executor-deps.js";
import type { OwnerRequestFacts } from "./mcp-owner-request.js";
import { addMcpServerFromTool } from "./mcp-server-tool.js";

const info = vi.hoisted(() => vi.fn());
vi.mock("@rakazo/logging", async (original) => {
  const actual = await original<typeof import("@rakazo/logging")>();
  return {
    ...actual,
    getLogger: () => {
      const logger = actual.getLogger();
      return new Proxy(logger, {
        get: (target, key, receiver) =>
          key === "info"
            ? (...args: unknown[]) => {
                info(...args);
              }
            : Reflect.get(target, key, receiver),
      });
    },
  };
});

const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe
    : describe.skip;

// FORK.md 1.26. On the code before it every add_mcp_server posted a pending card, also when the
// owner had just asked for the server himself.
describePostgres("an MCP server the owner asked for is connected without a question (fork)", () => {
  const previous = process.env.MCP_OWNER_REQUEST_AUTO_APPROVE;
  afterEach(() => {
    if (previous === undefined) delete process.env.MCP_OWNER_REQUEST_AUTO_APPROVE;
    else process.env.MCP_OWNER_REQUEST_AUTO_APPROVE = previous;
  });

  it("assigns it and posts the card as a notice, for the owner's own untainted request only", async () => {
    process.env.MCP_OWNER_REQUEST_AUTO_APPROVE = "1";
    const db = createDb(runtimeUrl!);
    const fixtures = asSystem(db.prisma);
    const organizationId = randomUUID();
    const userId = randomUUID();
    try {
      await fixtures.user.create({
        data: { id: userId, name: "Owner", email: `${userId}@rakazo.test` },
      });
      await fixtures.organization.create({
        data: { id: organizationId, slug: organizationId, name: "Auto", createdAt: new Date() },
      });
      const space = await fixtures.space.create({
        data: { id: randomUUID(), organizationId, name: "Space" },
      });
      const home = { spaceId: space.id, userId };
      const bot = await fixtures.bot.create({ data: { ...home, name: "Agent", color: "gray" } });
      const thread = await fixtures.thread.create({ data: { ...home, botId: bot.id } });
      const stored: string[] = [];
      const deps = {
        prisma: db.prisma,
        events: { notify: async () => undefined },
        secretHttp: { resolveHostname: async () => [{ address: "93.184.216.34", family: 4 }] },
        secretStore: {
          put: async (value: string) => {
            stored.push(value);
            return { id: randomUUID(), ciphertext: "sealed" };
          },
        },
      } as unknown as ExecutorDeps;
      const owner: OwnerRequestFacts = {
        trigger: "user",
        ownerStartedRun: true,
        messagingChannelRun: false,
        receivedOutsideMessage: false,
      };
      let n = 0;
      const add = async (
        facts: OwnerRequestFacts | undefined,
        args: Record<string, unknown> = {},
        catalog: { catalogSearchTool?: string; catalogExecuteTool?: string } = {},
      ) => {
        n += 1;
        const task = await fixtures.task.create({
          data: { ...home, botId: bot.id, threadId: thread.id, prompt: "x", status: "running" },
        });
        const run = await fixtures.run.create({
          data: {
            ...home,
            botId: bot.id,
            threadId: thread.id,
            taskId: task.id,
            status: "running",
            trigger: facts?.trigger ?? "user",
            startedAt: new Date(),
          },
        });
        const result = (await runAsTenant(home, () =>
          addMcpServerFromTool(
            deps,
            { id: run.id, ...home, threadId: thread.id, botId: bot.id },
            bot.id,
            {
              name: `Server ${n}`,
              transport: "streamable_http",
              endpoint: `https://s${n}.example.test/mcp`,
              secret: "a-static-credential",
              ...args,
            },
            randomUUID(),
            { ...catalog, ...(facts ? { ownerRequest: facts } : {}) },
          ),
        )) as { ok?: boolean; connected?: boolean; server_id: string; next_step: string };
        const messages = await fixtures.message.findMany({
          where: { threadId: thread.id, runId: run.id },
          select: { id: true, blocks: true },
        });
        const card = messages
          .flatMap((row) => storedMessageBlocks(row))
          .find((block) => block.kind === "mcp_approval");
        const assigned = await fixtures.botMcpServer.findUnique({
          where: { botId_serverId: { botId: bot.id, serverId: result.server_id } },
        });
        return { result, card, assigned, runId: run.id };
      };

      // The owner asked, in the app, nothing from outside in the run, a static credential.
      info.mockClear();
      const asked = await add(owner);
      expect(asked.result).toMatchObject({ ok: true, connected: true });
      expect(asked.result.next_step).toContain("the card in the chat is a notice, not a question");
      expect(asked.result.next_step).toContain("from your next turn");
      expect(asked.card).toMatchObject({ kind: "mcp_approval", status: "connected" });
      expect(asked.assigned).toMatchObject({ allowAllTools: true, ...home });
      // The credential is stored the usual way and never logged.
      expect(stored).toHaveLength(1);
      const logged = info.mock.calls.filter(([event]) => event === "mcp.server.auto_approved");
      expect(logged).toEqual([
        [
          "mcp.server.auto_approved",
          {
            "run.id": asked.runId,
            "bot.id": bot.id,
            "mcp.server_id": asked.result.server_id,
            "mcp.reason": "owner_request",
          },
        ],
      ]);
      expect(JSON.stringify(info.mock.calls)).not.toContain("a-static-credential");
      // With the catalog tools in the run it is usable at once, and the result says how.
      const withCatalog = await add(
        owner,
        {},
        {
          catalogSearchTool: "connectors_search_tools",
          catalogExecuteTool: "connectors_execute_tool",
        },
      );
      expect(withCatalog.result.next_step).toContain(
        "available now: find them with connectors_search_tools",
      );

      // Every other case keeps the pending card and assigns nothing.
      const pending = async (
        facts: OwnerRequestFacts | undefined,
        args: Record<string, unknown> = {},
      ) => {
        const outcome = await add(facts, args);
        expect(outcome.result.connected).toBeUndefined();
        expect(outcome.result.next_step).toContain("approval card");
        expect(outcome.card).toMatchObject({ status: "pending" });
        expect(outcome.assigned).toBeNull();
      };
      await pending({ ...owner, trigger: "bot_message", ownerStartedRun: false });
      await pending({ ...owner, trigger: "routine" });
      await pending({ ...owner, trigger: "webhook", ownerStartedRun: false });
      await pending({ ...owner, messagingChannelRun: true });
      await pending({ ...owner, receivedOutsideMessage: true });
      // No static credential: it may need the owner's OAuth step, which is his to complete.
      await pending(owner, { secret: undefined });
      // A caller that does not say who asked (anything not wired to the rule).
      await pending(undefined);
      // Registered without assigning: no card and no assignment, as before.
      const unassigned = await add(owner, { assign_to_self: false });
      expect(unassigned.card).toBeUndefined();
      expect(unassigned.assigned).toBeNull();
      // Switched off (the default): the owner's own request waits on its card as upstream does.
      delete process.env.MCP_OWNER_REQUEST_AUTO_APPROVE;
      await pending(owner);
    } finally {
      await fixtures.space.deleteMany({ where: { organizationId } }).catch(() => undefined);
      await fixtures.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
      await fixtures.user.delete({ where: { id: userId } }).catch(() => undefined);
      await db.prisma.$disconnect();
    }
  }, 120_000);
});
