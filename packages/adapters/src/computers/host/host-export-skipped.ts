import { getLogger } from "@rakazo/logging";
import { HOST_COMPUTER_MAX_FILE_BYTES } from "./host-computer-protocol.js";

/**
 * Fork (1.24). A home on a host computer is saved through the host protocol, whose frames cap one
 * file at HOST_COMPUTER_MAX_FILE_BYTES. Files over the cap are left out of the save and stay only
 * on that computer's disk. Say so once per computer for each state of things (the same count and
 * bytes are not repeated at every checkpoint), with numbers only: no paths, no contents.
 */
const REPEAT_AFTER_MS = 6 * 60 * 60_000;
const reported = new Map<string, { count: number; bytes: number; at: number }>();

export function reportSkippedLargeFiles(
  computer: { id: string; kind: string },
  skipped: { count: number; bytes: number },
  now = Date.now(),
): boolean {
  if (skipped.count <= 0) return false;
  const last = reported.get(computer.id);
  if (
    last &&
    last.count === skipped.count &&
    last.bytes === skipped.bytes &&
    now - last.at < REPEAT_AFTER_MS
  )
    return false;
  reported.set(computer.id, { ...skipped, at: now });
  getLogger().warn("computer.checkpoint_skipped_large", {
    "computer.id": computer.id,
    provider: computer.kind,
    "files.skipped": skipped.count,
    "files.skipped_bytes": skipped.bytes,
    "file.max_bytes": HOST_COMPUTER_MAX_FILE_BYTES,
  });
  return true;
}

/** Test seam. */
export function forgetSkippedLargeFileReports() {
  reported.clear();
}
