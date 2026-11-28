import { describe, expect, it, vi } from "vitest";
import type { RunContext } from "../assembly/run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { taskTools } from "./run-tools-tasks.js";

/**
 * Fork (FORK.md 1.33, A3): an item the agent keeps is the open work of the chat it was added in.
 * The handlers pass the run's own chat; that is what the open-work rule reads.
 */
function scratchpadRun(existing?: { threadId: string | null }) {
  const row = {
    id: "item-1",
    botId: "bot",
    title: "Write part three",
    status: "open",
    notes: "",
    threadId: existing?.threadId ?? null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    ...row,
    ...data,
  }));
  const updateManyAndReturn = vi.fn(async ({ data }: { data: Record<string, unknown> }) => [
    { ...row, ...data },
  ]);
  const ctx = {
    deps: {
      prisma: {
        scratchpadItem: { create, findFirst: vi.fn(async () => row), updateManyAndReturn },
      },
    },
    run: { spaceId: "space", userId: "user", threadId: "chat-1" },
    bot: { id: "bot" },
  } as unknown as RunContext;
  const call = (args: Record<string, unknown>) =>
    ({ args, finish: async (result: unknown) => result }) as unknown as ToolCall;
  return { ctx, call, create, updateManyAndReturn };
}

describe("scratchpad items and the chat they belong to", () => {
  it("scratchpad_add records the run's chat on the item", async () => {
    const h = scratchpadRun();
    await taskTools.scratchpad_add!(h.ctx, h.call({ title: "Write part three" }));
    expect(h.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ title: "Write part three", threadId: "chat-1" }),
    });
  });

  it("scratchpad_update and scratchpad_complete give an item with no chat the run's chat", async () => {
    const h = scratchpadRun({ threadId: null });
    await taskTools.scratchpad_update!(h.ctx, h.call({ itemId: "item-1", notes: "half done" }));
    expect(h.updateManyAndReturn.mock.calls[0]![0].data).toEqual({
      notes: "half done",
      threadId: "chat-1",
    });
    await taskTools.scratchpad_complete!(h.ctx, h.call({ itemId: "item-1" }));
    expect(h.updateManyAndReturn.mock.calls[1]![0].data).toEqual({
      status: "done",
      threadId: "chat-1",
    });
  });

  it("an item keeps the chat it was added in when another chat changes it", async () => {
    const h = scratchpadRun({ threadId: "chat-0" });
    await taskTools.scratchpad_update!(h.ctx, h.call({ itemId: "item-1", status: "parked" }));
    expect(h.updateManyAndReturn.mock.calls[0]![0].data).toEqual({ status: "parked" });
  });
});
