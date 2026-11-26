import type * as Core from "@rakazo/core";
import { approvalCardExpires } from "@rakazo/core";
import type * as Db from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { storeBotSecret } from "../../secrets/bot-secrets.js";
import { fakeDatabase } from "../../secrets/bot-secrets.test-support.js";
import { EncryptedSecretStore } from "../../secrets/secrets.js";
import { VAULT_FILL_TOOL } from "../../secrets/vault/vault-mcp-fill.js";
import { gateToolCall } from "./run-tool-gate.js";
import type { ToolRequest } from "./run-tool-request.js";
import { prepareToolRequest } from "./run-tool-request.js";

/**
 * Fork: a saved item its owner set to Ask first asks in every approval mode, Never ask included.
 * The real vault, the real prepare step and the real gate; the test stops where the approval
 * card's effect would be stored (as run-tool-gate.test.ts does).
 */
const plans = vi.hoisted(() => [] as string[]);
vi.mock("@rakazo/core", async (importOriginal) => {
  const core = await importOriginal<typeof Core>();
  return {
    ...core,
    planActionGate: (input: Parameters<typeof core.planActionGate>[0]) => {
      const plan = core.planActionGate(input);
      plans.push(plan);
      return plan;
    },
  };
});
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  recordAuditEvent: vi.fn(async () => {}),
}));
vi.mock("../lifecycle/run-effects.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordEffect: vi.fn(async () => {
    throw new Error("effect recorded");
  }),
}));

const site = "https://login.example.test";
const shop = "https://shop.example.test";
const owner = { userId: "user-1", spaceId: "space-1" };
const main = JSON.stringify(["pi-tool", "main", "call-1"]);
type Mode = "never" | "auto" | "ask";

async function setup() {
  const db = fakeDatabase();
  const secretStore = new EncryptedSecretStore("test-only-encryption-key");
  const login = (name: string, policy: "allow" | "ask") =>
    storeBotSecret({
      prisma: db.prisma,
      secretStore,
      scope: owner,
      destination: { name, origin: site, auth: { type: "login" } },
      plaintext: JSON.stringify({
        fields: [
          { label: "Email", value: "alice@example.test", hidden: false },
          { label: "Password", value: "fake-password-1", hidden: true },
        ],
      }),
      policy,
    });
  await login("asks", "ask");
  await login("plain", "allow");
  const card = (name: string, policy?: "ask") =>
    storeBotSecret({
      prisma: db.prisma,
      secretStore,
      scope: owner,
      destination: { name, origin: "", auth: { type: "card" } },
      plaintext: '{"number":"4242424242424242","expMonth":8,"expYear":2030,"cvc":"737"}',
      ...(policy ? { policy } : {}),
    });
  await card("visa");
  await card("careful");
  // A card can still carry Ask first from before only logins offered it.
  db.rows().find((row) => row.name === "careful")!.policy = "ask";
  Object.assign(db.prisma.secret, { findFirst: async () => null });

  const ctx = (mode: Mode, trigger = "user") => ({
    deps: { prisma: db.prisma, secretStore },
    run: { ...owner, botId: "bot-1", id: "run-1", trigger, threadId: "thread-1" },
    runId: "run-1",
    bot: { id: "bot-1", name: "Helper" },
    thread: { id: "thread-1" },
    source: { ownerStartedRun: trigger === "user" },
    providers: { browser: {} },
    computer: { pageBrowserAllowed: false, heldForTakeover: false },
    context: { signal: new AbortController().signal },
    secrets: [],
    tools: { connector: new Map(), connectedPlugins: [], offered: [{ name: VAULT_FILL_TOOL }] },
    state: {
      walletHosts: new Set<string>(),
      tainted: false,
      effects: { consumedIds: new Set(), counts: new Map(), occurrences: [] },
    },
    trust: {
      loadApprovalRules: async () => [],
      loadAutoReviewPreference: async () => ({
        enabled: mode === "auto",
        skipApprovals: mode === "never",
      }),
      loadApprovalModel: async () => null,
    },
  });
  const request = (name: string, args: Record<string, unknown>): ToolRequest => ({
    name,
    args,
    executionId: main,
    connectorCall: { tool: name, args, executionId: main, route: undefined },
    effectRequest: args,
    resolvedTool: undefined,
    catalogRemapped: false,
    nextApprovedTool: undefined,
    approvedEffectKey: undefined,
    replayEffectToolName: name,
    fleetSummary: undefined,
    heldForApproval: false,
    settingsChange: false,
    ignoresAllowRules: false,
    purchase: undefined,
    cardUse: undefined,
    loginUse: undefined,
  });
  /** Prepare, then the gate: the plan it chose and what the prepare step asked for. */
  const call = async (
    mode: Mode,
    name: string,
    args: Record<string, unknown>,
    trigger?: string,
  ) => {
    plans.length = 0;
    const prepared = request(name, args);
    const context = ctx(mode, trigger);
    const refused = await prepareToolRequest(context as never, prepared);
    if (refused) throw new Error(JSON.stringify(refused));
    await gateToolCall(context as never, prepared, undefined).catch(() => undefined);
    return { plan: plans.at(-1), prepared };
  };
  return { call };
}

const signIn = (secret: string) => ({
  actions: [{ kind: "fill_secret", ref: "e1", secret, field: "Password" }],
});
const vaultFill = (secret: string) => ({
  secret,
  page: 7,
  fills: [{ ref: "e2", field: "Password" }],
});
const payWith = (card: string) => ({
  actions: [{ kind: "fill_card", ref: "e2", card, site: shop, field: "number" }],
});

describe("a saved item set to Ask first, in each approval mode", () => {
  beforeEach(() => {
    plans.length = 0;
  });

  it.each([
    ["browser_act", signIn("asks")],
    [VAULT_FILL_TOOL, vaultFill("asks")],
  ])("asks before %s signs in with it in Never ask, as in Ask and Auto", async (name, args) => {
    const { call } = await setup();
    for (const mode of ["never", "ask", "auto"] as const) {
      const { plan, prepared } = await call(mode, name, args);
      expect(prepared.itemAsksFirst).toBe(true);
      expect(prepared.fleetSummary).toMatchObject({
        title: expect.stringContaining("Sign in to login.example.test"),
      });
      expect(plan).toBe("ask");
    }
  });

  it.each([
    ["browser_act", signIn("plain")],
    [VAULT_FILL_TOOL, vaultFill("plain")],
  ])("leaves a login without it alone: %s runs in Never ask without a card", async (name, args) => {
    const { call } = await setup();
    const { plan, prepared } = await call("never", name, args);
    expect(prepared.itemAsksFirst).toBeUndefined();
    expect(prepared.loginUse).toBeUndefined();
    expect(plan).toBe("allow");
  });

  it("types a saved card without a card to answer in Never ask, as before, and asks in Ask and Auto", async () => {
    const { call } = await setup();
    const never = await call("never", "browser_act", payWith("visa"));
    expect(never.prepared.cardUse).toMatchObject({ card: "visa" });
    expect(never.prepared.itemAsksFirst).toBeUndefined();
    expect(never.plan).toBe("allow");
    for (const mode of ["ask", "auto"] as const) {
      expect((await call(mode, "browser_act", payWith("visa"))).plan).toBe("ask");
    }
  });

  it("asks in Never ask for a saved card that is itself set to Ask first", async () => {
    const { call } = await setup();
    const { plan, prepared } = await call("never", "browser_act", payWith("careful"));
    expect(prepared.itemAsksFirst).toBe(true);
    expect(plan).toBe("ask");
  });

  it("asks for an Ask first login the call names by its title or in another case", async () => {
    const { call } = await setup();
    for (const given of ["ASKS", " Asks "]) {
      const { plan, prepared } = await call("never", "browser_act", signIn(given));
      expect(prepared.loginUse).toMatchObject({ login: "asks" });
      expect(prepared.args.actions).toEqual([expect.objectContaining({ secret: "asks" })]);
      expect(plan).toBe("ask");
    }
  });

  it("asks in an unattended run in Never ask too, on a card that expires unanswered", async () => {
    const { call } = await setup();
    for (const trigger of ["webhook", "routine", "bot_message"]) {
      expect(approvalCardExpires(trigger)).toBe(true);
      expect((await call("never", VAULT_FILL_TOOL, vaultFill("asks"), trigger)).plan).toBe("ask");
    }
  });
});
