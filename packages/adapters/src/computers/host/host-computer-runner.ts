import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { SandboxFileTooLargeError } from "@rakazo/adapter-kit";
import type { SkippedLargeFiles } from "../../providers/computer/desktop/desktop-sandbox.js";
import {
  DesktopSandboxProvider,
  SKIPPED_LARGE_PATHS_MAX,
} from "../../providers/computer/desktop/desktop-sandbox.js";
import { WorkspacePathError } from "../screens/computer-support.js";
import type { HostScreen } from "../screens/host-screen.js";
import { HostScreenError } from "../screens/host-screen.js";
import type {
  HostComputerFrame,
  HostComputerRequest,
  HostExportSkippedFrame,
} from "./host-computer-protocol.js";
import {
  HOST_COMPUTER_MAX_FILE_BYTES,
  hostComputerDeadlineMs,
  hostComputerFileTooLargeMessage,
  hostComputerRequest,
} from "./host-computer-protocol.js";
import type { HostDisplay } from "./host-display.js";

/** Where one request's frames go. A write may wait for the transport to drain. */
export interface HostComputerSink {
  /** Called once the request is accepted, before the first frame. */
  open(): void;
  write(frame: HostComputerFrame<unknown>): void | Promise<void>;
}

export type HostComputerOutcome = "invalid" | "disabled" | "busy" | "finished";

export interface HostComputerCall {
  readonly signal: AbortSignal;
  abort(): void;
  /** Validates and runs one request. Nothing is written after the call is aborted. */
  run(input: unknown, sink: HostComputerSink): Promise<HostComputerOutcome>;
  /** Releases the slot. Always call it, even when `run` was never reached. */
  end(): void;
}

/**
 * Runs host computer requests from any transport: the local HTTP listener and the outbound
 * device socket share validation, limits, cancellation, and error sanitizing.
 */
export function createHostComputerRunner(options: {
  root: string;
  screen?: HostScreen;
  /** This computer's whole display, when it serves one (Linux desktop). */
  display?: HostDisplay;
}) {
  let enabled = false;
  const active = new Map<
    AbortController,
    { botId: string; runId?: string; method: string } | undefined
  >();
  const provider = new DesktopSandboxProvider({
    root: options.root,
    hostRoots: [homedir()],
    maxFileBytes: HOST_COMPUTER_MAX_FILE_BYTES,
  });

  // Reconstruct only our own workspace path. Never trust a caller's providerRef or filesystem root.
  function ref(botId: string): ComputerRef {
    const key = createHash("sha256").update(botId).digest("hex");
    return {
      id: `desktop-${key}`,
      botId: key,
      kind: "desktop",
      providerRef: path.join(options.root, "desktop-computers", key),
    };
  }

  function screen() {
    if (!options.screen)
      throw new HostScreenError("Screen control is not available on this computer.");
    return options.screen;
  }

  function display() {
    if (!options.display)
      throw new HostScreenError("Screen control is not available on this computer.");
    return options.display;
  }

  async function* dispatch(
    input: HostComputerRequest,
    context: AdapterContext,
  ): AsyncIterable<unknown> {
    const computer = ref(input.botId);
    const scope = { botId: input.botId, signal: context.signal };
    switch (input.method) {
      case "screenObserve":
        yield await screen().observe(scope, input.app, { query: input.query });
        break;
      case "screenAct":
        yield await screen().act(scope, input.app, input.actions);
        break;
      case "displayConnect":
        yield await display().connect(input);
        break;
      case "displayControl":
        await display().setControl(input.interactive, input.controlToken);
        yield null;
        break;
      case "displayObserve":
        yield await display().observe(context.signal);
        break;
      case "displayInput":
        await display().input(input.input, context.signal);
        yield null;
        break;
      case "displayAct":
        yield await display().act(input.actions, input.observe, input.settleMs, context.signal);
        break;
      case "environment":
        yield {
          ...(await provider.environment()),
          // Fork (1.36): where this bot's commands run, so a path printed by `pwd` maps back.
          workspace: computer.providerRef,
          ...(options.display ? { display: true } : {}),
        };
        break;
      case "provision": {
        const result = await provider.provision({ botId: computer.botId, homePath: "" }, context);
        yield { ...result, botId: input.botId, providerRef: `host:${computer.botId}` };
        break;
      }
      case "isRunning":
        yield await provider.isRunning(computer, context);
        break;
      case "prepare":
        await provider.prepare(computer, context);
        yield null;
        break;
      case "execute":
        if (!(await provider.isRunning(computer, context)))
          throw new Error("Local computer stopped");
        yield* provider.execute(computer, input.command, context);
        break;
      case "workspaceDirectories":
        yield await provider.workspaceDirectories(computer, input.directories, context);
        break;
      case "cancelRunWork":
        await provider.cancelRunWork(computer, computer.id, input.targetRunId, context);
        for (const [controller, work] of active) {
          if (
            work?.method === "execute" &&
            work.botId === input.botId &&
            work.runId === input.targetRunId
          )
            controller.abort();
        }
        yield null;
        break;
      case "listFiles":
        yield await provider.listFiles(computer, input.path, context);
        break;
      case "readFile":
        yield Buffer.from(
          await provider.readFile(computer, input.path, context, {
            maxBytes: input.maxBytes ?? HOST_COMPUTER_MAX_FILE_BYTES,
          }),
        ).toString("base64");
        break;
      case "writeFile":
        await provider.writeFile(computer, {
          ...input.file,
          content: Buffer.from(input.file.content, "base64"),
        });
        yield null;
        break;
      case "exportWorkspace": {
        // Fork (1.24): the per-file cap is this protocol's frame limit, so it stays. A caller
        // that asks for it gets every file under the cap and a count of the ones left out; one
        // large file then no longer fails the whole save.
        const skipped: SkippedLargeFiles = { count: 0, bytes: 0, paths: [] };
        const files = input.skipLargeFiles
          ? provider.exportWorkspaceSkippingLarge(computer, skipped)
          : provider.exportWorkspace(computer);
        for await (const file of files) {
          if (file.content.byteLength > HOST_COMPUTER_MAX_FILE_BYTES) {
            // Grew between stat and read.
            if (!input.skipLargeFiles)
              throw new SandboxFileTooLargeError(HOST_COMPUTER_MAX_FILE_BYTES);
            skipped.count += 1;
            skipped.bytes += file.content.byteLength;
            if (skipped.paths.length < SKIPPED_LARGE_PATHS_MAX) skipped.paths.push(file.path);
            continue;
          }
          yield { ...file, content: Buffer.from(file.content).toString("base64") };
        }
        if (skipped.count > 0) yield { skippedLarge: skipped } satisfies HostExportSkippedFrame;
        break;
      }
      case "snapshot":
        yield await provider.snapshot(computer, context);
        break;
      case "stop":
      case "destroy":
        for (const [controller, work] of active) {
          if (work?.botId === input.botId && controller.signal !== context.signal)
            controller.abort();
        }
        if (input.method === "destroy") await provider.destroy(computer, context);
        else await provider.stop(computer, context);
        yield null;
        break;
    }
  }

  function abortAll() {
    for (const controller of active.keys()) controller.abort();
    provider.cancelAllCommands();
  }

  return {
    isEnabled: () => enabled,
    setEnabled(value: boolean) {
      enabled = value;
      if (!value) abortAll();
    },
    close() {
      enabled = false;
      abortAll();
    },
    /** Reserves a slot before the request body arrives, or null when execution capacity is full. */
    begin(): HostComputerCall | null {
      // Keep four bounded slots for cancellation and shutdown when commands fill execution capacity.
      if (active.size >= 20) return null;
      const controller = new AbortController();
      active.set(controller, undefined);
      const signal = controller.signal;
      const abort = () => controller.abort();
      return {
        signal,
        abort,
        end: () => active.delete(controller),
        async run(input, sink) {
          const parsed = hostComputerRequest.safeParse(input);
          if (!parsed.success) return "invalid";
          if (!enabled || signal.aborted) return "disabled";
          const lifecycle =
            parsed.data.method === "cancelRunWork" ||
            parsed.data.method === "stop" ||
            parsed.data.method === "destroy";
          if (!lifecycle && active.size > 16) return "busy";
          active.set(controller, {
            botId: parsed.data.botId,
            runId: parsed.data.runId,
            method: parsed.data.method,
          });
          const deadline = setTimeout(abort, hostComputerDeadlineMs(parsed.data));
          deadline.unref();
          sink.open();
          // Quiet commands must keep clients and intermediaries from timing out between frames.
          const heartbeat = setInterval(() => {
            if (!signal.aborted) void Promise.resolve(sink.write({ heartbeat: true })).catch(abort);
          }, 30_000);
          heartbeat.unref();
          try {
            const context: AdapterContext = {
              operationId: "desktop-host",
              traceId: "desktop-host",
              spaceId: "local",
              userId: "local",
              runId: parsed.data.runId,
              signal,
            };
            for await (const value of dispatch(parsed.data, context)) {
              if (signal.aborted) break;
              await sink.write({ value });
            }
            if (!signal.aborted) await sink.write({ done: true });
          } catch (error) {
            if (!signal.aborted)
              await Promise.resolve(sink.write({ error: hostComputerErrorMessage(error) })).catch(
                () => undefined,
              );
          } finally {
            clearTimeout(deadline);
            clearInterval(heartbeat);
          }
          return "finished";
        },
      };
    },
  };
}

/** Only messages that reveal nothing beyond the caller's own request leave this computer. */
function hostComputerErrorMessage(error: unknown) {
  if (error instanceof HostScreenError) return error.message;
  if (error instanceof SandboxFileTooLargeError)
    return hostComputerFileTooLargeMessage(error.maxBytes);
  if (error instanceof WorkspacePathError) return error.message;
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
    return "computer file not found";
  return "Local computer operation failed";
}
