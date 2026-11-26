import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { defaultMarkUnread } from "../assembly/run-messages.js";
import type { ExecutorDeps } from "../executor/executor-deps.js";
import {
  notifyOpenOwnerCards,
  openOwnerCards,
  ownerCardNotification,
} from "./owner-card-notice.js";

const notifyRun = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));
vi.mock("./run-notifications.js", () => ({ notifyRun }));

const approval: MessageBlock = {
  kind: "mcp_approval",
  name: "Any server",
  serverId: "server-1",
  transport: "streamable_http",
  endpoint: "https://mcp.example.test/mcp",
  needsOAuth: false,
  status: "pending",
};
const plan: MessageBlock = {
  kind: "plan",
  planId: "plan-1",
  title: "Any plan",
  steps: [{ text: "Do it" }],
  revision: 1,
  status: "pending",
};

function deps(rows: Array<{ id: string; blocks: MessageBlock[] }>) {
  const findMany = vi.fn(async (_args: unknown) => rows);
  return {
    deps: { prisma: { message: { findMany } } } as unknown as ExecutorDeps,
    findMany,
  };
}

const run = (trigger: string) => ({
  id: "run-1",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  threadId: "thread-1",
  trigger,
});
const bot = { id: "bot-1", name: "Scout" };

describe("owner card notice", () => {
  it("tells the owner once when a delegated run leaves a card waiting", async () => {
    notifyRun.mockClear();
    const { deps: value, findMany } = deps([
      { id: "m1", blocks: [{ kind: "text", text: "Working on it" }] },
      { id: "m2", blocks: [approval] },
      { id: "m3", blocks: [plan] },
    ]);

    await expect(notifyOpenOwnerCards(value, run("bot_message"), bot)).resolves.toBe(2);

    expect(findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { runId: "run-1", threadId: "thread-1", role: "bot" },
    });
    expect(notifyRun).toHaveBeenCalledTimes(1);
    expect(notifyRun.mock.calls[0]?.[2]).toEqual({
      kind: "help",
      title: "Scout needs you",
      body: "A card is waiting for you in this chat: Any server (+1 more)",
      botId: "bot-1",
      threadId: "thread-1",
    });
  });

  it("stays quiet when the card was already decided or the run posted none", async () => {
    notifyRun.mockClear();
    const { deps: value } = deps([
      { id: "m1", blocks: [{ ...approval, status: "connected" } as MessageBlock] },
      { id: "m2", blocks: [{ kind: "text", text: "Done" }] },
    ]);
    await expect(notifyOpenOwnerCards(value, run("bot_message"), bot)).resolves.toBe(0);
    expect(notifyRun).not.toHaveBeenCalled();
  });

  it("leaves runs the owner started to their own notifications", async () => {
    notifyRun.mockClear();
    const { deps: value, findMany } = deps([{ id: "m1", blocks: [approval] }]);
    await expect(notifyOpenOwnerCards(value, run("user"), bot)).resolves.toBe(0);
    expect(findMany).not.toHaveBeenCalled();
    expect(notifyRun).not.toHaveBeenCalled();
  });

  it("never fails the run when the lookup breaks", async () => {
    notifyRun.mockClear();
    const value = {
      prisma: {
        message: {
          findMany: async () => {
            throw new Error("db down");
          },
        },
      },
    } as unknown as ExecutorDeps;
    await expect(notifyOpenOwnerCards(value, run("bot_message"), bot)).resolves.toBe(0);
  });

  it("names the card without its contents", () => {
    expect(openOwnerCards([{ blocks: [approval, { kind: "text", text: "x" }] }])).toEqual([
      approval,
    ]);
    expect(ownerCardNotification("", [plan])).toEqual({
      title: "Bot needs you",
      body: "A card is waiting for you in this chat: Any plan",
    });
  });

  it("marks the chat unread for a card from a delegated run, and only for a card", () => {
    expect(defaultMarkUnread("bot_message", [{ kind: "text", text: "Done" }])).toBe(false);
    expect(defaultMarkUnread("bot_message", [approval])).toBeUndefined();
    expect(defaultMarkUnread("bot_message", [plan])).toBeUndefined();
    expect(defaultMarkUnread("user", [{ kind: "text", text: "Done" }])).toBeUndefined();
  });
});
