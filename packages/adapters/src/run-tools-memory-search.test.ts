import { beforeEach, describe, expect, it, vi } from "vitest";

const searchHistory = vi.hoisted(() => vi.fn(async () => ({ messages: [{ id: "m1" }] })));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  searchHistory,
}));

import { memoryTools } from "./run-tools-memory.js";

const ctx = (myChatsAllowed: boolean) => ({
  deps: { prisma: {} },
  run: { spaceId: "s1", threadId: "t1", botId: "b1", createdAt: new Date() },
  source: { myChatsAllowed, conversationThreadId: "t1" },
  trust: { receivedOutsideMessage: async () => false },
  secrets: { values: [] },
  computer: { copyEarlierFiles: vi.fn() },
});
const call = (args: Record<string, unknown>) => {
  const finish = vi.fn((result: unknown) => result);
  return { name: "search_history", args, finish };
};

describe("search_history in runs that may not search other chats", () => {
  beforeEach(() => searchHistory.mockClear());

  it("answers a refused my_chats search from this chat, with a note, instead of an error", async () => {
    const c = call({ query: "salary", scope: "my_chats" });
    const out = (await memoryTools.search_history!(ctx(false) as never, c as never)) as {
      note?: string;
      error?: string;
    };
    expect(out.error).toBeUndefined();
    expect(out.note).toMatch(/only this chat was searched/);
    expect(searchHistory).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ allowMyChats: false }),
      expect.objectContaining({ scope: "this_chat", query: "salary" }),
    );
  });

  it("keeps my_chats for a direct human run", async () => {
    const c = call({ query: "salary", scope: "my_chats" });
    const out = (await memoryTools.search_history!(ctx(true) as never, c as never)) as {
      note?: string;
    };
    expect(out.note).toBeUndefined();
    expect(searchHistory).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ allowMyChats: true }),
      expect.objectContaining({ scope: "my_chats" }),
    );
  });

  it("returns guidance, not an error, for a blank query with no kinds", async () => {
    const c = call({ query: "  ", scope: "this_chat", botId: "" });
    const out = (await memoryTools.search_history!(ctx(false) as never, c as never)) as {
      messages: unknown[];
      note: string;
      error?: string;
    };
    expect(out.error).toBeUndefined();
    expect(out.messages).toEqual([]);
    expect(out.note).toMatch(/give `query`/);
    expect(searchHistory).not.toHaveBeenCalled();
  });

  it("still lets kinds alone browse earlier tool work", async () => {
    await memoryTools.search_history!(ctx(false) as never, call({ kinds: ["tool_work"] }) as never);
    expect(searchHistory).toHaveBeenCalled();
  });
});
