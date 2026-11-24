import { createHash } from "node:crypto";
import type { ToolErrorClass } from "./tool-error-class.js";

/** What the audit log says about one tool call, never its arguments. */
export interface ToolCallAudit {
  /** 1-based: how many calls of this tool with identical arguments this run has made, this one included. */
  attempt: number;
  /** Short sha256 prefix of the canonical arguments. */
  argsHash: string;
  /** Milliseconds since the previous call of this tool with identical arguments; null for the first. */
  sinceSameMs: number | null;
  /** The tool or server a generic wrapper (`installed_execute_tool`, …) was pointed at. */
  inner?: string;
}

export interface RunAuditSummary {
  toolCalls: number;
  toolErrors: number;
  errorsByClass: Partial<Record<ToolErrorClass, number>>;
  refused: number;
  distinctTools: number;
  maxAttempt: number;
  autoContinued: boolean;
}

const ARGS_HASH_CHARS = 12;
const MAX_TRACKED_RUNS = 500;
const MAX_CALLS_PER_RUN = 2_000;
const TRACKER_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** Wrappers whose own arguments only name the tool or source they stand for. */
const CATALOG_WRAPPER = /(?:^|_)(search|load|execute)_tool(s)?$/;

function canonical(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint") return `${value}n`;
    if (typeof value === "function" || typeof value === "symbol") return undefined;
    return value;
  }
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => canonical(item, seen) ?? null);
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const item = canonical(record[key], seen);
    if (item !== undefined) sorted[key] = item;
  }
  return sorted;
}

/** Short sha256 prefix of the arguments with keys sorted, so key order never changes the hash. */
export function argsHash(args: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(canonical(args)) ?? "null";
  } catch {
    text = "unserializable";
  }
  return createHash("sha256").update(text).digest("hex").slice(0, ARGS_HASH_CHARS);
}

/**
 * Which tool or source a catalog wrapper call targets: the `id` of a load/execute call, the
 * `group` of a search. Never the query or the wrapped arguments. Other tools have no inner name.
 */
export function innerToolName(tool: string, args: unknown): string | undefined {
  if (!CATALOG_WRAPPER.test(tool) || !args || typeof args !== "object") return undefined;
  const record = args as { id?: unknown; group?: unknown };
  const target = typeof record.id === "string" ? record.id : record.group;
  return typeof target === "string" && target.trim() ? target.trim().slice(0, 120) : undefined;
}

class RunAudit {
  readonly startedAt: number;
  private readonly calls = new Map<string, ToolCallAudit>();
  private readonly seen = new Map<string, { count: number; lastAt: number }>();
  private readonly tools = new Set<string>();
  private toolCalls = 0;
  private toolErrors = 0;
  private refused = 0;
  private maxAttempt = 0;
  private autoContinued = false;
  private readonly errorsByClass: Partial<Record<ToolErrorClass, number>> = {};
  /** The summary waits for the end-of-run continuation check; see `holdSummary`. */
  summaryHeld = false;
  promptLogged = false;
  finalized: { outcome: string; at: number } | undefined;

  constructor(now: number) {
    this.startedAt = now;
  }

  recordCall(
    call: { name: string; args: unknown; executionId: string },
    now: number,
  ): ToolCallAudit {
    const hash = argsHash(call.args);
    const key = `${call.name}\n${hash}`;
    const previous = this.seen.get(key);
    const audit: ToolCallAudit = {
      attempt: (previous?.count ?? 0) + 1,
      argsHash: hash,
      sinceSameMs: previous ? Math.max(0, now - previous.lastAt) : null,
      ...(innerToolName(call.name, call.args)
        ? { inner: innerToolName(call.name, call.args)! }
        : {}),
    };
    this.seen.set(key, { count: audit.attempt, lastAt: now });
    this.tools.add(call.name);
    this.toolCalls += 1;
    this.maxAttempt = Math.max(this.maxAttempt, audit.attempt);
    if (this.calls.size >= MAX_CALLS_PER_RUN) {
      const oldest = this.calls.keys().next().value;
      if (oldest !== undefined) this.calls.delete(oldest);
    }
    this.calls.set(call.executionId, audit);
    return audit;
  }

  audit(executionId: string): ToolCallAudit | undefined {
    return this.calls.get(executionId);
  }

  noteError(errorClass: ToolErrorClass): void {
    this.toolErrors += 1;
    this.errorsByClass[errorClass] = (this.errorsByClass[errorClass] ?? 0) + 1;
  }

  noteRefusal(): void {
    this.refused += 1;
  }

  noteContinuation(): void {
    this.autoContinued = true;
  }

  summary(): RunAuditSummary {
    return {
      toolCalls: this.toolCalls,
      toolErrors: this.toolErrors,
      errorsByClass: { ...this.errorsByClass },
      refused: this.refused,
      distinctTools: this.tools.size,
      maxAttempt: this.maxAttempt,
      autoContinued: this.autoContinued,
    };
  }
}

/** Per-process, per-run counters. Bounded, and dropped when the run's summary is written. */
const runs = new Map<string, RunAudit>();

export function runAudit(runId: string, now = Date.now()): RunAudit {
  let audit = runs.get(runId);
  if (!audit) {
    for (const [id, old] of runs) {
      if (runs.size < MAX_TRACKED_RUNS && now - old.startedAt < TRACKER_MAX_AGE_MS) break;
      runs.delete(id);
    }
    audit = new RunAudit(now);
    runs.set(runId, audit);
  }
  return audit;
}

export function peekRunAudit(runId: string): RunAudit | undefined {
  return runs.get(runId);
}

export function endRunAudit(runId: string): void {
  runs.delete(runId);
}

/** Records one tool call as the run makes it, and returns what the logs may say about it. */
export function recordToolCall(
  runId: string,
  call: { name: string; args: unknown; executionId: string },
  now = Date.now(),
): ToolCallAudit {
  return runAudit(runId, now).recordCall(call, now);
}

export function toolCallAudit(runId: string, executionId: string): ToolCallAudit | undefined {
  return runs.get(runId)?.audit(executionId);
}

export function noteToolError(runId: string, errorClass: ToolErrorClass): void {
  runs.get(runId)?.noteError(errorClass);
}

export function noteToolRefusal(runId: string): void {
  runs.get(runId)?.noteRefusal();
}

export function noteAutoContinuation(runId: string): void {
  runs.get(runId)?.noteContinuation();
}

/** Test seam: forget every tracked run. */
export function resetRunAudits(): void {
  runs.clear();
}

/** The log fields for a tool call's audit, shared by `agent.tool.completed` and `agent.tool.refused`. */
export function toolCallAuditFields(audit: ToolCallAudit | undefined): Record<string, unknown> {
  return {
    "tool.attempt": audit?.attempt ?? null,
    "tool.args_hash": audit?.argsHash ?? null,
    "tool.since_prev_same_ms": audit?.sinceSameMs ?? null,
    ...(audit?.inner ? { "tool.inner": audit.inner } : {}),
  };
}
