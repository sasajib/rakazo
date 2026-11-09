import { t } from "@lingui/core/macro";
import { readJsonObjectWithin } from "@rakazo/core";
import type { ApiRequestContext } from "./api";
import { fetchServer } from "./server-headers";

/**
 * The deployment's call transport, mirrored from apps/web/src/lib/voice-agent.ts. `livekit`
 * means the API brokers room tokens for an external LiveKit voice agent (VOICE_AGENT_URL) and
 * the call is held in a room; `builtin` is the dictation loop in call-session.ts.
 */
export type CallTransport = "builtin" | "livekit";
export type VoiceAgentConfig = { mode: CallTransport };

export interface LivekitCallGrant {
  url: string;
  token: string;
  room: string;
  callId: string;
}

const BUILTIN: VoiceAgentConfig = { mode: "builtin" };
/** Both replies are tiny; a bigger one is not the API. */
const MAX_RESPONSE_BYTES = 16 * 1024;

export async function fetchVoiceAgentConfig(
  requestContext: ApiRequestContext,
  signal: AbortSignal,
): Promise<VoiceAgentConfig> {
  const { apiBase, headers } = requestContext;
  const res = await fetchServer(
    `${apiBase}/api/voice/agent`,
    { headers: { origin: "rakazo://", ...headers }, signal },
    apiBase,
  );
  // An older API has no such route: the built-in call is the only one it serves.
  if (res.status === 404) return BUILTIN;
  const body = await readJsonObjectWithin<{ mode?: unknown; error?: unknown }>(res, {
    maxBytes: MAX_RESPONSE_BYTES,
    tooLargeMessage: t("Could not start the call."),
    signal,
  });
  if (!res.ok) throw new Error(errorMessage(res, body));
  return body.mode === "livekit" ? { mode: "livekit" } : BUILTIN;
}

/**
 * A room for one call. With `callId`, the room is for the bot's own call the user just
 * answered (threads/answerCall): it keeps that id, so the agent's turns and the call marker
 * land in the same call as the request.
 */
export async function fetchLivekitCallGrant(
  botId: string,
  requestContext: ApiRequestContext,
  signal: AbortSignal,
  callId?: string,
): Promise<LivekitCallGrant> {
  const { apiBase, headers } = requestContext;
  const res = await fetchServer(
    `${apiBase}/api/voice/agent/token`,
    {
      method: "POST",
      headers: { "content-type": "application/json", origin: "rakazo://", ...headers },
      body: JSON.stringify(callId ? { botId, callId } : { botId }),
      signal,
    },
    apiBase,
  );
  const grant = await readJsonObjectWithin<Partial<LivekitCallGrant> & { error?: unknown }>(res, {
    maxBytes: MAX_RESPONSE_BYTES,
    tooLargeMessage: t("Could not start the call."),
    signal,
  });
  if (!res.ok) throw new Error(errorMessage(res, grant));
  if (!grant.url || !grant.token || !grant.room || !grant.callId) {
    throw new Error(t("Could not start the call."));
  }
  return { url: grant.url, token: grant.token, room: grant.room, callId: grant.callId };
}

/**
 * Which transport a call should use. The config is deployment state, not user state, but a
 * failed lookup must not block calling: the built-in call still works against any server.
 */
export async function resolveCallTransport(
  loadConfig: () => Promise<VoiceAgentConfig>,
): Promise<CallTransport> {
  try {
    return (await loadConfig()).mode === "livekit" ? "livekit" : "builtin";
  } catch {
    return "builtin";
  }
}

function errorMessage(res: Response, body: { error?: unknown }): string {
  if (typeof body.error === "string" && body.error) return body.error;
  return res.status === 401 ? t("Sign in again") : t("Could not start the call.");
}
