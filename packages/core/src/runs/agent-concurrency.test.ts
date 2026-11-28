import { UpdateBotInput } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  backgroundYieldsRunSlot,
  backgroundYieldsSlot,
  botConcurrency,
  COMMAND_SLOT_BASE,
  CONVERSATIONAL_RUN_TRIGGERS,
  commandSlotCount,
  compareQueueOrder,
  DEFAULT_BOT_CONCURRENCY,
  effectiveRunPriority,
  MAX_BOT_CONCURRENCY,
  PRIORITY_AGE_BOOST_CAP,
  planLeaseSlot,
  planRunLeaseSlot,
  priorityAgeBoost,
  runPriority,
  sameThreadWriterBlocks,
} from "./agent-concurrency.js";
import { asksForAnswer, talkLaneDue } from "./run-state.js";

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

describe("backgroundYieldsSlot", () => {
  const live = (slot: number, runId: string) => ({ slot, runId, expiresAt: minutesAgo(-5) });
  const expired = (slot: number, runId: string) => ({ slot, runId, expiresAt: minutesAgo(5) });
  const yields = (
    leases: Array<{ slot: number; runId: string; expiresAt: Date }>,
    maxSlots: number,
    waitingPeople: number,
  ) => backgroundYieldsSlot({ leases, runId: "bg", maxSlots, waitingPeople, now });

  it("yields a one-slot bot's computer to any waiting person, as upstream does", () => {
    expect(yields([], 1, 1)).toBe(true);
    expect(yields([expired(0, "old")], 1, 1)).toBe(true);
    expect(yields([], 1, 0)).toBe(false);
  });

  it("leaves only the slots the waiting people need on a bot with several", () => {
    // Three free, one person waiting (held back by the one-writer rule, say): other lanes go on.
    expect(yields([live(0, "writer")], 4, 1)).toBe(false);
    // One free and one person waiting: the person gets it.
    expect(yields([live(0, "a"), live(1, "b"), live(2, "c")], 4, 1)).toBe(true);
    expect(yields([live(0, "a")], 3, 2)).toBe(true);
    expect(yields([live(0, "a")], 4, 2)).toBe(false);
    // An expired lease is a free slot; none free still yields (and the plan is busy anyway).
    expect(yields([live(0, "a"), expired(1, "b")], 2, 1)).toBe(true);
    expect(yields([live(0, "a"), live(1, "b")], 2, 1)).toBe(true);
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

describe("asksForAnswer", () => {
  it("counts a question, however it is phrased", () => {
    for (const said of [
      "What is the capital of Bangladesh?",
      "what is the capital of bangladesh",
      "How long will that take",
      "Can you check the logs",
      "Tell me what you found",
      "Explain the pricing page",
    ]) {
      expect(asksForAnswer(said), said).toBe(true);
    }
  });

  it("does not count listening, so the work keeps reporting", () => {
    for (const said of [
      "",
      "   ",
      "okay",
      "hmm",
      "go on",
      "keep going",
      "thanks",
      "sounds good, continue",
    ]) {
      expect(asksForAnswer(said), said).toBe(false);
    }
  });
});

describe("talkLaneDue", () => {
  const now = new Date("2026-11-11T12:00:00Z");
  const started = (secondsAgo: number) => new Date(now.getTime() - secondsAgo * 1000);
  const base = {
    activeUserId: "user-1",
    userId: "user-1",
    hasLiveTalkRun: false,
    isCallTurn: false,
    stopping: false,
    now,
  };

  it("answers beside a run that has been working a while", () => {
    expect(talkLaneDue({ ...base, activeStartedAt: started(30) })).toBe(true);
  });

  it("does not answer beside a run that just started, when nothing was asked", () => {
    expect(talkLaneDue({ ...base, activeStartedAt: started(2) })).toBe(false);
  });

  it("answers a question beside a run however recently it started", () => {
    expect(talkLaneDue({ ...base, activeStartedAt: started(1), asksAnswer: true })).toBe(true);
  });

  it("does not answer beside a run that is still queued", () => {
    expect(talkLaneDue({ ...base, activeStartedAt: null })).toBe(false);
  });

  it("never answers twice for one message", () => {
    expect(talkLaneDue({ ...base, activeStartedAt: started(30), hasLiveTalkRun: true })).toBe(
      false,
    );
  });

  it("answers a spoken turn at once, whatever the run's age", () => {
    expect(talkLaneDue({ ...base, activeStartedAt: started(1), isCallTurn: true })).toBe(true);
    expect(talkLaneDue({ ...base, activeStartedAt: started(30), isCallTurn: true })).toBe(true);
  });

  it("still refuses a spoken turn while a talk run is live for it", () => {
    expect(
      talkLaneDue({ ...base, activeStartedAt: started(5), isCallTurn: true, hasLiveTalkRun: true }),
    ).toBe(false);
  });

  it("leaves another person's run alone", () => {
    expect(talkLaneDue({ ...base, activeStartedAt: started(30), activeUserId: "user-2" })).toBe(
      false,
    );
  });

  it("stays quiet while a stop is being handled", () => {
    expect(talkLaneDue({ ...base, activeStartedAt: started(30), stopping: true })).toBe(false);
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

describe("command slots (fork 1.40)", () => {
  const later = new Date(now.getTime() + 60_000);
  const lease = (slot: number, runId: string, expiresAt = later) => ({ slot, runId, expiresAt });
  const plan = (
    need: "commands" | "screen",
    leases: ReturnType<typeof lease>[],
    extra: { runId?: string; maxSlots?: number; commandSlots?: number } = {},
  ) =>
    planRunLeaseSlot({
      leases,
      runId: extra.runId ?? "run-new",
      maxSlots: extra.maxSlots ?? 1,
      commandSlots: extra.commandSlots ?? 5,
      need,
      now,
    });

  it("gives each run that only runs commands its own slot beside the others", () => {
    const leases: ReturnType<typeof lease>[] = [];
    for (const runId of ["helper-1", "helper-2", "helper-3", "helper-4"]) {
      const next = plan("commands", leases, { runId });
      expect(next.kind).toBe("create");
      if (next.kind !== "busy") leases.push(lease(next.slot, runId));
    }
    expect(leases.map(({ slot }) => slot)).toEqual([
      COMMAND_SLOT_BASE,
      COMMAND_SLOT_BASE + 1,
      COMMAND_SLOT_BASE + 2,
      COMMAND_SLOT_BASE + 3,
    ]);
  });

  it("leaves the screen slot free for the run that needs the screen", () => {
    const leases = [lease(COMMAND_SLOT_BASE, "helper-1"), lease(COMMAND_SLOT_BASE + 1, "helper-2")];
    expect(plan("screen", leases)).toEqual({ kind: "create", slot: 0 });
  });

  it("still serialises the screen: one run at a time on the default concurrency", () => {
    expect(plan("screen", [lease(0, "run-screen")])).toEqual({ kind: "busy" });
    // A command slot the run holds does not answer its request for the screen.
    expect(plan("screen", [lease(0, "run-screen"), lease(COMMAND_SLOT_BASE, "run-new")])).toEqual({
      kind: "busy",
    });
    expect(plan("screen", [lease(COMMAND_SLOT_BASE, "run-new")])).toEqual({
      kind: "create",
      slot: 0,
    });
    expect(
      plan("screen", [lease(0, "gone", minutesAgo(1)), lease(COMMAND_SLOT_BASE, "run-new")]),
    ).toEqual({ kind: "reclaim", slot: 0 });
  });

  it("lets commands run beside a run that holds the screen", () => {
    expect(plan("commands", [lease(0, "run-screen")])).toEqual({
      kind: "create",
      slot: COMMAND_SLOT_BASE,
    });
  });

  it("bounds the runs that use the computer at once, screen holders included", () => {
    const full = [
      lease(0, "run-screen"),
      lease(COMMAND_SLOT_BASE, "h1"),
      lease(COMMAND_SLOT_BASE + 1, "h2"),
    ];
    expect(plan("commands", full, { commandSlots: 3 })).toEqual({ kind: "busy" });
    expect(plan("commands", full, { commandSlots: 4 })).toEqual({
      kind: "create",
      slot: COMMAND_SLOT_BASE + 2,
    });
    // A slot whose run ended is taken again, so the rows never outgrow the bound.
    const ended = [
      lease(COMMAND_SLOT_BASE, "h1", minutesAgo(1)),
      lease(COMMAND_SLOT_BASE + 1, "h2"),
    ];
    expect(plan("commands", ended, { commandSlots: 2 })).toEqual({
      kind: "reclaim",
      slot: COMMAND_SLOT_BASE,
    });
  });

  it("keeps the slot a run holds", () => {
    expect(plan("commands", [lease(COMMAND_SLOT_BASE + 2, "run-new")])).toEqual({
      kind: "reclaim",
      slot: COMMAND_SLOT_BASE + 2,
    });
    // A run on a screen slot runs its commands there too.
    expect(plan("commands", [lease(0, "run-new")])).toEqual({ kind: "reclaim", slot: 0 });
    expect(plan("screen", [lease(0, "run-new"), lease(COMMAND_SLOT_BASE, "run-new")])).toEqual({
      kind: "reclaim",
      slot: 0,
    });
  });

  it.each([1, 0, -3, Number.NaN, undefined])(
    "is the old one-lease rule when the setting is %s",
    (commandSlots) => {
      const leases = [lease(0, "run-screen")];
      const input = { leases, runId: "run-new", maxSlots: 1, commandSlots, now };
      expect(planRunLeaseSlot({ ...input, need: "commands" })).toEqual({ kind: "busy" });
      expect(planRunLeaseSlot({ ...input, need: "commands", leases: [] })).toEqual({
        kind: "create",
        slot: 0,
      });
      expect(planRunLeaseSlot({ ...input, need: "commands", maxSlots: 2 })).toEqual(
        planLeaseSlot({ leases, runId: "run-new", maxSlots: 2, now }),
      );
    },
  );

  it("keeps the setting whole and bounded", () => {
    expect(commandSlotCount(5)).toBe(5);
    expect(commandSlotCount(2.9)).toBe(2);
    expect(commandSlotCount(99)).toBe(16);
    expect(commandSlotCount(0)).toBe(1);
  });

  it("makes background commands yield only when people need the slots that are left", () => {
    const yields = (leases: ReturnType<typeof lease>[], waitingPeople: number, need = "commands") =>
      backgroundYieldsRunSlot({
        leases,
        runId: "run-new",
        maxSlots: 1,
        commandSlots: 3,
        need: need as "commands" | "screen",
        waitingPeople,
        now,
      });
    expect(yields([], 1)).toBe(false);
    expect(yields([lease(COMMAND_SLOT_BASE, "h1")], 1)).toBe(false);
    expect(yields([lease(COMMAND_SLOT_BASE, "h1"), lease(0, "s")], 1)).toBe(true);
    expect(yields([lease(COMMAND_SLOT_BASE, "h1"), lease(0, "s")], 0)).toBe(false);
    // Wanting the screen is upstream's rule on the screen slots, whatever the command slots hold.
    expect(yields([lease(COMMAND_SLOT_BASE, "h1")], 1, "screen")).toBe(true);
    expect(yields([], 0, "screen")).toBe(false);
  });
});
