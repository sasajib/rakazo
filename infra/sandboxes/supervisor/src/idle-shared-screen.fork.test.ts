import type * as NodeHttp from "node:http";
import { Readable } from "node:stream";
import { resolveSupervisorToken } from "@rakazo/core/node/secrets-guard";
import type { Deferred } from "@rakazo/core/test-async";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computerNetworkNameFor } from "./computer-spec.js";
import { SCREEN_IDLE_MS, touchLeaselessScreen } from "./supervisor-logic.js";

const mocks = vi.hoisted(() => ({ getContainer: vi.fn() }));
vi.mock("dockerode", () => ({
  default: class {
    getContainer = mocks.getContainer;
  },
}));
vi.mock("node:http", async (original) => {
  const http = await original<typeof NodeHttp>();
  return {
    ...http,
    default: {
      ...http,
      get: vi.fn((_options, callback) => {
        callback({ statusCode: 200, resume() {} });
        return {
          once() {
            return this;
          },
          destroy() {},
        };
      }),
    },
  };
});

const token = resolveSupervisorToken(process.env);
const preview = { interactive: false, revokeControl: false };
// A Team Computer is provisioned under its home key; every bot on it gets the shared screen.
const TEAM_HOME = "team-0123456789abcdef0123456789abcdef";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("HOSTNAME", "");
  vi.stubEnv("SANDBOX_SCREEN_NETWORK", "published");
  vi.stubEnv("SANDBOX_SCREEN_HOST", "127.0.0.1");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** The command that stops a bot's viewer and browser, as eviction and the idle timeout run it. */
const isScreenClose = (command: string) =>
  /sockets\/view-\d+-/.test(command) && command.includes("Browser.close");

function fixture() {
  const commands: string[] = [];
  const computer = {
    running: true,
    startedAt: "boot-1",
    failCloses: false,
    failInspect: false,
    gate: undefined as Deferred<void> | undefined,
  };
  const container = {
    inspect: vi.fn(async () => {
      if (computer.failInspect)
        throw Object.assign(new Error("daemon unavailable"), { statusCode: 500 });
      return {
        Config: {
          Labels: {
            "rakazo.managed": "true",
            "rakazo.botId": TEAM_HOME,
            "rakazo.spaceId": "space",
          },
        },
        HostConfig: { NetworkMode: computerNetworkNameFor(TEAM_HOME) },
        State: { Running: computer.running, StartedAt: computer.startedAt },
        NetworkSettings: { Ports: { "6080/tcp": [{ HostIp: "127.0.0.1", HostPort: "6080" }] } },
      };
    }),
    exec: vi.fn(async ({ Cmd }: { Cmd: string[] }) => {
      const command = Cmd.join(" ");
      commands.push(command);
      const gate = computer.gate;
      if (gate) {
        computer.gate = undefined;
        await gate.promise;
      }
      return {
        start: async () => Readable.from([]),
        inspect: async () => ({ ExitCode: computer.failCloses && isScreenClose(command) ? 1 : 0 }),
      };
    }),
  };
  mocks.getContainer.mockReturnValue(container);
  return { computer, container, closes: () => commands.filter(isScreenClose) };
}

async function supervisor() {
  const { supervisorApp } = await import("./index.js");
  const { getLogger } = await import("@rakazo/logging");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const logError = vi.spyOn(getLogger(), "error").mockImplementation(() => undefined);
  const screenMode = (body: object, options: { leaseId?: string; screenId?: string } = {}) =>
    supervisorApp.request("/computers/computer/screen-mode", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-rakazo-bot-id": TEAM_HOME,
        "x-rakazo-space-id": "space",
        "x-rakazo-screen-id": options.screenId ?? "writer",
        ...(options.leaseId ? { "x-rakazo-screen-lease-id": options.leaseId } : {}),
      },
      body: JSON.stringify(body),
    });
  const releaseWarm = (leaseId: string) =>
    supervisorApp.request("/computers/computer/screen", {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${token}`,
        "x-rakazo-bot-id": TEAM_HOME,
        "x-rakazo-space-id": "space",
        "x-rakazo-screen-id": "writer",
        "x-rakazo-screen-lease-id": leaseId,
        "x-rakazo-preserve-screen": "1",
      },
    });
  return { logError, screenMode, releaseWarm };
}

// Fork (1.14) on upstream #6773: the shared screen has no run lease, so without this rule it is
// closed 30 minutes after it was set up, whoever is working on it.
describe("idle close and the team's shared screen (fork)", () => {
  it("keeps the shared browser while bots keep using it, and closes it 30 minutes after the last use", async () => {
    const { closes } = fixture();
    const { screenMode } = await supervisor();
    const { computerScreens } = await import("./screens.js");
    expect((await screenMode(preview, { screenId: "botA", leaseId: "runA:1" })).status).toBe(200);
    expect([...computerScreens.get("computer")!.keys()]).toEqual(["team-shared"]);

    // Two bots take turns for well over the idle time.
    for (let minute = 0; minute < 80; minute += 20) {
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      const bot = minute % 40 === 0 ? "botB" : "botA";
      expect((await screenMode(preview, { screenId: bot, leaseId: `${bot}:2` })).status).toBe(200);
    }
    expect(closes()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(SCREEN_IDLE_MS - 1);
    expect(closes()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(closes()).toHaveLength(1);
    expect(computerScreens.get("computer")?.has("team-shared") ?? false).toBe(false);
  });

  it("counts the idle time of a screen without a lease from its last use only", () => {
    const idle = { index: 0, leaseId: undefined, idleAt: 1 };
    touchLeaselessScreen(idle, 50);
    expect(idle.idleAt).toBe(50);
    // A screen a run holds is not idle, and one being released keeps its state.
    const held: { index: number; leaseId: string; idleAt?: number } = {
      index: 1,
      leaseId: "run:1",
    };
    touchLeaselessScreen(held, 50);
    expect(held.idleAt).toBeUndefined();
    const releasing = { index: 2, leaseId: undefined, idleAt: 1, releasing: true };
    touchLeaselessScreen(releasing, 50);
    expect(releasing.idleAt).toBe(1);
    touchLeaselessScreen(undefined, 50);
  });
});
