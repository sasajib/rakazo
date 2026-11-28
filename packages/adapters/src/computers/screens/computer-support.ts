import { createHash } from "node:crypto";
import path from "node:path";
import type { ComputerAction, ComputerObservation, ComputerRef } from "@rakazo/adapter-kit";
import type { ComputerMode } from "@rakazo/contracts";

export function toComputerRef(computer: {
  homeKey: string;
  kind: string;
  providerRef: string | null;
}): ComputerRef {
  if (!computer.providerRef) throw new Error("computer provider reference is missing");
  return {
    id: computer.providerRef,
    botId: computer.homeKey,
    kind: computer.kind,
    providerRef: computer.providerRef,
  };
}

const EMPTY_PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

export function computerObservation(
  image: Uint8Array,
  input: Omit<ComputerObservation, "frameId" | "capturedAt" | "image">,
): ComputerObservation {
  return {
    ...input,
    image,
    frameId: createHash("sha256").update(image).digest("hex"),
    capturedAt: new Date().toISOString(),
  };
}

export function placeholderObservation(label = "ready"): ComputerObservation {
  return computerObservation(EMPTY_PNG, {
    mimeType: "image/png",
    width: 1,
    height: 1,
    activeWindow: { id: "placeholder", title: label },
  });
}

export function applyPlaceholderAction(box: { screen: string }, action: ComputerAction): void {
  if (action.kind === "clipboard") box.screen = action.text;
  else if (action.kind === "open") box.screen = `opened ${action.path}`;
  else if (action.kind === "launch") box.screen = `launched ${action.application}`;
  else if (action.kind === "focus") box.screen = `focused ${action.application}`;
  else box.screen = action.kind;
}

export function boundedComputerActions(actions: readonly ComputerAction[]): ComputerAction[] {
  if (actions.length > 24) throw new Error("computer action batch exceeds 24 actions");
  return [...actions];
}

export function clampRounded(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), max);
}

/**
 * A path that leaves the folder it must stay in. Not a refusal by itself: the path may be one a
 * provider listed, which is a fault to log. A route that passes a caller's own path answers it.
 */
export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

export function normalizeWorkspacePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
  // "." stays where it is, so "." and "./notes" mean the root and notes; only ".." can leave.
  const segments = normalized.split("/").filter((segment) => segment && segment !== ".");
  if (segments.includes("..")) throw new WorkspacePathError("Path escapes the computer workspace");
  return segments.join("/");
}

/**
 * Bots see the real root in their shell, so a path already under it keeps only its tail
 * instead of nesting the root inside itself.
 */
export function workspaceRelativePath(root: string, value: string): string {
  const normalized = normalizeWorkspacePath(value);
  const rootRelative = normalizeWorkspacePath(root);
  if (!rootRelative) return normalized;
  if (normalized === rootRelative) return "";
  return normalized.startsWith(`${rootRelative}/`)
    ? normalized.slice(rootRelative.length + 1)
    : normalized;
}

export function workspacePath(root: string, relative: string): string {
  const tail = workspaceRelativePath(root, relative);
  return tail ? path.posix.join(root, tail) : root;
}

/** The workspace path bots see on every computer. */
const VIRTUAL_HOME = "/home/rakazo";

/**
 * The directory a command runs in. Empty, ".", "/", the workspace root and any home alias
 * mean the root; absolute paths under one of them keep their tail; anything else is taken
 * relative to the root. ".." segments throw, so a cwd cannot leave the workspace.
 */
export function workspaceCwd(
  root: string,
  cwd: string | undefined,
  homes: readonly string[] = [],
): string {
  if (!cwd || cwd === "." || cwd === "/") return root;
  for (const prefix of [root, VIRTUAL_HOME, ...homes]) {
    if (cwd === prefix) return root;
    if (cwd.startsWith(`${prefix}/`)) return workspacePath(root, cwd.slice(prefix.length + 1));
  }
  return workspacePath(root, cwd);
}

export function teamBotWorkspaceDirectory(botId: string): string {
  return path.posix.join("bots", normalizeWorkspacePath(botId));
}

/**
 * Fork (1.36): file tools take the paths a shell command takes. On unless FILE_TOOL_SHELL_PATHS
 * is "0" (also "false" / "off"), which restores upstream: every ".." is refused.
 */
export function shellPathsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env.FILE_TOOL_SHELL_PATHS ?? "").trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "off");
}

function hasParentSegment(value: string): boolean {
  return /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value);
}

/** "." and ".." resolved by name against `base` (workspace-relative); null above the root. */
function collapseSegments(base: string, value: string): string | null {
  const out = base ? base.split("/") : [];
  for (const segment of value.replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(segment);
  }
  return out.join("/");
}

function isUnder(value: string, directory: string): boolean {
  return value === directory || value.startsWith(`${directory}/`);
}

/** Where a path a bot gave is looked up, in words the bot can act on. */
export function describeBotWorkspaceBase(scope: ComputerMode, botId: string): string {
  return scope === "team"
    ? `relative paths start in your folder ${teamBotWorkspaceDirectory(botId)} (the shell's working directory); shared/... and bots/... start at the computer home, as do paths with a leading / or ~`
    : "paths start at the workspace root (the shell's working directory)";
}

function escapeError(scope: ComputerMode, botId: string, rawPath: string, resolved: string) {
  return new WorkspacePathError(
    `Path escapes the computer workspace: ${JSON.stringify(rawPath)} resolves to ${JSON.stringify(resolved)}; ${describeBotWorkspaceBase(scope, botId)}. ${
      scope === "team"
        ? `A path with ".." may end in your own folder or in shared/ only`
        : `A path may not leave the workspace root`
    }`,
  );
}

/** A real path under the computer's own home directory, as a shell prints it, made root-relative. */
function stripRealWorkspaceRoot(value: string, realRoot: string | undefined): string {
  if (!realRoot) return value;
  const root = realRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!root || root === "/") return value;
  const portable = value.replace(/\\/g, "/");
  if (portable === root) return "/";
  return portable.startsWith(`${root}/`) ? portable.slice(root.length) : value;
}

/**
 * The stored (home-relative) path of a path a bot gave to a file tool or as a shell cwd.
 *
 * Fork (1.36): one resolution for the shell and every file tool. A path the shell can write from
 * its working directory resolves to the same file here: ".." is resolved by name against the
 * folder the shell starts in, and it is accepted when it ends in the bot's own folder or in
 * shared/ (a Team Computer) or inside the workspace (a private one). `realRoot` is the computer
 * home's real path when the provider reports one (a host computer), so an absolute path printed
 * by `pwd` maps back. Everything else that leaves is refused as before, and a link that leaves is
 * still refused by the provider, which checks the real path.
 */
export function resolveBotWorkspacePath(
  scope: ComputerMode,
  botId: string,
  rawPath: string,
  realRoot?: string,
): string {
  const lenient = shellPathsEnabled();
  const requestedPath = expandHomePrefix(
    lenient ? stripRealWorkspaceRoot(rawPath, realRoot) : rawPath,
  );
  const parent = lenient && hasParentSegment(requestedPath);
  if (scope !== "team") {
    if (!parent) return requestedPath;
    const collapsed = collapseSegments("", requestedPath);
    if (collapsed === null) throw escapeError(scope, botId, rawPath, "a folder above the root");
    return /^[\\/]/.test(requestedPath) ? `/${collapsed}` : collapsed;
  }
  const explicitRootPath = stripVirtualWorkspaceRoot(requestedPath);
  if (parent) {
    const botDirectory = teamBotWorkspaceDirectory(botId);
    const first = requestedPath
      .replace(/\\/g, "/")
      .split("/")
      .find((segment) => segment && segment !== ".");
    const fromRoot = explicitRootPath !== null || first === "shared" || first === "bots";
    const collapsed = collapseSegments(
      fromRoot ? "" : botDirectory,
      explicitRootPath ?? requestedPath,
    );
    if (collapsed === null) throw escapeError(scope, botId, rawPath, "a folder above the home");
    if (!isUnder(collapsed, botDirectory) && !isUnder(collapsed, "shared"))
      throw escapeError(scope, botId, rawPath, collapsed || "the computer home");
    return collapsed;
  }
  const normalized = normalizeWorkspacePath(explicitRootPath ?? requestedPath);
  if (explicitRootPath !== null || isTeamRootPath(normalized)) return normalized;
  return path.posix.join(teamBotWorkspaceDirectory(botId), normalized);
}

export function resolveBotWorkspaceCwd(
  scope: ComputerMode,
  botId: string,
  requestedCwd: string | undefined,
): string | undefined {
  if (scope !== "team") {
    if (requestedCwd === undefined) return undefined;
    const expanded = expandHomePrefix(requestedCwd);
    if (expanded === requestedCwd) return requestedCwd;
    return stripVirtualWorkspaceRoot(expanded) || undefined;
  }
  if (!requestedCwd || requestedCwd === ".") return teamBotWorkspaceDirectory(botId);
  if (path.posix.isAbsolute(requestedCwd) || path.win32.isAbsolute(requestedCwd))
    return requestedCwd;
  return resolveBotWorkspacePath(scope, botId, requestedCwd);
}

/** Paths a user may write while controlling this bot: its home, or shared/. */
export function resolveBotUploadPath(
  scope: ComputerMode,
  botId: string,
  requestedPath: string,
): string {
  const stored = resolveBotWorkspacePath(scope, botId, requestedPath);
  if (scope !== "team") return normalizeWorkspacePath(stored);
  const normalized = normalizeWorkspacePath(stored);
  const botDirectory = teamBotWorkspaceDirectory(botId);
  if (
    normalized === botDirectory ||
    normalized.startsWith(`${botDirectory}/`) ||
    normalized === "shared" ||
    normalized.startsWith("shared/")
  ) {
    return normalized;
  }
  throw new WorkspacePathError("Path escapes the bot workspace");
}

export function displayBotWorkspacePath(
  scope: ComputerMode,
  botId: string,
  requestedPath: string,
  storedPath: string,
): string {
  if (scope !== "team" || !isBotRelativeRequest(botId, requestedPath)) return storedPath;
  const normalized = normalizeWorkspacePath(storedPath);
  const botDirectory = teamBotWorkspaceDirectory(botId);
  if (normalized === botDirectory) return "";
  return normalized.startsWith(`${botDirectory}/`)
    ? normalized.slice(botDirectory.length + 1)
    : normalized;
}

function isBotRelativeRequest(botId: string, value: string): boolean {
  if (stripVirtualWorkspaceRoot(expandHomePrefix(value)) !== null) return false;
  // Fork (1.36): a ".." request is shown from the bot's folder only when it ends inside it.
  if (shellPathsEnabled() && hasParentSegment(value)) {
    try {
      return isUnder(
        resolveBotWorkspacePath("team", botId, value),
        teamBotWorkspaceDirectory(botId),
      );
    } catch {
      return false;
    }
  }
  return !isTeamRootPath(normalizeWorkspacePath(value));
}

function isTeamRootPath(value: string): boolean {
  return (
    value === "shared" ||
    value.startsWith("shared/") ||
    value === "bots" ||
    value.startsWith("bots/")
  );
}

// A leading ~ or /home/rakazo means the workspace root, the same as a leading /.
function expandHomePrefix(value: string): string {
  return value.replace(
    /^(?:~|[\\/]home[\\/]rakazo)([\\/]|$)/,
    (_, separator: string) => separator || "/",
  );
}

function stripVirtualWorkspaceRoot(value: string): string | null {
  const portable = value.replace(/\\/g, "/");
  if (portable === "/") return "";
  return portable.startsWith("/") ? portable.slice(1) : null;
}

export { shellQuote } from "@rakazo/core/node/desktop-runtime";
