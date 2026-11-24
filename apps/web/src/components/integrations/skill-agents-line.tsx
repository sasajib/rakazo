import { Trans } from "@lingui/react/macro";
import { skipToken, useQuery } from "@tanstack/react-query";
import { useSpaceQueries } from "../../lib/query/query";

/** Fork: under a skill in the Skills window, the agents that can use it (per-agent skills). */
export function SkillAgentsLine({ skillId }: { skillId: string }) {
  const queries = useSpaceQueries();
  // Hand-written test clients may lack this fork procedure; then the line is left out.
  const procedure = queries.agentSkills.agents as typeof queries.agentSkills.agents | undefined;
  const agents = useQuery(
    procedure
      ? { ...procedure.queryOptions(), refetchOnMount: "always" }
      : { queryKey: ["skill-agents-unavailable"], queryFn: skipToken },
  ).data as Array<{ skillId: string; bots: Array<{ id: string; name: string }> }> | undefined;
  if (!agents) return null;
  const bots = agents.find((entry) => entry.skillId === skillId)?.bots ?? [];
  const names = bots.map((bot) => bot.name).join(", ");
  return (
    <div className="mt-1 text-body-sm text-muted-foreground" data-testid="skill-agents" dir="auto">
      {bots.length === 0 ? (
        <Trans>No agent uses this skill</Trans>
      ) : (
        <Trans>Used by: {names}</Trans>
      )}
    </div>
  );
}
