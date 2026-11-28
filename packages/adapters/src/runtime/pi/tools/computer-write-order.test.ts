import { describe, expect, it } from "vitest";
import { computerWritesInOrderEnabled, writesComputerFiles } from "./computer-write-order.js";

describe("tools that change files on the computer run in the order written (fork 1.36)", () => {
  it("names the writers, not the readers", () => {
    for (const name of ["shell", "write_file", "render_plot"])
      expect(writesComputerFiles(name, {}), name).toBe(true);
    for (const name of ["read_file", "list_files", "attach_file", "web_search", "message_bot"])
      expect(writesComputerFiles(name, {}), name).toBe(false);
  });

  it("is on unless COMPUTER_WRITES_IN_ORDER switches it off", () => {
    expect(computerWritesInOrderEnabled({})).toBe(true);
    expect(computerWritesInOrderEnabled({ COMPUTER_WRITES_IN_ORDER: "" })).toBe(true);
    expect(computerWritesInOrderEnabled({ COMPUTER_WRITES_IN_ORDER: "1" })).toBe(true);
    for (const off of ["0", "false", " Off "]) {
      expect(computerWritesInOrderEnabled({ COMPUTER_WRITES_IN_ORDER: off })).toBe(false);
      expect(writesComputerFiles("shell", { COMPUTER_WRITES_IN_ORDER: off })).toBe(false);
    }
  });
});
