import { getLogger } from "@rakazo/logging";

export type HonchoOperation =
  | "workspace_get_or_create"
  | "peer_get_or_create"
  | "write"
  | "recall"
  | "read"
  | "delete"
  | "chat"
  | "admin_probe"
  | "unknown";

export type HonchoFailureKind = "http" | "network" | "timeout" | "unreadable";

/** What a request to Honcho was for, from its method and path. */
export function honchoOperation(method: string, path: string): HonchoOperation {
  if (path.startsWith("/v3/workspaces/list")) return "admin_probe";
  if (/^\/v3\/workspaces\/?$/.test(path)) return "workspace_get_or_create";
  if (/\/peers\/[^/]+\/chat$/.test(path)) return "chat";
  if (/\/peers\/?$/.test(path)) return "peer_get_or_create";
  if (/\/conclusions\/query$/.test(path)) return "recall";
  if (/\/conclusions\/?$/.test(path) && method === "POST") return "write";
  if (/\/conclusions\/[^/]+$/.test(path)) return method === "DELETE" ? "delete" : "read";
  return "unknown";
}

/** The workspace a request addressed: in its path, or the id a create call carries. */
export function honchoWorkspaceOf(path: string, body: unknown): string | null {
  const match = /^\/v3\/workspaces\/([^/?]+)/.exec(path);
  if (match?.[1] && match[1] !== "list") {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
  const id = (body as { id?: unknown } | null | undefined)?.id;
  return typeof id === "string" ? id : null;
}

/**
 * Logs a failed Honcho request: which operation, what status, which workspace, how long it took.
 * Only this metadata: never the query, the conclusion text or the key. `attempt` is 1 for every
 * request today (Honcho calls are not retried); the field is here so a retry can be audited.
 */
export function logHonchoFailure(failure: {
  method: string;
  path: string;
  body: unknown;
  kind: HonchoFailureKind;
  status: number | null;
  attempt?: number;
  elapsedMs: number;
}): void {
  getLogger().warn("honcho.request.failed", {
    "honcho.operation": honchoOperation(failure.method, failure.path),
    "honcho.failure": failure.kind,
    "honcho.http_status": failure.status,
    "honcho.workspace_id": honchoWorkspaceOf(failure.path, failure.body),
    "honcho.attempt": failure.attempt ?? 1,
    "honcho.elapsed_ms": Math.max(0, Math.round(failure.elapsedMs)),
  });
}
