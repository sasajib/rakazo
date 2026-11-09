import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLivekitCallGrant, fetchVoiceAgentConfig } from "./voice-agent";

const grant = { url: "wss://lk.example.com", token: "jwt", room: "rakazo-abc", callId: "abc" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchVoiceAgentConfig", () => {
  it("reads the deployment's call transport with the session cookie", async () => {
    const fetchMock = vi.fn(async () => Response.json({ mode: "livekit" }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchVoiceAgentConfig()).toEqual({ mode: "livekit" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/voice/agent");
    expect(init.credentials).toBe("include");
  });

  it("falls back to the built-in call on an older API or an unknown mode", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 404 }));
    expect(await fetchVoiceAgentConfig()).toEqual({ mode: "builtin" });
    vi.stubGlobal("fetch", async () => Response.json({ mode: "teleport" }));
    expect(await fetchVoiceAgentConfig()).toEqual({ mode: "builtin" });
  });

  it("surfaces a refused request", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ error: "Unauthorized" }, { status: 401 }));
    await expect(fetchVoiceAgentConfig()).rejects.toThrow("Unauthorized");
  });
});

describe("fetchLivekitCallGrant", () => {
  it("posts the bot and returns the room grant", async () => {
    const fetchMock = vi.fn(async () => Response.json(grant));
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchLivekitCallGrant("bot-1")).toEqual(grant);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/voice/agent/token");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ botId: "bot-1" });
  });

  it("reports the server's reason and refuses an incomplete grant", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({ error: "The voice agent is unreachable." }, { status: 502 }),
    );
    await expect(fetchLivekitCallGrant("bot-1")).rejects.toThrow("unreachable");
    vi.stubGlobal("fetch", async () => Response.json({ ...grant, token: "" }));
    await expect(fetchLivekitCallGrant("bot-1")).rejects.toThrow("incomplete");
  });
});
