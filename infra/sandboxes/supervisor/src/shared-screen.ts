import { TEAM_SHARED_SCREEN_KEY } from "@rakazo/core/node/desktop-runtime";

/**
 * Fork: every bot on a Team Computer shares one screen, one browser and one browser profile, so
 * a site signed in once is signed in for every bot. Page tools (agent-browser over CDP) work in
 * each bot's own tab and never wait. Screen work (observe, act, input, takeover) needs the one
 * screen, so a bot holds it while it uses it and others wait a bounded time.
 *
 * `SANDBOX_TEAM_SHARED_BROWSER=0` on the supervisor turns this off (per-bot screens, upstream).
 */
export function teamSharedBrowserEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env.SANDBOX_TEAM_SHARED_BROWSER !== "0";
}

/** Team Computers are provisioned under their home key, which is `team-<digest>`. */
export function isTeamComputerIdentity(computerBotId: string | undefined) {
  return Boolean(computerBotId?.startsWith("team-"));
}

export interface ScreenIdentity {
  /** The key the supervisor's screen registry and the browser profile are kept under. */
  screenKey: string;
  /** The screen lease fence, or none on the shared screen: its holders are many bots. */
  screenLeaseId: string | undefined;
  /** The bot asking, on the shared screen; its tab is the one it works in. */
  tabOwner: string | undefined;
  shared: boolean;
}

/** Which screen a request is for. On a Team Computer every bot gets the one shared screen. */
export function screenIdentity(
  headers: {
    botId?: string;
    screenId?: string;
    screenLeaseId?: string;
  },
  computerId: string,
  env: NodeJS.ProcessEnv = process.env,
): ScreenIdentity {
  if (teamSharedBrowserEnabled(env) && isTeamComputerIdentity(headers.botId)) {
    return {
      screenKey: TEAM_SHARED_SCREEN_KEY,
      screenLeaseId: undefined,
      tabOwner:
        headers.screenId && headers.screenId !== headers.botId ? headers.screenId : undefined,
      shared: true,
    };
  }
  return {
    screenKey: headers.screenId || headers.botId || computerId,
    screenLeaseId: headers.screenLeaseId,
    tabOwner: undefined,
    shared: false,
  };
}

/** How long a bot keeps the shared screen after its last screen action. */
export const SHARED_SCREEN_HOLD_MS = 20_000;
/** How long another bot waits for the shared screen before it is told who has it. */
export const SHARED_SCREEN_WAIT_MS = 15_000;
const SHARED_SCREEN_POLL_MS = 250;

interface Holder {
  botId: string;
  until: number;
  /** A person took over the screen from this bot's chat; held until control is handed back. */
  controlled?: boolean;
}

export class SharedScreenBusyError extends Error {
  constructor(readonly holder: string) {
    super(
      `The team browser screen is in use by bot ${holder}. Your page tools still work in your own tab; retry the screen in a moment.`,
    );
    this.name = "SharedScreenBusyError";
  }
}

export interface ScreenHoldClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: ScreenHoldClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Who holds each Team Computer's shared screen, by computer id. */
export class SharedScreenHolds {
  private readonly holders = new Map<string, Holder>();

  constructor(private readonly clock: ScreenHoldClock = realClock) {}

  holderOf(computerId: string): string | undefined {
    const holder = this.holders.get(computerId);
    return holder && this.live(holder) ? holder.botId : undefined;
  }

  private live(holder: Holder) {
    return holder.controlled === true || holder.until > this.clock.now();
  }

  /**
   * Hold the screen for `botId`, waiting at most `waitMs` while another bot holds it. Returns
   * whether the hold is new (the bot's tab must then be brought to the front).
   */
  async hold(
    computerId: string,
    botId: string,
    options: { controlled?: boolean; waitMs?: number; holdMs?: number; signal?: AbortSignal } = {},
  ): Promise<{ fresh: boolean }> {
    const deadline = this.clock.now() + (options.waitMs ?? SHARED_SCREEN_WAIT_MS);
    for (;;) {
      options.signal?.throwIfAborted();
      const current = this.holders.get(computerId);
      if (!current || current.botId === botId || !this.live(current)) {
        const fresh = !current || current.botId !== botId || !this.live(current);
        this.holders.set(computerId, {
          botId,
          until: this.clock.now() + (options.holdMs ?? SHARED_SCREEN_HOLD_MS),
          controlled:
            options.controlled ?? (current?.botId === botId ? current.controlled : undefined),
        });
        return { fresh };
      }
      if (this.clock.now() >= deadline) throw new SharedScreenBusyError(current.botId);
      await this.clock.sleep(SHARED_SCREEN_POLL_MS);
    }
  }

  /** A person handed control back: the bot keeps the screen only for the usual hold. */
  endControl(computerId: string, botId: string) {
    const current = this.holders.get(computerId);
    if (current?.botId !== botId) return;
    delete current.controlled;
    current.until = Math.max(current.until, this.clock.now() + SHARED_SCREEN_HOLD_MS);
  }

  /** The bot's run ended: whatever it held is free. Another bot's hold is left alone. */
  release(computerId: string, botId: string | undefined): { wasControlled: boolean } {
    const current = this.holders.get(computerId);
    if (!current || (botId && current.botId !== botId)) return { wasControlled: false };
    this.holders.delete(computerId);
    return { wasControlled: current.controlled === true };
  }

  forget(computerId: string) {
    this.holders.delete(computerId);
  }
}

export const sharedScreenHolds = new SharedScreenHolds();
