import { encodeLoginSecret } from "@rakazo/contracts";
import { createStreamingRedactor } from "@rakazo/core";
import { installAuditEventStore } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorRegistry } from "../../integrations/connector-registry.js";
import { McpConnector } from "../../mcp/mcp-connector.js";
import { storeBotSecret } from "../../secrets/bot-secrets.js";
import { fakeAuditLog, fakeDatabase } from "../../secrets/bot-secrets.test-support.js";
import { EncryptedSecretStore } from "../../secrets/secrets.js";
import { VAULT_FILL_TOOL } from "../../secrets/vault/vault-mcp-fill.js";
import { vaultFillTool } from "./run-tools-vault-fill.js";

/**
 * vault_fill through the real McpConnector and a Streamable HTTP MCP server: the server's tools
 * are found by the server's slug in the bot's own catalog, every call of one fill and the bot's
 * own calls share one MCP session, and the bot's tool allowlist still decides what may be called.
 */

const USERNAME = "alice@example.test";
const PASSWORD = "fake-pass!word-7";
const SITE = "https://login.example.test";

const SERVER = {
  id: "server-1",
  slug: "web-driver",
  name: "Web Driver",
  transport: "streamable_http",
  endpoint: "https://mcp.example.test/mcp",
  secretId: null,
  args: [],
  revision: 1,
};

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

/** A browser MCP server answering JSON-RPC over HTTP, with one page and three fields. */
function browserServer(pageUrl: string) {
  const state = {
    initializations: 0,
    /** The session each tool call arrived in. */
    sessions: [] as Array<string | null>,
    calls: [] as Array<{ name: string; args: Record<string, unknown> }>,
    fields: { e1: { type: "email", value: "" }, e2: { type: "password", value: "" } } as Record<
      string,
      { type: string; value: string }
    >,
    focused: undefined as string | undefined,
  };
  const page = { type: "integer", minimum: 0 };
  const tools = [
    {
      name: "act",
      inputSchema: {
        type: "object",
        properties: {
          page,
          kind: { type: "string", enum: ["click", "fill", "focus"] },
          ref: { type: "string" },
          value: { type: "string" },
          sensitive: { type: "boolean" },
          diff: { type: "string" },
        },
        required: ["page", "kind"],
        additionalProperties: false,
      },
    },
    {
      name: "evaluate",
      inputSchema: {
        type: "object",
        properties: { page, code: { type: "string" } },
        required: ["page"],
        additionalProperties: false,
      },
    },
    { name: "snapshot", inputSchema: { type: "object", properties: { page } } },
  ];
  const text = (value: string, isError = false) => ({
    content: [{ type: "text", text: value }],
    ...(isError ? { isError: true } : {}),
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    if (name === "snapshot") return text(JSON.stringify(state.fields));
    if (name === "evaluate") {
      const focused = state.focused ? state.fields[state.focused] : undefined;
      const value = await new AsyncFunction("location", "document", String(args.code))(
        { origin: new URL(pageUrl).origin },
        { activeElement: focused && { tagName: "INPUT", type: focused.type } },
      );
      return text(JSON.stringify(value));
    }
    const field = state.fields[String(args.ref)];
    if (!field) return text("stale ref", true);
    if (args.kind === "focus") state.focused = String(args.ref);
    if (args.kind === "fill") field.value = String(args.value);
    return text("done");
  };
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const message = JSON.parse(await request.text()) as {
      id?: number;
      method?: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    const reply = (result: unknown, headers: Record<string, string> = {}) =>
      Response.json({ jsonrpc: "2.0", id: message.id, result }, { headers });
    if (message.method === "initialize") {
      state.initializations += 1;
      return reply(
        {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "test-browser", version: "1" },
        },
        { "mcp-session-id": `session-${state.initializations}` },
      );
    }
    if (message.method === "tools/list") return reply({ tools });
    if (message.method === "tools/call") {
      const name = String(message.params?.name);
      const args = message.params?.arguments ?? {};
      state.sessions.push(request.headers.get("mcp-session-id"));
      state.calls.push({ name, args });
      return reply(await call(name, args));
    }
    return new Response(null, { status: 202 });
  });
  return { state, fetch };
}

async function setup(options: { pageUrl?: string; allowedTools?: string[] } = {}) {
  fakeAuditLog();
  const server = browserServer(options.pageUrl ?? `${SITE}/login`);
  vi.stubGlobal("fetch", server.fetch);
  const assignment = {
    botId: "b1",
    serverId: SERVER.id,
    spaceId: "space",
    userId: "u",
    allowAllTools: !options.allowedTools,
    allowedTools: options.allowedTools ?? [],
    server: SERVER,
  };
  const mcp = new McpConnector(
    {
      mcpServer: { findMany: async () => [], findFirst: async () => null },
      botMcpServer: { findMany: async () => [assignment], findFirst: async () => assignment },
    } as never,
    {} as never,
    {
      network: {
        fetch: (input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init),
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
      },
    },
  );
  const connector = new ConnectorRegistry([mcp]);
  const db = fakeDatabase();
  const secretStore = new EncryptedSecretStore("test-only-encryption-key");
  const scope = { userId: "u", spaceId: "space" };
  await storeBotSecret({
    prisma: db.prisma,
    secretStore,
    scope,
    destination: { name: "work", origin: SITE, auth: { type: "login" } },
    plaintext: encodeLoginSecret({
      fields: [
        { label: "Email", value: USERNAME, hidden: false },
        { label: "Password", value: PASSWORD, hidden: true },
      ],
    }),
  });
  const context = {
    operationId: "1",
    traceId: "1",
    spaceId: "space",
    userId: "u",
    botId: "b1",
    runId: "run-1",
    signal: new AbortController().signal,
  };
  const ctx = {
    deps: { prisma: db.prisma, secretStore, connector },
    run: { ...scope, id: "run-1", botId: "b1", trigger: "user", threadId: "thread-1" },
    runId: "run-1",
    bot: { id: "b1", name: "Helper" },
    thread: { id: "thread-1" },
    context,
    secrets: [] as string[],
    tools: { offered: [{ name: VAULT_FILL_TOOL }] },
    state: {
      vaultUses: new Set<string>(),
      reply: { pendingProgress: "", redactor: createStreamingRedactor([]) },
    },
  };
  const fill = async () =>
    (await vaultFillTool(
      ctx as never,
      {
        name: VAULT_FILL_TOOL,
        args: {
          secret: "work",
          page: 3,
          fills: [
            { ref: "e1", field: "username" },
            { ref: "e2", field: "password" },
          ],
        },
        effectKey: "effect-1",
        finish: async (result: unknown) => result,
      } as never,
    )) as Record<string, unknown>;
  return { ...server, mcp, connector, context, fill };
}

beforeEach(() => vi.stubEnv("VAULT_FILL_MCP_BROWSERS", SERVER.slug));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  installAuditEventStore(undefined);
});

describe("vault_fill through the MCP connector", () => {
  it("fills in the same MCP session the bot's own calls use", async () => {
    const { state, mcp, connector, context, fill } = await setup();
    try {
      // The bot's own snapshot, as its connector tool call runs it.
      const [snapshot] = (await connector.discoverTools(context as never)).filter(
        (tool) => tool.route?.toolName === "snapshot",
      );
      for await (const _ of connector.execute(
        { tool: snapshot!.name, args: { page: 3 }, executionId: "own", route: snapshot!.route },
        context as never,
      )) {
        // Drained: only the session matters here.
      }
      const result = await fill();
      expect(result).toMatchObject({ ok: true, site: SITE });
      expect(JSON.stringify(result)).not.toContain(PASSWORD);
      expect(state.fields.e1!.value).toBe(USERNAME);
      expect(state.fields.e2!.value).toBe(PASSWORD);
      // One connection for the bot's call and every call of the fill.
      expect(state.initializations).toBe(1);
      expect(new Set(state.sessions)).toEqual(new Set(["session-1"]));
      expect(state.calls.map((call) => `${call.name}:${String(call.args.kind ?? "")}`)).toEqual([
        "snapshot:",
        "act:focus",
        "evaluate:",
        "act:fill",
        "act:focus",
        "evaluate:",
        "act:fill",
      ]);
    } finally {
      await mcp.close();
    }
  });

  it("types nothing on another site", async () => {
    const { state, mcp, fill } = await setup({ pageUrl: "https://other.example.test/login" });
    try {
      expect(await fill()).toMatchObject({ ok: false, completed: 0 });
      expect(state.calls.some((call) => call.args.kind === "fill")).toBe(false);
      expect(JSON.stringify(state.calls)).not.toContain(PASSWORD);
    } finally {
      await mcp.close();
    }
  });

  it("is held to the tools the bot was allowed on that server", async () => {
    // The owner allowed this bot the page actions only: without the page read, nothing is typed.
    const { state, mcp, fill } = await setup({ allowedTools: ["act", "snapshot"] });
    try {
      const result = await fill();
      expect(result).toMatchObject({ ok: false, completed: 0 });
      expect(String(result.error)).toContain("evaluate tool of web-driver is not available");
      expect(state.calls.some((call) => call.args.kind === "fill")).toBe(false);
    } finally {
      await mcp.close();
    }
  });
});
