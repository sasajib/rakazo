import { Trans, useLingui } from "@lingui/react/macro";
import type { PlanMode, PlanSettings } from "@rakazo/contracts";
import { Button, OptionSelect } from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSpaceQueries } from "../../../lib/query/query";
import { useSpaceRpc } from "../../../lib/query/space-rpc";
import { errorText } from "../../../lib/query/user-error";
import { PanelSection, SettingsCard } from "./bot-settings-sections";

/**
 * Fork: the agent's Plans setting (plan confirmation). Always ask: every hand-off to another
 * agent waits for your approval of a plan card. Ask until trusted (default): the same, but a known
 * workflow (skill) you approved N times runs without asking, still posting the plan as a notice.
 * Notify: it posts every plan as a notice and carries on at once; you correct it afterwards.
 * Never ask: it hands work on without a plan. Trusted workflows are listed with their count.
 */
export function BotPlansSection({ botId, ids }: { botId: string; ids: string }) {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const options = queries.plans.settings.queryOptions({ input: { botId } });
  const query = useQuery({ ...options, refetchOnMount: "always" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settings = query.data;
  if (!settings) return null;
  const modeLabel = (mode: PlanMode) =>
    mode === "always"
      ? t`Always ask`
      : mode === "notify"
        ? t`Notify (show the plan, do not wait)`
        : mode === "never"
          ? t`Never ask`
          : t`Ask until trusted`;

  async function save(input: { mode: PlanMode | null; threshold?: number }) {
    setSaving(true);
    setError(null);
    try {
      const saved: PlanSettings = await rpc.plans.setMode({ botId, ...input });
      queryClient.setQueryData(options.queryKey, saved);
    } catch (cause) {
      setError(errorText(cause, t`Could not save the plan setting`));
    } finally {
      setSaving(false);
    }
  }

  async function revoke(workflow: string) {
    setSaving(true);
    setError(null);
    try {
      await rpc.plans.revokeTrust({ botId, workflow });
      await query.refetch();
    } catch (cause) {
      setError(errorText(cause, t`Could not revoke the trust`));
    } finally {
      setSaving(false);
    }
  }

  return (
    <PanelSection label={t`Plans`}>
      <section data-testid="bot-settings-plans">
        <SettingsCard>
          <label
            htmlFor={`${ids}-plans`}
            className="flex min-h-12 items-center justify-between gap-3 text-body text-foreground"
          >
            <Trans>Confirm the plan before handing work on</Trans>
            <OptionSelect
              id={`${ids}-plans`}
              className="w-fit max-w-2/3"
              disabled={saving}
              value={settings.mode ?? ""}
              onValueChange={(value) => void save({ mode: value ? (value as PlanMode) : null })}
              options={[
                {
                  value: "",
                  label: t`Default (${modeLabel(settings.defaultMode ?? "until_trusted")})`,
                },
                { value: "always", label: modeLabel("always") },
                { value: "until_trusted", label: modeLabel("until_trusted") },
                { value: "notify", label: modeLabel("notify") },
                { value: "never", label: modeLabel("never") },
              ]}
            />
          </label>
          {settings.effective === "until_trusted" ? (
            <label
              htmlFor={`${ids}-plans-threshold`}
              className="flex min-h-12 items-center justify-between gap-3 text-body text-muted-foreground"
            >
              <Trans>Approvals before a workflow runs without asking</Trans>
              <OptionSelect
                id={`${ids}-plans-threshold`}
                className="w-fit"
                disabled={saving}
                value={String(settings.threshold)}
                onValueChange={(value) =>
                  void save({ mode: settings.mode ?? "until_trusted", threshold: Number(value) })
                }
                options={[1, 2, 3, 4, 5, 7, 10].map((n) => ({
                  value: String(n),
                  label: String(n),
                }))}
              />
            </label>
          ) : null}
          {settings.trust.length ? (
            <ul className="space-y-1 pb-2 text-body-sm" data-testid="bot-plan-trust">
              {settings.trust.map((row) => (
                <li key={row.workflow} className="flex items-center justify-between gap-3">
                  <span dir="auto">
                    {row.workflow}{" "}
                    <span className="text-muted-foreground">
                      {row.trusted ? (
                        <Trans>trusted ({row.approvals} approvals)</Trans>
                      ) : (
                        <Trans>
                          {row.approvals} of {row.threshold} approvals
                        </Trans>
                      )}
                    </span>
                  </span>
                  {row.approvals > 0 ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={saving}
                      onClick={() => void revoke(row.workflow)}
                    >
                      <Trans>Revoke</Trans>
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="pb-3 text-caption text-muted-foreground">
            {settings.effective === "never" ? (
              <Trans>It hands work to other agents without showing you a plan first.</Trans>
            ) : settings.effective === "notify" ? (
              <Trans>
                It shows you its plan as a notice and starts at once, without waiting for you. Tell
                it what to change afterwards if you want something different.
              </Trans>
            ) : settings.effective === "always" ? (
              <Trans>
                Before it hands work to another agent it shows you a plan card; approve it on the
                card or say "yes" (also on a call), or say what to change.
              </Trans>
            ) : (
              <Trans>
                Before it hands work to another agent it shows you a plan card. A known workflow you
                approved as proposed {settings.threshold} times runs without asking; it still posts
                the plan. Asking for changes starts the count again.
              </Trans>
            )}
          </p>
        </SettingsCard>
        {error ? <p className="mt-2 text-body-sm text-destructive">{error}</p> : null}
      </section>
    </PanelSection>
  );
}
