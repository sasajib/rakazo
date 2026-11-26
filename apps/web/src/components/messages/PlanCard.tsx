import { Trans, useLingui } from "@lingui/react/macro";
import type { PlanBlock } from "@rakazo/contracts";
import { Button, Textarea } from "@rakazo/ui-web";
import { useState } from "react";
import type { createSpaceRpc } from "../../lib/query/rpc";
import { errorText } from "../../lib/query/user-error";
import { BuiCard } from "../ai/primitives";

/**
 * Fork: a plan card. The agent shows what it will do (numbered steps, who does each, the inputs
 * it will use) before it hands work to another agent. Approve starts it; Change opens the steps as
 * text to edit and sends them back for a revised plan; Reject drops it. Saying "yes" or "change
 * step 2 to …" in the chat or on a call does the same. Nothing waits on the card.
 * A plan the agent may run without asking (a trusted workflow, or Notify mode) is a notice: no
 * buttons, "Running: …".
 */
export function PlanCard({
  block,
  rpc,
}: {
  block: PlanBlock;
  rpc: ReturnType<typeof createSpaceRpc>;
}) {
  const { t } = useLingui();
  const [current, setCurrent] = useState<PlanBlock>(block);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() =>
    block.steps
      .map((step, i) => `${i + 1}. ${step.agent ? `${step.agent}: ` : ""}${step.text}`)
      .join("\n"),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A newer copy from the server (decided by voice, text or another tab) wins over local state.
  const shown = block.status !== "pending" && current.status === "pending" ? block : current;
  const open = shown.status === "pending";

  async function decide(decision: "approve" | "change" | "reject", text?: string) {
    setBusy(true);
    setError(null);
    try {
      const next = await rpc.plans.decide({
        planId: shown.planId,
        decision,
        via: "click",
        ...(text ? { text } : {}),
      });
      setCurrent(next);
      setEditing(false);
    } catch (cause) {
      setError(errorText(cause, t`Could not send your decision`));
    } finally {
      setBusy(false);
    }
  }

  const via =
    shown.decidedVia === "voice"
      ? t`by voice`
      : shown.decidedVia === "text"
        ? t`in the chat`
        : shown.decidedVia === "click"
          ? t`on the card`
          : "";
  const status =
    shown.status === "approved"
      ? t`Approved ${via}.`
      : shown.status === "auto"
        ? shown.decidedVia === "notify"
          ? t`For your information: started without waiting. Say what to change if you want it done differently.`
          : t`Trusted workflow: running without asking.`
        : shown.status === "changes"
          ? t`You asked for changes; a revised plan follows.`
          : shown.status === "rejected"
            ? t`Rejected.`
            : shown.status === "replaced"
              ? t`Replaced by a newer plan.`
              : t`Go ahead?`;

  return (
    <BuiCard data-testid="plan-card" className="w-[520px] max-w-full px-5 py-4">
      <div className="text-body-lg font-medium text-foreground" dir="auto">
        {shown.status === "auto" ? t`Running: ${shown.title}` : t`Plan: ${shown.title}`}
        {shown.revision > 1 ? (
          <span className="ml-2 text-caption text-muted-foreground">
            <Trans>revision {shown.revision}</Trans>
          </span>
        ) : null}
      </div>
      {shown.workflow ? (
        <div className="mt-1 text-caption text-muted-foreground" data-testid="plan-workflow">
          <Trans>
            Workflow {shown.workflow.name} · approved {shown.workflow.approvals} of{" "}
            {shown.workflow.threshold} times before it runs without asking
          </Trans>
        </div>
      ) : null}
      {shown.inputs?.length ? (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-body-sm">
          {shown.inputs.map((input) => (
            <div key={input.label} className="contents">
              <dt className="text-muted-foreground">{input.label}</dt>
              <dd className="text-foreground" dir="auto">
                {input.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {editing ? (
        <Textarea
          data-testid="plan-edit"
          className="mt-3 min-h-32 font-mono text-body-sm"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      ) : (
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-body text-foreground" dir="auto">
          {shown.steps.map((step, i) => (
            <li key={`${i}-${step.text.slice(0, 20)}`}>
              {step.agent ? <span className="font-medium">{step.agent}: </span> : null}
              {step.text}
            </li>
          ))}
        </ol>
      )}
      <div className="mt-3 text-body-sm text-muted-foreground" data-testid="plan-status">
        {status}
      </div>
      {open ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {editing ? (
            <>
              <Button
                size="sm"
                disabled={busy || !draft.trim()}
                onClick={() => void decide("change", draft.trim())}
              >
                <Trans>Send changes</Trans>
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
                <Trans>Cancel</Trans>
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" disabled={busy} onClick={() => void decide("approve")}>
                <Trans>Approve</Trans>
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(true)}>
                <Trans>Change</Trans>
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void decide("reject")}
              >
                <Trans>Reject</Trans>
              </Button>
            </>
          )}
        </div>
      ) : null}
      {error ? <p className="mt-2 text-body-sm text-destructive">{error}</p> : null}
    </BuiCard>
  );
}
