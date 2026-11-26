import { compareBuilds, SERVER_BUILD_HEADER } from "@rakazo/contracts";
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
 * - the kill switch `WEB_AUTO_RELOAD=0` on the web server leaves only the notice.
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

/**
 * The whole rule in one place. Nothing unless the web server serves a newer build than this
 * bundle (same build, older build, unknown, malformed: nothing). Then reload when allowed,
 * otherwise show the notice.
 */
export function decideClientUpdate(facts: UpdateFacts): UpdateDecision {
  if ((compareBuilds(facts.build, facts.served) ?? 0) >= 0) return "nothing";
  return reloadAllowed(facts) ? "reload" : "bar";
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

/** An API reply that names a newer build, or suggests this bundle and the server disagree about the contract. */
export function replyHintsNewBuild(response: Response, build: string): boolean {
  if ((compareBuilds(build, response.headers.get(SERVER_BUILD_HEADER)) ?? 0) < 0) return true;
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
    void deps
      .attempt(moment)
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
    if (compareBuilds(deps.build, answer.build) === null) return;
    served = answer.build;
    if (served) deps.note(served);
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
          // Once the newer build is known to be served, replies have nothing more to say.
          if ((compareBuilds(deps.build, served) ?? 0) < 0) return;
          if (replyHintsNewBuild(response, deps.build)) void check(restingMoment);
        }),
      ];
      const poll = deps.setInterval(() => void check(restingMoment), FORK_POLL_MS);
      return () => {
        for (const stop of stops) stop();
        deps.clearInterval(poll);
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
