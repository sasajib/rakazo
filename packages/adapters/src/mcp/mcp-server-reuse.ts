/**
 * Fork (FORK.md 1.23): an MCP server the owner already approved is reused, not approved again.
 *
 * Upstream gives MCP access per agent (`bot_mcp_servers`) and `add_mcp_server` always registers a
 * NEW server row plus a pending approval card. So every other agent that needs the same endpoint
 * asks the owner again, and agents end up registering duplicates under new names.
 *
 * What this adds, behind MCP_REUSE_APPROVED_SERVERS (default on; "0" restores upstream):
 * - `add_mcp_server` for an endpoint that matches an approved server assigns THAT server to the
 *   calling agent and posts no card (`reuseApprovedMcpServer`).
 * - `spawn_bot` from a run the owner started copies the creator's assignments to the new agent
 *   (`copyApprovedMcpAssignments`), as duplicating an agent in the UI already does.
 *
 * Security boundary (what "approved" may be stretched to, and no further):
 * - Same owner AND same Space only: the lookup is `availableInSpace({spaceId, userId})` of the
 *   run, the same rule every MCP read uses. Nothing crosses owners or reaches a Space the owner did
 *   not make the server available in.
 * - Only servers that are enabled and already approved: `allBots`, or at least one
 *   `bot_mcp_servers` row of this owner in this Space (an approval card or Settings created it). A
 *   server still waiting on its card is never reused.
 * - Never stdio: a local server runs a command on the deployment's own hosts; only an admin adds
 *   or assigns one, in Settings.
 * - The endpoint must match after normalising (scheme, host, port, path, query). The approved
 *   server's stored credential is used; a secret or headers passed with the call are ignored and
 *   never stored, so a call cannot replace or read the approved credential.
 * - An existing assignment is left as it is (a tool list the owner narrowed stays narrowed); a new
 *   one allows all tools, which is what an approval card grants.
 * What the owner gives up: approval is per endpoint for his agents in the Space, no longer per
 * agent. An agent of his that knows the URL of an approved server can use it without a card.
 *
 * An organization's server (upstream, `mcp_servers.organizationId`, no `userId` / `spaceId`):
 * - It is usable by every non-guest member's agents already (`allBots`, upstream's `mcpServerIn`);
 *   nothing here grants or widens that.
 * - Reuse never targets it: the lookup stays `availableInSpace` (the run owner's own servers), so
 *   this code never writes an assignment for a server the run's owner does not own. A call for
 *   its endpoint gets upstream's answer ("Your organization already added this MCP server").
 * - Inheritance copies only the member's OWN `bot_mcp_servers` rows, and for an organization's
 *   server only while it is `allBots`: there such a row can only narrow the tool list, so the
 *   copy keeps a new agent within its creator's limit and gives it nothing it would not have had.
 */
import type { McpServer, Prisma, PrismaClient } from "@rakazo/db";
import { availableInSpace, organizationItemIn } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { logMcpAutoApproved } from "./mcp-owner-request.js";

type Db = PrismaClient | Prisma.TransactionClient;
type Scope = { spaceId: string; userId: string };

/** On unless MCP_REUSE_APPROVED_SERVERS is "0" (also "false" / "off"). */
export function mcpReuseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env.MCP_REUSE_APPROVED_SERVERS ?? "").trim().toLowerCase();
  return value !== "0" && value !== "false" && value !== "off";
}

/**
 * One spelling per endpoint: lower-case scheme and host, no default port, no fragment, no
 * trailing slash, query keys in a stable order. Undefined for anything that is not an http(s) URL.
 */
export function normalizeMcpEndpoint(endpoint: string | null | undefined): string | undefined {
  if (!endpoint) return undefined;
  let url: URL;
  try {
    url = new URL(endpoint.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  url.hash = "";
  url.username = "";
  url.password = "";
  url.searchParams.sort();
  const path = url.pathname.replace(/\/+$/, "");
  const query = url.searchParams.toString();
  // URL already lower-cases the host and drops the scheme's default port.
  return `${url.protocol}//${url.host}${path}${query ? `?${query}` : ""}`;
}

/** The approved server of this owner in this Space that serves `endpoint`, if any. */
export async function findApprovedMcpServer(
  db: Db,
  scope: Scope,
  endpoint: string,
): Promise<McpServer | undefined> {
  const wanted = normalizeMcpEndpoint(endpoint);
  if (!wanted) return undefined;
  const candidates = await db.mcpServer.findMany({
    where: {
      ...availableInSpace(scope),
      enabled: true,
      transport: { not: "stdio" },
      endpoint: { not: null },
      AND: [
        {
          OR: [
            { allBots: true },
            { assignments: { some: { spaceId: scope.spaceId, userId: scope.userId } } },
          ],
        },
      ],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const matching = candidates.filter((server) => normalizeMcpEndpoint(server.endpoint) === wanted);
  // A server every agent may use needs no assignment; otherwise the one approved first.
  return matching.find((server) => server.allBots) ?? matching[0];
}

export type ReusedMcpServer = {
  ok: true;
  reused: true;
  server_id: string;
  name: string;
  next_step: string;
};

/**
 * add_mcp_server for an endpoint the owner already approved: assign the existing server to the
 * calling agent. Undefined when there is nothing to reuse (the caller then registers a new one).
 */
export async function reuseApprovedMcpServer(
  prisma: PrismaClient,
  run: Scope & { id: string },
  botId: string,
  wanted: { endpoint: string; assignToSelf: boolean },
  options: { catalogSearchTool?: string; catalogExecuteTool?: string } = {},
): Promise<ReusedMcpServer | undefined> {
  const outcome = await prisma.$transaction(async (tx) => {
    const server = await findApprovedMcpServer(tx, run, wanted.endpoint);
    if (!server) return undefined;
    const bot = await tx.bot.findFirst({
      where: { id: botId, spaceId: run.spaceId, userId: run.userId, archivedAt: null },
      select: { id: true },
    });
    if (!bot) return undefined;
    let assigned = false;
    if (wanted.assignToSelf && !server.allBots) {
      const existing = await tx.botMcpServer.findUnique({
        where: { botId_serverId: { botId, serverId: server.id } },
        select: { id: true },
      });
      if (!existing) {
        await tx.botMcpServer.create({
          data: {
            spaceId: run.spaceId,
            userId: run.userId,
            botId,
            serverId: server.id,
            allowAllTools: true,
            allowedTools: [],
          },
        });
        assigned = true;
      }
    }
    return { server, assigned };
  });
  if (!outcome) return undefined;
  getLogger().info("mcp.server_reused", {
    "run.id": run.id,
    "bot.id": botId,
    "mcp.server_id": outcome.server.id,
    "mcp.newly_assigned": outcome.assigned,
    "mcp.all_bots": outcome.server.allBots,
  });
  if (wanted.assignToSelf)
    logMcpAutoApproved({
      runId: run.id,
      botId,
      serverId: outcome.server.id,
      reason: "reused",
    });
  const name = outcome.server.name;
  if (!wanted.assignToSelf)
    return {
      ok: true,
      reused: true,
      server_id: outcome.server.id,
      name,
      next_step: `This endpoint is already registered as "${name}" and approved by the owner; no second server was created and nothing was assigned to you (assign_to_self was false).`,
    };
  const now =
    options.catalogSearchTool && options.catalogExecuteTool
      ? `Its tools are available now: find them with ${options.catalogSearchTool} and run them with ${options.catalogExecuteTool}.`
      : `Its tools join your tool list from your next turn (this turn's list was fixed before the assignment). If the work needs them now, end this turn saying it is ready and continue on the next message; do not register it again.`;
  return {
    ok: true,
    reused: true,
    server_id: outcome.server.id,
    name,
    next_step: `Already approved by the owner as "${name}": it is assigned to you, no approval card was posted and none is needed. Do not ask the owner to approve anything. ${now}`,
  };
}

/**
 * spawn_bot: the new agent gets the creator's approved remote MCP assignments (same tool limits).
 * Servers every agent may use (`allBots`) already reach it. Returns how many were copied.
 */
export async function copyApprovedMcpAssignments(
  prisma: PrismaClient,
  input: Scope & { fromBotId: string; toBotId: string },
): Promise<number> {
  const scope = { spaceId: input.spaceId, userId: input.userId };
  const rows = await prisma.botMcpServer.findMany({
    where: {
      botId: input.fromBotId,
      spaceId: input.spaceId,
      userId: input.userId,
      // The member's own rows only. On an organization's server (1.29) that every agent may use,
      // such a row is a tool limit the member set, so the new agent starts with the same limit.
      server: {
        OR: [availableInSpace(scope), { ...organizationItemIn(scope), allBots: true }],
        enabled: true,
        transport: { not: "stdio" },
      },
    },
    select: { serverId: true, allowAllTools: true, allowedTools: true },
  });
  if (rows.length === 0) return 0;
  const target = await prisma.bot.findFirst({
    where: { id: input.toBotId, spaceId: input.spaceId, userId: input.userId },
    select: { id: true },
  });
  if (!target) return 0;
  const created = await prisma.botMcpServer.createMany({
    data: rows.map((row) => ({
      spaceId: input.spaceId,
      userId: input.userId,
      botId: input.toBotId,
      serverId: row.serverId,
      allowAllTools: row.allowAllTools,
      allowedTools: row.allowedTools as Prisma.InputJsonValue,
    })),
    skipDuplicates: true,
  });
  getLogger().info("mcp.assignments_inherited", {
    "bot.id": input.toBotId,
    "bot.parent_id": input.fromBotId,
    "mcp.count": created.count,
  });
  return created.count;
}
