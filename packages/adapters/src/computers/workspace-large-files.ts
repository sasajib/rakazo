/**
 * Fork (FORK.md 1.24): files a workspace export leaves out because the transport cannot carry
 * them (the host protocol caps one file at 8 MiB).
 *
 * Before, one such file failed the whole export, so nothing of the home was saved
 * (`computer.checkpoint_deferred`, every time). Now the export goes on without it and tells the
 * save which paths it left out: an entry marked `omitted`. The save keeps the version of that
 * file it stored earlier, if it has one (a file that GREW past the cap is not dropped from the
 * saved copy), and stores everything else as usual. The file itself stays on its computer.
 */
import { constants } from "node:fs";
import { copyFile, lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import type { PortableFile, StreamedPortableFile } from "@rakazo/adapter-kit";
import { normalizeWorkspacePath } from "./screens/computer-support.js";

/** A file the export did not carry. `content` is empty; never write it as the file. */
export type OmittedPortableFile = PortableFile & { omitted: "too_large" };

export function omittedLargeFile(filePath: string): OmittedPortableFile {
  return { path: filePath, content: new Uint8Array(0), omitted: "too_large" };
}

export function isOmittedLargeFile(
  file: PortableFile | StreamedPortableFile,
): file is OmittedPortableFile {
  return "omitted" in file && file.omitted === "too_large";
}

/**
 * Copies the earlier saved version of `filePath` from `savedRoot` into the staging directory of
 * the save in progress. Returns its size, or undefined when there is none to keep (never saved,
 * not a regular file, or outside the root).
 */
export async function keepSavedVersion(
  savedRoot: string,
  stagingRoot: string,
  filePath: string,
): Promise<number | undefined> {
  let relative: string;
  try {
    relative = normalizeWorkspacePath(filePath);
  } catch {
    // A path that leaves the workspace names nothing the save holds; it must not fail the save.
    return undefined;
  }
  if (!relative) return undefined;
  const source = contained(savedRoot, relative);
  const target = contained(stagingRoot, relative);
  if (!source || !target) return undefined;
  const info = await lstat(source).catch(() => undefined);
  // A link is not followed: the saved copy holds files only.
  if (!info?.isFile()) return undefined;
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(source, target, constants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  return info.size;
}

function contained(root: string, relative: string): string | undefined {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relative);
  return target.startsWith(`${resolvedRoot}${path.sep}`) ? target : undefined;
}
