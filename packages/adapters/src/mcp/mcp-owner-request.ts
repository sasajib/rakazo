/**
 * Fork (FORK.md 1.26): an MCP server the owner himself asked for is not asked about again.
 *
 * Upstream posts a pending approval card for every `add_mcp_server`, also when the owner has just
 * typed "add this server" into the chat. Behind MCP_OWNER_REQUEST_AUTO_APPROVE (default OFF =
 * upstream behaviour; "1" turns it on) the server is assigned to the calling agent at once and the
 * card is posted already connected, as a notice, when ALL of this holds:
 * - the run was started by the owner's own message in the app, his follow-up or the close of his
 *   call (not another agent, a new agent's first task, a routine, a webhook, a ticket);
 * - it is not a messaging-channel run (a chat app is not the app's own chat);
 * - no outside content has entered the run (the same taint check standing_set and the other
 *   owner-only tools use): a web page or a channel message cannot be what asked for the server;
 * - the server needs no OAuth authorization step (that popup is the owner's to complete);
 * - the agent asked for the server for itself (assign_to_self).
 * Anything else keeps the pending card. The rule is about who asked, never about which server.
 */
import { getLogger } from "@rakazo/logging";

/** Off unless MCP_OWNER_REQUEST_AUTO_APPROVE is "1" (also "true" / "on"). */
export function mcpOwnerAutoApproveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env.MCP_OWNER_REQUEST_AUTO_APPROVE ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "on";
}

/** Triggers of a run the owner is in right now. A routine is his prompt, but nobody is there. */
const OWNER_PRESENT_TRIGGERS = new Set(["user", "follow_up", "call_end"]);

export interface OwnerRequestFacts {
  trigger: string;
  ownerStartedRun: boolean;
  messagingChannelRun: boolean;
  /** Outside content (a channel or webhook message) entered the run; unknown counts as yes. */
  receivedOutsideMessage: boolean;
}

export type OwnerRequestVerdict =
  | { autoApprove: true }
  | {
      autoApprove: false;
      why:
        | "disabled"
        | "no_run_facts"
        | "not_assigned"
        | "needs_oauth"
        | "not_owner_started"
        | "owner_not_present"
        | "messaging_channel"
        | "outside_content";
    };

export function ownerRequestVerdict(
  facts: OwnerRequestFacts | undefined,
  server: { needsOAuth: boolean; assignToSelf: boolean },
  env: NodeJS.ProcessEnv = process.env,
): OwnerRequestVerdict {
  if (!mcpOwnerAutoApproveEnabled(env)) return { autoApprove: false, why: "disabled" };
  if (!facts) return { autoApprove: false, why: "no_run_facts" };
  if (!server.assignToSelf) return { autoApprove: false, why: "not_assigned" };
  if (server.needsOAuth) return { autoApprove: false, why: "needs_oauth" };
  if (!facts.ownerStartedRun) return { autoApprove: false, why: "not_owner_started" };
  if (!OWNER_PRESENT_TRIGGERS.has(facts.trigger))
    return { autoApprove: false, why: "owner_not_present" };
  if (facts.messagingChannelRun) return { autoApprove: false, why: "messaging_channel" };
  if (facts.receivedOutsideMessage) return { autoApprove: false, why: "outside_content" };
  return { autoApprove: true };
}

/**
 * The run's facts for the rule. The taint lookup costs a query, so it is made only when everything
 * else already allows it; a lookup that fails counts as tainted.
 */
export async function ownerRequestFacts(
  run: { trigger: string },
  source: { ownerStartedRun?: boolean; messagingChannelRun?: boolean } | undefined,
  receivedOutsideMessage: (() => Promise<boolean>) | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OwnerRequestFacts | undefined> {
  if (!mcpOwnerAutoApproveEnabled(env)) return undefined;
  const facts = {
    trigger: run.trigger,
    ownerStartedRun: source?.ownerStartedRun === true,
    messagingChannelRun: source?.messagingChannelRun === true,
  };
  const worthAsking =
    facts.ownerStartedRun && !facts.messagingChannelRun && OWNER_PRESENT_TRIGGERS.has(run.trigger);
  const tainted =
    !worthAsking || !receivedOutsideMessage
      ? true
      : await receivedOutsideMessage().catch(() => true);
  return { ...facts, receivedOutsideMessage: tainted };
}

/** One line per server that reached an agent without a card to answer. No names, no secrets. */
export function logMcpAutoApproved(input: {
  runId: string;
  botId: string;
  serverId: string;
  reason: "owner_request" | "reused";
}) {
  getLogger().info("mcp.server.auto_approved", {
    "run.id": input.runId,
    "bot.id": input.botId,
    "mcp.server_id": input.serverId,
    "mcp.reason": input.reason,
  });
}
