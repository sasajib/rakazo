import { redactErrorTail } from "./error-redaction.js";
import type { ToolErrorClass } from "./tool-error-class.js";

/**
 * Fork (1.37): what the audit log says about a command that ran and exited non-zero.
 *
 * Such a call is logged with outcome `error` (upstream's rule: the tool returned, the command
 * failed), but its result carries no `error`, so the line had class `unknown` and an empty
 * message: 59 of them in 35 hours, none readable. The result does carry the exit code and the
 * command's own last words; this reads them. What the model sees is not changed.
 */
export interface CommandExit {
  code: number;
  stderr: string;
  stdout: string;
}

/** The exit code and streams of a command result, from the result itself or its `details`. */
export function commandExit(result: unknown): CommandExit | undefined {
  for (const value of [result, (result as { details?: unknown } | null)?.details]) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const code = typeof record.code === "number" ? record.code : record.exitCode;
    if (typeof code !== "number" || !Number.isFinite(code)) continue;
    return {
      code,
      stderr: typeof record.stderr === "string" ? record.stderr : "",
      stdout: typeof record.stdout === "string" ? record.stdout : "",
    };
  }
  return undefined;
}

/** Exit codes `timeout(1)` and the computer providers use for a command stopped at its time limit. */
const TIMEOUT_EXIT_CODES = new Set([124]);

/**
 * `timeout` when the command was stopped at its time limit, `killed` when a signal or a
 * cancellation ended it (128 + signal, or the provider's own note), otherwise `nonzero_exit`:
 * the command ran to its end and reported failure itself (`grep` with no match, a failing test).
 */
export function classifyCommandExit(exit: CommandExit): ToolErrorClass {
  const said = exit.stderr.slice(-400).toLowerCase();
  if (TIMEOUT_EXIT_CODES.has(exit.code) || /\bcommand timed out after \d+ ?ms\b/.test(said))
    return "timeout";
  if (
    exit.code > 128 ||
    exit.code < 0 ||
    /\bcommand (?:aborted|terminated by sig[a-z0-9]+)\b/.test(said)
  )
    return "killed";
  return "nonzero_exit";
}

/** The log fields for a failed command: its class and the end of what it wrote, made safe. */
export function commandExitErrorFields(
  exit: CommandExit,
  secrets: readonly string[],
): { errorClass: ToolErrorClass; message: string } {
  // stderr says why; a command that wrote none (a test runner, `grep`) leaves stdout's end.
  const words = exit.stderr.trim() ? exit.stderr : exit.stdout;
  return { errorClass: classifyCommandExit(exit), message: redactErrorTail(words, secrets) };
}
