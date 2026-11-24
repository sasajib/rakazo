import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AdapterContext,
  CommandRequest,
  ComputerRef,
  ProcessEvent,
  SandboxProvider,
} from "@rakazo/adapter-kit";

/**
 * A computer that really runs bash on this host, in a throwaway HOME: the background job scripts
 * are exercised for real (setsid, the fd-9 marker, the exit file, the kill), not mocked. Only
 * `execute` exists, as the job code uses nothing else.
 */
export class LocalBashComputer implements Pick<SandboxProvider, "execute"> {
  readonly home = mkdtempSync(join(tmpdir(), "rakazo-shell-job-"));
  readonly computerId = `cmp${Math.random().toString(36).slice(2, 10)}`;
  readonly ref: ComputerRef = { id: "local", botId: "home", kind: "docker", providerRef: "local" };
  readonly calls: CommandRequest[] = [];
  /** Makes the next N execs fail, like a computer that cannot be reached. */
  failNext = 0;

  async *execute(
    _computer: ComputerRef,
    request: CommandRequest,
    _context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    this.calls.push(request);
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("computer unreachable");
    }
    const [file, ...args] = request.argv;
    const child = spawn(file ?? "bash", args, {
      cwd: this.home,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: this.home, ...(request.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const queue: ProcessEvent[] = [];
    let wake: (() => void) | undefined;
    let done = false;
    const push = (event: ProcessEvent) => {
      queue.push(event);
      wake?.();
    };
    child.stdout.on("data", (data: Buffer) => push({ type: "stdout", data: data.toString() }));
    child.stderr.on("data", (data: Buffer) => push({ type: "stderr", data: data.toString() }));
    child.on("close", (code) => {
      push({ type: "exit", code: code ?? 1 });
      done = true;
    });
    const timer = request.timeoutMs
      ? setTimeout(() => child.kill("SIGKILL"), request.timeoutMs)
      : undefined;
    try {
      while (true) {
        const next = queue.shift();
        if (next) {
          yield next;
          if (next.type === "exit") return;
          continue;
        }
        if (done) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Removes the throwaway home and this computer's markers in /tmp. */
  dispose() {
    rmSync(this.home, { recursive: true, force: true });
    for (const name of readdirSync("/tmp")) {
      if (name.startsWith(`rakazo-background-${this.computerId}-`))
        rmSync(join("/tmp", name), { force: true });
    }
  }
}
