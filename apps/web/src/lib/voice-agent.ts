import { queryOptions } from "@tanstack/react-query";
import { withSpaceHeaders } from "./rpc.js";

/**
 * The deployment's call transport. `livekit` means the API brokers room tokens for an external
 * LiveKit voice agent (VOICE_AGENT_URL); `builtin` is the dictation loop in call-session.ts.
 */
export type VoiceAgentConfig = { mode: "builtin" | "livekit" };

export interface LivekitCallGrant {
  url: string;
  token: string;
  room: string;
  callId: string;
}

const BUILTIN: VoiceAgentConfig = { mode: "builtin" };

export async function fetchVoiceAgentConfig(signal?: AbortSignal): Promise<VoiceAgentConfig> {
  const res = await fetch("/api/voice/agent", {
    credentials: "include",
    headers: withSpaceHeaders({}),
    signal,
  });
  // An older API has no such route: the built-in call is the only one it serves.
  if (res.status === 404) return BUILTIN;
  if (!res.ok) throw new Error(await errorMessage(res));
  const body: unknown = await res.json();
  const mode = (body as { mode?: unknown } | null)?.mode;
  return mode === "livekit" ? { mode } : BUILTIN;
}

export async function fetchLivekitCallGrant(
  botId: string,
  signal?: AbortSignal,
): Promise<LivekitCallGrant> {
  const res = await fetch("/api/voice/agent/token", {
    method: "POST",
    credentials: "include",
    headers: withSpaceHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ botId }),
    signal,
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  const grant = (await res.json()) as Partial<LivekitCallGrant>;
  if (!grant.url || !grant.token || !grant.room || !grant.callId) {
    throw new Error("The voice agent sent an incomplete call grant.");
  }
  return { url: grant.url, token: grant.token, room: grant.room, callId: grant.callId };
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    // Not JSON; the status is all there is.
  }
  return res.status === 401
    ? "Sign in again to call."
    : `Voice agent request failed (${res.status}).`;
}

/** Asked once per session: the transport is deployment configuration, not user state. */
export function voiceAgentConfigQuery(enabled: boolean) {
  return queryOptions({
    queryKey: ["voice-agent-config"],
    queryFn: ({ signal }) => fetchVoiceAgentConfig(signal),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  });
}
