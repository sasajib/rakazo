import { UpdateBotInput } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  botConcurrency,
  CONVERSATIONAL_RUN_TRIGGERS,
  compareQueueOrder,
  DEFAULT_BOT_CONCURRENCY,
  effectiveRunPriority,
  MAX_BOT_CONCURRENCY,
  PRIORITY_AGE_BOOST_CAP,
  planLeaseSlot,
  priorityAgeBoost,
  runPriority,
  sameThreadWriterBlocks,
} from "./agent-concurrency.js";

const now = new Date("2026-11-11T12:00:00Z");
const botInput = (concurrency: number) => ({ botId: "bot-1", concurrency });
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

describe("botConcurrency", () => {
  it("defaults to one run at a time", () => {
    expect(botConcurrency(undefined)).toBe(DEFAULT_BOT_CONCURRENCY);
    expect(botConcurrency(null)).toBe(1);
    expect(botConcurrency(Number.NaN)).toBe(1);
  });

  it("keeps a whole number within the supported range", () => {
    expect(botConcurrency(3)).toBe(3);
    expect(botConcurrency(2.9)).toBe(2);
    expect(botConcurrency(0)).toBe(1);
    expect(botConcurrency(-4)).toBe(1);
    expect(botConcurrency(500)).toBe(MAX_BOT_CONCURRENCY);
  });
});

describe("bots/update concurrency", () => {
  it("takes a whole slot count inside the supported range", () => {
    expect(UpdateBotInput.safeParse(botInput(1)).success).toBe(true);
    expect(UpdateBotInput.safeParse(botInput(MAX_BOT_CONCURRENCY)).success).toBe(true);
  });

  it("refuses zero, fractions and anything above the ceiling", () => {
    expect(UpdateBotInput.safeParse(botInput(0)).success).toBe(false);
    expect(UpdateBotInput.safeParse(botInput(1.5)).success).toBe(false);
    expect(UpdateBotInput.safeParse(botInput(MAX_BOT_CONCURRENCY + 1)).success).toBe(false);
  });
});

describe("runPriority", () => {
  it("puts the person ahead of every kind of bot housekeeping", () => {
    expect(runPriority("user")).toBeGreaterThan(runPriority("bot_message"));
    expect(runPriority("call_end")).toBeGreaterThan(runPriority("routine"));
    expect(runPriority("follow_up")).toBeGreaterThan(runPriority("routine"));
  });

  it("treats an unknown trigger as the least important", () => {
    expect(runPriority("something-new")).toBe(0);
    expect(runPriority(null)).toBe(0);
  });

  it("lets only the conversation take a message sent mid-run", () => {
    expect(CONVERSATIONAL_RUN_TRIGGERS.has("user")).toBe(true);
    expect(CONVERSATIONAL_RUN_TRIGGERS.has("bot_message")).toBe(false);
    expect(CONVERSATIONAL_RUN_TRIGGERS.has("routine")).toBe(false);
  });
});

describe("priorityAgeBoost", () => {
  it("earns a point a minute, and stops after two priority classes", () => {
    expect(priorityAgeBoost(minutesAgo(0), now)).toBe(0);
    expect(priorityAgeBoost(minutesAgo(5), now)).toBe(5);
    expect(priorityAgeBoost(minutesAgo(26), now)).toBe(PRIORITY_AGE_BOOST_CAP);
    expect(priorityAgeBoost(minutesAgo(600), now)).toBe(PRIORITY_AGE_BOOST_CAP);
  });

  it("never earns a point for a run created in the future", () => {
    expect(priorityAgeBoost(new Date(now.getTime() + 60_000), now)).toBe(0);
  });

  it("lets a patient routine overtake fresh bot traffic, but not a fresh user message", () => {
    const routine = { trigger: "routine", createdAt: minutesAgo(40) };
    const report = { trigger: "bot_message", createdAt: minutesAgo(2) };
    const user = { trigger: "user", createdAt: minutesAgo(0) };
    expect(effectiveRunPriority(routine, now)).toBeGreaterThan(effectiveRunPriority(report, now));
    expect(effectiveRunPriority(routine, now)).toBeLessThan(effectiveRunPriority(user, now));
  });
});

describe("compareQueueOrder", () => {
  const row = (id: string, trigger: string, createdAt: Date) => ({ id, trigger, createdAt });

  it("starts the person's message first even when it arrived last", () => {
    const rows = [row("a", "routine", minutesAgo(1)), row("b", "user", minutesAgo(0))].sort(
      (left, right) => compareQueueOrder(left, right, now),
    );
    expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("keeps arrival order inside one kind of work", () => {
    const rows = [row("new", "user", minutesAgo(1)), row("old", "user", minutesAgo(9))].sort(
      (left, right) => compareQueueOrder(left, right, now),
    );
    expect(rows.map((r) => r.id)).toEqual(["old", "new"]);
  });

  it("breaks a tie on the id, so a paged scan cannot repeat or skip a run", () => {
    const same = minutesAgo(2);
    const rows = [row("b", "user", same), row("a", "user", same)].sort((left, right) =>
      compareQueueOrder(left, right, now),
    );
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("planLeaseSlot", () => {
  const live = (slot: number, runId: string) => ({ slot, runId, expiresAt: minutesAgo(-5) });
  const expired = (slot: number, runId: string) => ({ slot, runId, expiresAt: minutesAgo(5) });

  it("takes slot 0 on an idle bot, which is the one-run-at-a-time rule", () => {
    expect(planLeaseSlot({ leases: [], runId: "r1", maxSlots: 1, now })).toEqual({
      kind: "create",
      slot: 0,
    });
  });

  it("reports busy when the only slot is held by another live run", () => {
    expect(planLeaseSlot({ leases: [live(0, "other")], runId: "r1", maxSlots: 1, now })).toEqual({
      kind: "busy",
    });
  });

  it("fills the free slots of a concurrent bot", () => {
    expect(planLeaseSlot({ leases: [live(0, "other")], runId: "r1", maxSlots: 3, now })).toEqual({
      kind: "create",
      slot: 1,
    });
    expect(
      planLeaseSlot({
        leases: [live(0, "other"), live(1, "other-2")],
        runId: "r1",
        maxSlots: 2,
        now,
      }),
    ).toEqual({ kind: "busy" });
  });

  it("reclaims the slot a resumed run already holds instead of taking a second one", () => {
    expect(
      planLeaseSlot({ leases: [live(1, "r1"), live(0, "other")], runId: "r1", maxSlots: 3, now }),
    ).toEqual({ kind: "reclaim", slot: 1 });
  });

  it("keeps a resumed run's slot even after the bot's concurrency was lowered", () => {
    expect(planLeaseSlot({ leases: [live(4, "r1")], runId: "r1", maxSlots: 1, now })).toEqual({
      kind: "reclaim",
      slot: 4,
    });
  });

  it("reclaims an expired tombstone instead of creating a row the unique key would refuse", () => {
    expect(planLeaseSlot({ leases: [expired(0, "other")], runId: "r1", maxSlots: 1, now })).toEqual(
      {
        kind: "reclaim",
        slot: 0,
      },
    );
  });

  it("takes the slot whose row expired when the lower slot is still live", () => {
    expect(
      planLeaseSlot({
        leases: [live(0, "other"), expired(1, "stale")],
        runId: "r1",
        maxSlots: 2,
        now,
      }),
    ).toEqual({ kind: "reclaim", slot: 1 });
  });
});

describe("sameThreadWriterBlocks", () => {
  it("stops two runs of one bot writing one conversation", () => {
    expect(
      sameThreadWriterBlocks({
        runId: "r1",
        runThreadId: "t1",
        otherRunId: "r2",
        otherRunThreadId: "t1",
      }),
    ).toBe(true);
  });

  it("lets concurrent runs work on different threads", () => {
    expect(
      sameThreadWriterBlocks({
        runId: "r1",
        runThreadId: "t1",
        otherRunId: "r2",
        otherRunThreadId: "t2",
      }),
    ).toBe(false);
  });

  it("does not block a run on its own row", () => {
    expect(
      sameThreadWriterBlocks({
        runId: "r1",
        runThreadId: "t1",
        otherRunId: "r1",
        otherRunThreadId: "t1",
      }),
    ).toBe(false);
  });
});
