import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isOmittedLargeFile, keepSavedVersion, omittedLargeFile } from "./workspace-large-files.js";

describe("files a workspace export leaves out (fork 1.24)", () => {
  let root: string;
  let saved: string;
  let staging: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "rakazo-large-files-"));
    saved = path.join(root, "saved");
    staging = path.join(root, "staging");
    await mkdir(path.join(saved, "work"), { recursive: true });
    await mkdir(staging, { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("marks an omitted file so it is never written as an empty one", () => {
    const file = omittedLargeFile("work/video.bin");
    expect(isOmittedLargeFile(file)).toBe(true);
    expect(file.content.byteLength).toBe(0);
    expect(isOmittedLargeFile({ path: "a.txt", content: new Uint8Array(1) })).toBe(false);
  });

  it("keeps the version saved earlier, in the same place", async () => {
    await writeFile(path.join(saved, "work/result.bin"), "earlier version");
    expect(await keepSavedVersion(saved, staging, "work/result.bin")).toBe(15);
    expect(await readFile(path.join(staging, "work/result.bin"), "utf8")).toBe("earlier version");
  });

  it("keeps nothing for a file never saved, a link, or a path outside the saved copy", async () => {
    await writeFile(path.join(root, "outside.txt"), "not yours");
    await symlink(path.join(root, "outside.txt"), path.join(saved, "work/link.bin"));
    expect(await keepSavedVersion(saved, staging, "work/never-saved.bin")).toBeUndefined();
    expect(await keepSavedVersion(saved, staging, "work/link.bin")).toBeUndefined();
    expect(await keepSavedVersion(saved, staging, "../outside.txt")).toBeUndefined();
    expect(await keepSavedVersion(saved, staging, "")).toBeUndefined();
  });
});
