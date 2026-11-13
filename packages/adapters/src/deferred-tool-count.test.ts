import type { ConnectorTool } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { catalogEntries, deferredToolCount, lazyCatalogTools } from "./lazy-tool-catalog.js";

function tool(name: string, group: string): ConnectorTool {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    route: {
      connectorId: "installed",
      toolName: name,
      resourceId: `r-${name}`,
      catalogGroup: group,
    },
  };
}

describe("deferredToolCount", () => {
  it("counts the tools behind a catalog wrapper that lists its names, even after the tools are copied", () => {
    const tools = [tool("a", "One"), tool("b", "One"), tool("c", "Two")];
    const wrappers = lazyCatalogTools("installed", "installed", "API", catalogEntries(tools));
    expect(deferredToolCount(wrappers.map((wrapper) => ({ ...wrapper })))).toBe(3);
  });

  it("counts from the sources summary when the names do not fit", () => {
    const many = Array.from({ length: 250 }, (_, n) => tool(`tool_${n}`, n % 2 ? "Odd" : "Even"));
    const wrappers = lazyCatalogTools("installed", "installed", "API", catalogEntries(many));
    expect(deferredToolCount(wrappers)).toBe(250);
  });

  it("is zero without a catalog wrapper", () => {
    expect(deferredToolCount([tool("shell", "x")])).toBe(0);
    expect(deferredToolCount([])).toBe(0);
  });
});
