/**
 * Fork (FORK.md 1.29): one MCP server row that cannot be turned into a reply must not take the
 * whole list with it. The reply schema checks every row, so a single row an older or newer build
 * wrote differently (or whose stored secret no longer opens) made `mcp/servers/list` answer 500
 * and Settings showed no server at all. Such a row is left out and named in the log by id.
 */
import type { McpServer } from "@rakazo/contracts";
import { McpServerSchema } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";

export async function readableMcpServers<Row extends { id: string }>(
  rows: Row[],
  toDto: (row: Row) => Promise<McpServer> | McpServer,
): Promise<McpServer[]> {
  const read = await Promise.all(
    rows.map(async (row): Promise<McpServer | undefined> => {
      try {
        const dto = await toDto(row);
        const checked = McpServerSchema.safeParse(dto);
        if (checked.success) return dto;
        // Field paths only: a value may be a credential's name or an address.
        getLogger().error("mcp.server_unreadable", {
          "mcp.server_id": row.id,
          "mcp.reason": "reply_schema",
          "mcp.fields": checked.error.issues.map((issue) => issue.path.join(".")).join(", "),
        });
      } catch (error) {
        getLogger().error("mcp.server_unreadable", {
          "mcp.server_id": row.id,
          "mcp.reason": "read_failed",
          error,
        });
      }
      return undefined;
    }),
  );
  return read.filter((dto): dto is McpServer => dto !== undefined);
}
