import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveBotWorkspaceCwd,
  resolveBotWorkspacePath,
  workspacePath,
} from "../../computers/screens/computer-support.js";
import { DesktopSandboxProvider } from "../../providers/computer/desktop/desktop-sandbox.js";
import { FakeSandboxProvider } from "../../providers/computer/fake/fake-sandbox.js";
import type { RunContext } from "../assembly/run-context.js";
import type { ToolCall } from "./run-tool-gate.js";

vi.mock("./run-tools-computer.js", () => ({ recordComputerAction: vi.fn(async () => undefined) }));

const { fileTools, readWorkspaceFile } = await import("./run-tools-files.js");

/**
 * Fork (1.36). A path a shell command reaches from its working directory must reach the same
 * file through every file tool, on every computer provider; anything outside the bot's folder
 * and shared/ stays refused, by name and through a link.
 */
const BOT = "bot-1";
const context = {
  operationId: "op",
  traceId: "trace",
  spaceId: "space-1",
  userId: "user-1",
  signal: new AbortController().signal,
} as AdapterContext;

let root: string;
let previous: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "file-tool-paths-"));
  previous = process.env.FILE_TOOL_SHELL_PATHS;
  delete process.env.FILE_TOOL_SHELL_PATHS;
});

afterEach(async () => {
  if (previous === undefined) delete process.env.FILE_TOOL_SHELL_PATHS;
  else process.env.FILE_TOOL_SHELL_PATHS = previous;
  await rm(root, { recursive: true, force: true });
});

function tools(sandbox: SandboxProvider, computer: ComputerRef, realRoot?: string) {
  const ctx = {
    bot: { id: BOT },
    run: { spaceId: "space-1" },
    computer: {
      stored: { id: "computer-1", kind: computer.kind },
      kind: computer.kind,
      mode: "team",
      // Ready, so nothing is read from a stopped disk.
      lazy: { ready: true },
      get: async () => computer,
      checkpoint: { markDirty: () => undefined },
      modelSeesImages: false,
      hostEnvironment: realRoot ? { workspace: realRoot } : undefined,
    },
    context,
    deps: { sandbox, artifacts: {} },
    secrets: [],
  } as unknown as RunContext;
  const call = (name: string, args: Record<string, unknown>) =>
    ({ name, args, executionId: "exec-1", finish: async (value: unknown) => value }) as ToolCall;
  return {
    read: (file: string) => fileTools.read_file!(ctx, call("read_file", { path: file })),
    list: (file: string) => fileTools.list_files!(ctx, call("list_files", { path: file })),
    write: (file: string, content: string) =>
      fileTools.write_file!(ctx, call("write_file", { path: file, content })),
    attach: (file: string) => readWorkspaceFile(ctx, call("attach_file", { path: file }), file),
  };
}

/** Runs a command the way the shell tool does: in the bot's folder unless a cwd is given. */
async function shell(provider: DesktopSandboxProvider, computer: ComputerRef, command: string) {
  let code: number | undefined;
  let stdout = "";
  for await (const event of provider.execute(
    computer,
    { argv: ["sh", "-c", command], cwd: resolveBotWorkspaceCwd("team", BOT, undefined) },
    context,
  )) {
    if (event.type === "exit") code = event.code;
    if (event.type === "stdout") stdout += event.data;
  }
  expect(code).toBe(0);
  return stdout.trim();
}

async function desktop() {
  const provider = new DesktopSandboxProvider({ root });
  const computer = await provider.provision({ botId: "home-1", homePath: "" }, context);
  const home = computer.providerRef as string;
  await mkdir(path.join(home, "bots", BOT), { recursive: true });
  await mkdir(path.join(home, "shared"), { recursive: true });
  return { provider, computer, home };
}

describe("a path the shell reaches is the same file in every file tool (host and desktop)", () => {
  it("reads, lists, attaches and writes ../../shared/... exactly where the shell put it", async () => {
    const { provider, computer, home } = await desktop();
    await shell(
      provider,
      computer,
      "mkdir -p ../../shared/skills-ext/demo book && printf rule > ../../shared/skills-ext/demo/SKILL.md && printf ch1 > book/ch1.md",
    );
    const file = tools(provider, computer);

    // The shared folder, spelled as the workspace instruction teaches it for the shell.
    await expect(file.read("../../shared/skills-ext/demo/SKILL.md")).resolves.toMatchObject({
      content: "rule",
    });
    await expect(file.list("../../shared/skills-ext")).resolves.toMatchObject({
      entries: [expect.objectContaining({ path: "shared/skills-ext/demo", kind: "dir" })],
    });
    const attached = await file.attach("../../shared/skills-ext/demo/SKILL.md");
    expect(attached).toHaveProperty("bytes");
    await expect(file.write("../../shared/out.md", "written")).resolves.toMatchObject({ ok: true });
    await expect(shell(provider, computer, "cat ../../shared/out.md")).resolves.toBe("written");
    expect(await readFile(path.join(home, "shared", "out.md"), "utf8")).toBe("written");

    // The bot's own folder: relative, with a detour, and the documented shared/ form.
    await expect(file.read("book/ch1.md")).resolves.toMatchObject({ content: "ch1" });
    await expect(file.read("book/../book/./ch1.md")).resolves.toMatchObject({ content: "ch1" });
    await expect(file.read("shared/out.md")).resolves.toMatchObject({ content: "written" });
  });

  it("maps an absolute path printed by pwd back into the workspace", async () => {
    const { provider, computer, home } = await desktop();
    const printed = await shell(provider, computer, "printf here > a.txt && pwd");
    expect(printed).toBe(path.join(home, "bots", BOT));
    const file = tools(provider, computer, home);
    await expect(file.read(`${printed}/a.txt`)).resolves.toMatchObject({ content: "here" });
    await expect(file.read(`${home}/shared/../bots/${BOT}/a.txt`)).resolves.toMatchObject({
      content: "here",
    });
    // Without the provider's real root the same path is not found, and the error says where it looked.
    const blind = await tools(provider, computer).read(`${printed}/a.txt`);
    expect(blind).toMatchObject({ error: expect.stringContaining("file not found") });
  });

  it("refuses a path that leaves by name, and says what it resolved to and from where", async () => {
    const { provider, computer, home } = await desktop();
    await writeFile(path.join(root, "outside.txt"), "secret");
    await mkdir(path.join(home, "bots", "bot-2"), { recursive: true });
    await writeFile(path.join(home, "bots", "bot-2", "private.txt"), "secret");
    const file = tools(provider, computer, home);

    for (const leaving of [
      "../../../outside.txt",
      "../../../../../../../../etc/passwd",
      "shared/../../outside.txt",
      "~/../outside.txt",
      `${root}/outside.txt`,
      "/etc/passwd",
    ]) {
      const result = (await file.read(leaving)) as { error?: string; content?: string };
      expect(result.content, leaving).toBeUndefined();
      expect(result.error, leaving).toMatch(/Path escapes the computer workspace|file not found/);
      const attached = await file.attach(leaving);
      expect(attached, leaving).not.toHaveProperty("bytes");
    }
    // ".." may end in the bot's own folder or shared/, never in another bot's folder.
    const other = (await file.read("../bot-2/private.txt")) as { error?: string };
    expect(other.error).toContain("Path escapes the computer workspace");
    expect(other.error).toContain('"../bot-2/private.txt" resolves to "bots/bot-2/private.txt"');
    expect(other.error).toContain(`your folder bots/${BOT}`);
    const written = (await file.write("../../../planted.txt", "x")) as { error?: string };
    expect(written.error).toContain("Path escapes the computer workspace");
    await expect(readFile(path.join(root, "planted.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses a link that leaves the workspace, in the bot folder and in shared/", async () => {
    const { provider, computer, home } = await desktop();
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(outside, path.join(home, "bots", BOT, "link"));
    await symlink(path.join(outside, "secret.txt"), path.join(home, "shared", "leak.txt"));
    const file = tools(provider, computer, home);

    for (const linked of ["link/secret.txt", "../../shared/leak.txt", "shared/leak.txt"]) {
      const result = (await file.read(linked)) as { error?: string; content?: string };
      expect(result.content, linked).toBeUndefined();
      expect(result.error, linked).toContain("Path escapes the computer workspace");
      expect(result.error, linked).toContain("a link in it leaves the workspace");
      expect(await file.attach(linked), linked).not.toHaveProperty("bytes");
    }
    await expect(file.write("link/planted.txt", "x")).resolves.toMatchObject({
      error: expect.stringContaining("Path escapes the computer workspace"),
    });
    await expect(readFile(path.join(outside, "planted.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("names the path it tried and the folder it started from when a file is missing", async () => {
    const { provider, computer } = await desktop();
    const file = tools(provider, computer);
    const missing = (await file.read("book/ch9.md")) as { error?: string; path?: string };
    expect(missing.path).toBe("book/ch9.md");
    expect(missing.error).toContain(
      `"book/ch9.md" was looked up at "bots/${BOT}/book/ch9.md" in the computer home`,
    );
    expect(missing.error).toContain(`relative paths start in your folder bots/${BOT}`);
    await expect(file.list("nope")).resolves.toMatchObject({
      error: expect.stringContaining(`"bots/${BOT}/nope"`),
    });
    await expect(file.attach("nope.png")).resolves.toMatchObject({
      error: expect.stringContaining(`"bots/${BOT}/nope.png"`),
    });
  });

  it("FILE_TOOL_SHELL_PATHS=0 restores the old refusal and the old words", async () => {
    const { provider, computer } = await desktop();
    await shell(provider, computer, "printf rule > ../../shared/rule.md");
    process.env.FILE_TOOL_SHELL_PATHS = "0";
    const file = tools(provider, computer);
    await expect(file.read("../../shared/rule.md")).rejects.toThrow(
      /^Path escapes the computer workspace$/,
    );
    await expect(file.attach("../../shared/rule.md")).resolves.toEqual({
      error: "file not found or unreadable",
    });
  });
});

describe("the same resolution on the other providers", () => {
  it("fake computer: the shared file is one file under both spellings", async () => {
    const provider = new FakeSandboxProvider();
    const computer = await provider.provision({ botId: "home-1", homePath: "" }, context);
    const file = tools(provider, computer);
    await expect(file.write("../../shared/brief.md", "brief")).resolves.toMatchObject({ ok: true });
    await expect(file.read("shared/brief.md")).resolves.toMatchObject({ content: "brief" });
    await expect(file.read("../../shared/brief.md")).resolves.toMatchObject({ content: "brief" });
    await expect(file.read("../../../etc/passwd")).resolves.toMatchObject({
      error: expect.stringContaining("Path escapes the computer workspace"),
    });
    await expect(file.read("gone.md")).resolves.toMatchObject({
      error: expect.stringContaining(`"bots/${BOT}/gone.md"`),
    });
  });

  it("container computers: the stored path is the file the shell's relative path names", () => {
    const WORKSPACE = "/home/rakazo";
    const cwd = workspacePath(WORKSPACE, resolveBotWorkspaceCwd("team", BOT, undefined) ?? "");
    for (const spelled of ["../../shared/a/b.md", "notes/../x.md", "./x.md", "shared/a/b.md"]) {
      const stored = resolveBotWorkspacePath("team", BOT, spelled);
      const fromShell = spelled.startsWith("shared/")
        ? path.posix.join(WORKSPACE, spelled)
        : path.posix.resolve(cwd, spelled);
      expect(workspacePath(WORKSPACE, stored), spelled).toBe(fromShell);
    }
    // A cwd with ".." lands where `cd` would.
    expect(resolveBotWorkspaceCwd("team", BOT, "../../shared/site")).toBe("shared/site");
  });
});
