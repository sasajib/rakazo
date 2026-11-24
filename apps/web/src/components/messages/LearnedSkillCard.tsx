import { Trans, useLingui } from "@lingui/react/macro";
import type { LearnedSkillBlock } from "@rakazo/contracts";
import { Button, Textarea } from "@rakazo/ui-web";
import { useState } from "react";
import { useInRouterContext, useSearchParams } from "react-router-dom";
import type { createSpaceRpc } from "../../lib/query/rpc";
import { errorText } from "../../lib/query/user-error";
import { BuiCard } from "../ai/primitives";

/**
 * Fork: the skill curator's card. Ask mode: "I learned a new skill … Keep it?" with Keep / Edit /
 * Discard (Edit opens the proposed SKILL.md right here, Keep saves the edited text). Auto mode:
 * a short notice that it was saved, with Open and Undo. Nothing waits on the card.
 */
export function LearnedSkillCard({
  block,
  rpc,
}: {
  block: LearnedSkillBlock;
  rpc: ReturnType<typeof createSpaceRpc>;
}) {
  const { t } = useLingui();
  const [current, setCurrent] = useState<LearnedSkillBlock>(block);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(block.content ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(current.error ?? null);
  // A newer copy of the card from the server (another tab decided) wins over local state.
  const shown = block.status !== "pending" && current.status === "pending" ? block : current;

  async function decide(decision: "keep" | "discard", content?: string) {
    setBusy(true);
    setError(null);
    try {
      const next = await rpc.skillLearning.decide({
        proposalId: shown.proposalId,
        decision,
        ...(content ? { content } : {}),
      });
      setCurrent(next);
      setError(next.error ?? null);
      if (next.status !== "pending") setEditing(false);
    } catch (cause) {
      setError(errorText(cause, t`Could not save the skill`));
    } finally {
      setBusy(false);
    }
  }

  const patch = shown.action === "patch";
  const title =
    shown.status === "saved"
      ? patch
        ? t`I updated a skill: ${shown.name}`
        : t`I learned a new skill: ${shown.name}`
      : patch
        ? t`I'd like to update a skill: ${shown.name}`
        : t`I learned a new skill: ${shown.name}`;
  const status =
    shown.status === "kept"
      ? t`Kept.`
      : shown.status === "discarded"
        ? t`Discarded.`
        : shown.status === "reverted"
          ? t`Undone.`
          : shown.status === "failed"
            ? t`Could not be saved.`
            : shown.status === "saved"
              ? t`Saved automatically.`
              : patch
                ? t`Keep the change?`
                : t`Keep it?`;

  return (
    <BuiCard data-testid="learned-skill-card" className="w-[520px] max-w-full px-5 py-4">
      <div className="text-body-lg font-medium text-foreground" dir="auto">
        {title}
      </div>
      <div className="mt-1 text-body text-muted-foreground" dir="auto">
        {shown.summary}
      </div>
      {shown.taught ? (
        <div className="mt-1 text-caption text-muted-foreground">
          <Trans>From what you taught in this chat.</Trans>
        </div>
      ) : null}
      {shown.diff ? (
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-muted px-3 py-2 text-caption text-foreground">
          {shown.diff}
        </pre>
      ) : null}
      {editing ? (
        <Textarea
          aria-label={t`Skill text`}
          className="mt-3 font-mono text-caption"
          rows={12}
          disabled={busy}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      ) : null}
      <div className="mt-3 text-body-sm text-muted-foreground">{status}</div>
      <div className="mt-2 flex flex-wrap gap-2">
        {shown.status === "pending" ? (
          <>
            <Button
              disabled={busy || (editing && !draft.trim())}
              onClick={() => void decide("keep", editing ? draft : undefined)}
            >
              {editing ? <Trans>Save and keep</Trans> : <Trans>Keep</Trans>}
            </Button>
            {shown.content ? (
              <Button variant="outline" disabled={busy} onClick={() => setEditing((on) => !on)}>
                {editing ? <Trans>Close editor</Trans> : <Trans>Edit</Trans>}
              </Button>
            ) : null}
            <Button variant="outline" disabled={busy} onClick={() => void decide("discard")}>
              <Trans>Discard</Trans>
            </Button>
          </>
        ) : null}
        {(shown.status === "kept" || shown.status === "saved") && shown.skillId ? (
          <OpenInSkills skillId={shown.skillId} disabled={busy} />
        ) : null}
        {shown.status === "saved" ? (
          <Button variant="outline" disabled={busy} onClick={() => void decide("discard")}>
            <Trans>Undo</Trans>
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-label text-destructive">
          {error}
        </p>
      ) : null}
    </BuiCard>
  );
}

function OpenInSkills({ skillId, disabled }: { skillId: string; disabled: boolean }) {
  return useInRouterContext() ? <OpenInSkillsButton skillId={skillId} disabled={disabled} /> : null;
}

/** Opens the Skills window on this skill (the window reads ?skills&skill=<id>). */
function OpenInSkillsButton({ skillId, disabled }: { skillId: string; disabled: boolean }) {
  const [, setSearchParams] = useSearchParams();
  return (
    <Button
      variant="outline"
      disabled={disabled}
      onClick={() =>
        setSearchParams(
          (params) => {
            const next = new URLSearchParams(params);
            next.set("skills", "");
            next.set("skill", skillId);
            return next;
          },
          { replace: true },
        )
      }
    >
      <Trans>Open in Skills</Trans>
    </Button>
  );
}
