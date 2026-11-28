import { Trans, useLingui } from "@lingui/react/macro";
import type { AgentSkillCatalogEntry, BotSkills } from "@rakazo/contracts";
import { Checkbox } from "@rakazo/ui-web";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSpaceQueries } from "../../../lib/query/query";
import { useSpaceRpc } from "../../../lib/query/space-rpc";
import { errorText } from "../../../lib/query/user-error";
import { PanelSection, SettingsCard, SwitchRow } from "./bot-settings-sections";

const NO_SKILLS: AgentSkillCatalogEntry[] = [];

/**
 * Fork: which of the space's skills this agent may use. "All skills" (the default) follows the
 * space as before; switching it off starts from every skill ticked, so nothing changes until a
 * skill is unticked. Built-in skills are ticked like the rest and stay on unless unticked.
 */
export function BotSkillsSection({ botId, ids }: { botId: string; ids: string }) {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const catalogQuery = useQuery({
    ...queries.agentSkills.list.queryOptions(),
    refetchOnMount: "always",
  });
  const selectionOptions = queries.agentSkills.forBot.queryOptions({ input: { botId } });
  const selectionQuery = useQuery({ ...selectionOptions, refetchOnMount: "always" });
  // Fork (1.32): a skill pinned for every agent is on here whatever is ticked. Hand-written test
  // clients may lack the procedure; then nothing is marked.
  const pinnedProcedure = queries.agentSkills.pinned as
    | typeof queries.agentSkills.pinned
    | undefined;
  const pinnedQuery = useQuery(
    pinnedProcedure
      ? { ...pinnedProcedure.queryOptions(), refetchOnMount: "always" }
      : { queryKey: ["pinned-skills-unavailable"], queryFn: skipToken },
  );
  const pinned = new Set((pinnedQuery.data as { skillIds: string[] } | undefined)?.skillIds ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const skills = catalogQuery.data ?? NO_SKILLS;
  const selection = selectionQuery.data;
  if (!selection || skills.length === 0) return null;
  const all = selection.all;
  const chosen = new Set(all ? skills.map((skill) => skill.id) : selection.skillIds);

  async function save(next: { all: boolean; skillIds: string[] }) {
    setSaving(true);
    setError(null);
    try {
      const saved: BotSkills = await rpc.agentSkills.setForBot({ botId, ...next });
      queryClient.setQueryData(selectionOptions.queryKey, saved);
      void queryClient.invalidateQueries({ queryKey: queries.agentSkills.agents.key() });
    } catch (cause) {
      setError(errorText(cause, t`Could not save the skills`));
    } finally {
      setSaving(false);
    }
  }

  return (
    <PanelSection label={t`Skills`}>
      <section data-testid="bot-settings-skills">
        <SettingsCard>
          <SwitchRow
            id={`${ids}-all-skills`}
            label={<Trans>All skills</Trans>}
            checked={all}
            disabled={saving}
            onChange={(checked) =>
              void save(
                checked
                  ? { all: true, skillIds: [] }
                  : { all: false, skillIds: skills.map((skill) => skill.id) },
              )
            }
          />
          {all ? null : (
            <div className="pb-2">
              {skills.map((skill) => {
                const everyAgent = pinned.has(skill.id);
                const checked = everyAgent || chosen.has(skill.id);
                return (
                  <label
                    key={skill.id}
                    htmlFor={`${ids}-skill-${skill.id}`}
                    className="flex min-h-11 cursor-pointer items-center justify-between gap-3 text-body"
                  >
                    <span className="min-w-0">
                      <span className="block truncate" dir="auto">
                        {skill.name}
                      </span>
                      {skill.source !== "user" ? (
                        <span className="text-caption text-muted-foreground">
                          {skill.source === "builtin" ? (
                            <Trans>Built-in</Trans>
                          ) : (
                            <Trans>Plugin</Trans>
                          )}
                        </span>
                      ) : null}
                      {everyAgent ? (
                        <span
                          className="block text-caption text-muted-foreground"
                          data-testid="bot-skill-pinned"
                        >
                          <Trans>Pinned: every agent follows it</Trans>
                        </span>
                      ) : null}
                    </span>
                    <Checkbox
                      id={`${ids}-skill-${skill.id}`}
                      checked={checked}
                      disabled={saving || everyAgent}
                      aria-label={checked ? t`Stop using ${skill.name}` : t`Use ${skill.name}`}
                      onCheckedChange={() => {
                        const next = new Set(chosen);
                        if (checked) next.delete(skill.id);
                        else next.add(skill.id);
                        void save({ all: false, skillIds: [...next] });
                      }}
                    />
                  </label>
                );
              })}
            </div>
          )}
        </SettingsCard>
        {error ? <p className="mt-2 text-body-sm text-destructive">{error}</p> : null}
      </section>
    </PanelSection>
  );
}
