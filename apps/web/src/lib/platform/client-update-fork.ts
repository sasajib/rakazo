import { compareBuilds, isBuildId, SERVER_BUILD_HEADER } from "@rakazo/contracts";
import { AUTO_RELOAD_HEADER } from "./auto-reload-header";

/**
 * Fork: an open tab moves onto a new deploy by itself.
 *
 * Upstream's tracker (`client-update.ts`) learns the deployed build from API replies and reloads a
 * tab when it is hidden, navigating, or five minutes idle. This module adds what a self-hosted
 * owner with long-lived tabs was missing:
 * - the tab asks the web server for its build (`/build-id`) when it becomes visible or focused, at
 *   a low interval, and after an API reply that names another build or looks like a contract
 *   mismatch, so a tab with no API traffic learns too;
 * - a tab that becomes visible on an old build, with nothing to lose, reloads at once;
 * - a tab that cannot reload yet shows a small "New version" notice with a Reload button, and
 *   reloads by itself once the thing in the way has ended;
 * - stricter rules for every automatic reload: never during a call, never while a text field on
 *   the page holds text, never while recording or controlling a computer's screen;
 * - the kill switch `WEB_AUTO_RELOAD=0` on the web server leaves only the notice;
 * - a ROLLBACK moves the tab too: an older build than this bundle counts as an update once the
 *   web server has answered with that same build on two checks in a row at least
 *   FORK_STABLE_MS apart (a rolling restart serves both builds for a moment, and a tab that
 *   just reloaded onto the new one must not be sent back). Same notice, same safety rules; the
 *   reload has its own loop guard (`claimRollbackReload`), since upstream's only knows "newer".
 *
 * Every reload still goes through upstream's guarded path (the web server must serve the newer
 * build, one attempt per build pair, at most one automatic reload per cooldown).
 */

/** Ask the web server at most this often (a becoming-visible check may come sooner). */
export const FORK_CHECK_SPACING_MS = 30_000;
/** A tab that just became visible or focused re-checks when the last check is at least this old. */
export const FORK_VISIBLE_CHECK_SPACING_MS = 5_000;
/** The background check of the served build. */
export const FORK_POLL_MS = 5 * 60_000;
/** While the notice is up, look this often whether the reload has become safe. */
export const FORK_RELEASE_TICK_MS = 3_000;
/** After the thing in the way ended, wait for this long without input before reloading. */
export const FORK_RELEASE_QUIET_MS = 3_000;
/** Guarded reload attempts are at least this far apart. */
export const FORK_ATTEMPT_SPACING_MS = 10_000;
/** An older served build is a rollback once two checks in a row, this far apart, both named it. */
export const FORK_STABLE_MS = 30_000;
/** While an older build waits for its second sighting, ask again this often. */
export const FORK_CONFIRM_MS = FORK_STABLE_MS + 5_000;
/** A tab reloads onto older builds at most this often per hour, and once per build. */
export const FORK_ROLLBACK_MAX_PER_HOUR = 3;
const ROLLBACK_KEY = "rk:client-update-rollbacks";
const IDLE_MS = 5 * 60_000;
const INPUT_EVENTS = ["keydown", "pointerdown", "input", "wheel", "touchstart"] as const;

/**
 * `visible`: the tab just became visible or focused. `released`: what blocked the reload has
 * ended. `waiting`: a visible tab in use with nothing at stake; it waits for a navigation.
 */
export type UpdateMoment = "hidden" | "navigation" | "idle" | "visible" | "released" | "waiting";
export type UpdateDecision = "nothing" | "reload" | "bar";

export type UnsafeFacts = {
  /** A voice call is ringing, connecting or live. */
  liveCall: boolean;
  /** A text field on the page holds text, a send is in flight, or attachments are picked. */
  composerText: boolean;
  /** Recording, an open dialog, or this person controls a computer's screen. */
  busy: boolean;
};

export type UpdateFacts = UnsafeFacts & {
  /** The build baked into this bundle. */
  build: string;
  /** The build the web server serves; null when unknown (never asked, or the request failed). */
  served: string | null;
  autoReload: boolean;
  moment: UpdateMoment;
  /** Milliseconds since the last key, pointer or scroll input. */
  quietMs: number;
  /** The older build the web server was seen serving on two checks in a row; null otherwise. */
  rolledBackTo?: string | null;
};

export function reloadUnsafe(facts: UnsafeFacts): boolean {
  return facts.liveCall || facts.composerText || facts.busy;
}

/** May an automatic reload happen at this moment? (The served build is checked by the caller.) */
export function reloadAllowed(
  facts: UnsafeFacts & { autoReload: boolean; moment: UpdateMoment; quietMs: number },
): boolean {
  if (!facts.autoReload || reloadUnsafe(facts)) return false;
  switch (facts.moment) {
    case "hidden":
    case "navigation":
    case "visible":
      return true;
    case "released":
      return facts.quietMs >= FORK_RELEASE_QUIET_MS;
    case "idle":
      return facts.quietMs >= IDLE_MS;
    default:
      return false;
  }
}

/** The served build is older than this bundle and was confirmed stable: a rollback. */
export function isRollback(facts: Pick<UpdateFacts, "build" | "served" | "rolledBackTo">): boolean {
  return (
    isBuildId(facts.rolledBackTo) &&
    facts.rolledBackTo === facts.served &&
    (compareBuilds(facts.build, facts.served) ?? 0) > 0
  );
}

/**
 * The whole rule in one place. Nothing unless the web server serves another build than this
 * bundle: a newer one, or an older one seen stable (same build, an older build seen once,
 * unknown, malformed: nothing). Then reload when allowed, otherwise show the notice.
 */
export function decideClientUpdate(facts: UpdateFacts): UpdateDecision {
  if ((compareBuilds(facts.build, facts.served) ?? 0) >= 0 && !isRollback(facts)) return "nothing";
  return reloadAllowed(facts) ? "reload" : "bar";
}

type RollbackStorage = Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;

/**
 * The loop guard of a rollback reload, kept for the tab's session. Refuses (null) when this tab
 * already reloaded for that build, or reloaded onto older builds FORK_ROLLBACK_MAX_PER_HOUR
 * times in the last hour, or the record cannot be kept. Otherwise records the reload and
 * returns its undo, for a reload the recovery guard then refused.
 */
export function claimRollbackReload(
  storage: RollbackStorage,
  to: string,
  now: number,
): (() => void) | null {
  if (!storage) return null;
  try {
    const previous = storage.getItem(ROLLBACK_KEY);
    const parsed: unknown = JSON.parse(previous ?? "[]");
    const reloads = (Array.isArray(parsed) ? parsed : []).filter(
      (entry): entry is { to: string; at: number } =>
        Boolean(entry) && typeof entry.to === "string" && typeof entry.at === "number",
    );
    if (reloads.some((entry) => entry.to === to)) return null;
    if (reloads.filter((entry) => now - entry.at < 3_600_000).length >= FORK_ROLLBACK_MAX_PER_HOUR)
      return null;
    storage.setItem(ROLLBACK_KEY, JSON.stringify([...reloads, { to, at: now }].slice(-20)));
    return () => {
      try {
        if (previous === null) storage.removeItem(ROLLBACK_KEY);
        else storage.setItem(ROLLBACK_KEY, previous);
      } catch {
        // The record stays: one reload fewer, never one more.
      }
    };
  } catch {
    return null;
  }
}

export type ServedBuild = { build: string | null; autoReload: boolean };

/** Reads `/build-id`; null when the request failed, so a failure never changes anything. */
export async function fetchServedBuild(
  fetcher: (input: string, init: RequestInit) => Promise<Response>,
): Promise<ServedBuild | null> {
  try {
    const response = await fetcher("/build-id", { cache: "no-store", credentials: "omit" });
    if (!response.ok) return null;
    return {
      build: (await response.text()).trim(),
      autoReload: response.headers.get(AUTO_RELOAD_HEADER)?.trim() !== "0",
    };
  } catch {
    return null;
  }
}

/**
 * An API reply that names another build (newer, or older after a rollback), or suggests this
 * bundle and the server disagree about the contract.
 */
export function replyHintsNewBuild(response: Response, build: string): boolean {
  if ((compareBuilds(build, response.headers.get(SERVER_BUILD_HEADER)) ?? 0) !== 0) return true;
  // An unknown procedure (404) or an input the server no longer accepts (400).
  return response.status === 404 || response.status === 400;
}

export type ForkUpdateDeps = {
  build: string;
  fetchServed: () => Promise<ServedBuild | null>;
  facts: () => UnsafeFacts;
  visibility: () => DocumentVisibilityState;
  now: () => number;
  /** Upstream's tracker learns a build. */
  note: (build: string) => void;
  /** Upstream's guarded reload; false when it did not reload. */
  attempt: (moment: UpdateMoment) => Promise<boolean>;
  /** The guarded reload onto an older build seen stable; false when it did not reload. */
  attemptRollback?: (moment: UpdateMoment, build: string) => Promise<boolean>;
  /** Show or hide the notice. Must never take focus. */
  bar: (show: boolean) => void;
  listen: (type: string, listener: () => void) => () => void;
  responses: (listener: (response: Response) => void) => () => void;
  setInterval: (callback: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
};

export function createForkClientUpdates(deps: ForkUpdateDeps) {
  let served: string | null = null;
  let autoReload = true;
  /** Something was in the way while a newer build was known: its end is the moment to reload. */
  let held = false;
  let lastInput = deps.now();
  let lastCheck = Number.NEGATIVE_INFINITY;
  let lastAttempt = Number.NEGATIVE_INFINITY;
  let checking = false;
  let attempting = false;
  let barShown = false;
  let tick: unknown = null;
  /** An older build than this bundle, and when the web server first answered with it. */
  let older: { build: string; since: number } | null = null;
  /** That build, once a later check at least FORK_STABLE_MS on named it again. */
  let rolledBackTo: string | null = null;
  let confirm: unknown = null;

  const quietMs = () => deps.now() - lastInput;
  const showBar = (show: boolean) => {
    if (show !== barShown) {
      barShown = show;
      deps.bar(show);
    }
    if (show && tick === null) {
      tick = deps.setInterval(() => evaluate(restingMoment()), FORK_RELEASE_TICK_MS);
    } else if (!show && tick !== null) {
      deps.clearInterval(tick);
      tick = null;
    }
  };
  const restingMoment = (): UpdateMoment =>
    deps.visibility() === "hidden" ? "hidden" : held ? "released" : "waiting";

  function evaluate(moment: UpdateMoment): UpdateDecision {
    const facts = deps.facts();
    const decision = decideClientUpdate({
      ...facts,
      build: deps.build,
      served,
      autoReload,
      moment,
      quietMs: quietMs(),
      rolledBackTo,
    });
    if (decision === "nothing") {
      showBar(false);
      return decision;
    }
    if (decision === "bar") {
      if (reloadUnsafe(facts)) held = true;
      showBar(true);
      return decision;
    }
    if (attempting || deps.now() - lastAttempt < FORK_ATTEMPT_SPACING_MS) return decision;
    attempting = true;
    lastAttempt = deps.now();
    const rollback = isRollback({ build: deps.build, served, rolledBackTo });
    void (
      rollback
        ? (deps.attemptRollback?.(moment, rolledBackTo as string) ?? Promise.resolve(false))
        : deps.attempt(moment)
    )
      .catch(() => false)
      .then((reloaded) => {
        attempting = false;
        // Still here (the reload guard refused, or work appeared): the notice offers the reload.
        if (!reloaded) showBar(true);
      });
    return decision;
  }

  async function check(moment: () => UpdateMoment, spacing = FORK_CHECK_SPACING_MS) {
    if (checking) return;
    if (deps.now() - lastCheck >= spacing) {
      checking = true;
      lastCheck = deps.now();
      try {
        const answer = await deps.fetchServed().catch(() => null);
        if (answer) note(answer);
      } finally {
        checking = false;
      }
    }
    evaluate(moment());
  }

  function note(answer: ServedBuild) {
    autoReload = answer.autoReload;
    const order = compareBuilds(deps.build, answer.build);
    if (order === null) return;
    served = answer.build;
    if (served) deps.note(served);
    // An older build must be named by two answers in a row, FORK_STABLE_MS apart, before it
    // counts: any other answer in between (this build again, a newer one) starts over.
    if (order <= 0 || !served) {
      older = null;
      rolledBackTo = null;
    } else if (older?.build !== served) {
      older = { build: served, since: deps.now() };
      rolledBackTo = null;
    } else if (deps.now() - older.since >= FORK_STABLE_MS) {
      rolledBackTo = served;
    }
    const waiting = older !== null && rolledBackTo === null;
    if (waiting && confirm === null) {
      confirm = deps.setInterval(() => void check(restingMoment), FORK_CONFIRM_MS);
    } else if (!waiting && confirm !== null) {
      deps.clearInterval(confirm);
      confirm = null;
    }
  }

  return {
    /** Upstream's safety check asks this for every automatic reload. */
    allows(moment: UpdateMoment): boolean {
      return reloadAllowed({ ...deps.facts(), autoReload, moment, quietMs: quietMs() });
    },
    /** Upstream's own `/build-id` read goes through here, so the kill switch is always fresh. */
    async servedBuild(): Promise<string | null> {
      const answer = await deps.fetchServed();
      if (!answer) return null;
      note(answer);
      return answer.build;
    },
    install(): () => void {
      if (!deps.build) return () => {};
      const visible = () => {
        if (deps.visibility() !== "visible") return;
        void check(() => "visible", FORK_VISIBLE_CHECK_SPACING_MS);
      };
      const stops = [
        ...INPUT_EVENTS.map((type) =>
          deps.listen(type, () => {
            lastInput = deps.now();
          }),
        ),
        deps.listen("visibilitychange", () => {
          if (deps.visibility() === "hidden") evaluate("hidden");
          else visible();
        }),
        deps.listen("focus", visible),
        deps.responses((response) => {
          // Once another build is known to be served, replies have nothing more to say.
          if ((compareBuilds(deps.build, served) ?? 0) < 0) return;
          if (isRollback({ build: deps.build, served, rolledBackTo })) return;
          if (replyHintsNewBuild(response, deps.build)) void check(restingMoment);
        }),
      ];
      const poll = deps.setInterval(() => void check(restingMoment), FORK_POLL_MS);
      return () => {
        for (const stop of stops) stop();
        deps.clearInterval(poll);
        if (confirm !== null) deps.clearInterval(confirm);
        confirm = null;
        showBar(false);
      };
    },
  };
}

const holds = new Set<symbol>();

/** A session a reload would cut off (controlling a screen, an upload) holds automatic reloads until released. */
export function holdReload(): () => void {
  const hold = Symbol("reload-hold");
  holds.add(hold);
  return () => {
    holds.delete(hold);
  };
}

export function reloadHeld(): boolean {
  return holds.size > 0;
}

/** A multi-line or rich text field on the page holds text: the composer, or any form being written. */
export function pageHoldsTypedText(doc: Pick<Document, "querySelectorAll">): boolean {
  const fields = doc.querySelectorAll('textarea, [contenteditable]:not([contenteditable="false"])');
  for (const field of Array.from(fields)) {
    const text = (field as HTMLTextAreaElement).value ?? field.textContent ?? "";
    if (typeof text === "string" && text.trim() !== "") return true;
  }
  return false;
}
