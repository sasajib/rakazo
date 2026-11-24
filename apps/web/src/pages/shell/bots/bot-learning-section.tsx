import { Trans, useLingui } from "@lingui/react/macro";
import type { SkillLearningMode, SkillLearningSettings } from "@rakazo/contracts";
import { OptionSelect } from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSpaceQueries } from "../../../lib/query/query";
import { useSpaceRpc } from "../../../lib/query/space-rpc";
import { errorText } from "../../../lib/query/user-error";
import { PanelSection, SettingsCard } from "./bot-settings-sections";

/**
 * Fork: the agent's Learning setting (skill curator). Off: it never writes skills on its own.
 * Ask: after a correction or a lesson it proposes a skill on a card in the chat. Auto: it saves
 * the skill and posts a short notice (it still asks before changing a skill you wrote).
 */
export function BotLearningSection({ botId, ids }: { botId: string; ids: string }) {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const options = queries.skillLearning.settings.queryOptions({ input: { botId } });
  const query = useQuery({ ...options, refetchOnMount: "always" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settings = query.data;
  if (!settings?.available) return null;

  const modeLabel = (mode: SkillLearningMode) =>
    mode === "off" ? t`Off` : mode === "auto" ? t`Auto` : t`Ask`;

  async function save(input: { botId?: string; mode: SkillLearningMode | null }) {
    setSaving(true);
    setError(null);
    try {
      const saved: SkillLearningSettings = await rpc.skillLearning.setMode(input);
      if (input.botId) queryClient.setQueryData(options.queryKey, saved);
      else void queryClient.invalidateQueries({ queryKey: queries.skillLearning.key() });
    } catch (cause) {
      setError(errorText(cause, t`Could not save the learning setting`));
    } finally {
      setSaving(false);
    }
  }

  const spaceDefault = settings.spaceMode ?? "ask";
  return (
    <PanelSection label={t`Learning`}>
      <section data-testid="bot-settings-learning">
        <SettingsCard>
          <label
            htmlFor={`${ids}-learning`}
            className="flex min-h-12 items-center justify-between gap-3 text-body text-foreground"
          >
            <Trans>Learn skills from how you work</Trans>
            <OptionSelect
              id={`${ids}-learning`}
              className="w-fit max-w-2/3"
              disabled={saving}
              value={settings.botMode ?? ""}
              onValueChange={(value) =>
                void save({ botId, mode: value ? (value as SkillLearningMode) : null })
              }
              options={[
                { value: "", label: t`Space default (${modeLabel(spaceDefault)})` },
                { value: "ask", label: t`Ask` },
                { value: "auto", label: t`Auto` },
                { value: "off", label: t`Off` },
              ]}
            />
          </label>
          <label
            htmlFor={`${ids}-learning-space`}
            className="flex min-h-12 items-center justify-between gap-3 text-body text-muted-foreground"
          >
            <Trans>Space default</Trans>
            <OptionSelect
              id={`${ids}-learning-space`}
              className="w-fit max-w-2/3"
              disabled={saving}
              value={spaceDefault}
              onValueChange={(value) => void save({ mode: value as SkillLearningMode })}
              options={[
                { value: "ask", label: t`Ask` },
                { value: "auto", label: t`Auto` },
                { value: "off", label: t`Off` },
              ]}
            />
          </label>
          <p className="pb-3 text-caption text-muted-foreground">
            {settings.effective === "off" ? (
              <Trans>This agent does not write skills on its own.</Trans>
            ) : settings.effective === "auto" ? (
              <Trans>
                After a correction or a lesson, it saves the skill and tells you in the chat. It
                still asks before changing a skill you wrote.
              </Trans>
            ) : (
              <Trans>
                After a correction or a lesson, it proposes a skill in the chat for you to keep,
                edit or discard.
              </Trans>
            )}{" "}
            <Trans>
              To teach it a task, write "Let me teach you how to …", give the steps, then say "save
              as skill".
            </Trans>
          </p>
        </SettingsCard>
        {error ? <p className="mt-2 text-body-sm text-destructive">{error}</p> : null}
      </section>
    </PanelSection>
  );
}
