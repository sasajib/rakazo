import type { JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { returnStoppedBotMessageOutcomes } from "../../messaging/bot-message-stopped.js";
import { createJobReconciler } from "./job-reconciler.js";

vi.mock("../../messaging/bot-messages.js", () => ({ returnBotMessageOutcome: vi.fn() }));
vi.mock("../../tasks/background-helpers.js", () => ({ returnHelperOutcome: vi.fn() }));
vi.mock("../../messaging/bot-message-stopped.js", () => ({
  returnStoppedBotMessageOutcomes: vi.fn(async () => 0),
}));

/** Fork (1.39): every reconciler pass looks for stopped delegated runs that told nobody. */
describe("the reconciler returns stopped delegated requests", () => {
  const jobs: JobPublisher = {
    enqueue: async () => undefined,
    enqueueIn: async () => undefined,
    enqueueManyIn: async () => undefined,
    cancelIn: async () => undefined,
    cancel: async () => undefined,
    close: async () => undefined,
  };
  const prisma = {
    computerExecutionLease: { findMany: vi.fn(async () => []) },
    message: { findMany: vi.fn(async () => []) },
    run: { findMany: vi.fn(async () => []) },
    routine: { findMany: vi.fn(async () => []) },
    computer: { findMany: vi.fn(async () => []) },
  } as unknown as PrismaClient;

  it("on each pass, with the pass's batch size, and a failure does not stop the pass", async () => {
    const events = { notify: vi.fn() } as unknown as ThreadEvents;
    const reconciler = createJobReconciler({ prisma, jobs, events }, { batchSize: 7 });
    await reconciler.reconcileOnce();
    expect(returnStoppedBotMessageOutcomes).toHaveBeenCalledTimes(1);
    expect(returnStoppedBotMessageOutcomes).toHaveBeenCalledWith(
      { prisma, jobs, events },
      expect.objectContaining({ batchSize: 7, now: expect.any(Date) }),
    );
    vi.mocked(returnStoppedBotMessageOutcomes).mockRejectedValueOnce(new Error("database busy"));
    await expect(reconciler.reconcileOnce()).resolves.not.toThrow();
    await reconciler.reconcileOnce();
    expect(returnStoppedBotMessageOutcomes).toHaveBeenCalledTimes(3);
    await reconciler.stop();
  });

  it("not without a way to deliver (no thread events)", async () => {
    vi.mocked(returnStoppedBotMessageOutcomes).mockClear();
    const reconciler = createJobReconciler({ prisma, jobs }, { batchSize: 7 });
    await reconciler.reconcileOnce();
    expect(returnStoppedBotMessageOutcomes).not.toHaveBeenCalled();
    await reconciler.stop();
  });
});
