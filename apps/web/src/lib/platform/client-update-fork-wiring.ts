import { t } from "@lingui/core/macro";
import { toast } from "@rakazo/ui-web";
import { getSnapshot as activeCall } from "../calls/call-session";
import { dictation } from "../calls/dictation";
import { composerHoldsUnsavedWork } from "../composer/composer-draft";
import { onRpcResponse } from "../query/rpc";
import { CLIENT_BUILD } from "./client-build";
import type { UnsafeFacts, UpdateMoment } from "./client-update-fork";
import {
  createForkClientUpdates,
  fetchServedBuild,
  pageHoldsTypedText,
  reloadHeld,
} from "./client-update-fork";
import { hasOpenDialog } from "./has-open-dialog";

const NOTICE_ID = "client-update-available";

/** What a reload would interrupt right now, read from the page and the app's own state. */
export function unsafeFacts(doc: Document = document): UnsafeFacts {
  return {
    liveCall: activeCall() !== null,
    composerText: composerHoldsUnsavedWork() || pageHoldsTypedText(doc),
    busy: dictation.state.status !== "idle" || reloadHeld() || hasOpenDialog(doc),
  };
}

/** A toast: it renders in the corner, takes no focus and blocks nothing. */
function notice(show: boolean): void {
  if (!show) {
    toast.dismiss(NOTICE_ID);
    return;
  }
  toast(t`New version available`, {
    id: NOTICE_ID,
    duration: Number.POSITIVE_INFINITY,
    action: { label: t`Reload`, onClick: () => window.location.reload() },
  });
}

type Link = {
  note: (build: string) => void;
  attempt: (moment: UpdateMoment) => Promise<boolean>;
  attemptRollback: (moment: UpdateMoment, build: string) => Promise<boolean>;
};

let shared: ReturnType<typeof createForkClientUpdates> | undefined;

/** The tab's one fork tracker, linked to upstream's on first use. */
export function forkClientUpdates(link: Link): ReturnType<typeof createForkClientUpdates> {
  const browser = typeof window !== "undefined";
  shared ??= createForkClientUpdates({
    // The desktop app bundles its renderer: a reload cannot change it, so nothing is offered there.
    build: browser && !window.rakazoDesktop ? CLIENT_BUILD : "",
    fetchServed: () => fetchServedBuild((input, init) => fetch(input, init)),
    facts: () => unsafeFacts(),
    visibility: () => document.visibilityState,
    now: () => Date.now(),
    note: link.note,
    attempt: link.attempt,
    attemptRollback: link.attemptRollback,
    bar: notice,
    listen: (type, listener) => {
      const target = type === "visibilitychange" ? document : window;
      target.addEventListener(type, listener, { capture: true, passive: true });
      return () => target.removeEventListener(type, listener, { capture: true });
    },
    responses: onRpcResponse,
    setInterval: (callback, ms) => window.setInterval(callback, ms),
    clearInterval: (handle) => window.clearInterval(handle as number),
  });
  return shared;
}
