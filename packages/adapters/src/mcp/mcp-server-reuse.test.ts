import { describe, expect, it } from "vitest";
import { mcpReuseEnabled, normalizeMcpEndpoint } from "./mcp-server-reuse.js";

describe("MCP server reuse rules (fork 1.23)", () => {
  it("is on unless MCP_REUSE_APPROVED_SERVERS switches it off", () => {
    expect(mcpReuseEnabled({})).toBe(true);
    expect(mcpReuseEnabled({ MCP_REUSE_APPROVED_SERVERS: "" })).toBe(true);
    expect(mcpReuseEnabled({ MCP_REUSE_APPROVED_SERVERS: "1" })).toBe(true);
    expect(mcpReuseEnabled({ MCP_REUSE_APPROVED_SERVERS: "0" })).toBe(false);
    expect(mcpReuseEnabled({ MCP_REUSE_APPROVED_SERVERS: " Off " })).toBe(false);
    expect(mcpReuseEnabled({ MCP_REUSE_APPROVED_SERVERS: "false" })).toBe(false);
  });

  it("reads one endpoint the same however it is spelled", () => {
    const same = [
      "https://mcp.example.test/mcp",
      "https://MCP.Example.test/mcp/",
      "HTTPS://mcp.example.test:443/mcp",
      " https://mcp.example.test/mcp#section ",
    ];
    expect(new Set(same.map(normalizeMcpEndpoint))).toEqual(
      new Set(["https://mcp.example.test/mcp"]),
    );
    expect(normalizeMcpEndpoint("https://mcp.example.test/mcp?b=2&a=1")).toBe(
      normalizeMcpEndpoint("https://mcp.example.test/mcp?a=1&b=2"),
    );
  });

  it("keeps different servers apart", () => {
    const base = normalizeMcpEndpoint("https://mcp.example.test/mcp");
    for (const other of [
      "https://mcp.example.test/other",
      "https://mcp.example.test/MCP",
      "https://mcp.example.test:8443/mcp",
      "http://mcp.example.test/mcp",
      "https://mcp2.example.test/mcp",
      "https://mcp.example.test/mcp?tenant=b",
    ])
      expect(normalizeMcpEndpoint(other)).not.toBe(base);
    expect(normalizeMcpEndpoint("not a url")).toBeUndefined();
    expect(normalizeMcpEndpoint("ftp://mcp.example.test/mcp")).toBeUndefined();
    expect(normalizeMcpEndpoint(null)).toBeUndefined();
  });
});
