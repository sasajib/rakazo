import { getLogger } from "@rakazo/logging";
import { z } from "zod";
import { redactConnectorPayload } from "../../integrations/connector-safety.js";
import {
  LOGIN_CODE_CHANGED,
  loginCodeClaim,
  resolveCodeFill,
  resolveLoginFill,
} from "../../secrets/bot-secrets.js";
import { LOGIN_CODE_FIELD, vaultLoginUseOf } from "../../secrets/vault/vault-card-use.js";
import type { FillKind, McpBrowserTarget } from "../../secrets/vault/vault-mcp-fill.js";
import {
  fieldRefusal,
  pageId,
  probePage,
  typeIntoPage,
  VAULT_FILL_TOOL,
  vaultFillConfig,
  vaultFillServer,
} from "../../secrets/vault/vault-mcp-fill.js";
import type { RunContext } from "../assembly/run-context.js";
import { addRunSecrets, recordVaultUse } from "../assembly/run-context.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";

/** Fork: vault_fill, a saved login typed into a page of an MCP browser (see vault-mcp-fill.ts). */

const Fill = z
  .object({
    ref: z.string().trim().min(1).max(200),
    field: z.string().trim().min(1).max(200).optional(),
    code: z.literal(true).optional(),
  })
  .refine((fill) => Boolean(fill.field) !== Boolean(fill.code), {
    message: "each fill names a field of the login, or code: true for its authenticator code",
  });

const VaultFillArgs = z.object({
  /** Left out only for the code the user entered for this run (request_secret oneTimeCode). */
  secret: z.string().trim().min(1).max(64).optional(),
  server: z.string().max(300).optional(),
  page: z.union([z.string(), z.number()]),
  fills: z.array(Fill).min(1).max(8),
});

type VaultFillInput = z.infer<typeof VaultFillArgs>;

function parseVaultFill(args: Record<string, unknown>): VaultFillInput | { error: string } {
  const parsed = VaultFillArgs.safeParse(args);
  if (!parsed.success) {
    return {
      error:
        "vault_fill needs secret (the login's name from list_secrets), page (the tab's page id) and fills: [{ref, field}] or [{ref, code: true}], with refs from the browser's own snapshot.",
    };
  }
  if (parsed.data.fills.filter((fill) => fill.code).length > 1) {
    return { error: "vault_fill types one code per call." };
  }
  if (!parsed.data.secret && (parsed.data.fills.length > 1 || !parsed.data.fills[0]!.code)) {
    return {
      error:
        "vault_fill needs secret: the login's name from list_secrets. Only the code the user entered for request_secret oneTimeCode is typed without one, as fills: [{ref, code: true}].",
    };
  }
  return parsed.data;
}

/**
 * The call's fills as browser_act's steps name them, so the approval of a login that asks first
 * is worked out (and later held to) by the same code as the built-in fill's.
 */
export function vaultFillLoginSteps(args: Record<string, unknown>): unknown[] {
  const parsed = parseVaultFill(args);
  // A code the user entered for this run is not a saved login: nothing to approve.
  if ("error" in parsed || !parsed.secret) return [];
  return parsed.fills.map((fill) =>
    fill.code
      ? { kind: "fill_code", secret: parsed.secret }
      : { kind: "fill_secret", secret: parsed.secret, field: fill.field },
  );
}

function browserTarget(
  ctx: RunContext,
  args: VaultFillInput,
  executionId: string,
): McpBrowserTarget | { error: string } {
  const config = vaultFillConfig();
  const named = vaultFillServer(config, args.server);
  if ("error" in named) return named;
  const page = pageId(args.page);
  if (page === undefined) return { error: "page must be the tab's page id from the browser." };
  const connector = ctx.deps.connector;
  if (!connector) return { error: "No MCP browser is connected to this run." };
  return {
    connector,
    context: ctx.context,
    server: named.server,
    shape: config.shapeFor(named.server),
    page,
    executionId,
    secrets: () => [...ctx.secrets],
  };
}

/**
 * The page the call would type into, for choosing which of a login's sites an approval names.
 * Nothing is focused or typed; an unreadable page is simply unknown.
 */
export async function vaultFillPageUrl(
  ctx: RunContext,
  args: Record<string, unknown>,
  executionId: string,
): Promise<string | undefined> {
  const parsed = parseVaultFill(args);
  if ("error" in parsed) return undefined;
  const target = browserTarget(ctx, parsed, `${executionId}:ask`);
  if ("error" in target) return undefined;
  const read = await probePage(target, "site");
  return "probe" in read ? read.probe.origin : undefined;
}

const refused = (error: string, completed = 0) => ({
  ok: false,
  uncertain: false,
  error,
  completed,
});

/** The built-in fill's wording names its own tool; this one is called again instead. */
const named = (error: string) => error.replaceAll("browser_act", VAULT_FILL_TOOL);

export async function vaultFillTool(ctx: RunContext, call: ToolCall) {
  const { deps, run } = ctx;
  const args = parseVaultFill(call.args);
  if ("error" in args) return call.finish(refused(args.error));
  const target = browserTarget(ctx, args, call.effectKey);
  if ("error" in target) return call.finish(refused(target.error));
  const log = (outcome: string, extra: Record<string, unknown> = {}) =>
    getLogger().info("vault_fill", {
      runId: run.id,
      botId: ctx.bot.id,
      server: target.server,
      fills: args.fills.length,
      outcome,
      ...extra,
    });
  const stop = async (outcome: string, result: Record<string, unknown>) => {
    log(outcome, { completed: result.completed });
    // Whatever a server's refusal quoted, nothing the run hides leaves in the result.
    return call.finish(redactConnectorPayload(result, [...ctx.secrets]));
  };

  // Where the page is, from the page itself, with the first field focused.
  const first = await probePage(target, "0", args.fills[0]!.ref);
  if ("error" in first) return stop("page_unreadable", refused(first.error));
  const pageOrigin = first.probe.origin;
  if (!pageOrigin.startsWith("https://")) {
    return stop(
      "not_https",
      refused("Website logins can only be filled on an HTTPS origin. Nothing was typed."),
    );
  }

  // Every value before any is typed, so a missing one cannot leave a half-filled form.
  const approval = vaultLoginUseOf(call.args.loginApproval);
  type Ready = {
    ref: string;
    label: string;
    kind: FillKind;
    text: string;
    typed?: () => Promise<void>;
    code?: {
      claim: () => Promise<string | undefined>;
      restore: () => Promise<void>;
      ends: number | undefined;
    };
  };
  const ready: Ready[] = [];
  const wrongSite = (sites: string[]) =>
    refused(
      `This is saved for ${sites.join(", ")}, and the page is on ${pageOrigin}. Nothing was typed. Open that site's own sign-in page first.`,
    );
  const { secret } = args;
  if (!secret) {
    // The code the user entered for this run, which was never in the vault: no item, no use.
    let held: Awaited<ReturnType<typeof resolveCodeFill>>;
    try {
      held = await resolveCodeFill({
        prisma: deps.prisma,
        secretStore: deps.secretStore,
        scope: run,
        runId: run.id,
      });
    } catch (error) {
      ctx.context.signal.throwIfAborted();
      getLogger().warn("one-time code could not be loaded for a fill", {
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return stop("load_failed", refused("This code could not be loaded."));
    }
    if ("error" in held) return stop("refused", refused(named(held.error)));
    addRunSecrets(ctx, held.redactions);
    if (held.origin !== pageOrigin) return stop("wrong_site", wrongSite([held.origin]));
    ready.push({
      ref: args.fills[0]!.ref,
      label: "code",
      kind: "code",
      text: held.text,
      code: { claim: held.claim, restore: held.restore, ends: undefined },
    });
  }
  for (const fill of args.fills) {
    // Typed above: the run's own code names no login.
    if (!secret) break;
    let resolved: Awaited<ReturnType<typeof resolveLoginFill>>;
    try {
      resolved = await resolveLoginFill({
        prisma: deps.prisma,
        secretStore: deps.secretStore,
        scope: run,
        runId: run.id,
        name: secret,
        field: fill.code ? LOGIN_CODE_FIELD : fill.field!,
        ...(fill.code ? { code: true as const } : {}),
        approval,
        pageUrl: pageOrigin,
      });
    } catch (error) {
      ctx.context.signal.throwIfAborted();
      // A stored login that can't be read may quote its own text in the error.
      getLogger().warn("saved login could not be loaded for a fill", {
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return stop("load_failed", refused("This saved login could not be loaded."));
    }
    if ("error" in resolved) return stop("refused", refused(named(resolved.error)));
    // Hidden from here on, before anything is sent: a page may echo what is typed into it.
    addRunSecrets(ctx, resolved.redactions);
    if (resolved.origin !== pageOrigin) return stop("wrong_site", wrongSite(resolved.sites));
    const { used, origin } = resolved;
    const typed = used ? () => recordVaultUse(ctx, VAULT_FILL_TOOL, used, origin) : undefined;
    if (fill.code) {
      if (!used || !resolved.login) {
        return stop(
          "refused",
          refused("This login has no authenticator key. Use request_secret with oneTimeCode."),
        );
      }
      ready.push({
        ref: fill.ref,
        label: "code",
        kind: "code",
        text: resolved.text,
        typed,
        code: {
          ...loginCodeClaim({
            prisma: deps.prisma,
            secretStore: deps.secretStore,
            scope: run,
            runId: run.id,
            login: resolved.login,
            origin,
            code: resolved.text,
          }),
          ends: resolved.codeEnds,
        },
      });
    } else {
      ready.push({
        ref: fill.ref,
        label: fill.field!,
        kind: resolved.hidden ? "hidden" : "visible",
        text: resolved.text,
        typed,
      });
    }
  }

  const filled: Array<{ ref: string; field: string }> = [];
  for (const [index, fill] of ready.entries()) {
    // Each field is checked on the page as it is now: its site again, and what kind of field it is.
    const read = index === 0 ? first : await probePage(target, String(index), fill.ref);
    if ("error" in read) return stop("page_unreadable", refused(read.error, index));
    if (read.probe.origin !== pageOrigin) {
      return stop(
        "page_moved",
        refused("The page moved to another site, so nothing more was typed.", index),
      );
    }
    if (target.shape.elementCheck) {
      const wrongField = fieldRefusal(fill.kind, read.probe.element);
      if (wrongField) return stop("wrong_field", refused(wrongField, index));
    }
    // A code is counted and taken just before the page is asked, by one call only.
    if (fill.code) {
      const { ends } = fill.code;
      const spent =
        ends !== undefined && Date.now() >= ends ? LOGIN_CODE_CHANGED : await fill.code.claim();
      if (spent) return stop("code_refused", refused(named(spent), index));
    }
    const typed = await typeIntoPage(target, String(index), fill.ref, fill.text);
    if (!typed.ok && typed.sure) {
      // The server said it typed nothing: the code goes back, and the login was not used.
      await fill.code?.restore().catch((error: unknown) =>
        getLogger().warn("one-time code could not be restored", {
          errorName: error instanceof Error ? error.name : typeof error,
        }),
      );
      return stop(
        "fill_refused",
        refused(`The browser did not fill ${fill.ref}: ${typed.error}`, index),
      );
    }
    await fill.typed?.();
    if (!typed.ok) {
      return stop("fill_uncertain", {
        ok: false,
        uncertain: true,
        error: `The browser gave no clear answer for ${fill.ref}: ${typed.error} Take a snapshot to see what the field holds before trying again.`,
        completed: index,
      });
    }
    filled.push({ ref: fill.ref, field: fill.label });
  }
  return stop("filled", {
    ok: true,
    site: pageOrigin,
    filled,
    note: "The values are typed and hidden from you. Press the form's submit button with the browser's own tools.",
  });
}

export const vaultFillTools: ToolHandlers = { [VAULT_FILL_TOOL]: vaultFillTool };

/** What the secret tools' notes say of the built-in page fill, as this run's fill is called. */
const WORDING: Array<[RegExp, string]> = [
  [/browser_act fill_code \{ref\}/g, "vault_fill {page, fills: [{ref, code: true}]} (no secret)"],
  [/browser_act fill_code/g, "vault_fill with code: true"],
  [/browser_act fill_secret/g, VAULT_FILL_TOOL],
  [/with browser_act\b/g, `with ${VAULT_FILL_TOOL}`],
];

/** The same value when nothing in it names the built-in fill; only plain data is rebuilt. */
function reworded(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return WORDING.reduce((text, [from, to]) => text.replace(from, to), value);
  }
  if (depth > 6 || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const items = value.map((item) => reworded(item, depth + 1));
    return items.some((item, index) => item !== value[index]) ? items : value;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  const entries = Object.entries(value).map(
    ([key, item]) => [key, reworded(item, depth + 1)] as const,
  );
  return entries.some(([key, item]) => item !== (value as Record<string, unknown>)[key])
    ? { ...value, ...Object.fromEntries(entries) }
    : value;
}

/**
 * The secret tools tell the bot to fill a login with browser_act. A run that was offered
 * vault_fill and not browser_act is told the tool it has instead, so their notes never send it
 * to one it cannot call.
 */
export function withVaultFillWording(handlers: ToolHandlers): ToolHandlers {
  return Object.fromEntries(
    Object.entries(handlers).map(([name, handler]) => [
      name,
      async (ctx: RunContext, call: ToolCall) => {
        const result = await handler(ctx, call);
        const offered = new Set(ctx.tools.offered.map((tool) => tool.name));
        return offered.has(VAULT_FILL_TOOL) && !offered.has("browser_act")
          ? reworded(result)
          : result;
      },
    ]),
  );
}
