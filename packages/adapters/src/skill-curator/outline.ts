/**
 * Fork: what the curator is shown of a run's work: one line per tool call with its name, a short
 * summary of its arguments and how it ended. Arguments were already redacted when the reply kept
 * them (keptToolArguments: the run's secrets and credential-like keys); they are bounded again
 * here and anything still shaped like a secret is dropped.
 */
import { holdsSecret } from "../memory-ledger/text.js";

export interface OutlineStep {
  n: number;
  tool: string;
  label: string;
  args?: string;
  outcome?: string;
}

export const OUTLINE_MAX_STEPS = 40;
const ARGS_MAX_CHARS = 240;

export interface ReplyLike {
  toolCalls: ReadonlyArray<{ label: string; executionId: string; tool?: string }>;
  toolOutcomes: ReadonlyMap<string, string>;
  toolStepCalls: ReadonlyMap<string, { arguments?: string | undefined }>;
}

function argsSummary(raw: string | undefined): string | undefined {
  if (!raw || raw === "{}") return undefined;
  const flat = raw.replace(/\s+/g, " ").trim();
  if (holdsSecret(flat)) return "[arguments hidden]";
  return flat.length > ARGS_MAX_CHARS ? `${flat.slice(0, ARGS_MAX_CHARS - 1)}…` : flat;
}

export function toolOutline(reply: ReplyLike): OutlineStep[] {
  const seen = new Set<string>();
  const steps: OutlineStep[] = [];
  for (const call of reply.toolCalls) {
    // One call can show as several steps (a connector's sub-steps); keep it once.
    const key = `${call.executionId}:${call.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const args = argsSummary(reply.toolStepCalls.get(call.executionId)?.arguments);
    const outcome = reply.toolOutcomes.get(call.executionId);
    steps.push({
      n: steps.length + 1,
      tool: call.tool ?? call.label,
      label: call.label,
      ...(args ? { args } : {}),
      ...(outcome ? { outcome } : {}),
    });
    if (steps.length >= OUTLINE_MAX_STEPS) break;
  }
  return steps;
}

/** Skills the run opened with skill_read, by name or id, from the outline. */
export function skillsReadIn(outline: readonly OutlineStep[]): string[] {
  const names: string[] = [];
  for (const step of outline) {
    if (step.tool !== "skill_read" || !step.args) continue;
    try {
      const args = JSON.parse(step.args) as { name?: unknown; skillId?: unknown };
      for (const value of [args.name, args.skillId])
        if (typeof value === "string" && value.trim()) names.push(value.trim());
    } catch {
      const match = /"(?:name|skillId)"\s*:\s*"([^"]+)"/.exec(step.args);
      if (match?.[1]) names.push(match[1]);
    }
  }
  return names;
}
