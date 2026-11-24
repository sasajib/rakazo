import type { AgentSteeringMessage } from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "../runs/executor/executor-deps.js";
import { jobSteeringText } from "./shell-job.prompt.js";
import { claimFinishedShellJobs } from "./shell-job-poll.js";
import { runMayStartShellJobs, shellJobConfig } from "./shell-job-rules.js";

/**
 * Delivery into a run that is still working: wraps the run's steering claim so that, at each
 * later turn boundary, the results of this bot's jobs in this thread that ended meanwhile join the
 * next model request, like a message that arrived mid-task. The claim is the same once-only
 * `returnedAt` stamp the poller uses, so a result is either steered here or woken there, never
 * both. The run's first claim (folded into its prompt as "additional user context") never takes a
 * job: a result must not read as the user's words.
 */
export function withShellJobSteering(
  deps: Pick<ExecutorDeps, "prisma" | "sandbox" | "jobs" | "events" | "secretStore">,
  input: { runId: string; trigger: string; threadId: string; botId: string; secrets: string[] },
  claim: (seenIds: string[]) => Promise<AgentSteeringMessage[]>,
): (seenIds: string[]) => Promise<AgentSteeringMessage[]> {
  if (!shellJobConfig().enabled || !runMayStartShellJobs(input.trigger)) return claim;
  let first = true;
  return async (seenIds) => {
    const steering = await claim(seenIds);
    if (first) {
      first = false;
      return steering;
    }
    const results = await claimFinishedShellJobs(deps, input).catch((error: unknown) => {
      getLogger().warn("shell_job.steer_failed", {
        "run.id": input.runId,
        error: error instanceof Error ? error.message.slice(0, 200) : "claim failed",
      });
      return [];
    });
    if (results.length === 0) return steering;
    return [
      ...steering,
      ...results.map(
        (result): AgentSteeringMessage => ({
          id: `shell-job:${result.jobId}`,
          messageId: `shell-job:${result.jobId}`,
          origin: "job",
          text: jobSteeringText(result),
        }),
      ),
    ];
  };
}
