import type { MemoryPromptBudget } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { endRunAudit, peekRunAudit, runAudit } from "./run-audit.js";
import type { RunLogTarget, ToolExposure } from "./run-audit-log.js";
import {
  buildPromptManifest,
  logMemoryPromptBuilt,
  logPromptManifest,
  logRunAuditSummary,
  promptSections,
  runAuditSummaryFields,
} from "./run-audit-log.js";

/**
 * `memory.prompt.built` and `run.prompt_manifest`, once per run: a run resumed after an approval
 * runs another attempt in the same process and does not log them again.
 */
export function logPromptAudit(
  target: RunLogTarget,
  input: {
    trigger: string;
    model?: { provider?: string; id?: string } | null;
    sections: ReadonlyArray<readonly [string, string | null | undefined]>;
    tools: ToolExposure;
    memoryPlan: MemoryPromptBudget | undefined;
  },
): void {
  const audit = runAudit(target.runId);
  if (audit.promptLogged) return;
  audit.promptLogged = true;
  logMemoryPromptBuilt(target, input.memoryPlan);
  logPromptManifest(
    target,
    buildPromptManifest({
      trigger: input.trigger,
      model: input.model,
      sections: promptSections(input.sections),
      tools: input.tools,
    }),
  );
}

/**
 * `run.audit_summary` is written once, when the run's terminal outcome is saved. A completed run
 * first goes through the one-shot "announced work, used no tool" continuation check, and the
 * summary says whether that fired, so the summary of a completed run waits for the check
 * (`holdAuditSummary` … `releaseAuditSummary`). Failed runs are summarised at once.
 */
export function holdAuditSummary(runId: string, held = true): void {
  const audit = peekRunAudit(runId);
  if (audit) audit.summaryHeld = held;
}

/** Called after a run's terminal outcome was saved (never for a fenced-out attempt). */
export async function onRunFinalized(
  prisma: PrismaClient,
  target: RunLogTarget,
  outcome: string,
): Promise<void> {
  const audit = peekRunAudit(target.runId);
  if (!audit) return;
  if (audit.summaryHeld && outcome === "completed") {
    audit.finalized = { outcome, at: Date.now() };
    return;
  }
  await writeSummary(prisma, target, outcome);
}

/** The continuation check is over: write a held summary, and stop holding. */
export async function releaseAuditSummary(
  prisma: PrismaClient,
  target: RunLogTarget,
): Promise<void> {
  const audit = peekRunAudit(target.runId);
  if (!audit) return;
  audit.summaryHeld = false;
  const finalized = audit.finalized;
  if (!finalized) return;
  audit.finalized = undefined;
  await writeSummary(prisma, target, finalized.outcome);
}

async function writeSummary(
  prisma: PrismaClient,
  target: RunLogTarget,
  outcome: string,
): Promise<void> {
  const audit = peekRunAudit(target.runId);
  if (!audit) return;
  try {
    const run = await prisma.run.findUnique({
      where: { id: target.runId },
      select: {
        trigger: true,
        createdAt: true,
        firstResponseAt: true,
        completedAt: true,
        sourceMessage: { select: { createdAt: true } },
      },
    });
    // Measured from the message that asked, as `run.finished` does.
    const origin = run ? (run.sourceMessage?.createdAt ?? run.createdAt) : undefined;
    const since = (end: Date | null | undefined) =>
      origin && end ? Math.max(0, end.getTime() - origin.getTime()) : null;
    logRunAuditSummary(
      target,
      runAuditSummaryFields(audit.summary(), {
        outcome,
        ...(run ? { trigger: run.trigger } : {}),
        firstResponseMs: since(run?.firstResponseAt),
        totalMs: since(run?.completedAt),
      }),
    );
  } catch (error) {
    getLogger().warn("run.audit_summary_failed", { "run.id": target.runId, error });
  } finally {
    endRunAudit(target.runId);
  }
}
