import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { beforeEach, describe, expect, it } from "vitest";
import { peekRunAudit, recordToolCall, resetRunAudits } from "./run-audit.js";
import { appendToolCompletionAudit, logToolRefusal } from "./tool-completion-audit.js";
import { refusal } from "./tool-refusal.js";

const target = { spaceId: "space-1", threadId: "thread-1", botId: "bot-1", runId: "run-1" };
const events = { append: async () => ({}) as never };
let sink: ReturnType<typeof createTestSink>;

beforeEach(() => {
  resetRunAudits();
  sink = createTestSink();
  installLogger(createLogger({ service: "test", sinks: [sink], level: "debug" }));
});

describe("agent.tool.completed audit fields", () => {
  it("adds the error class, a redacted message and the retry counters to a failed call", async () => {
    const args = { id: "browseros:click", arguments: { selector: "#secret-field" } };
    recordToolCall("run-1", { name: "installed_execute_tool", args, executionId: "e1" }, 10_000);
    recordToolCall("run-1", { name: "installed_execute_tool", args, executionId: "e2" }, 10_400);
    await appendToolCompletionAudit(
      { events },
      target,
      {
        name: "installed_execute_tool",
        executionId: "e2",
        durationMs: 30,
        error: new Error(
          "HTTP 503 from https://u:pw@api.example.com/x?token=abc for ana@example.com",
        ),
      },
      [],
    );
    const line = sink.events.find((e) => e.message === "agent.tool.completed");
    expect(line).toMatchObject({
      "run.id": "run-1",
      "bot.id": "bot-1",
      "tool.outcome": "error",
      "tool.error_class": "upstream_5xx",
      "tool.attempt": 2,
      "tool.since_prev_same_ms": 400,
      "tool.inner": "browseros:click",
    });
    const text = JSON.stringify(line);
    expect(line?.["tool.error_message"]).toContain("HTTP 503");
    expect(text).not.toContain("pw@");
    expect(text).not.toContain("token=abc");
    expect(text).not.toContain("ana@example.com");
    expect(text).not.toContain("#secret-field");
    expect(line?.["tool.args_hash"]).toMatch(/^[0-9a-f]{12}$/);
    expect(peekRunAudit("run-1")?.summary().errorsByClass).toEqual({ upstream_5xx: 1 });
  });

  it("logs attempt fields but no error fields for a success", async () => {
    recordToolCall("run-1", { name: "shell", args: { cmd: "ls" }, executionId: "e1" });
    await appendToolCompletionAudit(
      { events },
      target,
      {
        name: "shell",
        executionId: "e1",
        durationMs: 5,
        result: { kind: "agent_tool_result", content: [], details: {} },
      },
      [],
    );
    const line = sink.events.find((e) => e.message === "agent.tool.completed");
    expect(line).toMatchObject({
      "tool.outcome": "succeeded",
      "tool.attempt": 1,
      "tool.since_prev_same_ms": null,
    });
    expect(line).not.toHaveProperty("tool.error_class");
  });

  it("classifies a refused disabled tool and counts the refusal", async () => {
    const audit = recordToolCall("run-1", { name: "update_bot", args: {}, executionId: "e1" });
    logToolRefusal(
      { ...target, trigger: "talk" },
      "update_bot",
      refusal("tool_disabled", "This tool is disabled for this bot."),
      [],
      undefined,
      audit,
    );
    await appendToolCompletionAudit(
      { events },
      target,
      {
        name: "update_bot",
        executionId: "e1",
        durationMs: 0,
        result: { error: "This tool is disabled for this bot." },
      },
      [],
    );
    const refused = sink.events.find((e) => e.message === "agent.tool.refused");
    expect(refused).toMatchObject({ "tool.refusal": "tool_disabled", "tool.attempt": 1 });
    const completed = sink.events.find((e) => e.message === "agent.tool.completed");
    expect(completed?.["tool.error_class"]).toBe("tool_disabled");
    expect(peekRunAudit("run-1")?.summary().refused).toBe(1);
  });
});
