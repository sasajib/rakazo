import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ComputerRef } from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostComputerInstruction } from "../../runs/assembly/run-instructions.prompt.js";
import { HostComputerSandbox } from "./host-computer-sandbox.js";
import { startHostComputerServer } from "./host-computer-server.js";
import { displayScale, HostDisplay, xdotoolArgs, xdotoolChord } from "./host-display.js";
import { hostComputerServesScreen, userMachineServesScreen } from "./host-display-setting.js";

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "test",
  userId: "test",
  signal: new AbortController().signal,
};
const token = "cd".repeat(32);
const computer: ComputerRef = { id: "c", botId: "bot", kind: "desktop", providerRef: "host:x" };
// A real PNG header is not needed: the transport only base64-encodes what the capture returns.
const SCREEN = Buffer.from("full-size-capture");
const SMALL = Buffer.from("resized-capture");

interface Started {
  file: string;
  args: string[];
  child: ChildProcess;
}

/** x11vnc and websockify stand-ins: x11vnc "starts" by creating its unix socket. */
function fakeProcesses() {
  const started: Started[] = [];
  const sockets: ReturnType<typeof createServer>[] = [];
  const start = (file: string, args: string[]) => {
    const child = new EventEmitter() as unknown as ChildProcess & { exitCode: number | null };
    child.exitCode = null;
    child.kill = (() => {
      child.exitCode = 0;
      return true;
    }) as ChildProcess["kill"];
    if (file === "x11vnc") {
      const socket = args[args.indexOf("-unixsock") + 1]!;
      const server = createServer();
      server.listen(socket);
      sockets.push(server);
    }
    started.push({ file, args, child });
    return child;
  };
  return {
    started,
    start,
    close: () => Promise.all(sockets.map((s) => new Promise((r) => s.close(() => r(null))))),
  };
}

function fakeRun(geometry = "2560 1316", mouse = "X=1000\nY=500\nSCREEN=0\nWINDOW=1\n") {
  const calls: { file: string; args: string[]; input?: Buffer }[] = [];
  const run = async (file: string, args: string[], options?: { input?: Buffer }) => {
    calls.push({ file, args, input: options?.input });
    if (file === "xdotool" && args[0] === "getdisplaygeometry") return Buffer.from(geometry);
    if (file === "xdotool" && args[0] === "getmouselocation") return Buffer.from(mouse);
    if (file === "import") return SCREEN;
    if (file === "convert") return SMALL;
    return Buffer.from("");
  };
  return { calls, run };
}

describe("host display input", () => {
  it("scales model coordinates back to the real display", () => {
    expect(displayScale({ width: 2560, height: 1316 })).toBe(2);
    expect(displayScale({ width: 1280, height: 720 })).toBe(1);
    expect(xdotoolArgs({ kind: "pointer", type: "click", x: 100, y: 50 }, 2)).toEqual({
      args: ["mousemove", "200", "100", "click", "1"],
    });
    expect(
      xdotoolArgs({ kind: "pointer", type: "down", x: 10, y: 10, button: "right" }, 1.5),
    ).toEqual({ args: ["mousemove", "15", "15", "mousedown", "3"] });
    expect(xdotoolArgs({ kind: "scroll", direction: "down", amount: 2, x: 5, y: 6 }, 2)).toEqual({
      args: ["mousemove", "10", "12", "click", "--repeat", "2", "5"],
    });
  });

  it("names keys the way xdotool does and types text as an argument, never through a shell", () => {
    expect(xdotoolChord("l", ["ctrl"])).toBe("ctrl+l");
    expect(xdotoolChord("Enter")).toBe("Return");
    expect(xdotoolChord("cmd+shift+t")).toBe("super+shift+t");
    expect(xdotoolArgs({ kind: "clipboard", text: "$(rm -rf ~)" }, 1)).toEqual({
      args: ["type", "--clearmodifiers", "--delay", "12", "--", "$(rm -rf ~)"],
    });
  });

  it("refuses to open files or apps in the person's session", () => {
    expect(() => xdotoolArgs({ kind: "launch", application: "xterm" }, 1)).toThrow(/shell/);
    expect(() => xdotoolArgs({ kind: "open", path: "/etc/passwd" }, 1)).toThrow(/shell/);
  });
});

describe("host display screen", () => {
  let stateDir: string;
  let processes: ReturnType<typeof fakeProcesses>;
  beforeEach(async () => {
    stateDir = await realpath(await mkdtemp(path.join(tmpdir(), "rkz-hd-")));
    processes = fakeProcesses();
  });
  afterEach(async () => {
    await processes.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  function display(run = fakeRun().run) {
    return new HostDisplay({
      display: ":1",
      bindHost: "172.17.0.1",
      port: 7094,
      webDir: "/srv/novnc",
      stateDir,
      run,
      start: processes.start,
      probe: async () => processes.started.some((s) => s.file === "websockify"),
    });
  }

  it("never serves the screen on every interface", () => {
    expect(
      () =>
        new HostDisplay({
          display: ":1",
          bindHost: "0.0.0.0",
          port: 7094,
          webDir: "/srv/novnc",
          stateDir,
        }),
    ).toThrow(/every interface/);
  });

  it("opens a read-only viewer behind a token gateway, beside the display", async () => {
    const screen = display();
    const { url } = await screen.connect({});
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe("http://172.17.0.1:7094/embed.html");
    const socketPath = new URLSearchParams(parsed.searchParams.get("path")!.split("?")[1]);
    const viewToken = socketPath.get("token")!;
    expect(viewToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    const [viewer, gateway] = processes.started;
    expect(viewer!.file).toBe("x11vnc");
    expect(viewer!.args).toEqual(
      expect.arrayContaining(["-display", ":1", "-viewonly", "-repeat"]),
    );
    expect(viewer!.args).toContain("-rfbport");
    expect(viewer!.args[viewer!.args.indexOf("-rfbport") + 1]).toBe("0");
    expect(gateway!.file).toBe("websockify");
    expect(gateway!.args).toEqual(
      expect.arrayContaining(["--token-plugin=TokenFile", "172.17.0.1:7094", "--web=/srv/novnc"]),
    );
    const route = await readFile(path.join(stateDir, "targets", "view"), "utf8");
    expect(route).toBe(
      `${viewToken}: unix_socket:${path.join(stateDir, "sockets", "view.sock")}\n`,
    );
    // A second viewer reuses both processes.
    await screen.connect({});
    expect(processes.started).toHaveLength(2);
  });

  it("gives control only to the lease's token and revokes it with that token", async () => {
    const screen = display();
    const { url } = await screen.connect({ interactive: true, controlToken: "lease-1" });
    expect(new URL(url).searchParams.get("path")).toContain("token=lease-1");
    const control = processes.started.find(
      (s) => s.file === "x11vnc" && !s.args.includes("-viewonly"),
    )!;
    expect(control.args).toEqual(expect.arrayContaining(["-display", ":1", "-repeat"]));
    expect(await readFile(path.join(stateDir, "targets", "control"), "utf8")).toMatch(
      /^lease-1: unix_socket:/,
    );
    await expect(screen.connect({ interactive: true })).rejects.toThrow(/control token/);
    // An older lease cannot revoke its replacement.
    await screen.setControl(false, "lease-0");
    expect(control.child.exitCode).toBeNull();
    await screen.setControl(false, "lease-1");
    expect(control.child.exitCode).toBe(0);
    expect(await readdir(path.join(stateDir, "targets"))).toEqual(["view"]);
  });

  it("captures the whole display at the model's size and reports the scaled cursor", async () => {
    const { calls, run } = fakeRun();
    const observed = await display(run).observe();
    expect(observed).toMatchObject({ width: 1280, height: 658, cursor: { x: 500, y: 250 } });
    expect(Buffer.from(observed.image, "base64")).toEqual(SMALL);
    const resize = calls.find((call) => call.file === "convert")!;
    expect(resize.args).toEqual(["png:-", "-resize", "1280x658!", "png:-"]);
    expect(resize.input).toEqual(SCREEN);
  });

  it("acts in real pixels and returns a fresh look", async () => {
    const { calls, run } = fakeRun();
    const result = await display(run).act(
      [
        { kind: "pointer", type: "click", x: 640, y: 329 },
        { kind: "clipboard", text: "hello" },
      ],
      true,
      0,
    );
    expect(result.completed).toBe(2);
    expect(result.observation?.width).toBe(1280);
    expect(
      calls.filter((c) => c.file === "xdotool" && c.args[0] !== "get").map((c) => c.args),
    ).toEqual(
      expect.arrayContaining([
        ["mousemove", "1280", "658", "click", "1"],
        ["type", "--clearmodifiers", "--delay", "12", "--", "hello"],
      ]),
    );
  });

  it("serves the screen through the host computer transport", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "rkz-hd-root-")));
    const { run } = fakeRun();
    const server = await startHostComputerServer({
      root,
      token,
      hostname: "127.0.0.1",
      display: display(run),
    });
    server.setEnabled(true);
    try {
      const client = new HostComputerSandbox(`http://127.0.0.1:${server.port}`, token);
      const view = await client.connectScreen(computer, { view: "stream" }, context);
      expect(view.url).toContain("http://172.17.0.1:7094/embed.html");
      const held = await client.connectScreen(
        computer,
        { view: "stream", interactive: true, controlToken: "lease-9" },
        context,
      );
      expect(held.url).toContain("token%3Dlease-9");
      await client.setScreenControl(computer, false, context, "lease-9");
      const observed = await client.observe(computer, context);
      expect(observed).toMatchObject({ width: 1280, height: 658, mimeType: "image/png" });
      expect(Buffer.from(observed.image)).toEqual(SMALL);
      const acted = await client.act(
        computer,
        { actions: [{ kind: "key", key: "Return" }], observe: false },
        context,
      );
      expect(acted).toEqual({ completed: 1 });
      expect(
        await client.environment(computer, context).then((environment) => environment.display),
      ).toBe(true);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the old refusal on a host without a display", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "rkz-hd-root-")));
    const server = await startHostComputerServer({ root, token, hostname: "127.0.0.1" });
    server.setEnabled(true);
    try {
      const client = new HostComputerSandbox(`http://127.0.0.1:${server.port}`, token);
      await expect(client.connectScreen(computer, { view: "stream" }, context)).rejects.toThrow(
        "Local screen control is unavailable",
      );
      await expect(client.observe(computer, context)).rejects.toThrow("unavailable");
      // Releasing control on a host with no screen has nothing to release.
      await client.setScreenControl(computer, false, context, "lease");
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("host screen setting", () => {
  it("is off unless the deployment says its host serves the screen", () => {
    expect(hostComputerServesScreen({})).toBe(false);
    expect(hostComputerServesScreen({ SANDBOX_HOST_SCREEN: "1" })).toBe(true);
    expect(userMachineServesScreen("desktop", { SANDBOX_HOST_SCREEN: "true" })).toBe(true);
    expect(userMachineServesScreen("docker", { SANDBOX_HOST_SCREEN: "1" })).toBe(false);
  });
});

describe("host computer prompt", () => {
  const host = { home: "/home/me", shell: "/bin/bash", platform: "linux" };
  it("tells the bot the screen is the person's own desktop only when the host serves it", () => {
    expect(hostComputerInstruction("desktop", host)).toContain(
      "graphical screen control is unavailable",
    );
    const shared = hostComputerInstruction("desktop", { ...host, display: true });
    expect(shared).not.toContain("unavailable");
    expect(shared).toContain("windows and tabs you did not open are theirs");
  });
});
