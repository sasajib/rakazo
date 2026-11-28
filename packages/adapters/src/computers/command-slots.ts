import type { ComputerNeed } from "@rakazo/core";
import { commandSlotCount, DEFAULT_COMMAND_SLOTS, isCommandSlot } from "@rakazo/core";

/**
 * Fork (FORK.md 1.40): runs of one agent run commands on its computer at the same time.
 *
 * The rule is in `@rakazo/core` (`planRunLeaseSlot`); this file holds what the executor needs to
 * apply it: which tools are commands only, how many runs may use the computer at once, and how a
 * run changes its command slot for a screen slot without its heartbeat mistaking that for a
 * lost lease.
 *
 *   COMPUTER_COMMAND_SLOTS   runs of one agent that may use its computer at once (default 5:
 *                            four helpers and the agent's own run; 1, 0 or off = one run at a
 *                            time, as upstream; at most 16)
 */

/**
 * Tools whose whole use of the computer is a command or a file. Everything else (the screen,
 * the browser, opening an app, a takeover, a script at the end of a run, a caller that names no
 * tool) needs the screen: unknown means the old, exclusive rule.
 */
const COMMAND_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "shell",
  "read_file",
  "write_file",
  "list_files",
  "attach_file",
  "render_plot",
]);

export function computerNeedFor(
  reason: "tool" | "takeover" | "script",
  tool?: string,
): ComputerNeed {
  return reason === "tool" && tool !== undefined && COMMAND_ONLY_TOOL_NAMES.has(tool)
    ? "commands"
    : "screen";
}

export function computerCommandSlots(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.COMPUTER_COMMAND_SLOTS ?? "").trim().toLowerCase();
  if (raw === "") return DEFAULT_COMMAND_SLOTS;
  if (raw === "false" || raw === "off") return 1;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? commandSlotCount(parsed) : DEFAULT_COMMAND_SLOTS;
}

type SlotLease = { slot: number };

/** True when the run's lease is a command slot, so the screen is not its to use yet. */
export function holdsCommandSlotOnly(lease: SlotLease | null | undefined): boolean {
  return Boolean(lease && isCommandSlot(lease.slot));
}

/**
 * Renews the lease a run holds now. While the run changes its command slot for a screen slot
 * the heartbeat can read the old lease just before the change and find its row given back; the
 * lease the run holds by then is the one that counts. A lease that is really lost still fails:
 * the holder did not change, or the new one cannot be renewed either.
 */
export async function renewHeldComputerLease<L>(
  holder: { computerLease: L },
  renew: (lease: L) => Promise<boolean>,
): Promise<boolean> {
  const lease = holder.computerLease;
  if (await renew(lease)) return true;
  if (holder.computerLease === lease) return false;
  return renew(holder.computerLease);
}

/**
 * The lease a run uses its computer with. The first use decides what is asked for; a later use
 * that needs the screen while the run holds a command slot takes a screen slot (waiting its
 * turn like any run) and only then gives the command slot back. Calls of one step that arrive
 * together share one acquisition.
 */
export function createRunComputerLease<L extends SlotLease>(options: {
  current: () => L | null;
  /** Waits for a lease for this need and returns it. */
  acquire: (need: ComputerNeed) => Promise<L | null>;
  /** Stores the lease the run holds from now on. */
  hold: (lease: L | null) => void;
  /** Gives back the command slot(s) of the run after it took `kept`. */
  releaseCommandSlots: (kept: L) => Promise<void>;
  onScreenSlot?: (lease: L, waitedMs: number) => void;
}) {
  let first: ComputerNeed | undefined;
  let taking: Promise<void> | undefined;
  let changing: Promise<void> | undefined;
  return {
    /** Names what the run's first use of the computer needs; later calls do not change it. */
    request(need: ComputerNeed): void {
      first ??= need;
    },
    /** The run's first lease. A caller that asked for nothing gets the screen. */
    take(): Promise<void> {
      taking ??= (async () => {
        if (options.current()) return;
        options.hold(await options.acquire(first ?? "screen"));
      })();
      return taking;
    },
    /** Before a use that needs the screen: change a command slot for a screen slot. */
    async ensure(need: ComputerNeed): Promise<void> {
      if (need !== "screen" || !holdsCommandSlotOnly(options.current())) return;
      changing ??= (async () => {
        const startedAt = Date.now();
        const lease = await options.acquire("screen");
        if (!lease) return;
        options.hold(lease);
        options.onScreenSlot?.(lease, Date.now() - startedAt);
        await options.releaseCommandSlots(lease).catch(() => undefined);
      })().finally(() => {
        changing = undefined;
      });
      await changing;
    },
  };
}
