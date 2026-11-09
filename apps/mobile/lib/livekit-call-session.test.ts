import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./haptics", () => ({ hapticImpact: vi.fn(), hapticSuccess: vi.fn() }));
vi.mock("./monitoring", () => ({ reportMobileError: vi.fn() }));
vi.mock("./i18n", () => ({ t: (value: string) => value }));
vi.mock("./api", () => ({
  captureApiRequestContext: async () => ({ apiBase: "https://example.invalid", headers: {} }),
}));
vi.mock("./voice-agent", () => ({ fetchLivekitCallGrant: vi.fn() }));

import type { Room } from "livekit-client";
import { RoomEvent } from "livekit-client";
import type { LivekitCallDeps } from "./livekit-call-session";
import {
  endCall,
  getSnapshot,
  isActive,
  startCall,
  subscribe,
  toggleMute,
  toggleTranscript,
} from "./livekit-call-session";
import type { LivekitCallGrant } from "./voice-agent";

type Listener = (...args: unknown[]) => void;
type StreamHandler = (
  reader: {
    info: { id: string; attributes?: Record<string, string> };
    [Symbol.asyncIterator]: () => AsyncIterator<string>;
  },
  participant: { identity: string },
) => Promise<void>;

/** A room that records what the call asked of it and lets the test play the agent. */
function fakeRoom() {
  const listeners = new Map<string, Listener[]>();
  const remote = new Map<string, { identity: string; attributes: Record<string, string> }>();
  let streamHandler: StreamHandler | undefined;
  const room = {
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    localParticipant: { identity: "user-1", setMicrophoneEnabled: vi.fn(async () => undefined) },
    remoteParticipants: remote,
    on(event: string, listener: Listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return room;
    },
    registerTextStreamHandler(_topic: string, handler: StreamHandler) {
      streamHandler = handler;
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
    agentJoins(state: string) {
      const agent = { identity: "agent-1", attributes: { "lk.agent.state": state } };
      remote.set(agent.identity, agent);
      room.emit(RoomEvent.ParticipantConnected, agent);
      return agent;
    },
    agentState(state: string) {
      const agent = remote.get("agent-1");
      if (!agent) throw new Error("no agent");
      agent.attributes = { "lk.agent.state": state };
      room.emit(RoomEvent.ParticipantAttributesChanged, agent.attributes, agent);
    },
    agentLeaves() {
      remote.clear();
      room.emit(RoomEvent.ParticipantDisconnected, {});
    },
    async stream(identity: string, segment: { id: string; final?: boolean }, ...chunks: string[]) {
      if (!streamHandler) throw new Error("no transcription handler");
      await streamHandler(
        {
          info: {
            id: `stream-${segment.id}`,
            attributes: {
              "lk.segment_id": segment.id,
              ...(segment.final ? { "lk.transcription_final": "true" } : {}),
            },
          },
          async *[Symbol.asyncIterator]() {
            for (const chunk of chunks) yield chunk;
          },
        },
        { identity },
      );
    },
  };
  return room;
}

function fakeDeps(room: ReturnType<typeof fakeRoom>, overrides: Partial<LivekitCallDeps> = {}) {
  const deps = {
    grant: vi.fn(async (_botId: string, _signal: AbortSignal, callId?: string) => ({
      url: "wss://lk.example.invalid",
      token: "grant-token",
      room: `rakazo-${callId ?? "fresh"}`,
      callId: callId ?? "fresh",
    })),
    requestMicrophone: vi.fn(async () => true),
    audioSession: vi.fn(async () => undefined),
    createRoom: vi.fn(async () => room as unknown as Room),
    ...overrides,
  };
  return deps;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  endCall();
  vi.useRealTimers();
});

describe("mobile LiveKit call", () => {
  it("joins the room with the caller's microphone and shows the agent's state", async () => {
    const room = fakeRoom();
    const deps = fakeDeps(room);
    const watcher = vi.fn();
    subscribe(watcher);
    startCall({ botId: "bot-1", botName: "Max" }, deps);
    expect(getSnapshot()).toMatchObject({
      botId: "bot-1",
      phase: "thinking",
      caption: "Connecting…",
      muted: false,
    });
    expect(isActive()).toBe(true);
    await flush();
    expect(deps.grant).toHaveBeenCalledWith("bot-1", expect.any(AbortSignal), undefined);
    expect(deps.audioSession).toHaveBeenCalledWith("start");
    expect(room.connect).toHaveBeenCalledWith("wss://lk.example.invalid", "grant-token", {
      autoSubscribe: true,
    });
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
    expect(getSnapshot()?.caption).toBe("");
    room.agentJoins("listening");
    expect(getSnapshot()?.phase).toBe("listening");
    room.agentState("speaking");
    expect(getSnapshot()?.phase).toBe("speaking");
    expect(watcher).toHaveBeenCalled();
  });

  it("keeps an answered call's id so the room is the bot's own call", async () => {
    const room = fakeRoom();
    const deps = fakeDeps(room);
    startCall({ botId: "bot-1", botName: "Max", answered: { callId: "call-7" } }, deps);
    await flush();
    expect(deps.grant).toHaveBeenCalledWith("bot-1", expect.any(AbortSignal), "call-7");
  });

  it("asks for the microphone before any grant, and gives up without it", async () => {
    vi.useFakeTimers();
    const room = fakeRoom();
    const deps = fakeDeps(room, { requestMicrophone: vi.fn(async () => false) });
    startCall({ botId: "bot-1", botName: "Max" }, deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.grant).not.toHaveBeenCalled();
    expect(getSnapshot()?.caption).toBe("Allow microphone access to call a bot.");
    await vi.advanceTimersByTimeAsync(2_500);
    expect(getSnapshot()).toBeNull();
  });

  it("shows the transcript as the agent streams it", async () => {
    const room = fakeRoom();
    startCall({ botId: "bot-1", botName: "Max" }, fakeDeps(room));
    await flush();
    room.agentJoins("listening");
    await room.stream("user-1", { id: "u1" }, "What time", " is it");
    expect(getSnapshot()).toMatchObject({
      heard: "What time is it",
      exchanges: [{ role: "user", text: "What time is it" }],
    });
    await room.stream("user-1", { id: "u1", final: true }, "What time is it?");
    expect(getSnapshot()?.heard).toBe("");
    await room.stream("agent-1", { id: "b1" }, "It is ", "noon.");
    expect(getSnapshot()).toMatchObject({
      caption: "It is noon.",
      exchanges: [
        { role: "user", text: "What time is it?" },
        { role: "bot", text: "It is noon." },
      ],
    });
    room.agentState("listening");
    expect(getSnapshot()?.caption).toBe("");
  });

  it("mutes by disabling the microphone track, never by leaving", async () => {
    const room = fakeRoom();
    startCall({ botId: "bot-1", botName: "Max" }, fakeDeps(room));
    await flush();
    toggleMute();
    expect(getSnapshot()?.muted).toBe(true);
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(false);
    toggleMute();
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(true);
    expect(room.disconnect).not.toHaveBeenCalled();
    toggleTranscript();
    expect(getSnapshot()?.transcriptOpen).toBe(true);
  });

  it("hangs up by leaving the room and releases the audio session", async () => {
    const room = fakeRoom();
    const deps = fakeDeps(room);
    startCall({ botId: "bot-1", botName: "Max" }, deps);
    await flush();
    endCall();
    expect(room.disconnect).toHaveBeenCalledOnce();
    expect(deps.audioSession).toHaveBeenLastCalledWith("stop");
    expect(getSnapshot()).toBeNull();
  });

  it("ends when the agent leaves: it hung up and files the call itself", async () => {
    const room = fakeRoom();
    startCall({ botId: "bot-1", botName: "Max" }, fakeDeps(room));
    await flush();
    room.agentJoins("speaking");
    room.agentLeaves();
    expect(room.disconnect).toHaveBeenCalledOnce();
    expect(getSnapshot()).toBeNull();
  });

  it("drops a call the server would not grant, after showing why", async () => {
    vi.useFakeTimers();
    const room = fakeRoom();
    const deps = fakeDeps(room, {
      grant: vi.fn(async () => {
        throw new Error("Calls are off for this Space.");
      }),
    });
    startCall({ botId: "bot-1", botName: "Max" }, deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(getSnapshot()?.caption).toBe("Calls are off for this Space.");
    expect(room.connect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(getSnapshot()).toBeNull();
  });

  it("leaves a room it joined after the caller already hung up", async () => {
    const room = fakeRoom();
    let release: (() => void) | undefined;
    const deps = fakeDeps(room, {
      grant: vi.fn(
        () =>
          new Promise<LivekitCallGrant>((resolve) => {
            release = () =>
              resolve({ url: "wss://x", token: "t", room: "rakazo-fresh", callId: "fresh" });
          }),
      ),
    });
    startCall({ botId: "bot-1", botName: "Max" }, deps);
    await flush();
    endCall();
    release?.();
    await flush();
    expect(room.connect).not.toHaveBeenCalled();
    expect(getSnapshot()).toBeNull();
  });
});
