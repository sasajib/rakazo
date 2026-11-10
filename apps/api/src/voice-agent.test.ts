import type { Actor } from "@rakazo/contracts";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  callerBearerFromRequest,
  mountVoiceAgentRoutes,
  parseLivekitCallGrant,
  requestLivekitCallGrant,
  voiceAgentConfig,
} from "./voice-agent.js";

const actor = { userId: "user-1", spaceId: "space-1" } as Actor;
const grant = {
  url: "wss://lk.example.com",
  token: "jwt",
  room: "rakazo-abc123",
  callId: "abc123",
};

function mount(options: {
  voiceAgentUrl?: string;
  voiceAgentInternalToken?: string;
  actor?: Actor | null;
  bearer?: string;
  fetch?: typeof fetch;
  answeredCall?: NonNullable<Parameters<typeof mountVoiceAgentRoutes>[1]["answeredCall"]>;
}) {
  const app = new Hono();
  const fetchMock = options.fetch ?? vi.fn<typeof fetch>(async () => Response.json(grant));
  mountVoiceAgentRoutes(
    app,
    {
      env: {
        voiceAgentUrl: options.voiceAgentUrl,
        voiceAgentInternalToken: options.voiceAgentInternalToken,
      },
      callerBearer: async () => options.bearer,
      ...(options.answeredCall ? { answeredCall: options.answeredCall } : {}),
      fetch: fetchMock,
    },
    async () => (options.actor === undefined ? actor : options.actor),
  );
  return { app, fetchMock: fetchMock as ReturnType<typeof vi.fn<typeof fetch>> };
}

function tokenRequest(body: unknown = { botId: "bot-1" }) {
  return new Request("http://localhost/api/voice/agent/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("voiceAgentConfig", () => {
  it("keeps the built-in call loop unless a token server is configured", () => {
    expect(voiceAgentConfig({})).toEqual({ mode: "builtin" });
    expect(voiceAgentConfig({ voiceAgentUrl: "http://token:8080" })).toEqual({ mode: "livekit" });
  });
});

describe("GET /api/voice/agent", () => {
  it("requires a session", async () => {
    const { app } = mount({ actor: null });
    expect((await app.request("/api/voice/agent")).status).toBe(401);
  });

  it("reports builtin with the flag unset and livekit with it set", async () => {
    const off = mount({});
    expect(await (await off.app.request("/api/voice/agent")).json()).toEqual({ mode: "builtin" });
    const on = mount({ voiceAgentUrl: "http://token:8080" });
    const response = await on.app.request("/api/voice/agent");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ mode: "livekit" });
  });
});

describe("POST /api/voice/agent/token", () => {
  it("is not found while no agent is configured, before any upstream call", async () => {
    const { app, fetchMock } = mount({ bearer: "signed.bearer" });
    expect((await app.request(tokenRequest())).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires a session and a bearer to act with", async () => {
    const anonymous = mount({ voiceAgentUrl: "http://token:8080", actor: null });
    expect((await anonymous.app.request(tokenRequest())).status).toBe(401);
    const noBearer = mount({ voiceAgentUrl: "http://token:8080", bearer: undefined });
    expect((await noBearer.app.request(tokenRequest())).status).toBe(401);
    expect(noBearer.fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a request without a bot", async () => {
    const { app } = mount({ voiceAgentUrl: "http://token:8080", bearer: "signed.bearer" });
    expect((await app.request(tokenRequest({}))).status).toBe(400);
    expect((await app.request(tokenRequest({ botId: "  " }))).status).toBe(400);
  });

  it("asks the token server on the caller's behalf and returns the grant", async () => {
    const { app, fetchMock } = mount({
      voiceAgentUrl: "http://token:8080",
      voiceAgentInternalToken: "internal",
      bearer: "signed.bearer",
    });
    const response = await app.request(tokenRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(grant);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://token:8080/token");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer signed.bearer");
    expect(headers["x-voice-internal-token"]).toBe("internal");
    expect(JSON.parse(String(init.body))).toEqual({ botId: "bot-1", spaceId: "space-1" });
  });

  it("maps token server refusals without leaking its reply", async () => {
    for (const [upstream, expected] of [
      [401, 401],
      [403, 401],
      [404, 404],
      [500, 502],
    ] as const) {
      const { app } = mount({
        voiceAgentUrl: "http://token:8080",
        bearer: "signed.bearer",
        fetch: vi.fn(async () => Response.json({ error: "secret detail" }, { status: upstream })),
      });
      const response = await app.request(tokenRequest());
      expect(response.status).toBe(expected);
      expect(JSON.stringify(await response.json())).not.toContain("secret detail");
    }
  });

  it("treats an unreachable token server as a bad gateway", async () => {
    const { app } = mount({
      voiceAgentUrl: "http://token:8080",
      bearer: "signed.bearer",
      fetch: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    });
    expect((await app.request(tokenRequest())).status).toBe(502);
  });

  describe("for the bot's own call the user answered", () => {
    const callId = "6f1d2c3b-4a5e-4f60-9b7c-8d9e0f1a2b3c";
    const answeredGrant = { ...grant, room: `rakazo-${callId}`, callId };
    const answered = { callId, opening: "Hi, about the invoice." };

    it("names the room after the call and passes the bot's opening to the token server", async () => {
      const answeredCall = vi.fn(async () => ({ opening: answered.opening }));
      const { app, fetchMock } = mount({
        voiceAgentUrl: "http://token:8080",
        bearer: "signed.bearer",
        answeredCall,
        fetch: vi.fn(async () => Response.json(answeredGrant)),
      });
      const response = await app.request(tokenRequest({ botId: "bot-1", callId }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(answeredGrant);
      expect(answeredCall).toHaveBeenCalledWith(actor, { botId: "bot-1", callId });
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(String(init.body))).toEqual({
        botId: "bot-1",
        spaceId: "space-1",
        callId,
        opening: answered.opening,
      });
    });

    it("rejects an id that is not a call id, before any lookup", async () => {
      const answeredCall = vi.fn(async () => ({ opening: "x" }));
      const { app, fetchMock } = mount({
        voiceAgentUrl: "http://token:8080",
        bearer: "signed.bearer",
        answeredCall,
      });
      for (const bad of ["call:1234567", "short", "a".repeat(201), 42, { id: callId }]) {
        expect((await app.request(tokenRequest({ botId: "bot-1", callId: bad }))).status).toBe(400);
      }
      expect(answeredCall).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses a call that is not answered in this user's chat with the bot", async () => {
      const { app, fetchMock } = mount({
        voiceAgentUrl: "http://token:8080",
        bearer: "signed.bearer",
        answeredCall: async () => null,
      });
      const response = await app.request(tokenRequest({ botId: "bot-1", callId }));
      expect(response.status).toBe(409);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("has no incoming calls where the deployment cannot look them up", async () => {
      const { app, fetchMock } = mount({ voiceAgentUrl: "http://token:8080", bearer: "b" });
      expect((await app.request(tokenRequest({ botId: "bot-1", callId }))).status).toBe(404);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses a grant that renamed the call, and maps a room already taken", async () => {
      const renamed = mount({
        voiceAgentUrl: "http://token:8080",
        bearer: "b",
        answeredCall: async () => ({ opening: "x" }),
        fetch: vi.fn(async () => Response.json(grant)),
      });
      expect((await renamed.app.request(tokenRequest({ botId: "bot-1", callId }))).status).toBe(
        502,
      );
      const taken = mount({
        voiceAgentUrl: "http://token:8080",
        bearer: "b",
        answeredCall: async () => ({ opening: "x" }),
        fetch: vi.fn(async () => Response.json({ error: "taken" }, { status: 409 })),
      });
      expect((await taken.app.request(tokenRequest({ botId: "bot-1", callId }))).status).toBe(409);
    });
  });

  it("refuses a grant whose room is not the call's rakazo- room", async () => {
    const { app } = mount({
      voiceAgentUrl: "http://token:8080",
      bearer: "signed.bearer",
      fetch: vi.fn(async () => Response.json({ ...grant, room: "lobby" })),
    });
    expect((await app.request(tokenRequest())).status).toBe(502);
  });
});

describe("requestLivekitCallGrant", () => {
  it("strips a trailing slash from the configured URL", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json(grant));
    await requestLivekitCallGrant(
      {
        env: { voiceAgentUrl: "http://token:8080" },
        callerBearer: async () => "b",
        fetch: fetchMock,
      },
      { bearer: "b", botId: "bot", spaceId: "space" },
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://token:8080/token");
  });
});

describe("parseLivekitCallGrant", () => {
  it("accepts only a complete grant for the call's own room", () => {
    expect(parseLivekitCallGrant(grant)).toEqual(grant);
    expect(parseLivekitCallGrant({ ...grant, token: "" })).toBeNull();
    expect(parseLivekitCallGrant({ ...grant, callId: "other1" })).toBeNull();
    expect(parseLivekitCallGrant(null)).toBeNull();
  });
});

describe("callerBearerFromRequest", () => {
  it("prefers a bearer header and falls back to the signed session cookie", async () => {
    const app = new Hono();
    app.get("/probe", (c) => c.text(callerBearerFromRequest(c, "rakazo.session_token") ?? ""));
    const header = await app.request("/probe", { headers: { authorization: "Bearer abc.sig" } });
    expect(await header.text()).toBe("abc.sig");
    const cookie = await app.request("/probe", {
      headers: { cookie: "other=1; rakazo.session_token=tok.sig%3D" },
    });
    expect(await cookie.text()).toBe("tok.sig=");
    expect(await (await app.request("/probe")).text()).toBe("");
  });
});
