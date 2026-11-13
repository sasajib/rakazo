import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { beforeEach, describe, expect, it } from "vitest";
import { AGENT_MEMORY_MAX_BYTES, buildAgentMemoryPrompt } from "./memory-context.js";
import { noteAutoContinuation, recordToolCall, resetRunAudits } from "./run-audit.js";
import {
  buildPromptManifest,
  hashPrefix,
  logMemorySave,
  logRunAuditSummary,
  memoryPromptFields,
  memoryRefusalReason,
  memorySaveOp,
  promptSections,
  runAuditSummaryFields,
} from "./run-audit-log.js";
import {
  holdAuditSummary,
  logPromptAudit,
  onRunFinalized,
  releaseAuditSummary,
} from "./run-audit-run.js";

const target = { runId: "run-1", spaceId: "space-1", threadId: "thread-1", botId: "bot-1" };
let sink: ReturnType<typeof createTestSink>;

beforeEach(() => {
  resetRunAudits();
  sink = createTestSink();
  installLogger(createLogger({ service: "test", sinks: [sink], level: "debug" }));
});

describe("prompt manifest", () => {
  it("carries sizes and fingerprints of each section, never their text", () => {
    const sections = promptSections([
      ["bot_instructions", "Be brief. SECRET-RULE"],
      ["memory_block", undefined],
      ["skills_list", "héllo"],
    ]);
    expect(sections).toEqual([
      { name: "bot_instructions", bytes: 21, sha256: hashPrefix("Be brief. SECRET-RULE") },
      { name: "memory_block", bytes: 0, sha256: null },
      { name: "skills_list", bytes: 6, sha256: hashPrefix("héllo") },
    ]);
    const manifest = buildPromptManifest({
      trigger: "user",
      model: { provider: "openai", id: "gpt-x" },
      sections,
      tools: { exposed: 12, deferred: 340 },
    });
    expect(manifest).toMatchObject({
      "run.trigger": "user",
      "model.id": "gpt-x",
      "tools.exposed": 12,
      "tools.deferred": 340,
    });
    expect(JSON.stringify(manifest)).not.toContain("SECRET-RULE");
    expect(hashPrefix("x")).toMatch(/^[0-9a-f]{12}$/);
  });

  it("logs once per run with the correlation fields", () => {
    const input = {
      trigger: "user",
      model: { id: "m" },
      sections: [["bot_instructions", "abc"]] as const,
      tools: { exposed: 1, deferred: null },
      memoryPlan: undefined,
    };
    logPromptAudit(target, input);
    logPromptAudit(target, input);
    const manifests = sink.events.filter((e) => e.message === "run.prompt_manifest");
    expect(manifests).toHaveLength(1);
    expect(manifests[0]).toMatchObject({
      "run.id": "run-1",
      "bot.id": "bot-1",
      "thread.id": "thread-1",
      "space.id": "space-1",
      "tools.deferred": null,
    });
    expect(sink.events.filter((e) => e.message === "memory.prompt.built")).toHaveLength(1);
  });
});

describe("memory.prompt.built fields", () => {
  it("lists each document with included and truncated, against the prompt limit", () => {
    const { plan } = buildAgentMemoryPrompt(
      [
        {
          scope: "bot",
          path: "MEMORY.md",
          revision: 2,
          updatedAt: "2026-11-13T00:00:00Z",
          content: "a".repeat(100),
        },
        {
          scope: "user",
          path: "rules.md",
          revision: 1,
          updatedAt: "2026-11-12T00:00:00Z",
          content: "b".repeat(500),
        },
        {
          scope: "user",
          path: "big.md",
          revision: 1,
          updatedAt: "2026-11-11T00:00:00Z",
          content: "c".repeat(900),
        },
      ],
      1_000,
    );
    const fields = memoryPromptFields(plan);
    const docs = fields["memory.documents"] as Array<Record<string, unknown>>;
    expect(docs.map((d) => [d.path, d.included, d.truncated])).toEqual([
      ["MEMORY.md", true, false],
      ["rules.md", true, false],
      ["big.md", true, true],
    ]);
    expect(fields["memory.limit_bytes"]).toBe(1_000);
    expect(fields["memory.over_limit"]).toBe(true);
    expect(JSON.stringify(fields)).not.toContain("aaaa");
  });

  it("marks documents that did not fit as not included, and reports a skipped block", () => {
    const { plan } = buildAgentMemoryPrompt(
      [
        {
          scope: "bot",
          path: "MEMORY.md",
          revision: 1,
          updatedAt: "2026-11-13T00:00:00Z",
          content: "x".repeat(2_000),
        },
        {
          scope: "user",
          path: "late.md",
          revision: 1,
          updatedAt: "2026-11-01T00:00:00Z",
          content: "y",
        },
      ],
      1_000,
    );
    const docs = memoryPromptFields(plan)["memory.documents"] as Array<Record<string, unknown>>;
    expect(docs.find((d) => d.path === "late.md")).toMatchObject({
      included: false,
      included_bytes: 0,
    });
    expect(memoryPromptFields(undefined)).toMatchObject({
      "memory.skipped": true,
      "memory.limit_bytes": AGENT_MEMORY_MAX_BYTES,
    });
  });
});

describe("memory.save", () => {
  it("classifies the edit and the refusal", () => {
    expect(memorySaveOp("fact", "")).toBe("add");
    expect(memorySaveOp("new", "old")).toBe("replace");
    expect(memorySaveOp("", "old")).toBe("remove");
    expect(memoryRefusalReason("Memory is full (4096 bytes). Make room")).toBe("cap_exceeded");
    expect(memoryRefusalReason("old_text matches more than one entry. Quote more")).toBe(
      "ambiguous_match",
    );
    expect(memoryRefusalReason("No entry contains old_text.")).toBe("no_match");
  });

  it("warns on a refusal with the reason and the cap, informs on success", () => {
    logMemorySave(target, {
      op: "add",
      bytesBefore: 4_000,
      bytesAfter: 4_000,
      capBytes: 4_096,
      attempt: 1,
      reason: "cap_exceeded",
    });
    logMemorySave(target, {
      op: "add",
      bytesBefore: 100,
      bytesAfter: 150,
      capBytes: 4_096,
      attempt: 1,
    });
    expect(sink.events.map((e) => [e.level, e.message])).toEqual([
      ["warn", "memory.save"],
      ["info", "memory.save"],
    ]);
    expect(sink.events[0]).toMatchObject({
      "bot.id": "bot-1",
      "memory.op": "add",
      "memory.reason": "cap_exceeded",
      "memory.cap_bytes": 4_096,
      "memory.ok": false,
    });
    expect(sink.events[1]).toMatchObject({ "memory.ok": true, "memory.bytes_after": 150 });
  });
});

describe("run.audit_summary", () => {
  it("builds the fields from the counters and timing", () => {
    recordToolCall("run-1", { name: "a", args: 1, executionId: "e1" });
    noteAutoContinuation("run-1");
    const fields = runAuditSummaryFields(
      {
        toolCalls: 1,
        toolErrors: 0,
        errorsByClass: {},
        refused: 0,
        distinctTools: 1,
        maxAttempt: 1,
        autoContinued: true,
      },
      { outcome: "completed", firstResponseMs: 1200, totalMs: 4000 },
    );
    logRunAuditSummary(target, fields);
    expect(sink.events[0]).toMatchObject({
      message: "run.audit_summary",
      "run.id": "run-1",
      "audit.tool_calls": 1,
      "audit.auto_continued": true,
      "audit.first_response_ms": 1200,
      "audit.total_ms": 4000,
    });
  });

  const prisma = {
    run: {
      findUnique: async () => ({
        trigger: "user",
        createdAt: new Date(1_000),
        firstResponseAt: new Date(3_000),
        completedAt: new Date(7_000),
        sourceMessage: null,
      }),
    },
  };

  it("waits for the continuation check on a completed run, then reports whether it fired", async () => {
    recordToolCall("run-1", { name: "a", args: 1, executionId: "e1" });
    holdAuditSummary("run-1");
    await onRunFinalized(prisma as never, target, "completed");
    expect(sink.events.filter((e) => e.message === "run.audit_summary")).toHaveLength(0);
    noteAutoContinuation("run-1");
    await releaseAuditSummary(prisma as never, target);
    const [summary] = sink.events.filter((e) => e.message === "run.audit_summary");
    expect(summary).toMatchObject({
      "audit.auto_continued": true,
      "audit.first_response_ms": 2_000,
      "audit.total_ms": 6_000,
      "run.trigger": "user",
    });
  });

  it("summarises a failed run at once, and writes nothing for a run it never tracked", async () => {
    recordToolCall("run-1", { name: "a", args: 1, executionId: "e1" });
    holdAuditSummary("run-1");
    await onRunFinalized(prisma as never, target, "failed");
    expect(sink.events.filter((e) => e.message === "run.audit_summary")).toHaveLength(1);
    await onRunFinalized(prisma as never, { ...target, runId: "other" }, "completed");
    expect(sink.events.filter((e) => e.message === "run.audit_summary")).toHaveLength(1);
  });
});
