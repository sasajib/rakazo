import type { ConnectorTool } from "@rakazo/adapter-kit";

/**
 * Fork: how a connector tool's own id names the server it belongs to: `mcp__<slug>__<tool>` for
 * an MCP server, `<source>__<tool>` for an installed source. Upstream labels a catalog source by
 * the server's display name (`route.catalogGroup`), which a person can change and two servers
 * can share; the id part is what deployment settings (VAULT_FILL_MCP_BROWSERS) name.
 */
export function connectorToolServerKey(
  tool: Pick<ConnectorTool, "name" | "route">,
): string | undefined {
  const route = tool.route;
  if (!route?.resourceId || !route.toolName) return undefined;
  const suffix = `__${route.toolName}`;
  if (!tool.name.endsWith(suffix)) return undefined;
  const head = tool.name.slice(0, -suffix.length);
  return (route.connectorId === "mcp" ? head.replace(/^mcp__/, "") : head) || undefined;
}

/**
 * Every name the tools' servers go by (id part and source label), for the folded catalog's
 * search tool: once a long tool list is folded, nothing else says which servers are behind it.
 */
export function catalogSourceKeys(
  tools: readonly Pick<ConnectorTool, "name" | "route">[],
): string[] {
  const keys = new Set<string>();
  for (const tool of tools) {
    const key = connectorToolServerKey(tool);
    if (key) keys.add(key);
    const group = tool.route?.catalogGroup?.trim();
    if (tool.route?.resourceId && group) keys.add(group);
  }
  return [...keys];
}
