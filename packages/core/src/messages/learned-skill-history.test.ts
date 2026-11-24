import { describe, expect, it } from "vitest";
import { blocksToAgentHistoryText } from "./attachments.js";
import { messageReplyPreview } from "./message-quote.js";

// Fork: the skill curator's card as the bot sees it again in later turns.
describe("learned_skill blocks in history", () => {
  const block = {
    kind: "learned_skill" as const,
    proposalId: "p1",
    action: "create" as const,
    name: "Tidy Reports",
    description: "Use when tidying reports",
    summary: "Tidies reports",
    mode: "ask" as const,
    status: "pending" as const,
  };
  it("says a pending proposal is not saved, and a kept one is", () => {
    expect(blocksToAgentHistoryText([block])).toBe(
      '[skill curator: new skill "Tidy Reports" (Tidies reports) - proposed, waiting for the owner\'s Keep or Discard; not saved yet]',
    );
    expect(blocksToAgentHistoryText([{ ...block, status: "kept" }])).toContain("- saved]");
    expect(blocksToAgentHistoryText([{ ...block, status: "discarded" }])).toContain("not kept");
  });
  it("previews as its name", () => {
    expect(messageReplyPreview([block], "bot").text).toBe("Tidy Reports");
  });
});
