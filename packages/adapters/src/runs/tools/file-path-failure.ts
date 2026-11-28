import { SandboxFileTooLargeError } from "@rakazo/adapter-kit";
import type { ComputerMode } from "@rakazo/contracts";
import {
  describeBotWorkspaceBase,
  shellPathsEnabled,
  WorkspacePathError,
} from "../../computers/screens/computer-support.js";

/**
 * Fork (1.36): what a file tool tells the model when the path is the problem. A bare "file not
 * found" left the model guessing which folder was searched; this names the path that was tried
 * and the folder it was resolved against, so the next call can be right.
 *
 * Returns undefined for any other failure (the caller keeps its own handling), and always when
 * FILE_TOOL_SHELL_PATHS is off.
 */
export function filePathFailure(
  error: unknown,
  where: { scope: ComputerMode; botId: string; requested: string; stored?: string },
): string | undefined {
  if (!shellPathsEnabled()) return undefined;
  if (error instanceof SandboxFileTooLargeError) return undefined;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const escapes =
    error instanceof WorkspacePathError ||
    (error instanceof Error && error.name === "WorkspacePathError") ||
    /^Path escapes the (?:computer|bot) workspace/.test(message);
  const base = describeBotWorkspaceBase(where.scope, where.botId);
  if (escapes) {
    // The resolver's own refusal already names the path and the base.
    if (message.includes(" resolves to ")) return message;
    return `Path escapes the computer workspace: ${JSON.stringify(where.requested)} was looked up at ${JSON.stringify(where.stored ?? where.requested)} in the computer home, and that path or a link in it leaves the workspace; ${base}`;
  }
  if (!isMissingFile(error, message)) return undefined;
  return `file not found: ${JSON.stringify(where.requested)} was looked up at ${JSON.stringify(where.stored ?? where.requested)} in the computer home; ${base}. Check the folder with list_files or ls before retrying`;
}

function isMissingFile(error: unknown, message: string): boolean {
  if (error && typeof error === "object" && "code" in error) {
    const { code } = error as { code?: unknown };
    if (code === "ENOENT" || code === "ENOTDIR") return true;
  }
  return /computer file not found|no such file or directory|\bENOENT\b|\bENOTDIR\b|not a directory|could not inspect computer file/i.test(
    message,
  );
}
