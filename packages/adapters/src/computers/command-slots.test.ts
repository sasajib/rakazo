import { COMMAND_SLOT_BASE } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import {
  computerCommandSlots,
  computerNeedFor,
  createRunComputerLease,
  holdsCommandSlotOnly,
  renewHeldComputerLease,
} from "./command-slots.js";

type Lease = { slot: number; fence: number };

describe("computerNeedFor", () => {
  it.each(["shell", "read_file", "write_file", "list_files", "attach_file", "render_plot"])(
    "%s is commands only",
    (tool) => expect(computerNeedFor("tool", tool)).toBe("commands"),
  );

  it.each(["computer_observe", "computer_act", "browser_act", "open_path", "launch_app", "x"])(
    "%s needs the screen",
    (tool) => expect(computerNeedFor("tool", tool)).toBe("screen"),
  );

  it("needs the screen whenever the use is not a named command tool", () => {
    expect(computerNeedFor("tool")).toBe("screen");
    expect(computerNeedFor("takeover")).toBe("screen");
    expect(computerNeedFor("takeover", "shell")).toBe("screen");
    expect(computerNeedFor("script")).toBe("screen");
  });
});

describe("computerCommandSlots", () => {
  it("defaults to more than one run at a time", () => {
    expect(computerCommandSlots({})).toBe(5);
    expect(computerCommandSlots({ COMPUTER_COMMAND_SLOTS: "" })).toBe(5);
    expect(computerCommandSlots({ COMPUTER_COMMAND_SLOTS: "junk" })).toBe(5);
  });

  it.each(["1", "0", "off", "false", "OFF"])("%s is one run at a time", (value) => {
    expect(computerCommandSlots({ COMPUTER_COMMAND_SLOTS: value })).toBe(1);
  });

  it("takes a number within bounds", () => {
    expect(computerCommandSlots({ COMPUTER_COMMAND_SLOTS: "3" })).toBe(3);
    expect(computerCommandSlots({ COMPUTER_COMMAND_SLOTS: "400" })).toBe(16);
  });
});

function leaseOf(options: { screenBusyFor?: Promise<void> } = {}) {
  let held: Lease | null = null;
  let fence = 0;
  const acquire = vi.fn(async (need: "commands" | "screen") => {
    if (need === "screen") await options.screenBusyFor;
    fence += 1;
    return { slot: need === "screen" ? 0 : COMMAND_SLOT_BASE, fence };
  });
  const released = vi.fn(async (_kept: Lease) => undefined);
  const lease = createRunComputerLease<Lease>({
    current: () => held,
    acquire,
    hold: (next) => {
      held = next;
    },
    releaseCommandSlots: released,
  });
  return { lease, acquire, released, held: () => held };
}

describe("createRunComputerLease", () => {
  it("takes a command slot for a run that starts with a command", async () => {
    const run = leaseOf();
    run.lease.request("commands");
    await run.lease.take();
    await run.lease.ensure("commands");
    expect(run.acquire.mock.calls).toEqual([["commands"]]);
    expect(holdsCommandSlotOnly(run.held())).toBe(true);
    expect(run.released).not.toHaveBeenCalled();
  });

  it("takes the screen for a run that starts with the screen, or names nothing", async () => {
    const named = leaseOf();
    named.lease.request("screen");
    named.lease.request("commands");
    await named.lease.take();
    expect(named.acquire.mock.calls).toEqual([["screen"]]);
    const unnamed = leaseOf();
    await unnamed.lease.take();
    expect(unnamed.acquire.mock.calls).toEqual([["screen"]]);
    expect(holdsCommandSlotOnly(unnamed.held())).toBe(false);
  });

  it("changes a command slot for a screen slot before the screen is used, once", async () => {
    let free!: () => void;
    const run = leaseOf({ screenBusyFor: new Promise<void>((resolve) => (free = resolve)) });
    run.lease.request("commands");
    await run.lease.take();
    let used = 0;
    const screenUses = [run.lease.ensure("screen"), run.lease.ensure("screen")].map((wait) =>
      wait.then(() => (used += 1)),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The screen is another run's: both calls wait, and the command slot is still held.
    expect(used).toBe(0);
    expect(holdsCommandSlotOnly(run.held())).toBe(true);
    expect(run.released).not.toHaveBeenCalled();
    free();
    await Promise.all(screenUses);
    expect(run.acquire.mock.calls).toEqual([["commands"], ["screen"]]);
    expect(run.held()).toEqual({ slot: 0, fence: 2 });
    expect(run.released.mock.calls).toEqual([[{ slot: 0, fence: 2 }]]);
    await run.lease.ensure("screen");
    expect(run.acquire).toHaveBeenCalledTimes(2);
  });

  it("does not take a lease again when the attempt already holds one", async () => {
    const run = leaseOf();
    run.lease.request("commands");
    await run.lease.take();
    await run.lease.take();
    expect(run.acquire).toHaveBeenCalledTimes(1);
  });
});

describe("renewHeldComputerLease", () => {
  const command: Lease = { slot: COMMAND_SLOT_BASE, fence: 1 };
  const screen: Lease = { slot: 0, fence: 7 };

  it("renews the held lease", async () => {
    const renew = vi.fn(async () => true);
    expect(await renewHeldComputerLease({ computerLease: command }, renew)).toBe(true);
    expect(renew.mock.calls).toEqual([[command]]);
  });

  it("fails when the held lease is lost", async () => {
    expect(await renewHeldComputerLease({ computerLease: command }, async () => false)).toBe(false);
  });

  it("renews the new lease when the slot was changed during the beat", async () => {
    const holder: { computerLease: Lease } = { computerLease: command };
    const renew = vi.fn(async (lease: Lease) => {
      if (lease === command) {
        // The run took its screen slot and gave the command slot back while this was in flight.
        holder.computerLease = screen;
        return false;
      }
      return true;
    });
    expect(await renewHeldComputerLease(holder, renew)).toBe(true);
    expect(renew.mock.calls).toEqual([[command], [screen]]);
  });

  it("fails when the new lease cannot be renewed either", async () => {
    const holder: { computerLease: Lease } = { computerLease: command };
    const renew = async (lease: Lease) => {
      if (lease === command) holder.computerLease = screen;
      return false;
    };
    expect(await renewHeldComputerLease(holder, renew)).toBe(false);
  });
});
