import { randomBytes } from "node:crypto";
import type {
  AdapterContext,
  ConnectorCall,
  ConnectorProvider,
  ConnectorTool,
} from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import { z } from "zod";
import { sanitizeConnectorError } from "../../integrations/connector-safety.js";
import { parseConnectorToolArgs } from "../../tools/lazy-tool-catalog.js";
import { CATALOG_EXECUTE, CATALOG_SEARCH } from "../../tools/lazy-tool-catalog.tool-definition.js";

/**
 * Fork: a saved login (or its authenticator code) typed into a page of a browser the bot drives
 * through an MCP server, with the value put in on this side. The built-in `browser_act
 * fill_secret` only reaches the bot's own page browser; a deployment whose bots browse through an
 * MCP browser had no way to use a saved login at all.
 *
 * Nothing here names a server or a site: which servers are browsers, and how each one focuses a
 * field, reports where its page is and fills it, is deployment configuration.
 */
export const VAULT_FILL_TOOL = "vault_fill";

/** One call of an MCP browser's tool; its arguments may hold the placeholders below. */
const StepSchema = z.object({
  tool: z.string().min(1).max(200),
  args: z.record(z.string(), z.unknown()).default({}),
});

const ShapeSchema = z.object({
  /** Puts the keyboard focus on `{ref}`, so `inspect` can describe the field. Null: it cannot. */
  focus: StepSchema.nullable().optional(),
  /** Runs `{script}` (an async body that returns) or `{function}` (a function) in the page. */
  inspect: StepSchema.optional(),
  /** Types `{value}` into `{ref}`. */
  fill: StepSchema.optional(),
  /**
   * False only for a server that cannot say which element a ref is: the field's type is then not
   * checked, so a hidden value could be typed into a field that displays it.
   */
  elementCheck: z.boolean().optional(),
});

export type VaultFillStep = z.infer<typeof StepSchema>;
export type VaultFillBrowserShape = {
  focus: VaultFillStep | null;
  inspect: VaultFillStep;
  fill: VaultFillStep;
  elementCheck: boolean;
};

/**
 * The default calls, which are BrowserOS neo's: `act` focuses and fills by snapshot ref,
 * `evaluate` runs a script in the page. `sensitive` keeps the value out of that server's own
 * audit log and `diff: "none"` keeps the page's change, which would quote the value, out of the
 * answer. A server with other tool or argument names overrides them per server.
 */
export const DEFAULT_VAULT_FILL_SHAPE: VaultFillBrowserShape = {
  focus: { tool: "act", args: { page: "{page}", kind: "focus", ref: "{ref}", diff: "none" } },
  inspect: { tool: "evaluate", args: { page: "{page}", code: "{script}" } },
  fill: {
    tool: "act",
    args: {
      page: "{page}",
      kind: "fill",
      ref: "{ref}",
      value: "{value}",
      sensitive: true,
      diff: "none",
    },
  },
  elementCheck: true,
};

export type VaultFillConfig = {
  /** The MCP servers that are browsers, as the deployment named them. */
  servers: string[];
  shapeFor: (server: string) => VaultFillBrowserShape;
};

const sameServer = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Which MCP servers a vault value may be typed through, from the environment:
 * `VAULT_FILL_MCP_BROWSERS` is a comma list of server names (an MCP server's slug, or the name of
 * an installed MCP source), and `VAULT_FILL_MCP_BROWSER_SHAPES` an optional JSON object of
 * per-server overrides of the default calls (`"*"` applies to every server). Shapes that cannot
 * be read switch the feature off instead of guessing how to type a password.
 */
export function vaultFillConfig(
  env: Record<string, string | undefined> = {
    VAULT_FILL_MCP_BROWSERS: process.env.VAULT_FILL_MCP_BROWSERS,
    VAULT_FILL_MCP_BROWSER_SHAPES: process.env.VAULT_FILL_MCP_BROWSER_SHAPES,
  },
): VaultFillConfig {
  const servers = [
    ...new Set(
      (env.VAULT_FILL_MCP_BROWSERS ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ];
  const off: VaultFillConfig = { servers: [], shapeFor: () => DEFAULT_VAULT_FILL_SHAPE };
  if (servers.length === 0) return off;
  let overrides: Record<string, z.infer<typeof ShapeSchema>> = {};
  const raw = env.VAULT_FILL_MCP_BROWSER_SHAPES?.trim();
  if (raw) {
    try {
      overrides = z.record(z.string(), ShapeSchema).parse(JSON.parse(raw));
    } catch {
      getLogger().warn("vault_fill.config_invalid", {
        reason: "VAULT_FILL_MCP_BROWSER_SHAPES is not a JSON object of server shapes",
      });
      return off;
    }
  }
  const shapes = new Map<string, VaultFillBrowserShape>();
  for (const server of servers) {
    const named = Object.entries(overrides).find(([name]) => sameServer(name, server))?.[1];
    const merged = { ...DEFAULT_VAULT_FILL_SHAPE, ...overrides["*"], ...named };
    const shape: VaultFillBrowserShape = {
      focus: merged.focus ?? null,
      inspect: merged.inspect ?? DEFAULT_VAULT_FILL_SHAPE.inspect,
      fill: merged.fill ?? DEFAULT_VAULT_FILL_SHAPE.fill,
      elementCheck: merged.elementCheck ?? true,
    };
    // A field can only be described once it has the focus.
    if (shape.elementCheck && !shape.focus) {
      getLogger().warn("vault_fill.config_invalid", {
        server,
        reason: "elementCheck needs a focus step; set elementCheck false to do without",
      });
      return off;
    }
    shapes.set(server.toLowerCase(), shape);
  }
  return {
    servers,
    shapeFor: (server) => shapes.get(server.trim().toLowerCase()) ?? DEFAULT_VAULT_FILL_SHAPE,
  };
}

/** The configured server a call names, however the bot wrote it; the only one when it names none. */
export function vaultFillServer(
  config: VaultFillConfig,
  given: unknown,
): { server: string } | { error: string } {
  if (config.servers.length === 0) {
    return { error: "Filling saved logins through an MCP browser is not set up here." };
  }
  const allowed = `Browser servers saved logins can be typed through: ${config.servers.join(", ")}.`;
  const text = typeof given === "string" ? given.trim() : "";
  if (!text) {
    return config.servers.length === 1
      ? { server: config.servers[0]! }
      : { error: `server is required. ${allowed}` };
  }
  // As a tool id names it too: mcp__<server>__<tool>, <server>__<tool>, <server>:<tool>.
  const bare = text.replace(/^mcp__/i, "");
  const server = config.servers.find(
    (name) =>
      sameServer(name, text) ||
      sameServer(name, bare) ||
      ["__", ":", "/"].some((separator) =>
        bare.toLowerCase().startsWith(`${name.toLowerCase()}${separator}`),
      ),
  );
  return server
    ? { server }
    : { error: `${JSON.stringify(text.slice(0, 80))} is not a browser server here. ${allowed}` };
}

/**
 * Whether this run reaches one of the configured browser servers: one of its tools is listed
 * directly, or the catalog a longer tool list is folded into names the server as a source.
 */
export function vaultFillBrowserInRun(
  discovered: readonly ConnectorTool[],
  config: VaultFillConfig,
): boolean {
  if (config.servers.length === 0) return false;
  return discovered.some((tool) => {
    const route = tool.route;
    if (!route || (route.connectorId !== "mcp" && route.connectorId !== "installed")) return false;
    if (route.resourceId) {
      return config.servers.some((server) => sameServer(server, route.catalogGroup ?? ""));
    }
    if (route.toolName !== CATALOG_SEARCH) return false;
    const listed = tool.description.toLowerCase();
    return config.servers.some((server) => listed.includes(server.toLowerCase()));
  });
}

const PROBE_END = "|END";

/**
 * What the page says of itself and of the field that has the focus, as text the answer is read
 * from. The page's origin is written first and from `location.origin` alone, which page script
 * cannot replace, under a marker made for this one call. The marker is put together in the page,
 * so a server that quotes the script back does not quote a record. Every origin record in the
 * answer must be readable and agree (see readProbe), so a page that slips a second one into the
 * part it does control (the focused element) is refused instead of believed.
 */
function probeScript(marker: string): { body: string; fn: string } {
  const half = Math.ceil(marker.length / 2);
  const body = [
    `const m = '${marker.slice(0, half)}' + '${marker.slice(half)}';`,
    `const o = m + 'O|' + location.origin + '${PROBE_END}';`,
    "let e = document.activeElement;",
    "for (let i = 0; i < 20 && e; i++) {",
    "  if (e.shadowRoot && e.shadowRoot.activeElement) e = e.shadowRoot.activeElement;",
    "  else if (e.tagName === 'IFRAME' && e.contentDocument && e.contentDocument.activeElement) e = e.contentDocument.activeElement;",
    "  else break;",
    "}",
    "const tag = e && e.tagName ? String(e.tagName).toLowerCase() : '';",
    "const type = tag === 'input' ? String(e.type || 'text').toLowerCase() : tag === 'textarea' ? 'textarea' : tag === 'select' ? 'select' : '';",
    "const locked = e && (e.disabled === true || e.readOnly === true) ? 'locked' : 'open';",
    `return o + m + 'E|' + tag + '|' + type + '|' + locked + '${PROBE_END}';`,
  ].join("\n");
  return { body, fn: `() => {\n${body}\n}` };
}

export type PageProbe = {
  /** The page's origin, e.g. https://example.com. */
  origin: string;
  /** The focused element, when the page described one. */
  element?: { tag: string; type: string; locked: boolean };
};

/**
 * Read a probe's answer, however the server wrapped or quoted the returned text. Nothing is
 * read from an answer with an origin record that cannot be read, or with two that differ: the
 * script writes exactly one, so anything else was written by the page.
 */
export function readProbe(result: unknown, marker: string): PageProbe | undefined {
  let text: string;
  try {
    text = typeof result === "string" ? result : JSON.stringify(result);
  } catch {
    return undefined;
  }
  const safe = marker.replace(/[^A-Za-z0-9]/g, "");
  if (!safe) return undefined;
  const origins = [
    ...text.matchAll(
      new RegExp(`${safe}O\\|([a-z][a-z0-9+.-]*://[a-z0-9._:\\[\\]-]{1,300}|null)\\|END`, "g"),
    ),
  ].map((match) => match[1]!);
  const [origin] = origins;
  if (!origin || origins.some((other) => other !== origin)) return undefined;
  if (text.split(`${safe}O|`).length - 1 !== origins.length) return undefined;
  const elements = [
    ...text.matchAll(
      new RegExp(`${safe}E\\|([a-z0-9-]{0,40})\\|([a-z0-9-]{0,40})\\|(locked|open)\\|END`, "g"),
    ),
  ];
  const [element] = elements;
  if (!element || elements.some((other) => other[0] !== element[0])) return { origin };
  return {
    origin,
    element: { tag: element[1]!, type: element[2]!, locked: element[3] === "locked" },
  };
}

/** The types of field each kind of value may be typed into, as the built-in page browser holds it. */
const VISIBLE_INPUT_TYPES = new Set(["text", "email", "tel"]);
const CODE_INPUT_TYPES = new Set(["text", "tel", "number", "password"]);

export type FillKind = "hidden" | "visible" | "code";

/** Why this value may not be typed into the focused field, if it may not. */
export function fieldRefusal(kind: FillKind, element: PageProbe["element"]): string | undefined {
  if (!element?.tag) {
    return "The field could not be identified (it may sit in a frame of another site, or the ref is stale). Take a fresh snapshot and use the field's own ref.";
  }
  if (element.locked) return "The field is read-only.";
  if (kind === "hidden") {
    return element.tag === "input" && element.type === "password"
      ? undefined
      : "A saved password can only be typed into a password field.";
  }
  if (kind === "code") {
    return element.tag === "input" && CODE_INPUT_TYPES.has(element.type)
      ? undefined
      : "A code can only be typed into a text, telephone, number or password field.";
  }
  return (element.tag === "input" && VISIBLE_INPUT_TYPES.has(element.type)) ||
    element.tag === "select"
    ? undefined
    : "A saved username can only be typed into a text, email, or telephone field, or chosen in a dropdown.";
}

type Placeholders = { page: string | number; ref?: string; value?: string; marker?: string };

/** A step's arguments with its placeholders filled in; a key whose placeholder has no value is left out. */
function stepArgs(step: VaultFillStep, values: Placeholders): Record<string, unknown> {
  const script = values.marker ? probeScript(values.marker) : undefined;
  const known: Record<string, unknown> = {
    "{page}": values.page,
    "{ref}": values.ref,
    "{value}": values.value,
    "{script}": script?.body,
    "{function}": script?.fn,
  };
  const fill = (value: unknown): unknown => {
    if (typeof value === "string" && Object.hasOwn(known, value)) return known[value];
    if (Array.isArray(value)) return value.map(fill);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .map(([key, item]) => [key, fill(item)] as const)
          .filter(([, item]) => item !== undefined),
      );
    }
    return value;
  };
  return fill(step.args) as Record<string, unknown>;
}

export type McpBrowserTarget = {
  connector: Pick<ConnectorProvider, "execute" | "resolveCall">;
  context: AdapterContext;
  server: string;
  shape: VaultFillBrowserShape;
  /** The page (tab) id as the server's own tools take it. */
  page: string | number;
  /** Starts each call's execution id, so calls of one tool call are told apart. */
  executionId: string;
  /** Values no error text may quote. */
  secrets: () => string[];
  /** The server's tools found so far in this call, so each is looked up once. */
  found?: Map<string, ConnectorTool>;
};

type StepOutcome =
  | { ok: true; data: unknown }
  /** `sure`: the server answered that it did not do it; otherwise it may have. */
  | { ok: false; sure: boolean; error: string };

const CONNECTORS = ["mcp", "installed"] as const;

const badArguments = (tool: string) =>
  `The browser server's ${tool} tool does not take the arguments configured for it (VAULT_FILL_MCP_BROWSER_SHAPES).`;

/**
 * Call one tool of the browser server through the run's own connector, so it runs in the MCP
 * session the bot's own calls use (the server sees the same client, and tabs it gave the bot are
 * still the bot's), under the same assignment and tool allowlist. The tool is looked up by the
 * server's name among the tools this bot may use, and the match must be that server's.
 */
async function callStep(
  target: McpBrowserTarget,
  label: string,
  step: VaultFillStep,
  values: Placeholders,
): Promise<StepOutcome> {
  const { connector, context, server } = target;
  const args = stepArgs(step, values);
  const executionId = `${target.executionId}:${label}`;
  let call: ConnectorCall | undefined;
  target.found ??= new Map();
  const known = target.found.get(step.tool);
  if (known) {
    try {
      call = {
        tool: known.name,
        args: parseConnectorToolArgs(known.inputSchema, args),
        executionId,
        route: known.route,
      };
    } catch {
      return { ok: false, sure: true, error: badArguments(step.tool) };
    }
  }
  for (const connectorId of known ? [] : CONNECTORS) {
    const id = connectorId === "mcp" ? `mcp__${server}__${step.tool}` : `${server}__${step.tool}`;
    try {
      const resolved = await connector.resolveCall?.(
        {
          tool: id,
          args: { id, arguments: args },
          executionId,
          route: { connectorId, toolName: CATALOG_EXECUTE },
        },
        context,
      );
      const route = resolved?.call.route;
      if (
        route?.connectorId === connectorId &&
        route.resourceId &&
        route.toolName === step.tool &&
        sameServer(route.catalogGroup ?? "", server)
      ) {
        call = resolved!.call;
        target.found.set(step.tool, resolved!.tool);
        break;
      }
    } catch (error) {
      context.signal.throwIfAborted();
      // Unknown here; the other connector may have it. Bad arguments are the shape's mistake.
      if (error instanceof Error && /arguments/i.test(error.message)) {
        return { ok: false, sure: true, error: badArguments(step.tool) };
      }
    }
  }
  if (!call) {
    return {
      ok: false,
      sure: true,
      error: `The ${step.tool} tool of ${server} is not available to this bot.`,
    };
  }
  let outcome: StepOutcome = {
    ok: false,
    sure: false,
    error: "The browser server gave no answer.",
  };
  try {
    for await (const event of connector.execute(
      { ...call, executionId, withApp: false },
      context,
    )) {
      if (event.type === "result") {
        const failed = (event.data as { isError?: unknown } | null)?.isError === true;
        outcome = failed
          ? { ok: false, sure: true, error: serverText(event.data, target.secrets()) }
          : { ok: true, data: event.data };
      } else if (event.type === "error") {
        outcome = {
          ok: false,
          sure: false,
          error: sanitizeConnectorError(event.message, target.secrets()).slice(0, 300),
        };
      }
    }
  } catch (error) {
    context.signal.throwIfAborted();
    return {
      ok: false,
      sure: false,
      error: sanitizeConnectorError(error, target.secrets()).slice(0, 300),
    };
  }
  return outcome;
}

/** The text of a server's refusal, without anything the run hides, cut short. */
function serverText(data: unknown, secrets: string[]): string {
  const content = (data as { content?: unknown } | null)?.content;
  const text = Array.isArray(content)
    ? content
        .map((part) => (typeof part?.text === "string" ? part.text : ""))
        .join(" ")
        .trim()
    : "";
  return sanitizeConnectorError(text || "The browser server refused.", secrets).slice(0, 300);
}

/**
 * Where the page is, and which field has the focus once `ref` was focused. A page that cannot be
 * read is an error: nothing is typed on a page whose site is unknown.
 */
export async function probePage(
  target: McpBrowserTarget,
  label: string,
  ref?: string,
): Promise<{ probe: PageProbe } | { error: string }> {
  const { shape, page } = target;
  if (ref !== undefined && shape.focus) {
    const focused = await callStep(target, `${label}:focus`, shape.focus, { page, ref });
    if (!focused.ok) return { error: `The field could not be focused: ${focused.error}` };
  }
  const marker = `RKZ${randomBytes(9).toString("hex")}`;
  const inspected = await callStep(target, `${label}:inspect`, shape.inspect, { page, marker });
  if (!inspected.ok) return { error: `The page could not be read: ${inspected.error}` };
  const probe = readProbe(inspected.data, marker);
  if (!probe) return { error: "The page did not say which site it is on, so nothing was typed." };
  return { probe };
}

/** Type one value into `ref`. The value goes only into the server call, never into the outcome. */
export async function typeIntoPage(
  target: McpBrowserTarget,
  label: string,
  ref: string,
  value: string,
): Promise<{ ok: true } | { ok: false; sure: boolean; error: string }> {
  const filled = await callStep(target, `${label}:fill`, target.shape.fill, {
    page: target.page,
    ref,
    value,
  });
  return filled.ok ? { ok: true } : filled;
}

/** A page id as a server takes it: a number when it is written as one. */
export function pageId(value: unknown): string | number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > 200) return undefined;
  return /^\d{1,15}$/.test(text) ? Number(text) : text;
}
