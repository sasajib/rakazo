import type { Actor } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";
import type { Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import { readBoundedBody } from "./http-body.js";

/**
 * Duplex calls through an external LiveKit voice agent (examples/livekit-voice-agent).
 *
 * With `VOICE_AGENT_URL` set, the web client's Call button joins a LiveKit room instead of
 * running the built-in dictation loop. The agent's token server mints the room token: it
 * takes the caller's own Rakazo bearer, checks it against the API, and registers the call so
 * the agent worker can speak to the bot as that user. The API brokers that request here, so
 * the browser never learns where the token server is and no second origin needs CORS.
 */
export interface VoiceAgentDeps {
  env: {
    voiceAgentUrl?: string;
    voiceAgentInternalToken?: string;
  };
  /** The caller's signed Rakazo bearer, as a native client would send it. */
  callerBearer: (c: Context) => Promise<string | undefined>;
  fetch?: typeof fetch;
}

export type VoiceAgentConfig = { mode: "builtin" } | { mode: "livekit" };

export interface LivekitCallGrant {
  url: string;
  token: string;
  room: string;
  callId: string;
}

/** How long the token server may take; a stalled agent must not hold the call button. */
export const VOICE_AGENT_TIMEOUT_MS = 10_000;
const MAX_TOKEN_REQUEST_BYTES = 4 * 1024;
const ROOM_PATTERN = /^rakazo-[A-Za-z0-9_-]{6,}$/;

export function voiceAgentConfig(env: VoiceAgentDeps["env"]): VoiceAgentConfig {
  return env.voiceAgentUrl ? { mode: "livekit" } : { mode: "builtin" };
}

/**
 * The bearer a native client sends, or the signed session cookie a browser holds: Better Auth's
 * bearer plugin accepts the cookie's signed value verbatim (see withSignedSessionToken in
 * packages/auth), so the token server can present it back to the API as the caller.
 */
export function callerBearerFromRequest(c: Context, sessionCookieName: string): string | undefined {
  const header = c.req.header("authorization") ?? "";
  if (/^bearer\s+\S/i.test(header)) return header.replace(/^bearer\s+/i, "").trim();
  const cookie = getCookie(c, sessionCookieName);
  return cookie?.trim() || undefined;
}

/** Only the shape the client needs leaves the token server's reply. */
export function parseLivekitCallGrant(value: unknown): LivekitCallGrant | null {
  if (!value || typeof value !== "object") return null;
  const { url, token, room, callId } = value as Record<string, unknown>;
  if ([url, token, room, callId].some((field) => typeof field !== "string" || !field)) return null;
  if (!ROOM_PATTERN.test(room as string) || room !== `rakazo-${callId as string}`) return null;
  return {
    url: url as string,
    token: token as string,
    room: room as string,
    callId: callId as string,
  };
}

export async function requestLivekitCallGrant(
  deps: VoiceAgentDeps,
  input: { bearer: string; botId: string; spaceId: string; signal?: AbortSignal },
): Promise<{ grant: LivekitCallGrant } | { status: 401 | 404 | 502 | 504; error: string }> {
  const base = deps.env.voiceAgentUrl;
  if (!base) return { status: 404, error: "No voice agent is configured." };
  const headers: Record<string, string> = {
    authorization: `Bearer ${input.bearer}`,
    "content-type": "application/json",
  };
  if (deps.env.voiceAgentInternalToken) {
    headers["x-voice-internal-token"] = deps.env.voiceAgentInternalToken;
  }
  const signals = [AbortSignal.timeout(VOICE_AGENT_TIMEOUT_MS), input.signal].filter(
    Boolean,
  ) as AbortSignal[];
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(`${base}/token`, {
      method: "POST",
      headers,
      body: JSON.stringify({ botId: input.botId, spaceId: input.spaceId }),
      signal: AbortSignal.any(signals),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    getLogger().warn("voice agent token server unreachable", {
      reason: error instanceof Error ? error.message : String(error),
    });
    return timedOut
      ? { status: 504, error: "The voice agent did not answer in time." }
      : { status: 502, error: "The voice agent is unreachable." };
  }
  if (response.status === 401 || response.status === 403) {
    return { status: 401, error: "The voice agent refused this session." };
  }
  if (response.status === 404) return { status: 404, error: "The bot is not in this space." };
  if (!response.ok) {
    getLogger().warn("voice agent token server failed", { status: response.status });
    return { status: 502, error: "The voice agent could not start the call." };
  }
  const grant = parseLivekitCallGrant(await response.json().catch(() => null));
  if (!grant) {
    getLogger().warn("voice agent token server returned an unexpected reply");
    return { status: 502, error: "The voice agent could not start the call." };
  }
  return { grant };
}

export function mountVoiceAgentRoutes(
  app: Hono,
  deps: VoiceAgentDeps,
  authenticate: (c: Context) => Promise<Actor | null>,
) {
  // Which call transport the client should use. Not secret, but only for signed-in users.
  app.get("/api/voice/agent", async (c) => {
    const actor = await authenticate(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    c.header("cache-control", "no-store");
    return c.json(voiceAgentConfig(deps.env));
  });

  // A room token for one call with one bot, minted on the caller's behalf.
  app.post("/api/voice/agent/token", async (c) => {
    const actor = await authenticate(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    if (!deps.env.voiceAgentUrl) return c.json({ error: "No voice agent is configured." }, 404);
    const raw = await readBoundedBody(c.req.raw, MAX_TOKEN_REQUEST_BYTES);
    if (raw === null) return c.json({ error: "Request body is too large." }, 413);
    let botId = "";
    try {
      const body: unknown = JSON.parse(raw);
      botId =
        body && typeof body === "object" ? String((body as { botId?: unknown }).botId ?? "") : "";
    } catch {
      botId = "";
    }
    if (!botId.trim()) return c.json({ error: "botId is required." }, 400);
    const bearer = await deps.callerBearer(c);
    if (!bearer) return c.json({ error: "Unauthorized" }, 401);
    const result = await requestLivekitCallGrant(deps, {
      bearer,
      botId: botId.trim(),
      spaceId: actor.spaceId,
      signal: c.req.raw.signal,
    });
    c.header("cache-control", "no-store");
    if ("grant" in result) return c.json(result.grant);
    return c.json({ error: result.error }, result.status);
  });
}
