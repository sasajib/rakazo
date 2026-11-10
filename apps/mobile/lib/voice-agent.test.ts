import { describe, expect, it, vi } from "vitest";

vi.mock("./i18n", () => ({ t: (value: string) => value }));
const fake = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("./server-headers", () => ({
  fetchServer: (input: string, init: RequestInit) => fake.fetch(input, init),
}));

import { fetchLivekitCallGrant, fetchVoiceAgentConfig, resolveCallTransport } from "./voice-agent";

const context = {
  apiBase: "https://rakazo.example.invalid",
  headers: { authorization: "Bearer session", "x-rakazo-space-id": "space-1" },
};
const signal = new AbortController().signal;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("voice agent config", () => {
  it("reads the deployment's call transport with the caller's session and Space", async () => {
    fake.fetch.mockResolvedValueOnce(json({ mode: "livekit", livekitUrl: "wss://lk" }));
    await expect(fetchVoiceAgentConfig(context, signal)).resolves.toEqual({ mode: "livekit" });
    expect(fake.fetch).toHaveBeenCalledWith(
      "https://rakazo.example.invalid/api/voice/agent",
      expect.objectContaining({ headers: expect.objectContaining(context.headers) }),
    );
  });

  it("treats an older API without the route as the built-in call", async () => {
    fake.fetch.mockResolvedValueOnce(new Response("not found", { status: 404 }));
    await expect(fetchVoiceAgentConfig(context, signal)).resolves.toEqual({ mode: "builtin" });
    fake.fetch.mockResolvedValueOnce(json({ mode: "builtin" }));
    await expect(fetchVoiceAgentConfig(context, signal)).resolves.toEqual({ mode: "builtin" });
  });

  it("surfaces the API's refusal", async () => {
    fake.fetch.mockResolvedValueOnce(json({ error: "Calls are off." }, 403));
    await expect(fetchVoiceAgentConfig(context, signal)).rejects.toThrow("Calls are off.");
    fake.fetch.mockResolvedValueOnce(new Response("", { status: 401 }));
    await expect(fetchVoiceAgentConfig(context, signal)).rejects.toThrow("Sign in again");
  });
});

describe("resolveCallTransport", () => {
  it("picks the room when the API has a voice agent", async () => {
    await expect(resolveCallTransport(async () => ({ mode: "livekit" }))).resolves.toBe("livekit");
    await expect(resolveCallTransport(async () => ({ mode: "builtin" }))).resolves.toBe("builtin");
  });

  it("falls back to the built-in call when the lookup fails", async () => {
    await expect(
      resolveCallTransport(async () => {
        throw new Error("offline");
      }),
    ).resolves.toBe("builtin");
  });
});

describe("fetchLivekitCallGrant", () => {
  it("asks for a fresh call's room, or the answered call's own", async () => {
    const grant = { url: "wss://lk", token: "jwt", room: "rakazo-abc123", callId: "abc123" };
    fake.fetch.mockResolvedValueOnce(json(grant));
    await expect(fetchLivekitCallGrant("bot-1", context, signal)).resolves.toEqual(grant);
    expect(JSON.parse(fake.fetch.mock.lastCall?.[1].body as string)).toEqual({ botId: "bot-1" });
    fake.fetch.mockResolvedValueOnce(json({ ...grant, room: "rakazo-call-7", callId: "call-7" }));
    await fetchLivekitCallGrant("bot-1", context, signal, "call-7");
    expect(JSON.parse(fake.fetch.mock.lastCall?.[1].body as string)).toEqual({
      botId: "bot-1",
      callId: "call-7",
    });
  });

  it("rejects an incomplete grant", async () => {
    fake.fetch.mockResolvedValueOnce(json({ url: "wss://lk" }));
    await expect(fetchLivekitCallGrant("bot-1", context, signal)).rejects.toThrow(
      "Could not start the call.",
    );
  });
});
