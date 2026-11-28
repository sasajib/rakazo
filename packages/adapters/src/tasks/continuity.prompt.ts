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

/**
 * A3: what "open work" is and what the platform does with it. Given to every run; the part about
 * items only where the run has the scratchpad tools.
 */
export function openWorkClause(
  keepsItems: boolean,
  config: Pick<ContinuityConfig, "continueOpenWork"> = continuityConfig(),
): string | undefined {
  if (!config.continueOpenWork) return undefined;
  const honest =
    "Never end a run by saying you are continuing, or that you will do something next, unless that work is really going on: running in a subagent or a background job, scheduled, or kept as an open item. Otherwise do it in this run.";
  if (!keepsItems) return honest;
  return `For work in several parts, keep one scratchpad item (status open) per part that is still yours to do in this chat, and complete each one when it is done. When a run of yours ends with such an item open and nothing else is going to wake you (no subagent, background job, schedule, card or request pending), the platform starts you again to do the next one, so a long job finishes without the person asking. An item that waits on a person or an outside event is parked, with the reason in its notes: parked items start nothing. ${honest}`;
}

/** The scratchpad block's opening line about waking, true to the switch. */
export function scratchpadWakeLine(
  config: Pick<ContinuityConfig, "continueOpenWork"> = continuityConfig(),
): string {
  return config.continueOpenWork
    ? "This list is not a scheduler: no clock wakes you up."
    : "This list is not a scheduler — it does not wake you.";
}
