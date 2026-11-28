import type { RunTrigger } from "@rakazo/contracts";
import { MAX_BOT_CONCURRENCY } from "@rakazo/contracts";

/**
 * How many execution slots a bot may use at once.
 *
 * One is the product rule: a bot answers the way a person does, one piece of work in front of them.
 * A Space can raise it for a bot whose work is long and whose threads do not overlap (a research
 * bot running three separate threads), and nothing else changes: the queue still allows one writer
 * per thread, so two runs of one bot never touch the same conversation at the same time.
 */
export const DEFAULT_BOT_CONCURRENCY = 1;
/** More slots than this has never been wanted, and every extra slot is another run's worth of memory. */
export { MAX_BOT_CONCURRENCY };

/** A stored or submitted concurrency, made safe: whole, at least one, at most {@link MAX_BOT_CONCURRENCY}. */
export function botConcurrency(configured: number | null | undefined): number {
  if (configured == null || !Number.isFinite(configured)) return DEFAULT_BOT_CONCURRENCY;
  return Math.min(MAX_BOT_CONCURRENCY, Math.max(1, Math.trunc(configured)));
}

/**
 * What a run's place in the queue is worth. Higher starts first; equal weights keep FIFO order, so
 * with one slot and one thread nothing about today's behaviour changes.
 *
 * The ordering answers one question — who is waiting on a person? A person is waiting on their own
 * message and on a call, so those outrank everything. A report from another bot or a routine is the
 * bot's own housekeeping: it waits.
 */
export const RUN_PRIORITY: Record<RunTrigger, number> = {
  // The person is on the other end: a typed message, a spoken turn, or the end of a call.
  user: 50,
  call_end: 50,
  // The person's previous message, answered after the run it could not steer.
  follow_up: 45,
  resume: 45,
  // Work a run asked for and is waiting on.
  helper_result: 40,
  cloud_agent: 40,
  // A background shell job the person's run started has finished (fork).
  job_result: 40,
  spawn: 35,
  helper: 30,
  // The person's message answered beside the bot's own run: it is a person turn, but the run it
  // accompanies is already answering that person, so it starts just below a fresh user run.
  talk: 48,
  // Another bot, or an app, talking to this one.
  messaging: 25,
  bot_message: 20,
  webhook: 15,
  tickets: 15,
  skill: 15,
  purchase: 10,
  media: 10,
  created: 10,
  // The bot's own schedule.
  routine: 5,
  reaction: 5,
};

/** Triggers whose run is the conversation, and may take a message sent while it works. */
export const CONVERSATIONAL_RUN_TRIGGERS = new Set<string>(["user", "follow_up", "call_end"]);

export function runPriority(trigger: string | null | undefined): number {
  if (!trigger) return 0;
  return RUN_PRIORITY[trigger as RunTrigger] ?? 0;
}

/**
 * A minute of waiting is worth one point, capped at 25 — two priority classes. Without it a stream
 * of person messages would starve routines forever; with it, a run that has waited long enough
 * overtakes the classes above it but never the person, whose lowest possible weight (50) is still
 * above the highest a boosted background run can reach (5 + 25).
 */
export const PRIORITY_AGE_STEP_MS = 60_000;
export const PRIORITY_AGE_BOOST_CAP = 25;

export function priorityAgeBoost(createdAt: Date, now: Date): number {
  const waitedMs = Math.max(0, now.getTime() - createdAt.getTime());
  return Math.min(PRIORITY_AGE_BOOST_CAP, Math.floor(waitedMs / PRIORITY_AGE_STEP_MS));
}

/** The number a queue scan sorts by: the trigger's weight plus what waiting has earned it. */
export function effectiveRunPriority(
  run: { trigger: string | null | undefined; createdAt: Date },
  now: Date,
): number {
  return runPriority(run.trigger) + priorityAgeBoost(run.createdAt, now);
}

/**
 * Queue order: highest effective priority first, then oldest first. Deterministic on `id`, so a
 * paginated scan cannot see the same run twice or skip one.
 */
export function compareQueueOrder(
  a: { id: string; trigger: string | null | undefined; createdAt: Date },
  b: { id: string; trigger: string | null | undefined; createdAt: Date },
  now: Date,
): number {
  const byPriority = effectiveRunPriority(b, now) - effectiveRunPriority(a, now);
  if (byPriority !== 0) return byPriority;
  const byAge = a.createdAt.getTime() - b.createdAt.getTime();
  if (byAge !== 0) return byAge;
  return a.id.localeCompare(b.id);
}

/** A lease this bot already holds, as slot planning needs to see it. */
export type LeaseSlotView = { slot: number; runId: string; expiresAt: Date };

export type LeaseSlotPlan =
  /** This run already holds a slot: renew it in place. */
  | { kind: "reclaim"; slot: number }
  /** A slot is free: create the lease in it. */
  | { kind: "create"; slot: number }
  /** Every slot is taken by another live run of this bot. */
  | { kind: "busy" };

/**
 * Whether background work without a lease leaves the bot's free slots to people's runs that wait
 * for its computer (upstream's "a person's message goes before scheduled work", on the fork's
 * slots). It yields while the free slots are no more than the people waiting, and may take a slot
 * beyond those. With one slot that is upstream's rule: any waiting person makes it yield.
 */
export function backgroundYieldsSlot(input: {
  leases: readonly LeaseSlotView[];
  runId: string;
  maxSlots: number;
  /** People's runs of this bot marked as waiting for the computer; 0 for a person's own run. */
  waitingPeople: number;
  now: Date;
}): boolean {
  if (input.waitingPeople <= 0) return false;
  const held = input.leases.filter(
    (lease) => lease.runId !== input.runId && lease.expiresAt.getTime() > input.now.getTime(),
  ).length;
  const free = Math.max(0, botConcurrency(input.maxSlots) - held);
  return free <= input.waitingPeople;
}

/**
 * Which slot a run should take, given the bot's live leases.
 *
 * Pure on purpose: the lease table is the only thing that can race, and this decides the whole
 * policy in one place. A run that already holds a slot (a resumed attempt) keeps it even when the
 * bot's concurrency was lowered meanwhile — losing the slot would cancel work already on screen.
 */
export function planLeaseSlot(input: {
  leases: readonly LeaseSlotView[];
  runId: string;
  maxSlots: number;
  now: Date;
}): LeaseSlotPlan {
  const maxSlots = botConcurrency(input.maxSlots);
  // A run that already holds a slot keeps it, even when the bot's concurrency was lowered
  // meanwhile: taking its slot away would cancel work already on the user's screen.
  const held = input.leases.find((lease) => lease.runId === input.runId);
  if (held) return { kind: "reclaim", slot: held.slot };

  const bySlot = new Map(input.leases.map((lease) => [lease.slot, lease]));
  for (let slot = 0; slot < maxSlots; slot += 1) {
    const existing = bySlot.get(slot);
    if (!existing) return { kind: "create", slot };
    // An expired row is a tombstone: it still occupies the slot, and reclaiming it is what
    // raises the fence the next run's screen session is checked against.
    if (existing.expiresAt.getTime() <= input.now.getTime()) {
      return { kind: "reclaim", slot };
    }
  }
  return { kind: "busy" };
}

/**
 * Fork (FORK.md 1.40): command slots.
 *
 * The execution lease serialises a bot's SCREEN: one browser profile, one desktop, one fence. It
 * was also the only way onto the computer at all, so a run that only ran commands or read files
 * waited for every other run of its bot to END (the lease is held from first use to the end of a
 * run). Four helpers of one bot therefore worked one after another.
 *
 * Commands and file tools do not use the screen (the sandbox routes for them take no screen
 * lease), so a run whose computer use is commands only takes a command slot: a lease row in a
 * slot range of its own. Screen slots stay `0 .. concurrency-1` and keep every rule they had;
 * command slots are `COMMAND_SLOT_BASE ..`. A run that later needs the screen takes a screen
 * slot the old way and then gives its command slot back.
 */
export const COMMAND_SLOT_BASE = 100;
/** Runs of one bot that may use its computer at once: four helpers and the bot's own run. */
export const DEFAULT_COMMAND_SLOTS = 5;
export const MAX_COMMAND_SLOTS = 16;

/** What a run wants from its bot's computer: commands and files only, or everything. */
export type ComputerNeed = "commands" | "screen";

export function isCommandSlot(slot: number): boolean {
  return slot >= COMMAND_SLOT_BASE;
}

/** A configured number of command slots, made safe. One (or less) means none: upstream's rule. */
export function commandSlotCount(configured: number | null | undefined): number {
  if (configured == null || !Number.isFinite(configured)) return 1;
  return Math.min(MAX_COMMAND_SLOTS, Math.max(1, Math.trunc(configured)));
}

type RunLeaseInput = {
  leases: readonly LeaseSlotView[];
  runId: string;
  /** Screen slots: the bot's concurrency. */
  maxSlots: number;
  /** Runs of the bot that may use the computer at once, screen holders included. */
  commandSlots: number | null | undefined;
  need: ComputerNeed;
  now: Date;
};

/**
 * Which slot a run takes for what it needs. With `commandSlots` of one, or for a run that needs
 * the screen, this is {@link planLeaseSlot} over the screen slots: nothing changes. A run that
 * needs commands only takes a free command slot while fewer than `commandSlots` other runs of
 * the bot hold a live lease. A run keeps a screen slot it holds, whatever it asks for next; a
 * command slot it holds does not answer a request for the screen.
 */
export function planRunLeaseSlot(input: RunLeaseInput): LeaseSlotPlan {
  const screenLeases = input.leases.filter((lease) => !isCommandSlot(lease.slot));
  const ownScreen = screenLeases.find((lease) => lease.runId === input.runId);
  if (ownScreen) return { kind: "reclaim", slot: ownScreen.slot };
  const total = commandSlotCount(input.commandSlots);
  if (input.need === "screen" || total <= 1) {
    return planLeaseSlot({
      leases: screenLeases,
      runId: input.runId,
      maxSlots: input.maxSlots,
      now: input.now,
    });
  }
  const ownCommand = input.leases.find((lease) => lease.runId === input.runId);
  if (ownCommand) return { kind: "reclaim", slot: ownCommand.slot };
  const live = (lease: LeaseSlotView) => lease.expiresAt.getTime() > input.now.getTime();
  if (input.leases.filter(live).length >= total) return { kind: "busy" };
  const bySlot = new Map(input.leases.map((lease) => [lease.slot, lease]));
  for (let slot = COMMAND_SLOT_BASE; slot < COMMAND_SLOT_BASE + total; slot += 1) {
    const existing = bySlot.get(slot);
    if (!existing) return { kind: "create", slot };
    if (!live(existing)) return { kind: "reclaim", slot };
  }
  return { kind: "busy" };
}

/**
 * {@link backgroundYieldsSlot} for either need. Background work that wants the screen yields the
 * screen slots as before. Background work that wants commands only yields when the command
 * slots left are no more than the people waiting for the computer.
 */
export function backgroundYieldsRunSlot(input: RunLeaseInput & { waitingPeople: number }): boolean {
  const total = commandSlotCount(input.commandSlots);
  if (input.need === "screen" || total <= 1) {
    return backgroundYieldsSlot({
      leases: input.leases.filter((lease) => !isCommandSlot(lease.slot)),
      runId: input.runId,
      maxSlots: input.maxSlots,
      waitingPeople: input.waitingPeople,
      now: input.now,
    });
  }
  if (input.waitingPeople <= 0) return false;
  const held = input.leases.filter(
    (lease) => lease.runId !== input.runId && lease.expiresAt.getTime() > input.now.getTime(),
  ).length;
  return Math.max(0, total - held) <= input.waitingPeople;
}

/**
 * Whether a run may start in a thread another run of the same bot is still writing.
 *
 * One writer per (thread, bot) is what keeps a conversation, its history and its pi session
 * consistent. Concurrency raises how many *threads* a bot works on at once; it does not let two
 * runs edit one conversation. The executor compares thread ids, because a bot's own chat and a
 * helper's thread are different conversations even though the bot is the same.
 */
export function sameThreadWriterBlocks(input: {
  runId: string;
  runThreadId: string;
  otherRunId: string;
  otherRunThreadId: string;
}): boolean {
  return input.runThreadId === input.otherRunThreadId && input.runId !== input.otherRunId;
}
