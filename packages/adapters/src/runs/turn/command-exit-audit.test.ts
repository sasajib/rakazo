import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { beforeEach, describe, expect, it } from "vitest";
import { classifyCommandExit, commandExit, commandExitErrorFields } from "./command-exit-audit.js";
import { redactErrorTail } from "./error-redaction.js";
import { peekRunAudit, recordToolCall, resetRunAudits } from "./run-audit.js";
import { appendToolCompletionAudit, toolCompletionAuditPayload } from "./tool-completion-audit.js";
import { TOOL_ERROR_CLASSES } from "./tool-error-class.js";

const target = { spaceId: "space-1", threadId: "thread-1", botId: "bot-1", runId: "run-1" };
const events = { append: async () => ({}) as never };
let sink: ReturnType<typeof createTestSink>;

beforeEach(() => {
  resetRunAudits();
  sink = createTestSink();
  installLogger(createLogger({ service: "test", sinks: [sink], level: "debug" }));
});

async function logged(name: string, result: unknown, secrets: string[] = []) {
  recordToolCall("run-1", { name, args: { command: "x" }, executionId: "e1" });
  await appendToolCompletionAudit(
    { events },
    target,
    { name, executionId: "e1", durationMs: 12, result },
    secrets,
  );
  return sink.events.find((event) => event.message === "agent.tool.completed");
}

// Fork (1.37): a command that exits non-zero is no longer an `unknown` error with no reason.
describe("agent.tool.completed for a command", () => {
  it("carries the exit code, a real class and the end of stderr for a failed command", async () => {
    const line = await logged("shell", {
      stdout: "collected 3 items\n",
      stderr: `Traceback (most recent call last):\n${"  frame\n".repeat(80)}ModuleNotFoundError: No module named 'yaml'\n`,
      code: 1,
    });
    expect(line).toMatchObject({
      tool: "shell",
      "tool.outcome": "error",
      "tool.exit_code": 1,
      "tool.error_class": "nonzero_exit",
    });
    const message = String(line?.["tool.error_message"]);
    expect(message.endsWith("ModuleNotFoundError: No module named 'yaml'")).toBe(true);
    expect(message.length).toBeLessThanOrEqual(200);
    expect(peekRunAudit("run-1")?.summary().errorsByClass).toEqual({ nonzero_exit: 1 });
  });

  it("reads the same from a wrapped result, and falls back to stdout when stderr is empty", async () => {
    const line = await logged("shell", {
      kind: "agent_tool_result",
      content: [{ type: "text", text: "..." }],
      details: {
        stdout: "FAILED tests/test_a.py::test_one - assert 1 == 2\n",
        stderr: "",
        code: 2,
      },
    });
    expect(line).toMatchObject({
      "tool.exit_code": 2,
      "tool.error_class": "nonzero_exit",
      "tool.error_message": "FAILED tests/test_a.py::test_one - assert 1 == 2",
    });
  });

  it("tells a time limit and a kill from a command's own failure", async () => {
    expect(
      await logged("shell", {
        stdout: "",
        stderr: "command timed out after 120000 ms\n",
        code: 124,
      }),
    ).toMatchObject({ "tool.error_class": "timeout", "tool.exit_code": 124 });
    resetRunAudits();
    sink.events.length = 0;
    expect(
      await logged("shell", { stdout: "", stderr: "command terminated by SIGKILL\n", code: 1 }),
    ).toMatchObject({ "tool.error_class": "killed" });
    expect(classifyCommandExit({ code: 137, stderr: "", stdout: "" })).toBe("killed");
    expect(classifyCommandExit({ code: 130, stderr: "command aborted\n", stdout: "" })).toBe(
      "killed",
    );
    expect(classifyCommandExit({ code: 1, stderr: "grep: no match", stdout: "" })).toBe(
      "nonzero_exit",
    );
    for (const name of ["nonzero_exit", "killed", "timeout"])
      expect(TOOL_ERROR_CLASSES).toContain(name);
  });

  it("logs the exit code of a command that succeeded, and no error fields", async () => {
    const line = await logged("shell", { stdout: "ok\n", stderr: "warning: x\n", code: 0 });
    expect(line).toMatchObject({ "tool.outcome": "succeeded", "tool.exit_code": 0 });
    expect(line).not.toHaveProperty("tool.error_class");
    expect(line).not.toHaveProperty("tool.error_message");
  });

  it("has no exit code for a command still running or a tool that reports none", async () => {
    const running = await logged("shell", { stdout: "", stderr: "", code: null, running: true });
    expect(running).toMatchObject({ "tool.outcome": "succeeded" });
    expect(running).not.toHaveProperty("tool.exit_code");
    expect(commandExit({ ok: true })).toBeUndefined();
    expect(commandExit("text")).toBeUndefined();
  });

  it("keeps a tool's own error ahead of an exit code", async () => {
    const line = await logged("shell", { error: "computer is stopped", code: 1 });
    expect(line).toMatchObject({ "tool.error_message": "computer is stopped" });
    expect(line?.["tool.error_class"]).not.toBe("nonzero_exit");
  });

  it("never logs a secret from the command's output, whole or cut", async () => {
    const secret = "s3cr3t-run-value-1234567890";
    const line = await logged(
      "shell",
      {
        stdout: "",
        stderr: `${"x".repeat(5000)} curl: (22) https://user:hunter2@api.example.com/v1?token=abc123 failed for ana@example.com Authorization: Bearer abcdefghijklmnop password=${secret} exit`,
        code: 22,
      },
      [secret],
    );
    const text = JSON.stringify(line);
    for (const leaked of [secret, "hunter2", "token=abc123", "ana@example.com", "abcdefghijklmnop"])
      expect(text, leaked).not.toContain(leaked);
    expect(String(line?.["tool.error_message"]).endsWith("exit")).toBe(true);
    // The logger has its own filter; the field must be safe before it gets there.
    const direct = commandExitErrorFields(
      {
        code: 22,
        stdout: "",
        stderr: `https://user:hunter2@api.example.com/v1?token=abc123 for ana@example.com Authorization: Bearer abcdefghijklmnop password=${secret} exit`,
      },
      [secret],
    ).message;
    for (const leaked of [secret, "hunter2", "token=abc123", "ana@example.com", "abcdefghijklmnop"])
      expect(direct, leaked).not.toContain(leaked);
    expect(direct.endsWith("exit")).toBe(true);
    expect(classifyCommandExit({ code: 124, stderr: "", stdout: "" })).toBe("timeout");
  });

  it("cuts on a word and drops the half word at the start of a long window", () => {
    const tail = redactErrorTail(`${"a".repeat(300)} ${"word ".repeat(60)}end`);
    expect(tail.length).toBeLessThanOrEqual(200);
    expect(tail.startsWith("word")).toBe(true);
    expect(tail.endsWith("end")).toBe(true);
    // A window that starts inside a long token never shows the token's tail.
    const long = `${"k".repeat(4100)}SECRETTAIL ok`;
    expect(redactErrorTail(long)).toBe("ok");
    // ...also when the rest is short enough to be logged whole.
    expect(redactErrorTail(`${"k".repeat(200)}SECRETTAIL${" ".repeat(3995)}ok`)).toBe("ok");
    expect(redactErrorTail("short reason")).toBe("short reason");
    expect(commandExitErrorFields({ code: 1, stderr: "  \n", stdout: "from stdout" }, [])).toEqual({
      errorClass: "nonzero_exit",
      message: "from stdout",
    });
  });

  it("leaves what the model and the thread event get unchanged", () => {
    const completion = {
      name: "shell",
      executionId: "e1",
      durationMs: 5,
      result: { stdout: "", stderr: "boom", code: 3 },
    };
    expect(toolCompletionAuditPayload(completion)).toEqual({
      name: "shell",
      executionId: "e1",
      durationMs: 5,
      outcome: "error",
    });
  });
});
