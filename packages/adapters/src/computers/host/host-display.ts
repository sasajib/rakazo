import type { ChildProcess } from "node:child_process";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ComputerAction, ComputerInput } from "@rakazo/adapter-kit";
import { desktopUrl } from "@rakazo/core/node/desktop-runtime";
import { z } from "zod";
import { HostScreenError } from "../screens/host-screen.js";

/**
 * The screen of an X11 display the host computer server runs on (a Linux desktop such as a VNC
 * session), shown and driven the way a Docker computer's screen is: a read-only x11vnc viewer and,
 * while a person holds control, a second input-capable x11vnc, both behind one websockify gateway
 * whose TokenFile maps a per-session token to each viewer's unix socket. The gateway listens on
 * an address only the server's own proxy reaches; the proxy seals the viewer URL, so no browser
 * ever sees a token. Both viewers attach beside whatever already shows the display and never
 * restart it.
 */
export interface HostDisplayOptions {
  /** X display to show, e.g. `:1`. */
  display: string;
  /** Address the gateway listens on (the Docker bridge gateway, never every interface). */
  bindHost: string;
  port: number;
  /** noVNC files plus Rakazo's embed.html, served by the gateway. */
  webDir: string;
  /** Private directory for sockets and token routes (mode 700). */
  stateDir: string;
  /** Largest picture the model gets; coordinates are scaled back to the real display. */
  maxImage?: { width: number; height: number };
  /** Command runner, replaceable in tests. */
  run?: HostDisplayRunner;
  /** Long-running process starter, replaceable in tests. */
  start?: (file: string, args: string[]) => ChildProcess;
}

export type HostDisplayRunner = (
  file: string,
  args: string[],
  options?: { input?: Buffer; signal?: AbortSignal },
) => Promise<Buffer>;

export interface HostDisplayObservation {
  /** base64 PNG */
  image: string;
  mimeType: "image/png";
  width: number;
  height: number;
  cursor?: { x: number; y: number };
}

const TOKEN = /^[A-Za-z0-9_-]{1,128}$/;
const DEFAULT_MAX_IMAGE = { width: 1280, height: 800 };

const coordinate = z.number().finite().min(0).max(20_000);
export const hostDisplayInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("key"),
    key: z.string().min(1).max(64),
    modifiers: z.array(z.string().min(1).max(16)).max(4).optional(),
  }),
  z.object({
    kind: z.literal("pointer"),
    x: coordinate,
    y: coordinate,
    button: z.enum(["left", "right"]).optional(),
    type: z.enum(["move", "down", "up", "click"]),
  }),
  z.object({ kind: z.literal("clipboard"), text: z.string().max(10_000) }),
]);
export const hostDisplayAction = z.union([
  hostDisplayInput,
  z.object({
    kind: z.literal("scroll"),
    direction: z.enum(["up", "down", "left", "right"]),
    amount: z.number().int().min(1).max(20).optional(),
    x: coordinate.optional(),
    y: coordinate.optional(),
  }),
  z.object({ kind: z.literal("wait"), ms: z.number().int().min(0).max(5_000) }),
  z.object({ kind: z.literal("open"), path: z.string().max(4096) }),
  z.object({
    kind: z.enum(["launch", "focus"]),
    application: z.string().max(200),
    uri: z.string().max(4096).optional(),
  }),
]);
export const hostDisplayMethods = {
  displayConnect: {
    interactive: z.boolean().optional(),
    controlToken: z.string().regex(TOKEN).optional(),
  },
  displayControl: { interactive: z.boolean(), controlToken: z.string().regex(TOKEN).optional() },
  displayObserve: {},
  displayInput: { input: hostDisplayInput },
  displayAct: {
    actions: z.array(hostDisplayAction).min(1).max(24),
    observe: z.boolean().optional(),
    settleMs: z.number().int().min(0).max(5_000).optional(),
  },
};

const MODIFIER_NAMES: Record<string, string> = {
  cmd: "super",
  command: "super",
  meta: "super",
  win: "super",
  super: "super",
  option: "alt",
  alt: "alt",
  ctrl: "ctrl",
  control: "ctrl",
  shift: "shift",
};

/** Browser-style key names models use, as X keysyms. */
const KEY_NAMES: Record<string, string> = {
  enter: "Return",
  return: "Return",
  esc: "Escape",
  escape: "Escape",
  backspace: "BackSpace",
  delete: "Delete",
  del: "Delete",
  tab: "Tab",
  space: "space",
  pageup: "Prior",
  pagedown: "Next",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
};

/** xdotool's name for a key chord such as ["ctrl"] + "l". */
export function xdotoolChord(key: string, modifiers: readonly string[] = []) {
  const parts = key.split("+").filter(Boolean);
  const raw = parts.pop() ?? key;
  const base = KEY_NAMES[raw.toLowerCase()] ?? raw;
  const mods = [...modifiers, ...parts].map(
    (modifier) => MODIFIER_NAMES[modifier.toLowerCase()] ?? modifier,
  );
  return [...new Set(mods), base].join("+");
}

/** Scale that fits a display into the model's picture; 1 when it already fits. */
export function displayScale(
  real: { width: number; height: number },
  max: { width: number; height: number } = DEFAULT_MAX_IMAGE,
) {
  return Math.max(real.width / max.width, real.height / max.height, 1);
}

/** xdotool argv for one action, in real display pixels. Undefined for a pause. */
export function xdotoolArgs(
  action: ComputerAction,
  scale: number,
): { args: string[] } | { waitMs: number } {
  const at = (x: number, y: number) => [
    "mousemove",
    String(Math.round(x * scale)),
    String(Math.round(y * scale)),
  ];
  switch (action.kind) {
    case "wait":
      return { waitMs: Math.min(Math.max(Math.round(action.ms), 0), 5_000) };
    case "scroll": {
      const button = { up: "4", down: "5", left: "6", right: "7" }[action.direction];
      const repeat = String(Math.min(Math.max(Math.round(action.amount ?? 3), 1), 20));
      return {
        args: [
          ...(action.x !== undefined && action.y !== undefined ? at(action.x, action.y) : []),
          "click",
          "--repeat",
          repeat,
          button,
        ],
      };
    }
    case "key":
      return { args: ["key", "--clearmodifiers", xdotoolChord(action.key, action.modifiers)] };
    case "clipboard":
      return { args: ["type", "--clearmodifiers", "--delay", "12", "--", action.text] };
    case "pointer": {
      const button = action.button === "right" ? "3" : "1";
      const verb =
        action.type === "move"
          ? []
          : [
              action.type === "down" ? "mousedown" : action.type === "up" ? "mouseup" : "click",
              button,
            ];
      return { args: [...at(action.x, action.y), ...verb] };
    }
    default:
      // Opening files or apps on someone's own desktop starts them in their session; bots use the
      // shell for that, where the command is visible.
      throw new HostScreenError(
        "Opening files or applications is not available on this desktop. Use the shell instead.",
      );
  }
}

const defaultRun: HostDisplayRunner = (file, args, options) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { encoding: "buffer", maxBuffer: 32 * 1024 * 1024, timeout: 30_000, signal: options?.signal },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    if (options?.input) child.stdin?.end(options.input);
  });

export class HostDisplay {
  private readonly run: HostDisplayRunner;
  private readonly startProcess: (file: string, args: string[]) => ChildProcess;
  private readonly viewToken = randomBytes(24).toString("base64url");
  private viewer?: ChildProcess;
  private gateway?: ChildProcess;
  private control?: { token: string; process: ChildProcess };
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: HostDisplayOptions) {
    if (options.bindHost === "0.0.0.0" || options.bindHost === "::")
      throw new Error("refusing to serve a screen on every interface");
    this.run = options.run ?? defaultRun;
    this.startProcess =
      options.start ??
      ((file, args) =>
        spawn(file, args, {
          stdio: "ignore",
          env: { ...process.env, DISPLAY: options.display },
        }));
  }

  private get targets() {
    return path.join(this.options.stateDir, "targets");
  }
  private socket(name: string) {
    return path.join(this.options.stateDir, "sockets", `${name}.sock`);
  }

  /** One screen transition at a time: viewers and routes are shared by every caller. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async writeRoute(name: string, token: string, socket: string) {
    const file = path.join(this.targets, name);
    const next = `${file}.next`;
    await writeFile(next, `${token}: unix_socket:${socket}\n`, { mode: 0o600 });
    await rename(next, file);
  }

  private async waitForSocket(socket: string, child: ChildProcess) {
    for (let i = 0; i < 60; i += 1) {
      if (child.exitCode !== null) break;
      if (
        await stat(socket).then(
          (s) => s.isSocket(),
          () => false,
        )
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new HostScreenError("The screen viewer did not start.");
  }

  private x11vnc(socket: string, interactive: boolean) {
    return this.startProcess("x11vnc", [
      "-display",
      this.options.display,
      "-forever",
      "-shared",
      ...(interactive ? ["-wait", "5", "-defer", "5"] : ["-viewonly"]),
      // Never touch the person's own key autorepeat or screen settings.
      "-repeat",
      "-nopw",
      "-rfbport",
      "0",
      "-unixsock",
      socket,
      "-xkb",
      "-ncache",
      "0",
      "-quiet",
    ]);
  }

  private async ensureView() {
    await mkdir(this.targets, { recursive: true, mode: 0o700 });
    await mkdir(path.dirname(this.socket("view")), { recursive: true, mode: 0o700 });
    if (!this.viewer || this.viewer.exitCode !== null) {
      await rm(this.socket("view"), { force: true });
      this.viewer = this.x11vnc(this.socket("view"), false);
      await this.waitForSocket(this.socket("view"), this.viewer);
    }
    await this.writeRoute("view", this.viewToken, this.socket("view"));
    if (!this.gateway || this.gateway.exitCode !== null) {
      this.gateway = this.startProcess("websockify", [
        "--heartbeat=30",
        `--web=${this.options.webDir}`,
        "--token-plugin=TokenFile",
        `--token-source=${this.targets}`,
        `${this.options.bindHost}:${this.options.port}`,
      ]);
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (this.gateway.exitCode !== null)
        throw new HostScreenError("The screen gateway did not start.");
    }
  }

  private async stopControl() {
    await rm(path.join(this.targets, "control"), { force: true });
    const held = this.control;
    this.control = undefined;
    if (held && held.process.exitCode === null) held.process.kill("SIGTERM");
  }

  private async ensureControl(token: string) {
    if (this.control?.token === token && this.control.process.exitCode === null) return;
    await this.stopControl();
    const name = `control-${createHash("sha256").update(token).digest("hex").slice(0, 16)}`;
    const socket = this.socket(name);
    await rm(socket, { force: true });
    const process = this.x11vnc(socket, true);
    this.control = { token, process };
    await this.waitForSocket(socket, process);
    await this.writeRoute("control", token, socket);
  }

  private screenUrl() {
    return `http://${this.options.bindHost}:${this.options.port}/embed.html`;
  }

  connect(request: { interactive?: boolean; controlToken?: string }) {
    return this.serial(async () => {
      await this.ensureView();
      if (!request.interactive) return { url: desktopUrl(this.screenUrl(), this.viewToken) };
      if (!request.controlToken || !TOKEN.test(request.controlToken))
        throw new HostScreenError("interactive screen requires a control token");
      await this.ensureControl(request.controlToken);
      return { url: desktopUrl(this.screenUrl(), request.controlToken) };
    });
  }

  /** Revoking with a token ends only that control; without one it ends any control. */
  setControl(interactive: boolean, controlToken?: string) {
    return this.serial(async () => {
      if (interactive) {
        if (!controlToken || !TOKEN.test(controlToken))
          throw new HostScreenError("interactive screen requires a control token");
        await this.ensureView();
        await this.ensureControl(controlToken);
        return;
      }
      if (controlToken && this.control && this.control.token !== controlToken) return;
      await this.stopControl();
    });
  }

  private async geometry(signal?: AbortSignal) {
    const out = (await this.run("xdotool", ["getdisplaygeometry"], { signal })).toString("utf8");
    const [width, height] = out.trim().split(/\s+/).map(Number);
    if (!width || !height) throw new HostScreenError("The screen size could not be read.");
    return { width, height };
  }

  async observe(signal?: AbortSignal): Promise<HostDisplayObservation> {
    const real = await this.geometry(signal);
    const scale = displayScale(real, this.options.maxImage);
    const width = Math.round(real.width / scale);
    const height = Math.round(real.height / scale);
    const captured = await this.run("import", ["-window", "root", "png:-"], { signal });
    const image =
      scale === 1
        ? captured
        : await this.run("convert", ["png:-", "-resize", `${width}x${height}!`, "png:-"], {
            input: captured,
            signal,
          });
    if (!image.byteLength) throw new HostScreenError("The screen could not be captured.");
    const mouse = (
      await this.run("xdotool", ["getmouselocation", "--shell"], { signal }).catch(() =>
        Buffer.from(""),
      )
    ).toString("utf8");
    const x = mouse.match(/X=(\d+)/)?.[1];
    const y = mouse.match(/Y=(\d+)/)?.[1];
    return {
      image: image.toString("base64"),
      mimeType: "image/png",
      width,
      height,
      ...(x && y
        ? { cursor: { x: Math.round(Number(x) / scale), y: Math.round(Number(y) / scale) } }
        : {}),
    };
  }

  async input(input: ComputerInput, signal?: AbortSignal) {
    await this.act([input], false, 0, signal);
  }

  async act(
    actions: readonly ComputerAction[],
    observe: boolean | undefined,
    settleMs: number | undefined,
    signal?: AbortSignal,
  ) {
    const scale = displayScale(await this.geometry(signal), this.options.maxImage);
    let completed = 0;
    for (const action of actions) {
      signal?.throwIfAborted();
      const step = xdotoolArgs(action, scale);
      if ("waitMs" in step) await new Promise((resolve) => setTimeout(resolve, step.waitMs));
      else await this.run("xdotool", step.args, { signal });
      completed += 1;
    }
    if (settleMs) await new Promise((resolve) => setTimeout(resolve, Math.min(settleMs, 5_000)));
    return {
      completed,
      ...(observe === false ? {} : { observation: await this.observe(signal) }),
    };
  }

  close() {
    for (const child of [this.viewer, this.gateway, this.control?.process])
      if (child && child.exitCode === null) child.kill("SIGTERM");
  }
}
