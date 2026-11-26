import { describe, expect, it, vi } from "vitest";
import type { OwnerRequestFacts } from "./mcp-owner-request.js";
import {
  mcpOwnerAutoApproveEnabled,
  ownerRequestFacts,
  ownerRequestVerdict,
} from "./mcp-owner-request.js";

const on = { MCP_OWNER_REQUEST_AUTO_APPROVE: "1" };
const owner: OwnerRequestFacts = {
  trigger: "user",
  ownerStartedRun: true,
  messagingChannelRun: false,
  receivedOutsideMessage: false,
};
const plain = { needsOAuth: false, assignToSelf: true };

describe("an MCP server the owner asked for himself (fork 1.26)", () => {
  it("is off unless MCP_OWNER_REQUEST_AUTO_APPROVE switches it on", () => {
    expect(mcpOwnerAutoApproveEnabled({})).toBe(false);
    expect(mcpOwnerAutoApproveEnabled({ MCP_OWNER_REQUEST_AUTO_APPROVE: "" })).toBe(false);
    expect(mcpOwnerAutoApproveEnabled({ MCP_OWNER_REQUEST_AUTO_APPROVE: "0" })).toBe(false);
    expect(mcpOwnerAutoApproveEnabled(on)).toBe(true);
    expect(mcpOwnerAutoApproveEnabled({ MCP_OWNER_REQUEST_AUTO_APPROVE: " On " })).toBe(true);
    expect(ownerRequestVerdict(owner, plain, {})).toEqual({ autoApprove: false, why: "disabled" });
  });

  it("approves only the owner's own request, with him there, untainted, without OAuth", () => {
    expect(ownerRequestVerdict(owner, plain, on)).toEqual({ autoApprove: true });
    for (const trigger of ["follow_up", "call_end"])
      expect(ownerRequestVerdict({ ...owner, trigger }, plain, on)).toEqual({ autoApprove: true });
  });

  it.each([
    [
      "another agent's request",
      { trigger: "bot_message", ownerStartedRun: false },
      "not_owner_started",
    ],
    ["a new agent's first task", { trigger: "spawn", ownerStartedRun: false }, "not_owner_started"],
    ["a webhook", { trigger: "webhook", ownerStartedRun: false }, "not_owner_started"],
    ["a routine (his prompt, nobody there)", { trigger: "routine" }, "owner_not_present"],
    ["a chat app he linked", { trigger: "messaging" }, "owner_not_present"],
    ["a messaging-channel run", { messagingChannelRun: true }, "messaging_channel"],
    ["a run outside content entered", { receivedOutsideMessage: true }, "outside_content"],
  ] as const)("keeps the card for %s", (_name, change, why) => {
    expect(ownerRequestVerdict({ ...owner, ...change }, plain, on)).toEqual({
      autoApprove: false,
      why,
    });
  });

  it("keeps the card for a server that needs authorizing, or one not assigned to the agent", () => {
    expect(ownerRequestVerdict(owner, { ...plain, needsOAuth: true }, on)).toEqual({
      autoApprove: false,
      why: "needs_oauth",
    });
    expect(ownerRequestVerdict(owner, { ...plain, assignToSelf: false }, on)).toEqual({
      autoApprove: false,
      why: "not_assigned",
    });
    expect(ownerRequestVerdict(undefined, plain, on)).toEqual({
      autoApprove: false,
      why: "no_run_facts",
    });
  });

  it("reads the run: taint is looked up last, and an unknown answer counts as tainted", async () => {
    const source = { ownerStartedRun: true, messagingChannelRun: false };
    const clean = vi.fn(async () => false);
    expect(await ownerRequestFacts({ trigger: "user" }, source, clean, on)).toEqual(owner);
    expect(clean).toHaveBeenCalledTimes(1);
    // Switched off: nothing is read at all.
    const unused = vi.fn(async () => false);
    expect(await ownerRequestFacts({ trigger: "user" }, source, unused, {})).toBeUndefined();
    // Not the owner's run: no lookup, and never approvable.
    const peer = await ownerRequestFacts(
      { trigger: "bot_message" },
      { ownerStartedRun: false },
      unused,
      on,
    );
    expect(unused).not.toHaveBeenCalled();
    expect(ownerRequestVerdict(peer, plain, on).autoApprove).toBe(false);
    // A lookup that fails, or none to ask, is treated as tainted.
    const broken = async () => {
      throw new Error("db down");
    };
    expect(
      (await ownerRequestFacts({ trigger: "user" }, source, broken, on))?.receivedOutsideMessage,
    ).toBe(true);
    expect(
      (await ownerRequestFacts({ trigger: "user" }, source, undefined, on))?.receivedOutsideMessage,
    ).toBe(true);
    expect(
      (await ownerRequestFacts({ trigger: "user" }, undefined, clean, on))?.ownerStartedRun,
    ).toBe(false);
  });
});
