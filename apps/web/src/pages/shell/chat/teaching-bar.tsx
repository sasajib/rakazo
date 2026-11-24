import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSpaceQueries } from "../../../lib/query/query";
import { useSpaceRpc } from "../../../lib/query/space-rpc";
import { errorText } from "../../../lib/query/user-error";

/**
 * Fork: while the owner is teaching an agent a task in this chat ("Let me teach you how to …"),
 * a slim bar above the composer names the lesson and offers Save as skill / Cancel. Nothing shows
 * otherwise.
 */
export function TeachingBar({ botId, threadId }: { botId?: string; threadId?: string }) {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const procedure = queries.skillLearning?.teaching as
    | typeof queries.skillLearning.teaching
    | undefined;
  const ready = Boolean(procedure && botId && threadId);
  const options =
    ready && procedure
      ? procedure.queryOptions({ input: { botId: botId!, threadId: threadId! } })
      : undefined;
  const query = useQuery(
    options
      ? { ...options, refetchInterval: 8_000, retry: false }
      : { queryKey: ["teaching-unavailable"], queryFn: skipToken },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = query.data as { active: boolean; task?: string } | undefined;
  if (!state?.active || !botId || !threadId) return null;

  async function act(action: "save" | "cancel") {
    setBusy(true);
    setError(null);
    try {
      const next = await rpc.skillLearning.teach({ botId: botId!, threadId: threadId!, action });
      if (options) queryClient.setQueryData(options.queryKey, next);
    } catch (cause) {
      setError(errorText(cause, t`Could not finish the lesson`));
    } finally {
      setBusy(false);
    }
  }

  const task = state.task ?? "";
  return (
    <div
      data-testid="teaching-bar"
      className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-2 px-4 pb-1 text-body-sm text-muted-foreground"
    >
      <span className="min-w-0 truncate" dir="auto">
        <Trans>Teaching: {task}</Trans>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {error ? <span className="text-destructive">{error}</span> : null}
        <Button size="xs" disabled={busy} onClick={() => void act("save")}>
          <Trans>Save as skill</Trans>
        </Button>
        <Button size="xs" variant="outline" disabled={busy} onClick={() => void act("cancel")}>
          <Trans>Cancel lesson</Trans>
        </Button>
      </span>
    </div>
  );
}
