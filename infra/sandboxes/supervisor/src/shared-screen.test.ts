import { Duplex, Readable, Writable } from "node:stream";
import { TEAM_SHARED_SCREEN_KEY } from "@rakazo/core/node/desktop-runtime";
import { resolveSupervisorToken } from "@rakazo/core/node/secrets-guard";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ exec: vi.fn(), inspect: vi.fn(), commands: [] as string[][] }));
vi.mock("dockerode", () => ({
  default: class {
    getContainer() {
      return mock;
    }
  },
}));

import { supervisorApp } from "./index.js";
import {
  SharedScreenBusyError,
  SharedScreenHolds,
  screenIdentity,
  teamSharedBrowserEnabled,
} from "./shared-screen.js";

const TEAM_HOME = "team-0123456789abcdef0123456789abcdef";

beforeEach(() => {
  mock.exec.mockReset();
  mock.inspect.mockReset();
  mock.commands.length = 0;
  mock.inspect.mockResolvedValue({
    Config: {
      Labels: { "rakazo.managed": "true", "rakazo.botId": TEAM_HOME, "rakazo.spaceId": "space" },
    },
    State: { Running: true, StartedAt: "boot-1" },
  });
  mock.exec.mockImplementation(async (options: { Cmd: string[] }) => {
    mock.commands.push(options.Cmd);
    return {
      start: async () =>
        Duplex.from({
          readable: Readable.from([
            Buffer.from(
              options.Cmd.includes("/usr/local/bin/rakazo-page-browser")
                ? JSON.stringify({ ok: true, url: "https://example.test", tree: "", elements: [] })
                : "RAKAZO_DESKTOP_RELEASED=1\n",
            ),
          ]),
          writable: new Writable({
            write(_chunk, _encoding, callback) {
              callback();
            },
          }),
        }),
      inspect: async () => ({ ExitCode: 0 }),
    };
  });
});

function headers(bot: string, lease: string, home = TEAM_HOME) {
  return {
    authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
    "content-type": "application/json",
    "x-rakazo-bot-id": home,
    "x-rakazo-space-id": "space",
    "x-rakazo-screen-id": bot,
    "x-rakazo-screen-lease-id": lease,
  };
}

async function snapshot(id: string, bot: string, lease: string, home = TEAM_HOME) {
  return supervisorApp.request(`/computers/${id}/browser`, {
    method: "POST",
    headers: headers(bot, lease, home),
    body: JSON.stringify({ command: "snapshot" }),
  });
}

function helperEnv(index: number) {
  return mock.exec.mock.calls
    .map(([options]) => options as { Cmd: string[]; Env?: string[] })
    .filter((options) => options.Cmd.includes("/usr/local/bin/rakazo-page-browser"))
    .at(index)?.Env;
}

describe("team computer shared browser", () => {
  it("gives every bot on a Team Computer the same screen, browser and profile", () => {
    const a = screenIdentity({ botId: TEAM_HOME, screenId: "botA", screenLeaseId: "runA:7" }, "c");
    const b = screenIdentity({ botId: TEAM_HOME, screenId: "botB", screenLeaseId: "runB:1" }, "c");
    expect(a.screenKey).toBe(TEAM_SHARED_SCREEN_KEY);
    expect(b.screenKey).toBe(a.screenKey);
    // Fences of different bots cannot be compared, so the shared screen is not fenced.
    expect([a.screenLeaseId, b.screenLeaseId]).toEqual([undefined, undefined]);
    expect([a.tabOwner, b.tabOwner]).toEqual(["botA", "botB"]);
  });

  it("keeps dedicated computers and the kill switch on per-bot screens", () => {
    expect(screenIdentity({ botId: "botA", screenId: "botA", screenLeaseId: "r:1" }, "c")).toEqual({
      screenKey: "botA",
      screenLeaseId: "r:1",
      tabOwner: undefined,
      shared: false,
    });
    const off = { SANDBOX_TEAM_SHARED_BROWSER: "0" } as NodeJS.ProcessEnv;
    expect(teamSharedBrowserEnabled(off)).toBe(false);
    expect(screenIdentity({ botId: TEAM_HOME, screenId: "botA" }, "c", off).screenKey).toBe("botA");
  });

  it("runs two bots' page tools on the one browser, each in its own tab", async () => {
    expect(await (await snapshot("team-shared-1", "botA", "runA:5")).json()).toMatchObject({
      ok: true,
    });
    // A lower fence of another bot is not "an older execution" on the shared screen.
    expect(await (await snapshot("team-shared-1", "botB", "runB:1")).json()).toMatchObject({
      ok: true,
    });
    expect(helperEnv(0)).toEqual(
      expect.arrayContaining(["DISPLAY=:1", "RAKAZO_CDP_PORT=9222", "RAKAZO_TAB_OWNER=botA"]),
    );
    expect(helperEnv(1)).toEqual(
      expect.arrayContaining(["DISPLAY=:1", "RAKAZO_CDP_PORT=9222", "RAKAZO_TAB_OWNER=botB"]),
    );
  });

  it("never stops the shared browser when a bot's run releases the screen", async () => {
    await snapshot("team-shared-2", "botA", "runA:1");
    mock.commands.length = 0;
    const res = await supervisorApp.request("/computers/team-shared-2/screen", {
      method: "DELETE",
      headers: { ...headers("botA", "runA:1"), "x-rakazo-cancel-run-work": "1" },
    });
    expect(res.status).toBe(200);
    const ran = mock.commands.map((cmd) => cmd.join(" ")).join("\n");
    expect(ran).not.toMatch(/Browser\.close|pkill|kill /);
    // The next page call still finds the same screen without setting it up again from scratch.
    expect(await (await snapshot("team-shared-2", "botB", "runB:1")).json()).toMatchObject({
      ok: true,
    });
  });
});

describe("SharedScreenHolds", () => {
  function clock() {
    let now = 1_000;
    return {
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it("makes another bot wait, then names the bot holding the screen", async () => {
    const time = clock();
    const holds = new SharedScreenHolds(time);
    expect(await holds.hold("c", "botA")).toEqual({ fresh: true });
    expect(await holds.hold("c", "botA")).toEqual({ fresh: false });
    const started = time.now();
    await expect(holds.hold("c", "botB", { waitMs: 3_000, holdMs: 60_000 })).rejects.toThrow(
      new SharedScreenBusyError("botA").message,
    );
    expect(time.now() - started).toBeGreaterThanOrEqual(3_000);
  });

  it("hands the screen over once the holder's run ends or its hold lapses", async () => {
    const time = clock();
    const holds = new SharedScreenHolds(time);
    await holds.hold("c", "botA", { holdMs: 5_000 });
    // Another bot's release leaves the hold alone.
    holds.release("c", "botB");
    expect(holds.holderOf("c")).toBe("botA");
    time.advance(5_001);
    expect(await holds.hold("c", "botB", { waitMs: 0 })).toEqual({ fresh: true });
    holds.release("c", "botB");
    expect(holds.holderOf("c")).toBeUndefined();
  });

  it("keeps a takeover's hold until the person hands control back", async () => {
    const time = clock();
    const holds = new SharedScreenHolds(time);
    await holds.hold("c", "botA", { controlled: true, holdMs: 1_000 });
    time.advance(60_000);
    await expect(holds.hold("c", "botB", { waitMs: 0 })).rejects.toBeInstanceOf(
      SharedScreenBusyError,
    );
    holds.endControl("c", "botA");
    time.advance(30_000);
    expect(await holds.hold("c", "botB", { waitMs: 0 })).toEqual({ fresh: true });
  });
});
