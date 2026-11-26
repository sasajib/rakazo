import { beforeEach, describe, expect, it, vi } from "vitest";
import { hostComputerRequest, hostExportSkipped } from "./host-computer-protocol.js";
import { forgetSkippedLargeFileReports, reportSkippedLargeFiles } from "./host-export-skipped.js";

const warn = vi.hoisted(() => vi.fn());
vi.mock("@rakazo/logging", () => ({ getLogger: () => ({ warn }) }));

const computer = { id: "computer-1", kind: "desktop" };

describe("files a host checkpoint leaves out (fork 1.24)", () => {
  beforeEach(() => {
    warn.mockClear();
    forgetSkippedLargeFileReports();
  });

  it("warns once with count and bytes, and again only when they change or after a while", () => {
    const t0 = 1_000_000;
    expect(reportSkippedLargeFiles(computer, { count: 2, bytes: 30_000_000 }, t0)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("computer.checkpoint_skipped_large", {
      "computer.id": "computer-1",
      provider: "desktop",
      "files.skipped": 2,
      "files.skipped_bytes": 30_000_000,
      "file.max_bytes": 8 * 1024 * 1024,
    });
    // The same state at the next checkpoints is not repeated.
    for (let i = 1; i <= 50; i++)
      expect(
        reportSkippedLargeFiles(computer, { count: 2, bytes: 30_000_000 }, t0 + i * 60_000),
      ).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    // Another file, another computer, or six hours later: said again.
    expect(reportSkippedLargeFiles(computer, { count: 3, bytes: 45_000_000 }, t0 + 1)).toBe(true);
    expect(reportSkippedLargeFiles({ ...computer, id: "computer-2" }, { count: 3, bytes: 1 })).toBe(
      true,
    );
    expect(
      reportSkippedLargeFiles(computer, { count: 3, bytes: 45_000_000 }, t0 + 7 * 60 * 60_000),
    ).toBe(true);
    expect(warn).toHaveBeenCalledTimes(4);
  });

  it("says nothing when nothing was left out", () => {
    expect(reportSkippedLargeFiles(computer, { count: 0, bytes: 0 })).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("tells a skipped-files frame from a file frame", () => {
    expect(hostExportSkipped({ skippedLarge: { count: 1, bytes: 9 } })).toEqual({
      count: 1,
      bytes: 9,
      paths: [],
    });
    expect(
      hostExportSkipped({ skippedLarge: { count: 2, bytes: 9, paths: ["a.bin", 7, "b/c.bin"] } }),
    ).toEqual({ count: 2, bytes: 9, paths: ["a.bin", "b/c.bin"] });
    expect(hostExportSkipped({ path: "a.txt", content: "" })).toBeUndefined();
    expect(hostExportSkipped({ skippedLarge: { count: "1" } })).toBeUndefined();
    expect(hostExportSkipped(null)).toBeUndefined();
  });

  it("accepts the export request with and without the flag", () => {
    const base = { method: "exportWorkspace", botId: "bot-1" };
    expect(hostComputerRequest.safeParse(base).success).toBe(true);
    expect(hostComputerRequest.safeParse({ ...base, skipLargeFiles: true }).data).toMatchObject({
      skipLargeFiles: true,
    });
    // Unknown keys are dropped, which is what lets a host older than the flag answer as before.
    expect(hostComputerRequest.safeParse({ ...base, somethingNewer: 1 }).data).not.toHaveProperty(
      "somethingNewer",
    );
  });
});
