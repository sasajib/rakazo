import { boundedSandboxCommandTimeoutMs } from "@rakazo/core/node/sandbox-command";
import { z } from "zod";
import { hostScreenMethods } from "../screens/host-screen.js";
import { hostDisplayMethods } from "./host-display.js";

export const HOST_COMPUTER_MAX_BYTES = 12 * 1024 * 1024;
export const HOST_COMPUTER_MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Largest file that fits both the per-file cap and the base64 content cap of one frame. */
export const HOST_COMPUTER_TRANSFER_MAX_FILE_BYTES = Math.min(
  HOST_COMPUTER_MAX_FILE_BYTES,
  Math.floor(HOST_COMPUTER_MAX_BYTES / 4) * 3,
);
const file = z.object({
  path: z.string().max(4096),
  content: z.string().max(HOST_COMPUTER_MAX_BYTES),
  executable: z.boolean().optional(),
});
const command = z.object({
  argv: z
    .array(z.string().max(1024 * 1024))
    .min(1)
    .max(1024),
  cwd: z.string().max(4096).optional(),
  env: z.record(z.string(), z.string()).optional(),
  unsetEnv: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
});
const directories = z.discriminatedUnion("action", [
  z.object({ action: z.literal("ensure"), paths: z.array(z.string().max(4096)).max(256) }),
  z.object({ action: z.literal("list") }),
  z.object({
    action: z.literal("remove"),
    parent: z.enum(["bots", ".browser-profiles"]),
    names: z.array(z.string().max(256)).max(256),
  }),
]);
const base = { botId: z.string().min(1).max(256), runId: z.string().min(1).max(256).optional() };
export const hostComputerRequest = z.discriminatedUnion("method", [
  z.object({
    ...base,
    method: z.enum([
      "provision",
      "prepare",
      "isRunning",
      "snapshot",
      "stop",
      "destroy",
      "environment",
    ]),
  }),
  // Fork (1.24): `skipLargeFiles` leaves files over HOST_COMPUTER_MAX_FILE_BYTES out of the export
  // and ends it with one `skippedLarge` frame, instead of failing the whole export. A host that
  // predates the field drops it (unknown keys are stripped) and answers as before.
  z.object({
    ...base,
    method: z.literal("exportWorkspace"),
    skipLargeFiles: z.boolean().optional(),
  }),
  z.object({ ...base, method: z.literal("execute"), command }),
  z.object({ ...base, method: z.literal("workspaceDirectories"), directories }),
  z.object({
    ...base,
    method: z.literal("cancelRunWork"),
    targetRunId: z.string().min(1).max(256),
  }),
  z.object({ ...base, method: z.literal("listFiles"), path: z.string().max(4096) }),
  z.object({
    ...base,
    method: z.literal("readFile"),
    path: z.string().max(4096),
    maxBytes: z.number().int().positive().max(HOST_COMPUTER_MAX_FILE_BYTES).optional(),
  }),
  z.object({ ...base, method: z.literal("writeFile"), file }),
  z.object({ ...base, method: z.literal("screenObserve"), ...hostScreenMethods.screenObserve }),
  z.object({ ...base, method: z.literal("screenAct"), ...hostScreenMethods.screenAct }),
  // The whole display of a host that serves its screen (Linux desktop), like a Docker computer's.
  z.object({ ...base, method: z.literal("displayConnect"), ...hostDisplayMethods.displayConnect }),
  z.object({ ...base, method: z.literal("displayControl"), ...hostDisplayMethods.displayControl }),
  z.object({ ...base, method: z.literal("displayObserve"), ...hostDisplayMethods.displayObserve }),
  z.object({ ...base, method: z.literal("displayInput"), ...hostDisplayMethods.displayInput }),
  z.object({ ...base, method: z.literal("displayAct"), ...hostDisplayMethods.displayAct }),
]);
export type HostComputerRequest = z.infer<typeof hostComputerRequest>;
export interface HostComputerEnvironment {
  platform: string;
  home: string;
  shell: string;
  /** Set when this host serves its whole display (see HostDisplay). */
  display?: boolean;
}
export type HostComputerFrame<T> =
  | { value: T }
  | { done: true }
  | { error: string }
  | { heartbeat: true };

/**
 * The text of the error frame for a file over the size limit. Desktop apps already installed
 * send and read exactly this, so it is the wire format.
 */
export function hostComputerFileTooLargeMessage(maxBytes: number) {
  return `computer file exceeds ${maxBytes} bytes`;
}
/** The limit in a file-too-large error frame, or undefined for any other error frame. */
export function hostComputerFileTooLargeLimit(message: string): number | undefined {
  const limit = /^computer file exceeds (\d+) bytes$/.exec(message)?.[1];
  return limit === undefined ? undefined : Number(limit);
}

/** Leave time for the command timeout event and final response to cross the bridge. */
export function hostComputerDeadlineMs(request: HostComputerRequest) {
  if (request.method === "execute")
    return boundedSandboxCommandTimeoutMs(request.command.timeoutMs) + 30_000;
  return request.method.startsWith("screen") || request.method.startsWith("display")
    ? 2 * 60_000
    : 10 * 60_000;
}

/** Fork (1.24): the last frame of an export that left files over the per-file cap out. */
export type HostExportSkippedFrame = {
  skippedLarge: { count: number; bytes: number; paths: string[] };
};

export function hostExportSkipped(
  frame: unknown,
): HostExportSkippedFrame["skippedLarge"] | undefined {
  if (!frame || typeof frame !== "object" || !("skippedLarge" in frame)) return undefined;
  const value = frame.skippedLarge as { count?: unknown; bytes?: unknown; paths?: unknown } | null;
  if (!value || typeof value.count !== "number" || typeof value.bytes !== "number")
    return undefined;
  const paths = Array.isArray(value.paths)
    ? value.paths.filter((item): item is string => typeof item === "string")
    : [];
  return { count: value.count, bytes: value.bytes, paths };
}
