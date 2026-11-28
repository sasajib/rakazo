import { McpServerSchema } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";

const logged = vi.hoisted(() => [] as Array<{ message: string; attributes: unknown }>);
vi.mock("@rakazo/logging", () => ({
  getLogger: () => ({
    error: (message: string, attributes: unknown) => logged.push({ message, attributes }),
  }),
}));

import { readableMcpServers } from "./mcp-server-list-fork.js";
import { mcpServerDto } from "./mcp-servers.js";

const row = (over: Record<string, unknown> = {}) => ({
  id: "srv-1",
  spaceId: "space-1" as string | null,
  organizationId: null as string | null,
  slug: "tools",
  name: "Tools",
  description: "",
  transport: "streamable_http",
  endpoint: "https://tools.example.test/mcp",
  command: null,
  args: [],
  hasArgs: false,
  env: {},
  files: {},
  headers: {},
  secretId: null,
  allSpaces: false,
  availableIn: [],
  allBots: true,
  enabled: true,
  revision: 1,
  healthStatus: "unknown",
  healthMessage: null,
  healthToolCount: null,
  healthCheckedAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...over,
});
const oauth = {
  status: "none",
  clientId: null,
  credential: false,
  hasBearerToken: false,
} as unknown as Parameters<typeof mcpServerDto>[1];
const viewer = { spaceId: "space-9", managedOrganizationId: "org-1" };

// FORK.md 1.29.
describe("an organization's MCP server in a reply (fork)", () => {
  // Upstream fixed the reply at sync 1128b: the server reads as in the viewer's Space. The fork's
  // own patch (no `availability` at all) is gone; this case keeps the reply schema pinned.
  it("reads as in the viewer's Space, and passes the reply schema", () => {
    const dto = mcpServerDto(row({ spaceId: null, organizationId: "org-1" }), oauth, viewer);
    expect(dto.availability).toEqual({ allSpaces: false, spaceIds: ["space-9"] });
    expect(dto).toMatchObject({ spaceId: "space-9", organization: true, manageable: true });
    expect(McpServerSchema.safeParse(dto).success).toBe(true);
  });

  it("keeps a member's own server as it was", () => {
    const dto = mcpServerDto(row({ availableIn: [{ spaceId: "space-2" }] }), oauth, viewer);
    expect(dto.availability).toEqual({ allSpaces: false, spaceIds: ["space-1", "space-2"] });
    expect(dto.organization).toBe(false);
  });
});

describe("readableMcpServers (fork)", () => {
  it("leaves out a row that fails the reply schema or cannot be read, and logs its id only", async () => {
    logged.length = 0;
    const rows = [
      row(),
      row({ id: "srv-bad", revision: 0, name: "Secret name" }),
      row({ id: "srv-throws" }),
      row({ id: "srv-org", spaceId: null, organizationId: "org-1" }),
    ];
    const listed = await readableMcpServers(rows, (item) => {
      if (item.id === "srv-throws") throw new Error("secret does not open");
      return mcpServerDto(item, oauth, viewer);
    });
    expect(listed.map((dto) => dto.id)).toEqual(["srv-1", "srv-org"]);
    expect(logged.map((entry) => entry.message)).toEqual([
      "mcp.server_unreadable",
      "mcp.server_unreadable",
    ]);
    const of = (id: string) =>
      logged.find((entry) => (entry.attributes as Record<string, unknown>)["mcp.server_id"] === id);
    expect(of("srv-bad")?.attributes).toEqual({
      "mcp.server_id": "srv-bad",
      "mcp.reason": "reply_schema",
      "mcp.fields": "revision",
    });
    expect(JSON.stringify(of("srv-bad"))).not.toContain("Secret name");
    expect(of("srv-throws")?.attributes).toMatchObject({ "mcp.reason": "read_failed" });
  });
});
