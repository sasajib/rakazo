/**
 * Fork (FORK.md 1.33): what an agent is told about long-task continuity, so it reports the truth:
 * a result run can delegate, extra helpers queue by themselves, and "I am continuing" is only said
 * about work that is really going on.
 */
import type { ContinuityConfig } from "./continuity-config.js";
import { continuityConfig } from "./continuity-config.js";

/** Added to the run_subagent guidance of a run that may delegate. */
export function delegationContinuityClause(
  config: Pick<ContinuityConfig, "delegateFromAnyRun" | "queueHelpers"> = continuityConfig(),
): string {
  return [
    config.delegateFromAnyRun
      ? " Every run of yours can delegate, also the one that receives a subagent's result: when the task needs more subagents, start them there instead of waiting for the person."
      : "",
    config.queueHelpers
      ? " When you ask for more than can work at once, the extra ones are queued and start by themselves as the others finish; do not ask for the same one again."
      : "",
  ].join("");
}
