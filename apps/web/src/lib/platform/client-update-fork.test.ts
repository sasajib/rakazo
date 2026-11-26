import { flush } from "@rakazo/core/test-async";
import { describe, expect, it, vi } from "vitest";

vi.mock("../query/rpc", () => ({ onRpcResponse: () => () => {} }));
vi.mock("../calls/call-session", () => ({ getSnapshot: () => null }));
vi.mock("../calls/dictation", () => ({ dictation: { state: { status: "idle" } } }));

import { AUTO_RELOAD_HEADER } from "./auto-reload-header";
import type { ClientUpdateDeps } from "./client-update";
import { createClientUpdates } from "./client-update";
import type { ServedBuild, UnsafeFacts, UpdateFacts } from "./client-update-fork";
import {
  createForkClientUpdates,
  decideClientUpdate,
  FORK_CHECK_SPACING_MS,
  FORK_POLL_MS,
  FORK_RELEASE_QUIET_MS,
  FORK_RELEASE_TICK_MS,
  fetchServedBuild,
  holdReload,
  pageHoldsTypedText,
  reloadHeld,
  replyHintsNewBuild,
} from "./client-update-fork";

const OLD = "20261022090000";
const NEW = "20261022100000";

const facts = (overrides: Partial<UpdateFacts> = {}): UpdateFacts => ({
  build: OLD,
  served: NEW,
  autoReload: true,
  moment: "visible",
  liveCall: false,
  composerText: false,
  busy: false,
  quietMs: 60_000,
  ...overrides,
});

describe("decideClientUpdate", () => {
  it("does nothing on the same build, an older build, or an unknown one", () => {
    expect(decideClientUpdate(facts({ served: OLD }))).toBe("nothing");
    expect(decideClientUpdate(facts({ build: NEW, served: OLD }))).toBe("nothing");
    expect(decideClientUpdate(facts({ served: null }))).toBe("nothing");
    expect(decideClientUpdate(facts({ served: "<html>" }))).toBe("nothing");
    expect(decideClientUpdate(facts({ build: "" }))).toBe("nothing");
  });

  it("reloads an idle tab that became visible, navigates, or is hidden", () => {
    for (const moment of ["visible", "navigation", "hidden"] as const) {
      expect(decideClientUpdate(facts({ moment }))).toBe("reload");
    }
  });

  it("shows the notice to a visible tab in use, until it navigates", () => {
    expect(decideClientUpdate(facts({ moment: "waiting", quietMs: 0 }))).toBe("bar");
    expect(decideClientUpdate(facts({ moment: "waiting", quietMs: 3_600_000 }))).toBe("bar");
  });

  it("never reloads during a call, with typed text, or while busy, at any moment", () => {
    for (const moment of ["visible", "navigation", "hidden", "idle", "released"] as const) {
      expect(decideClientUpdate(facts({ moment, liveCall: true }))).toBe("bar");
      expect(decideClientUpdate(facts({ moment, composerText: true }))).toBe("bar");
      expect(decideClientUpdate(facts({ moment, busy: true }))).toBe("bar");
    }
  });

  it("reloads once what was in the way has ended and input has settled", () => {
    expect(decideClientUpdate(facts({ moment: "released", quietMs: 0 }))).toBe("bar");
    expect(decideClientUpdate(facts({ moment: "released", quietMs: FORK_RELEASE_QUIET_MS }))).toBe(
      "reload",
    );
  });

  it("only shows the notice when the deployment switched automatic reloads off", () => {
    for (const moment of ["visible", "navigation", "hidden", "idle", "released"] as const) {
      expect(decideClientUpdate(facts({ moment, autoReload: false }))).toBe("bar");
    }
  });
});

describe("fetchServedBuild", () => {
  it("reads the build and the kill switch header", async () => {
    const on = await fetchServedBuild(async () => new Response(`${NEW}\n`));
    expect(on).toEqual({ build: NEW, autoReload: true });
    const off = await fetchServedBuild(
      async () => new Response(NEW, { headers: { [AUTO_RELOAD_HEADER]: "0" } }),
    );
    expect(off).toEqual({ build: NEW, autoReload: false });
  });

  it("answers null when the request fails", async () => {
    expect(await fetchServedBuild(async () => Promise.reject(new TypeError("offline")))).toBeNull();
    expect(await fetchServedBuild(async () => new Response("", { status: 502 }))).toBeNull();
  });
});

describe("replyHintsNewBuild", () => {
  const reply = (status: number, build?: string) =>
    new Response(null, { status, headers: build ? { "x-rakazo-build": build } : {} });
  it("takes a newer build header or a contract mismatch as a hint", () => {
    expect(replyHintsNewBuild(reply(200, NEW), OLD)).toBe(true);
    expect(replyHintsNewBuild(reply(200, OLD), OLD)).toBe(false);
    expect(replyHintsNewBuild(reply(200, OLD), NEW)).toBe(false);
    expect(replyHintsNewBuild(reply(200), OLD)).toBe(false);
    expect(replyHintsNewBuild(reply(404, OLD), OLD)).toBe(true);
    expect(replyHintsNewBuild(reply(400), OLD)).toBe(true);
    expect(replyHintsNewBuild(reply(500), OLD)).toBe(false);
  });
});

describe("page state", () => {
  it("finds typed text in a textarea or an editable element, not blank ones", () => {
    const page = (fields: unknown[]) => ({ querySelectorAll: () => fields }) as unknown as Document;
    expect(pageHoldsTypedText(page([]))).toBe(false);
    expect(pageHoldsTypedText(page([{ value: "  \n" }]))).toBe(false);
    expect(pageHoldsTypedText(page([{ value: "" }, { value: "hello" }]))).toBe(true);
    expect(pageHoldsTypedText(page([{ textContent: "draft" }]))).toBe(true);
  });

  it("counts holds until each is released", () => {
    const first = holdReload();
    const second = holdReload();
    expect(reloadHeld()).toBe(true);
    first();
    first();
    expect(reloadHeld()).toBe(true);
    second();
    expect(reloadHeld()).toBe(false);
  });
});

/** The fork tracker linked to upstream's real tracker, as the app wires them. */
function setup(options: { build?: string } = {}) {
  let now = 1_000_000;
  const listeners = new Map<string, Array<() => void>>();
  const intervals = new Map<number, { callback: () => void; ms: number }>();
  let handle = 0;
  const responders: Array<(response: Response) => void> = [];
  const state = {
    visibility: "visible" as DocumentVisibilityState,
    unsafe: { liveCall: false, composerText: false, busy: false } as UnsafeFacts,
    served: { build: NEW, autoReload: true } as ServedBuild | null,
  };
  const listen = (type: string, listener: () => void) => {
    listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    return () => {};
  };
  const setInterval = (callback: () => void, ms: number) => {
    intervals.set(++handle, { callback, ms });
    return handle;
  };
  const clearInterval = (id: unknown) => void intervals.delete(id as number);
  const fetchServed = vi.fn(async () => state.served);
  const bar = vi.fn();
  const reload = vi.fn(() => true);
  const store = new Map<string, string>();

  let upstream: ReturnType<typeof createClientUpdates>;
  const fork = createForkClientUpdates({
    build: options.build ?? OLD,
    fetchServed,
    facts: () => state.unsafe,
    visibility: () => state.visibility,
    now: () => now,
    note: (build) => upstream.noteServerBuild(build),
    attempt: (moment) =>
      moment === "hidden" || moment === "visible" || moment === "released"
        ? upstream.attempt(moment)
        : Promise.resolve(false),
    bar,
    listen,
    responses: (listener) => {
      responders.push(listener);
      return () => {};
    },
    setInterval,
    clearInterval,
  });
  const deps: ClientUpdateDeps = {
    build: options.build ?? OLD,
    document: {
      get visibilityState() {
        return state.visibility;
      },
      activeElement: null,
      querySelector: (() => null) as unknown as Document["querySelector"],
    },
    storage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => void store.set(key, value),
      removeItem: (key) => void store.delete(key),
    },
    listen,
    responses: (listener) => {
      responders.push(listener);
      return () => {};
    },
    servedBuild: fork.servedBuild,
    reload,
    holdsUnsavedWork: () => false,
    holdsWorkInFlight: () => false,
    offerReload: vi.fn(),
    hasUnsentDraft: () => false,
    now: () => now,
    setInterval,
    clearInterval,
    forkAllows: fork.allows,
    installFork: fork.install,
  };
  upstream = createClientUpdates(deps);
  upstream.install();
  const fire = (type: string) => {
    for (const listener of listeners.get(type) ?? []) listener();
  };
  return {
    state,
    bar,
    reload,
    fetchServed,
    upstream,
    advance: (ms: number) => {
      now += ms;
    },
    fire,
    becomeVisible: async () => {
      state.visibility = "visible";
      fire("visibilitychange");
      await flush();
      await flush();
    },
    /** Runs the interval callbacks registered with this period. */
    tick: async (ms: number) => {
      for (const interval of [...intervals.values()]) if (interval.ms === ms) interval.callback();
      await flush();
      await flush();
    },
    reply: async (status: number, build?: string) => {
      const response = new Response(null, {
        status,
        headers: build ? { "x-rakazo-build": build } : {},
      });
      for (const responder of responders) responder(response);
      await flush();
      await flush();
    },
    barShown: () => bar.mock.calls.at(-1)?.[0] === true,
  };
}

describe("fork client updates", () => {
  it("does nothing when the web server serves this bundle's build", async () => {
    const tab = setup();
    tab.state.served = { build: OLD, autoReload: true };
    await tab.becomeVisible();
    await tab.tick(FORK_POLL_MS);
    expect(tab.fetchServed).toHaveBeenCalled();
    expect(tab.reload).not.toHaveBeenCalled();
    expect(tab.bar).not.toHaveBeenCalled();
  });

  it("reloads an idle tab when it becomes visible on an old build", async () => {
    const tab = setup();
    await tab.becomeVisible();
    expect(tab.reload).toHaveBeenCalledOnce();
    expect(tab.barShown()).toBe(false);
  });

  it("reloads an idle tab when its window regains focus", async () => {
    const tab = setup();
    tab.fire("focus");
    await flush();
    await flush();
    expect(tab.reload).toHaveBeenCalledOnce();
  });

  it("shows the notice while the composer holds text, then reloads after it clears", async () => {
    const tab = setup();
    tab.state.unsafe = { liveCall: false, composerText: true, busy: false };
    await tab.becomeVisible();
    expect(tab.reload).not.toHaveBeenCalled();
    expect(tab.barShown()).toBe(true);

    // Navigating with text typed does not reload either.
    tab.upstream.navigated();
    await flush();
    expect(tab.reload).not.toHaveBeenCalled();

    tab.state.unsafe = { liveCall: false, composerText: false, busy: false };
    tab.fire("keydown");
    await tab.tick(FORK_RELEASE_TICK_MS);
    // The last key was just now: wait for input to settle.
    expect(tab.reload).not.toHaveBeenCalled();
    tab.advance(FORK_CHECK_SPACING_MS);
    await tab.tick(FORK_RELEASE_TICK_MS);
    expect(tab.reload).toHaveBeenCalledOnce();
  });

  it("only shows the notice during a live call, however long it lasts and wherever the tab is", async () => {
    const tab = setup();
    tab.state.unsafe = { liveCall: true, composerText: false, busy: false };
    await tab.becomeVisible();
    for (let round = 0; round < 5; round++) {
      tab.advance(FORK_POLL_MS);
      await tab.tick(FORK_RELEASE_TICK_MS);
      await tab.tick(FORK_POLL_MS);
      await tab.tick(60_000);
      tab.upstream.navigated();
      tab.state.visibility = round % 2 ? "visible" : "hidden";
      tab.fire("visibilitychange");
      await flush();
      await flush();
    }
    expect(tab.reload).not.toHaveBeenCalled();
    expect(tab.barShown()).toBe(true);

    // The call ends: the tab reloads by itself.
    tab.state.unsafe = { liveCall: false, composerText: false, busy: false };
    tab.state.visibility = "visible";
    tab.advance(FORK_CHECK_SPACING_MS);
    await tab.tick(FORK_RELEASE_TICK_MS);
    expect(tab.reload).toHaveBeenCalledOnce();
  });

  it("does nothing when the build check fails", async () => {
    const tab = setup();
    tab.state.served = null;
    await tab.becomeVisible();
    await tab.reply(200, NEW);
    tab.advance(FORK_POLL_MS);
    await tab.tick(FORK_POLL_MS);
    tab.state.visibility = "hidden";
    tab.fire("visibilitychange");
    await flush();
    await flush();
    expect(tab.fetchServed).toHaveBeenCalled();
    expect(tab.reload).not.toHaveBeenCalled();
    expect(tab.bar).not.toHaveBeenCalled();
  });

  it("waits while the API is ahead of the web server, then reloads once it serves the build", async () => {
    const tab = setup();
    tab.state.served = { build: OLD, autoReload: true };
    await tab.reply(200, NEW);
    expect(tab.fetchServed).toHaveBeenCalledOnce();
    expect(tab.reload).not.toHaveBeenCalled();
    expect(tab.bar).not.toHaveBeenCalled();

    tab.state.served = { build: NEW, autoReload: true };
    tab.advance(FORK_CHECK_SPACING_MS);
    await tab.becomeVisible();
    expect(tab.reload).toHaveBeenCalledOnce();
  });

  it("checks the served build after a reply that looks like a contract mismatch", async () => {
    const tab = setup();
    await tab.reply(404);
    expect(tab.fetchServed).toHaveBeenCalledOnce();
    // A visible tab in use learns it and offers the reload; it does not reload under the user.
    expect(tab.reload).not.toHaveBeenCalled();
    expect(tab.barShown()).toBe(true);
    await tab.reply(404);
    expect(tab.fetchServed).toHaveBeenCalledOnce();
  });

  it("learns a new build without any API traffic, from the background check", async () => {
    const tab = setup();
    tab.state.visibility = "hidden";
    await tab.tick(FORK_POLL_MS);
    expect(tab.reload).toHaveBeenCalledOnce();
  });

  it("with automatic reloads switched off, shows the notice and never reloads", async () => {
    const tab = setup();
    tab.state.served = { build: NEW, autoReload: false };
    await tab.becomeVisible();
    expect(tab.barShown()).toBe(true);
    tab.upstream.navigated();
    tab.state.visibility = "hidden";
    tab.fire("visibilitychange");
    await flush();
    await flush();
    tab.advance(10 * FORK_POLL_MS);
    await tab.tick(FORK_RELEASE_TICK_MS);
    await tab.tick(FORK_POLL_MS);
    await tab.tick(60_000);
    expect(tab.reload).not.toHaveBeenCalled();
  });

  it("keeps the switch-off even when upstream's own check is what reads the build", async () => {
    const tab = setup();
    tab.state.served = { build: NEW, autoReload: false };
    // No fork check has run yet; upstream learns the build from a reply while hidden.
    tab.state.visibility = "hidden";
    tab.upstream.noteServerBuild(NEW);
    await flush();
    await flush();
    expect(tab.fetchServed).toHaveBeenCalled();
    expect(tab.reload).not.toHaveBeenCalled();
  });

  it("stays off on a bundle without a build id (dev server, desktop renderer)", async () => {
    const tab = setup({ build: "" });
    await tab.becomeVisible();
    await tab.reply(404);
    expect(tab.fetchServed).not.toHaveBeenCalled();
    expect(tab.reload).not.toHaveBeenCalled();
  });
});
