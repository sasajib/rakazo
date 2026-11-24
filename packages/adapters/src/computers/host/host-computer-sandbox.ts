import type {
  AdapterContext,
  CommandRequest,
  ComputerActionRequest,
  ComputerActionResult,
  ComputerFileEntry,
  ComputerInput,
  ComputerObservation,
  ComputerRef,
  ControlLeaseRef,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
  ScreenSession,
  WorkspaceDirectoryRequest,
} from "@rakazo/adapter-kit";
import { SandboxFileTooLargeError } from "@rakazo/adapter-kit";
import { boundedSandboxCommandTimeoutMs } from "@rakazo/core/node/sandbox-command";
import { describeDesktopSandbox } from "../../providers/computer/desktop/desktop-sandbox.js";
import { shouldSkipPortableWorkspaceFile } from "../../storage/workspace-save-policy.js";
import { boundedComputerActions, computerObservation } from "../screens/computer-support.js";
import type {
  HostComputerEnvironment,
  HostComputerFrame,
  HostComputerRequest,
} from "./host-computer-protocol.js";
import {
  HOST_COMPUTER_MAX_BYTES,
  HOST_COMPUTER_MAX_FILE_BYTES,
  hostComputerDeadlineMs,
  hostComputerFileTooLargeLimit,
} from "./host-computer-protocol.js";
import type { HostDisplayObservation } from "./host-display.js";

/** Authenticated native host transport. Commands are never retried after a lost response. */
export class HostComputerSandbox implements SandboxProvider {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}
  describe() {
    return describeDesktopSandbox();
  }

  private async *request<T>(input: HostComputerRequest, context: AdapterContext): AsyncIterable<T> {
    if (!this.url || !this.token)
      throw new Error("Local computer access requires the desktop app. Enable it in the app menu.");
    const body = JSON.stringify({ ...input, runId: context.runId });
    if (Buffer.byteLength(body) > HOST_COMPUTER_MAX_BYTES)
      throw new Error("Local computer request is too large");
    const signal = AbortSignal.any([
      context.signal,
      AbortSignal.timeout(hostComputerDeadlineMs(input)),
    ]);
    const response = await fetch(new URL("/computer", this.url), {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body,
      signal,
      redirect: "error",
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(
        "Local computer unavailable. Open the desktop app and enable local computer access.",
      );
    }
    const reader = response.body.getReader();
    const abort = () => {
      void reader.cancel(signal.reason).catch(() => undefined);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const decoder = new TextDecoder();
    let pending = "";
    try {
      while (true) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        signal.throwIfAborted();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        let newline = pending.indexOf("\n");
        while (newline !== -1) {
          signal.throwIfAborted();
          if (newline > HOST_COMPUTER_MAX_BYTES)
            throw new Error("Local computer response is too large");
          const frame = JSON.parse(pending.slice(0, newline)) as HostComputerFrame<T>;
          pending = pending.slice(newline + 1);
          if ("error" in frame) {
            const maxBytes = hostComputerFileTooLargeLimit(frame.error);
            throw maxBytes === undefined
              ? new Error(frame.error)
              : new SandboxFileTooLargeError(maxBytes);
          }
          if ("heartbeat" in frame) {
            newline = pending.indexOf("\n");
            continue;
          }
          if ("done" in frame) {
            return;
          }
          yield frame.value;
          newline = pending.indexOf("\n");
        }
        if (pending.length > HOST_COMPUTER_MAX_BYTES)
          throw new Error("Local computer response is too large");
      }
      throw new Error("Local computer disconnected. Check the result before retrying.");
    } finally {
      signal.removeEventListener("abort", abort);
      const cancellation = reader.cancel().catch(() => undefined);
      if (!signal.aborted) await cancellation;
      reader.releaseLock();
    }
  }
  /** One request outside a computer's lifecycle, such as screen control of this computer. */
  stream<T>(input: HostComputerRequest, signal: AbortSignal): AsyncIterable<T> {
    return this.request<T>(input, {
      operationId: "host-computer",
      traceId: "host-computer",
      spaceId: "local",
      userId: "local",
      runId: input.runId,
      signal,
    });
  }
  private async one<T>(input: HostComputerRequest, context: AdapterContext): Promise<T> {
    let result: T | undefined;
    for await (const value of this.request<T>(input, context)) result = value;
    return result as T;
  }
  environment(computer: ComputerRef, context: AdapterContext) {
    return this.one<HostComputerEnvironment>(
      { method: "environment", botId: computer.botId },
      context,
    );
  }
  provision(input: { botId: string; homePath: string }, context: AdapterContext) {
    return this.one<ComputerRef>({ method: "provision", botId: input.botId }, context);
  }
  async prepare(computer: ComputerRef, context: AdapterContext) {
    await this.one({ method: "prepare", botId: computer.botId }, context);
  }
  isRunning(computer: ComputerRef, context: AdapterContext) {
    return this.one<boolean>({ method: "isRunning", botId: computer.botId }, context);
  }
  execute(computer: ComputerRef, command: CommandRequest, context: AdapterContext) {
    return this.request<ProcessEvent>(
      {
        method: "execute",
        botId: computer.botId,
        command: { ...command, timeoutMs: boundedSandboxCommandTimeoutMs(command.timeoutMs) },
      },
      context,
    );
  }
  workspaceDirectories(
    computer: ComputerRef,
    directories: WorkspaceDirectoryRequest,
    context: AdapterContext,
  ) {
    return this.one<string[]>(
      { method: "workspaceDirectories", botId: computer.botId, directories },
      context,
    );
  }
  async cancelRunWork(
    computer: ComputerRef,
    _computerId: string,
    runId: string,
    context: AdapterContext,
  ) {
    await this.one({ method: "cancelRunWork", botId: computer.botId, targetRunId: runId }, context);
  }
  listFiles(computer: ComputerRef, path: string, context: AdapterContext) {
    return this.one<ComputerFileEntry[]>(
      { method: "listFiles", botId: computer.botId, path },
      context,
    );
  }
  async readFile(
    computer: ComputerRef,
    path: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ) {
    const content = await this.one<string>(
      {
        method: "readFile",
        botId: computer.botId,
        path,
        maxBytes: Math.min(
          options?.maxBytes ?? HOST_COMPUTER_MAX_FILE_BYTES,
          HOST_COMPUTER_MAX_FILE_BYTES,
        ),
      },
      context,
    );
    return new Uint8Array(Buffer.from(content, "base64"));
  }
  async writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    await this.one(
      {
        method: "writeFile",
        botId: computer.botId,
        file: { ...file, content: Buffer.from(file.content).toString("base64") },
      },
      context,
    );
  }
  async *exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    for await (const file of this.request<{ path: string; content: string; executable?: boolean }>(
      { method: "exportWorkspace", botId: computer.botId },
      context,
    )) {
      if (shouldSkipPortableWorkspaceFile(file.path)) continue;
      yield { ...file, content: new Uint8Array(Buffer.from(file.content, "base64")) };
    }
  }
  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ) {
    for await (const file of files) {
      if (shouldSkipPortableWorkspaceFile(file.path)) continue;
      await this.writeFile(computer, file, context);
    }
  }
  snapshot(computer: ComputerRef, context: AdapterContext) {
    return this.one<{ id: string; createdAt: string }>(
      { method: "snapshot", botId: computer.botId },
      context,
    );
  }
  async stop(computer: ComputerRef, context: AdapterContext) {
    await this.one({ method: "stop", botId: computer.botId }, context);
  }
  async destroy(computer: ComputerRef, context: AdapterContext) {
    await this.one({ method: "destroy", botId: computer.botId }, context);
  }
  /**
   * A host that serves its display (Linux desktop, see HostDisplay) shows and takes input like a
   * Docker computer; any other host refuses, as before.
   */
  async connectScreen(
    computer: ComputerRef,
    request: ScreenRequest,
    context: AdapterContext,
  ): Promise<ScreenSession> {
    if (request.interactive && !request.controlToken)
      throw new Error("interactive screen requires a control token");
    const session = await this.one<{ url: string }>(
      {
        method: "displayConnect",
        botId: computer.botId,
        interactive: request.interactive === true,
        controlToken: request.interactive ? request.controlToken : undefined,
      },
      context,
    ).catch((error: unknown) => {
      throw screenUnavailable(error);
    });
    return { url: session.url, mimeType: "text/html", close: async () => undefined };
  }
  async setScreenControl(
    computer: ComputerRef,
    interactive: boolean,
    context: AdapterContext,
    controlToken?: string,
  ) {
    try {
      await this.one(
        { method: "displayControl", botId: computer.botId, interactive, controlToken },
        context,
      );
    } catch (error) {
      // Nothing to release on a host without a screen.
      if (interactive || !isNoScreen(error)) throw screenUnavailable(error);
    }
  }
  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    _lease: ControlLeaseRef,
    context: AdapterContext,
  ) {
    await this.one({ method: "displayInput", botId: computer.botId, input }, context).catch(
      (error: unknown) => {
        throw screenUnavailable(error);
      },
    );
  }
  async observe(computer: ComputerRef, context: AdapterContext): Promise<ComputerObservation> {
    const observed = await this.one<HostDisplayObservation>(
      { method: "displayObserve", botId: computer.botId },
      context,
    ).catch((error: unknown) => {
      throw screenUnavailable(error);
    });
    return hostObservation(observed);
  }
  async act(
    computer: ComputerRef,
    request: ComputerActionRequest,
    context: AdapterContext,
  ): Promise<ComputerActionResult> {
    const result = await this.one<{ completed: number; observation?: HostDisplayObservation }>(
      {
        method: "displayAct",
        botId: computer.botId,
        actions: boundedComputerActions(request.actions),
        observe: request.observe,
        settleMs:
          request.settleMs === undefined
            ? undefined
            : Math.min(Math.max(Math.round(request.settleMs), 0), 5_000),
      },
      context,
    ).catch((error: unknown) => {
      throw screenUnavailable(error);
    });
    return {
      completed: result.completed,
      ...(result.observation ? { observation: hostObservation(result.observation) } : {}),
    };
  }
}

const NO_SCREEN = "Screen control is not available on this computer.";

function isNoScreen(error: unknown) {
  return error instanceof Error && error.message === NO_SCREEN;
}

/** A host without a display (macOS/Windows desktop app) keeps the message it always gave. */
function screenUnavailable(error: unknown) {
  return isNoScreen(error)
    ? new Error("Local screen control is unavailable. Use commands to work with files and apps.")
    : error;
}

function hostObservation(observed: HostDisplayObservation): ComputerObservation {
  return computerObservation(new Uint8Array(Buffer.from(observed.image, "base64")), {
    mimeType: observed.mimeType,
    width: observed.width,
    height: observed.height,
    ...(observed.cursor ? { cursor: observed.cursor } : {}),
  });
}
