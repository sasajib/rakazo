import { describe, expect, it } from "vitest";
import { classifyToolError, TOOL_ERROR_CLASSES } from "./tool-error-class.js";

describe("classifyToolError", () => {
  it.each([
    ["This tool is disabled for this bot.", "tool_disabled"],
    ["Memory is full (4096 bytes). Make room by merging, then save again.", "memory_full"],
    ["Honcho request failed: 429", "rate_limited"],
    ["429 inference service is overloaded", "rate_limited"],
    ["Too many requests, slow down", "rate_limited"],
    ["HTTP 401 Unauthorized", "auth"],
    ["request failed with status 403", "auth"],
    ["Invalid API key provided", "auth"],
    ["The operation timed out after 30s", "timeout"],
    ["AbortError: The operation was aborted due to timeout", "timeout"],
    ["connect ECONNREFUSED 127.0.0.1:9210", "network"],
    ["TypeError: fetch failed", "network"],
    ["getaddrinfo ENOTFOUND api.example.com", "network"],
    ["HTTP 503 Service Unavailable", "upstream_5xx"],
    ["502 Bad Gateway", "upstream_5xx"],
    ["Honcho request failed: 409", "upstream_4xx"],
    ["status 404 not found", "upstream_4xx"],
    ["id: Required", "validation"],
    ["input: Expected string, received number", "validation"],
    ["No entry contains old_text. Copy it exactly.", "validation"],
    ["tool reported an error result", "mcp_error"],
    ["MCP error -32602: bad params", "mcp_error"],
    ["something odd happened", "unknown"],
  ] as const)("%s -> %s", (message, expected) => {
    expect(classifyToolError({ message })).toBe(expected);
  });

  it("reads a status from the error object when the text has none", () => {
    expect(classifyToolError({ message: "boom", error: { status: 502 } })).toBe("upstream_5xx");
    expect(classifyToolError({ message: "boom", error: { statusCode: 429 } })).toBe("rate_limited");
  });

  it("uses the refusal code and the tool family", () => {
    expect(classifyToolError({ message: "nope", refusal: "tool_disabled" })).toBe("tool_disabled");
    expect(classifyToolError({ message: "weird failure", tool: "mcp__browser__click" })).toBe(
      "mcp_error",
    );
  });

  it("only ever returns a listed class", () => {
    for (const message of ["", "x", "ECONNRESET", "HTTP 500", "invalid"]) {
      expect(TOOL_ERROR_CLASSES).toContain(classifyToolError({ message }));
    }
  });
});
