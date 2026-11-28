import { randomUUID } from "node:crypto";
import { COMMAND_SLOT_BASE, isCommandSlot } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, provisionMessagingIdentity, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ComputerExecutionLease } from "./computer-lifecycle.js";
import {
  acquireComputerExecutionLease,
  ComputerBusyError,
  releaseCommandSlots,
  releaseComputerExecutionLease,
  renewComputerExecutionLease,
  waitForRunComputerLease,
} from "./computer-lifecycle.js";

const url = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE === "1" && url ? describe : describe.skip;

/** Fork (FORK.md 1.40): runs of one bot use its computer for commands at the same time. */
describePostgres("command slots on a Team Computer", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let identity: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  let computerId: string;
  const signal = new AbortController().signal;

  beforeAll(async () => {
    const db = createDb(url!);
    prisma = asSystem(db.prisma);
    identity = await runAsSystem("command slots fixture", () =>
      provisionMessagingIdentity(db.prisma, {
        provider: "email",
        address: `slots-${randomUUID()}@example.test`,
      }),
    );
    computerId = (await prisma.bot.findUniqueOrThrow({ where: { id: identity.botId } }))
      .computerId!;
    close = async () => {
      await prisma.organization.deleteMany({ where: { id: identity.spaceId } });
      await prisma.user.deleteMany({ where: { id: identity.userId } });
      await db.prisma.$disconnect();
      await db.pool.end();
    };
  });
  afterAll(async () => close?.());
  beforeEach(async () => {
    await prisma.computerExecutionLease.deleteMany({ where: { computerId } });
    await prisma.run.updateMany({
      where: { botId: identity.botId },
      data: { status: "completed" },
    });
  });

  /** A running run of the bot: a helper in a thread of its own, anything else in the bot's chat. */
  async function running(trigger: string, commandSlots = 5) {
    const botId = identity.botId;
    const thread =
      trigger === "helper"
        ? await prisma.thread.create({
            data: { spaceId: identity.spaceId, userId: identity.userId, helperBotId: botId },
          })
        : await prisma.thread.upsert({
            where: { botId },
            create: { spaceId: identity.spaceId, userId: identity.userId, botId },
            update: {},
          });
    const task = await prisma.task.create({
      data: {
        spaceId: identity.spaceId,
        userId: identity.userId,
        botId,
        threadId: thread.id,
        prompt: "Do one part of the job",
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: identity.spaceId,
        userId: identity.userId,
        botId,
        threadId: thread.id,
        taskId: task.id,
        trigger,
        status: "running",
        leaseOwner: "worker",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 300_000),
      },
    });
    return {
      computerId,
      botId,
      runId: run.id,
      threadId: thread.id,
      workerId: "worker",
      runFence: 1,
      commandSlots,
    };
  }

  const settles = async (work: Promise<unknown>, ms: number) =>
    Promise.race([
      work.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
    ]);

  /** One run's whole use of the computer: wait for its turn, run a command, let go. */
  async function runsACommand(
    run: Awaited<ReturnType<typeof running>>,
    commandMs: number,
    spans: Array<{ start: number; end: number }>,
  ) {
    const lease = await waitForRunComputerLease(prisma, { ...run, use: "commands" }, signal);
    const start = Date.now();
    await new Promise((resolve) => setTimeout(resolve, commandMs));
    spans.push({ start, end: Date.now() });
    await releaseComputerExecutionLease(prisma, lease);
    await prisma.run.update({ where: { id: run.runId }, data: { status: "completed" } });
  }

  const overlapping = (spans: Array<{ start: number; end: number }>) =>
    spans.filter((a) => spans.some((b) => b !== a && b.start < a.end && a.start < b.end)).length;

  it("runs the commands of four helpers and the bot's own run at the same time", async () => {
    const runs = [
      await running("helper"),
      await running("helper"),
      await running("helper"),
      await running("helper"),
      await running("helper_result"),
    ];
    const spans: Array<{ start: number; end: number }> = [];
    const startedAt = Date.now();
    await Promise.all(runs.map((run) => runsACommand(run, 600, spans)));
    const elapsed = Date.now() - startedAt;
    expect(overlapping(spans)).toBe(5);
    // One after another is 3 s and more; together it is one command and the bookkeeping.
    expect(elapsed).toBeLessThan(2_400);
  });

  it("is one run after another when the setting is 1 (upstream)", async () => {
    const runs = [
      await running("helper", 1),
      await running("helper", 1),
      await running("helper", 1),
    ];
    const spans: Array<{ start: number; end: number }> = [];
    await Promise.all(runs.map((run) => runsACommand(run, 300, spans)));
    expect(overlapping(spans)).toBe(0);
  });

  it("gives each run a command slot of its own and makes one more wait for a free one", async () => {
    const runs = [];
    for (let index = 0; index < 3; index += 1) runs.push(await running("helper", 3));
    const leases: Array<ComputerExecutionLease | null> = [];
    for (const run of runs)
      leases.push(await acquireComputerExecutionLease(prisma, { ...run, use: "commands" }));
    expect(leases.map((lease) => lease?.slot).sort()).toEqual([
      COMMAND_SLOT_BASE,
      COMMAND_SLOT_BASE + 1,
      COMMAND_SLOT_BASE + 2,
    ]);
    const extra = await running("helper", 3);
    await expect(
      acquireComputerExecutionLease(prisma, { ...extra, use: "commands" }),
    ).rejects.toBeInstanceOf(ComputerBusyError);
    const waiting = waitForRunComputerLease(prisma, { ...extra, use: "commands" }, signal);
    expect(await settles(waiting, 400)).toBe(false);
    await releaseComputerExecutionLease(prisma, leases[1]!);
    const taken = await waiting;
    // The freed slot is taken again, with a higher fence: the rows never outgrow the bound.
    expect(taken?.slot).toBe(COMMAND_SLOT_BASE + 1);
    expect(taken!.fence).toBeGreaterThan(leases[1]!.fence);
    expect(
      await prisma.computerExecutionLease.count({ where: { computerId, botId: identity.botId } }),
    ).toBe(3);
  });

  it("keeps the screen one run at a time while commands run beside it", async () => {
    const onScreen = await running("helper");
    const screen = await waitForRunComputerLease(prisma, { ...onScreen, use: "screen" }, signal);
    expect(screen?.slot).toBe(0);
    // Commands of other runs do not wait for the screen's holder.
    const commands = await running("helper");
    const command = await acquireComputerExecutionLease(prisma, { ...commands, use: "commands" });
    expect(isCommandSlot(command!.slot)).toBe(true);
    // A second run that needs the screen waits, as it always did.
    const second = await running("helper");
    await expect(
      acquireComputerExecutionLease(prisma, { ...second, use: "screen" }),
    ).rejects.toBeInstanceOf(ComputerBusyError);
    // So does a caller that names no need, and a run that holds a command slot.
    await expect(acquireComputerExecutionLease(prisma, second)).rejects.toBeInstanceOf(
      ComputerBusyError,
    );
    const changing = waitForRunComputerLease(prisma, { ...commands, use: "screen" }, signal);
    expect(await settles(changing, 400)).toBe(false);
    expect(await renewComputerExecutionLease(prisma, command)).toBe(true);
    await releaseComputerExecutionLease(prisma, screen);
    const changed = await changing;
    expect(changed?.slot).toBe(0);
    expect(changed?.runId).toBe(commands.runId);
    expect(changed!.fence).toBeGreaterThan(screen!.fence);
    // Until the run gives the command slot back it holds both; then only the screen slot.
    expect(await renewComputerExecutionLease(prisma, command)).toBe(true);
    await releaseCommandSlots(prisma, changed);
    expect(await renewComputerExecutionLease(prisma, command)).toBe(false);
    expect(await renewComputerExecutionLease(prisma, changed)).toBe(true);
    const live = await prisma.computerExecutionLease.findMany({
      where: { computerId, botId: identity.botId, expiresAt: { gt: new Date() } },
      select: { slot: true, runId: true },
    });
    expect(live).toEqual([{ slot: 0, runId: commands.runId }]);
  });

  it("still allows one writer per conversation", async () => {
    const first = await running("helper_result");
    const second = await running("user");
    expect(second.threadId).toBe(first.threadId);
    const lease = await acquireComputerExecutionLease(prisma, { ...first, use: "commands" });
    await expect(
      acquireComputerExecutionLease(prisma, { ...second, use: "commands" }),
    ).rejects.toBeInstanceOf(ComputerBusyError);
    await releaseComputerExecutionLease(prisma, lease);
    expect(
      await acquireComputerExecutionLease(prisma, { ...second, use: "commands" }),
    ).not.toBeNull();
  });

  it("refuses an operation that is not a run while a run's commands hold the computer", async () => {
    const helper = await running("helper");
    const lease = await acquireComputerExecutionLease(prisma, { ...helper, use: "commands" });
    const operation = { computerId, botId: identity.botId, runId: `reset:${randomUUID()}` };
    await expect(acquireComputerExecutionLease(prisma, operation)).rejects.toBeInstanceOf(
      ComputerBusyError,
    );
    await releaseComputerExecutionLease(prisma, lease);
    const held = await acquireComputerExecutionLease(prisma, operation);
    expect(held?.slot).toBe(0);
  });

  it("does not make a helper's commands yield to a person's run that already has its turn", async () => {
    const person = await running("user");
    const own = await waitForRunComputerLease(prisma, { ...person, use: "commands" }, signal);
    expect(isCommandSlot(own!.slot)).toBe(true);
    for (let index = 0; index < 4; index += 1) {
      const helper = await running("helper");
      expect(
        await acquireComputerExecutionLease(prisma, { ...helper, use: "commands" }),
      ).not.toBeNull();
    }
    // The screen is different: background work leaves it to the person's run (upstream's rule).
    const background = await running("helper");
    await expect(
      acquireComputerExecutionLease(prisma, { ...background, use: "screen" }),
    ).rejects.toBeInstanceOf(ComputerBusyError);
  });
});
