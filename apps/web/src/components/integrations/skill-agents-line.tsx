import { Trans } from "@lingui/react/macro";
import { skipToken, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useInRouterContext, useSearchParams } from "react-router-dom";
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

/**
 * Fork: under a skill the skill curator wrote, where it came from (agent, date, how often it was
 * updated since). Nothing for skills the owner wrote himself.
 */
export function LearnedSkillLine({ skillId }: { skillId: string }) {
  const queries = useSpaceQueries();
  const procedure = queries.skillLearning?.learned as
    | typeof queries.skillLearning.learned
    | undefined;
  const learned = useQuery(
    procedure
      ? { ...procedure.queryOptions(), refetchOnMount: "always" }
      : { queryKey: ["learned-skills-unavailable"], queryFn: skipToken },
  ).data as
    | Array<{
        skillId: string;
        botName: string | null;
        taught: boolean;
        patches: number;
        createdAt: string;
      }>
    | undefined;
  const row = learned?.find((entry) => entry.skillId === skillId);
  if (!row) return null;
  const who = row.botName ?? "an agent";
  const when = new Date(row.createdAt).toLocaleDateString();
  const patches = row.patches;
  return (
    <div className="mt-1 text-body-sm text-muted-foreground" data-testid="skill-learned" dir="auto">
      {row.taught ? (
        <Trans>
          Learned by {who} from your lesson on {when}
        </Trans>
      ) : (
        <Trans>
          Learned by {who} from your work on {when}
        </Trans>
      )}
      {patches > 0 ? (
        <>
          {" · "}
          <Trans>updated {patches} times since</Trans>
        </>
      ) : null}
    </div>
  );
}

/** Opens the skill a link named with ?skill=<id>, once, then drops the parameter. */
export function LinkedSkillOpener({ onOpen }: { onOpen: (skillId: string) => void }) {
  // Hand-rendered tests have no router; without one there is no link to follow.
  return useInRouterContext() ? <LinkedSkillParam onOpen={onOpen} /> : null;
}

function LinkedSkillParam({ onOpen }: { onOpen: (skillId: string) => void }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const skillId = searchParams.get("skill");
  useEffect(() => {
    if (!skillId) return;
    setSearchParams(
      (params) => {
        const next = new URLSearchParams(params);
        next.delete("skill");
        return next;
      },
      { replace: true },
    );
    onOpen(skillId);
  }, [skillId]);
  return null;
}
