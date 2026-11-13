import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { beforeEach, describe, expect, it } from "vitest";
import type { HonchoConnectionConfig } from "./honcho-client.js";
import { ensureHonchoWorkspace, queryHonchoConclusions } from "./honcho-client.js";
import { honchoOperation, honchoWorkspaceOf } from "./honcho-request-log.js";

let sink: ReturnType<typeof createTestSink>;
beforeEach(() => {
  sink = createTestSink();
  installLogger(createLogger({ service: "test", sinks: [sink], level: "debug" }));
});

const config = (fetch: HonchoConnectionConfig["fetch"]): HonchoConnectionConfig => ({
  baseUrl: "https://api.honcho.dev",
  apiKey: "key-never-logged",
  reasoningLevel: "low",
  fetch,
});

describe("honcho operations", () => {
  it.each([
    ["POST", "/v3/workspaces", "workspace_get_or_create"],
    ["POST", "/v3/workspaces/ws/peers", "peer_get_or_create"],
    ["POST", "/v3/workspaces/ws/conclusions", "write"],
    ["POST", "/v3/workspaces/ws/conclusions/query", "recall"],
    ["GET", "/v3/workspaces/ws/conclusions/c1", "read"],
    ["DELETE", "/v3/workspaces/ws/conclusions/c1", "delete"],
    ["POST", "/v3/workspaces/ws/peers/p/chat", "chat"],
    ["POST", "/v3/workspaces/list?size=1", "admin_probe"],
  ] as const)("%s %s -> %s", (method, path, expected) => {
    expect(honchoOperation(method, path)).toBe(expected);
  });

  it("finds the workspace in the path or in a create body", () => {
    expect(honchoWorkspaceOf("/v3/workspaces/space-1/conclusions", {})).toBe("space-1");
    expect(honchoWorkspaceOf("/v3/workspaces", { id: "space-2" })).toBe("space-2");
    expect(honchoWorkspaceOf("/v3/workspaces/list?size=1", {})).toBeNull();
  });
});

describe("honcho failure log", () => {
  it("logs the status, operation, workspace, attempt and elapsed time of a failed create", async () => {
    const fetch = async () => new Response("conflict", { status: 409 });
    const result = await ensureHonchoWorkspace(config(fetch as never), "space-9");
    expect(result).toEqual({ ok: false, error: "Honcho request failed: 409" });
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      level: "warn",
      message: "honcho.request.failed",
      "honcho.operation": "workspace_get_or_create",
      "honcho.http_status": 409,
      "honcho.failure": "http",
      "honcho.workspace_id": "space-9",
      "honcho.attempt": 1,
    });
    expect(typeof sink.events[0]?.["honcho.elapsed_ms"]).toBe("number");
    expect(JSON.stringify(sink.events)).not.toContain("key-never-logged");
  });

  it("logs a network failure with no status, and never the query text", async () => {
    const fetch = async () => {
      throw new TypeError("fetch failed");
    };
    await queryHonchoConclusions(config(fetch as never), "ws", {
      query: "very private question",
      observerId: "a",
      observedId: "b",
      topK: 3,
    });
    expect(sink.events[0]).toMatchObject({
      "honcho.operation": "recall",
      "honcho.failure": "network",
      "honcho.http_status": null,
    });
    expect(JSON.stringify(sink.events)).not.toContain("private question");
  });

  it("logs nothing for a request that succeeds", async () => {
    await ensureHonchoWorkspace(
      config((async () => new Response("{}", { status: 200 })) as never),
      "ws",
    );
    expect(sink.events).toHaveLength(0);
  });
});
