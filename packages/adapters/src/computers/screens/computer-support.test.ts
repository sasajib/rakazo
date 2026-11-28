import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  displayBotWorkspacePath,
  resolveBotUploadPath,
  resolveBotWorkspaceCwd,
  resolveBotWorkspacePath,
  shellPathsEnabled,
  teamBotWorkspaceDirectory,
  workspaceCwd,
  workspacePath,
} from "./computer-support.js";
import { teamWorkspaceInstruction } from "./computer-support.prompt.js";

describe("workspaceCwd", () => {
  const root = "/home/user/rakazo-home";

  it("maps empty, '.', '/', the root and home aliases to the root", () => {
    for (const cwd of [undefined, "", ".", "/", root, "/home/rakazo", "/home/user"]) {
      expect(workspaceCwd(root, cwd, ["/home/user"])).toBe(root);
    }
  });

  it("keeps paths inside the root, a home alias or the bot-visible home", () => {
    expect(workspaceCwd(root, `${root}/notes/a`, ["/home/user"])).toBe(`${root}/notes/a`);
    expect(workspaceCwd(root, "/home/rakazo/notes", ["/home/user"])).toBe(`${root}/notes`);
    expect(workspaceCwd(root, "/home/user/notes", ["/home/user"])).toBe(`${root}/notes`);
    expect(workspaceCwd(root, "notes/a")).toBe(`${root}/notes/a`);
    expect(workspaceCwd(root, "/etc")).toBe(`${root}/etc`);
  });

  it("rejects '..' segments, including under an absolute workspace path", () => {
    for (const cwd of [
      `${root}/../etc`,
      `${root}/notes/../../..`,
      "/home/rakazo/../etc",
      "/home/user/../../etc",
      "../etc",
      "notes/./../..",
    ]) {
      expect(() => workspaceCwd(root, cwd, ["/home/user"])).toThrow(
        "Path escapes the computer workspace",
      );
    }
  });
});

describe("workspacePath", () => {
  it("keeps only the tail of a path already under the workspace root", () => {
    const root = "/home/user/rakazo-home";
    expect(workspacePath(root, `${root}/shared/x.md`)).toBe(`${root}/shared/x.md`);
    expect(
      workspacePath(root, resolveBotWorkspacePath("team", "bot-1", `${root}/shared/x.md`)),
    ).toBe(`${root}/shared/x.md`);
  });
});

describe("Team Computer bot folders", () => {
  it("uses the bot folder for relative paths and cwd", () => {
    expect(teamBotWorkspaceDirectory("bot-1")).toBe("bots/bot-1");
    expect(resolveBotWorkspacePath("team", "bot-1", "notes/result.txt")).toBe(
      "bots/bot-1/notes/result.txt",
    );
    expect(resolveBotWorkspacePath("team", "bot-1", "")).toBe("bots/bot-1");
    expect(resolveBotWorkspacePath("team", "bot-1", ".")).toBe("bots/bot-1");
    expect(resolveBotWorkspacePath("team", "bot-1", "./notes/./x.md")).toBe(
      "bots/bot-1/notes/x.md",
    );
    expect(resolveBotWorkspaceCwd("team", "bot-1", undefined)).toBe("bots/bot-1");
    expect(resolveBotWorkspaceCwd("team", "bot-1", "projects/site")).toBe(
      "bots/bot-1/projects/site",
    );
    expect(resolveBotWorkspaceCwd("team", "bot-1", "/Users/me/project")).toBe("/Users/me/project");
  });

  it("reads a leading ~ in a dedicated computer's shell cwd as the workspace root", () => {
    const root = "/workspace";
    const cwd = (requested: string | undefined) =>
      workspaceCwd(root, resolveBotWorkspaceCwd("dedicated", "bot-1", requested));
    expect(cwd("~")).toBe(root);
    expect(cwd("~/src")).toBe(`${root}/src`);
    expect(cwd("src")).toBe(`${root}/src`);
    expect(cwd(undefined)).toBe(root);
    expect(cwd("~user/src")).toBe(`${root}/~user/src`);
  });

  it("hands a dedicated computer's provider a relative cwd for a home alias", () => {
    const requested = (cwd: string) => resolveBotWorkspaceCwd("dedicated", "bot-1", cwd);
    expect(requested("~")).toBeUndefined();
    expect(requested("~/")).toBeUndefined();
    expect(requested("~/src")).toBe("src");
  });

  it("tells the bot how its shell reaches the same shared folder as the file tools", () => {
    const shellDefaultCwd = resolveBotWorkspaceCwd("team", "bot-1", undefined) ?? "";
    const sharedForFileTools = resolveBotWorkspacePath("team", "bot-1", "shared/report.xlsx");
    const instruction = teamWorkspaceInstruction("bot-1");
    const shellPath = instruction.match(/(\.\.\/)+shared\//)?.[0];
    expect(shellPath).toBeDefined();
    expect(path.posix.join(shellDefaultCwd, `${shellPath}report.xlsx`)).toBe(sharedForFileTools);
    expect(instruction).toContain("shell cwd of shared");
    expect(resolveBotWorkspaceCwd("team", "bot-1", "shared")).toBe("shared");
  });

  it("preserves Windows absolute working directories even when the backend runs on Linux", () => {
    const drive = String.raw`C:\Users\example\project`;
    const share = String.raw`\\server\share\project`;
    expect(resolveBotWorkspaceCwd("team", "bot-1", drive)).toBe(drive);
    expect(resolveBotWorkspaceCwd("team", "bot-1", share)).toBe(share);
  });

  it("keeps shared, bot-root, and absolute paths at the Team root", () => {
    expect(resolveBotWorkspacePath("team", "bot-1", "shared/brief.md")).toBe("shared/brief.md");
    expect(resolveBotWorkspacePath("team", "bot-1", "bots/bot-2/result.md")).toBe(
      "bots/bot-2/result.md",
    );
    expect(resolveBotWorkspacePath("team", "bot-1", "/root-note.md")).toBe("root-note.md");
    expect(resolveBotWorkspacePath("team", "bot-1", "/shared/brief.md")).toBe("shared/brief.md");
  });

  it("treats a leading ~ as the workspace root", () => {
    expect(resolveBotWorkspacePath("team", "bot-1", "~")).toBe("");
    expect(resolveBotWorkspacePath("team", "bot-1", "~/notes/x.md")).toBe("notes/x.md");
    expect(resolveBotWorkspacePath("team", "bot-1", "~\\notes\\x.md")).toBe("notes/x.md");
    expect(resolveBotWorkspacePath("team", "bot-1", "~/shared/brief.md")).toBe("shared/brief.md");
    expect(resolveBotWorkspacePath("dedicated", "bot-1", "~/notes/x.md")).toBe("/notes/x.md");
    expect(resolveBotWorkspacePath("team", "bot-1", "~x/y")).toBe("bots/bot-1/~x/y");
    expect(() => resolveBotWorkspacePath("team", "bot-1", "~/../x")).toThrow(
      "Path escapes the computer workspace",
    );
  });

  it("keeps root paths for a listing requested under ~", () => {
    expect(displayBotWorkspacePath("team", "bot-1", "~/bots", "bots/bot-1")).toBe("bots/bot-1");
  });

  it("treats a leading /home/rakazo as the workspace root", () => {
    expect(resolveBotWorkspacePath("team", "bot-1", "/home/rakazo")).toBe("");
    expect(resolveBotWorkspacePath("team", "bot-1", "/home/rakazo/notes/x.md")).toBe("notes/x.md");
    expect(resolveBotWorkspacePath("team", "bot-1", String.raw`\home\rakazo\notes\x.md`)).toBe(
      "notes/x.md",
    );
    expect(resolveBotWorkspacePath("team", "bot-1", "/home/rakazo/shared/brief.md")).toBe(
      "shared/brief.md",
    );
    expect(resolveBotWorkspacePath("dedicated", "bot-1", "/home/rakazo/notes/x.md")).toBe(
      "/notes/x.md",
    );
    expect(resolveBotWorkspacePath("dedicated", "bot-1", "/home/rakazo")).toBe("/");
    expect(resolveBotWorkspacePath("dedicated", "bot-1", String.raw`\home\rakazo\notes\x.md`)).toBe(
      String.raw`\notes\x.md`,
    );
    expect(resolveBotWorkspacePath("team", "bot-1", "/home/rakazotest/file.txt")).toBe(
      "home/rakazotest/file.txt",
    );
    expect(() => resolveBotWorkspacePath("team", "bot-1", "/home/rakazo/../x")).toThrow(
      "Path escapes the computer workspace",
    );
  });

  it("keeps root paths for a listing requested under /home/rakazo", () => {
    expect(displayBotWorkspacePath("team", "bot-1", "/home/rakazo/bots", "bots/bot-1")).toBe(
      "bots/bot-1",
    );
  });

  it("presents the current bot folder as its home without hiding Team paths", () => {
    expect(displayBotWorkspacePath("team", "bot-1", "notes", "bots/bot-1/notes/result.txt")).toBe(
      "notes/result.txt",
    );
    expect(displayBotWorkspacePath("team", "bot-1", "shared", "shared/brief.md")).toBe(
      "shared/brief.md",
    );
    expect(displayBotWorkspacePath("team", "bot-1", "bots", "bots/bot-1")).toBe("bots/bot-1");
    expect(displayBotWorkspacePath("team", "bot-1", "/", "bots/bot-1")).toBe("bots/bot-1");
    expect(
      displayBotWorkspacePath("team", "bot-1", "bots/bot-1", "bots/bot-1/notes/result.txt"),
    ).toBe("bots/bot-1/notes/result.txt");
  });

  it("leaves Private Computer paths unchanged", () => {
    expect(resolveBotWorkspacePath("dedicated", "bot-1", "notes/result.txt")).toBe(
      "notes/result.txt",
    );
    expect(resolveBotWorkspaceCwd("dedicated", "bot-1", undefined)).toBeUndefined();
    expect(displayBotWorkspacePath("dedicated", "bot-1", "notes", "notes/result.txt")).toBe(
      "notes/result.txt",
    );
  });
});

describe("resolveBotUploadPath", () => {
  it("keeps team uploads in the controlling bot home or shared", () => {
    expect(resolveBotUploadPath("team", "bot-1", "notes.txt")).toBe("bots/bot-1/notes.txt");
    expect(resolveBotUploadPath("team", "bot-1", "shared/brief.md")).toBe("shared/brief.md");
    expect(() => resolveBotUploadPath("team", "bot-1", "bots/bot-2/secret.txt")).toThrow(
      /escapes the bot workspace/,
    );
  });
});

// Fork (1.36): one path resolution for the shell and the file tools.
describe("a path with .. resolves the way the shell resolves it", () => {
  it("ends in the bot's folder or in shared/ on a Team Computer", () => {
    expect(resolveBotWorkspacePath("team", "bot-1", "../../shared/skills/x/SKILL.md")).toBe(
      "shared/skills/x/SKILL.md",
    );
    expect(resolveBotWorkspacePath("team", "bot-1", String.raw`..\..\shared\a.md`)).toBe(
      "shared/a.md",
    );
    expect(resolveBotWorkspacePath("team", "bot-1", "book/../notes/./a.md")).toBe(
      "bots/bot-1/notes/a.md",
    );
    expect(resolveBotWorkspacePath("team", "bot-1", "../bot-1/a.md")).toBe("bots/bot-1/a.md");
    expect(resolveBotWorkspacePath("team", "bot-1", "shared/site/../brief.md")).toBe(
      "shared/brief.md",
    );
    expect(resolveBotWorkspacePath("team", "bot-1", "/bots/bot-1/x/../a.md")).toBe(
      "bots/bot-1/a.md",
    );
    expect(resolveBotWorkspacePath("team", "bot-1", "~/shared/x/../a.md")).toBe("shared/a.md");
    expect(resolveBotWorkspaceCwd("team", "bot-1", "../../shared/site")).toBe("shared/site");
  });

  it("refuses every other place, naming what the path resolved to and the base", () => {
    for (const [given, resolved] of [
      ["../bot-2/a.md", "bots/bot-2/a.md"],
      ["../../.config/x", ".config/x"],
      ["../..", "the computer home"],
      ["../../..", "a folder above the home"],
      ["shared/../../x", "a folder above the home"],
      ["bots/bot-1/../bot-2/a.md", "bots/bot-2/a.md"],
    ] as const) {
      expect(() => resolveBotWorkspacePath("team", "bot-1", given), given).toThrow(
        `Path escapes the computer workspace: ${JSON.stringify(given)} resolves to ${JSON.stringify(resolved)}; relative paths start in your folder bots/bot-1`,
      );
    }
  });

  it("stays inside the root of a private workspace", () => {
    expect(resolveBotWorkspacePath("dedicated", "bot-1", "notes/../a.md")).toBe("a.md");
    expect(resolveBotWorkspacePath("dedicated", "bot-1", "/notes/../a.md")).toBe("/a.md");
    expect(() => resolveBotWorkspacePath("dedicated", "bot-1", "../a.md")).toThrow(
      'Path escapes the computer workspace: "../a.md" resolves to "a folder above the root"',
    );
  });

  it("maps the computer home's real path back, and nothing beside it", () => {
    const real = "/srv/computers/abc";
    expect(resolveBotWorkspacePath("team", "bot-1", `${real}/bots/bot-1/a.md`, real)).toBe(
      "bots/bot-1/a.md",
    );
    expect(resolveBotWorkspacePath("team", "bot-1", `${real}/shared/a.md`, `${real}/`)).toBe(
      "shared/a.md",
    );
    expect(resolveBotWorkspacePath("team", "bot-1", real, real)).toBe("");
    expect(resolveBotWorkspacePath("dedicated", "bot-1", `${real}/a.md`, real)).toBe("/a.md");
    // A sibling folder with the same prefix is not the home.
    expect(resolveBotWorkspacePath("team", "bot-1", `${real}x/a.md`, real)).toBe(
      "srv/computers/abcx/a.md",
    );
    expect(() => resolveBotWorkspacePath("team", "bot-1", `${real}/../other/a.md`, real)).toThrow(
      "Path escapes the computer workspace",
    );
  });

  it("shows a listing from the bot's folder only when the .. request ends inside it", () => {
    expect(displayBotWorkspacePath("team", "bot-1", "book/..", "bots/bot-1/notes")).toBe("notes");
    expect(displayBotWorkspacePath("team", "bot-1", "../../shared", "shared/site")).toBe(
      "shared/site",
    );
  });

  it("FILE_TOOL_SHELL_PATHS switches it off", () => {
    expect(shellPathsEnabled({})).toBe(true);
    expect(shellPathsEnabled({ FILE_TOOL_SHELL_PATHS: "1" })).toBe(true);
    expect(shellPathsEnabled({ FILE_TOOL_SHELL_PATHS: " Off " })).toBe(false);
    const previous = process.env.FILE_TOOL_SHELL_PATHS;
    process.env.FILE_TOOL_SHELL_PATHS = "0";
    try {
      expect(() => resolveBotWorkspacePath("team", "bot-1", "../../shared/a.md")).toThrow(
        /^Path escapes the computer workspace$/,
      );
      expect(resolveBotWorkspacePath("dedicated", "bot-1", "notes/../a.md")).toBe("notes/../a.md");
      expect(resolveBotWorkspacePath("team", "bot-1", "/srv/c/a.md", "/srv/c")).toBe("srv/c/a.md");
    } finally {
      if (previous === undefined) delete process.env.FILE_TOOL_SHELL_PATHS;
      else process.env.FILE_TOOL_SHELL_PATHS = previous;
    }
  });
});
