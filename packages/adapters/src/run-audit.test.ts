import { beforeEach, describe, expect, it } from "vitest";
import {
  argsHash,
  endRunAudit,
  innerToolName,
  noteAutoContinuation,
  noteToolError,
  noteToolRefusal,
  peekRunAudit,
  recordToolCall,
  resetRunAudits,
  toolCallAudit,
  toolCallAuditFields,
} from "./run-audit.js";

beforeEach(() => resetRunAudits());

describe("argsHash", () => {
  it("is a short hex prefix that ignores key order and never contains the arguments", () => {
    const a = argsHash({ id: "x", arguments: { b: 1, a: [1, 2] } });
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(argsHash({ arguments: { a: [1, 2], b: 1 }, id: "x" })).toBe(a);
    expect(argsHash({ id: "x", arguments: { a: [1, 2], b: 2 } })).not.toBe(a);
    expect(a).not.toContain("x");
  });

  it("survives circular and non-JSON values", () => {
    const loop: Record<string, unknown> = { n: 1n };
    loop.self = loop;
    expect(argsHash(loop)).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("attempt counter", () => {
  it("counts identical calls of one tool in one run and times the gap", () => {
    const first = recordToolCall(
      "run-1",
      { name: "shell", args: { cmd: "ls" }, executionId: "e1" },
      1_000,
    );
    const second = recordToolCall(
      "run-1",
      { name: "shell", args: { cmd: "ls" }, executionId: "e2" },
      1_250,
    );
    const third = recordToolCall(
      "run-1",
      { name: "shell", args: { cmd: "ls" }, executionId: "e3" },
      6_250,
    );
    expect([first.attempt, second.attempt, third.attempt]).toEqual([1, 2, 3]);
    expect([first.sinceSameMs, second.sinceSameMs, third.sinceSameMs]).toEqual([null, 250, 5_000]);
    expect(toolCallAudit("run-1", "e2")?.attempt).toBe(2);
  });

  it("does not mix different arguments, different tools or different runs", () => {
    recordToolCall("run-1", { name: "shell", args: { cmd: "ls" }, executionId: "e1" }, 1);
    expect(
      recordToolCall("run-1", { name: "shell", args: { cmd: "pwd" }, executionId: "e2" }, 2)
        .attempt,
    ).toBe(1);
    expect(
      recordToolCall("run-1", { name: "read_file", args: { cmd: "ls" }, executionId: "e3" }, 3)
        .attempt,
    ).toBe(1);
    expect(
      recordToolCall("run-2", { name: "shell", args: { cmd: "ls" }, executionId: "e4" }, 4).attempt,
    ).toBe(1);
  });

  it("counts retries sent in the same millisecond", () => {
    const attempts = [1, 2, 3].map(
      (n) =>
        recordToolCall("run-1", { name: "update_bot", args: {}, executionId: `e${n}` }, 5_000)
          .attempt,
    );
    expect(attempts).toEqual([1, 2, 3]);
    expect(toolCallAudit("run-1", "e3")?.sinceSameMs).toBe(0);
  });

  it("reports an unknown call as null fields", () => {
    expect(toolCallAuditFields(undefined)).toEqual({
      "tool.attempt": null,
      "tool.args_hash": null,
      "tool.since_prev_same_ms": null,
    });
  });
});

describe("generic wrappers", () => {
  it("names the tool or source a wrapper points at, never the query", () => {
    expect(
      innerToolName("installed_execute_tool", { id: "browseros:click", arguments: { a: 1 } }),
    ).toBe("browseros:click");
    expect(innerToolName("installed_load_tool", { id: "gmail:send" })).toBe("gmail:send");
    expect(
      innerToolName("installed_search_tools", { query: "secret words", group: "BrowserOS" }),
    ).toBe("BrowserOS");
    expect(innerToolName("installed_search_tools", { query: "secret words" })).toBeUndefined();
    expect(innerToolName("shell", { id: "x" })).toBeUndefined();
    const audit = recordToolCall("run-1", {
      name: "installed_execute_tool",
      args: { id: "b:c", arguments: {} },
      executionId: "e1",
    });
    expect(toolCallAuditFields(audit)["tool.inner"]).toBe("b:c");
  });
});

describe("run summary counters", () => {
  it("accumulates calls, errors by class, refusals, distinct tools and the max attempt", () => {
    recordToolCall("run-1", { name: "a", args: 1, executionId: "e1" });
    recordToolCall("run-1", { name: "a", args: 1, executionId: "e2" });
    recordToolCall("run-1", { name: "b", args: 1, executionId: "e3" });
    noteToolError("run-1", "timeout");
    noteToolError("run-1", "timeout");
    noteToolError("run-1", "auth");
    noteToolRefusal("run-1");
    noteAutoContinuation("run-1");
    expect(peekRunAudit("run-1")?.summary()).toEqual({
      toolCalls: 3,
      toolErrors: 3,
      errorsByClass: { timeout: 2, auth: 1 },
      refused: 1,
      distinctTools: 2,
      maxAttempt: 2,
      autoContinued: true,
    });
    endRunAudit("run-1");
    expect(peekRunAudit("run-1")).toBeUndefined();
  });

  it("keeps a bounded number of runs", () => {
    for (let n = 0; n < 600; n += 1)
      recordToolCall(`run-${n}`, { name: "a", args: n, executionId: "e" }, n);
    expect(peekRunAudit("run-0")).toBeUndefined();
    expect(peekRunAudit("run-599")).toBeDefined();
  });
});
