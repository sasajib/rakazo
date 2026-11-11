import { describe, expect, it, vi } from "vitest";

vi.mock("./haptics", () => ({ hapticImpact: vi.fn(), hapticSuccess: vi.fn() }));
vi.mock("./monitoring", () => ({ reportMobileError: vi.fn() }));
vi.mock("expo-localization", () => ({ getLocales: () => [{ languageTag: "en-US" }] }));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("expo-file-system", () => ({ File: class {}, Paths: {} }));
vi.mock("./voice", () => ({
  createSpeechOwner: () => Symbol("SpeechOwner"),
  setCallAudio: vi.fn(async () => undefined),
  ensureVoiceConsent: vi.fn(async () => undefined),
  speakText: vi.fn(),
  stopSpeaking: vi.fn(),
}));
vi.mock("./call-sounds", () => ({
  playCallCue: vi.fn(),
  preloadWaitSound: vi.fn(async () => undefined),
  releaseWaitSound: vi.fn(),
  startWaitSound: vi.fn(async () => undefined),
  stopWaitSound: vi.fn(),
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));
vi.mock("./live-notifications", () => ({ stopLiveNotifications: vi.fn(async () => undefined) }));
vi.mock("./thread-feedback", () => ({ clearFailedSends: vi.fn() }));
vi.mock("./network-cache", () => ({ clearNetworkCache: vi.fn() }));

/** The room transport, as call-session sees it: a store of its own behind the same CallState. */
const room = vi.hoisted(() => {
  const watchers = new Set<() => void>();
  const store = {
    state: null as null | Record<string, unknown>,
    startCall: vi.fn((call: { botId: string; botName: string }) => {
      store.state = { ...call, phase: "thinking", muted: false, transcriptOpen: false };
      for (const watcher of watchers) watcher();
    }),
    endCall: vi.fn(() => {
      if (!store.state) return;
      store.state = null;
      for (const watcher of watchers) watcher();
    }),
    toggleMute: vi.fn(() => {
      if (store.state) store.state = { ...store.state, muted: !store.state.muted };
    }),
    toggleTranscript: vi.fn(),
    isActive: () => store.state !== null,
    getSnapshot: () => store.state,
    subscribe: (watcher: () => void) => {
      watchers.add(watcher);
      return () => watchers.delete(watcher);
    },
  };
  return store;
});
vi.mock("./livekit-call-session", () => room);

import type { CallDeps } from "./call-session";
import {
  endCall,
  getSnapshot,
  hangUp,
  startCall,
  subscribe,
  toggleMute,
  toggleTranscript,
} from "./call-session";
import { hapticImpact } from "./haptics";

/** Built-in deps that never touch a device, so a built-in call can start beside the room one. */
const quiet: Partial<CallDeps> = {
  dictate: async () => false,
  record: async () => null,
  transcribe: async () => "",
  send: async () => undefined,
  answer: async () => undefined,
  followUp: async () => undefined,
  endCall: vi.fn(async () => undefined),
  speak: async () => undefined,
  stopSpeaking: () => undefined,
  cue: async () => undefined,
  waitSound: () => undefined,
  watch: () => () => undefined,
};

describe("call-session on the livekit transport", () => {
  it("hands a room call to the LiveKit session and shows it through the same store", () => {
    const watcher = vi.fn();
    const unsubscribe = subscribe(watcher);
    const callId = startCall({
      botId: "bot-1",
      botName: "Max",
      transport: "livekit",
      answered: { callId: "call-7" },
    });
    expect(callId).toBe("call-7");
    expect(room.startCall).toHaveBeenCalledWith(
      expect.objectContaining({ botId: "bot-1", answered: { callId: "call-7" } }),
    );
    expect(getSnapshot()).toMatchObject({ botId: "bot-1", phase: "thinking" });
    expect(watcher).toHaveBeenCalled();
    unsubscribe();
    endCall();
  });

  it("routes mute, transcript and hang-up to the room while it is active", () => {
    startCall({ botId: "bot-1", botName: "Max", transport: "livekit" });
    toggleMute();
    expect(room.toggleMute).toHaveBeenCalledOnce();
    expect(getSnapshot()?.muted).toBe(true);
    toggleTranscript();
    expect(room.toggleTranscript).toHaveBeenCalledOnce();
    hangUp();
    expect(hapticImpact).toHaveBeenCalled();
    expect(room.endCall).toHaveBeenCalled();
    expect(getSnapshot()).toBeNull();
    // Leaving the room is the hang-up: the agent files threads/endCall, this side never does.
    expect(quiet.endCall).not.toHaveBeenCalled();
  });

  it("a fresh room call has no id yet: the server mints it with the grant", () => {
    expect(startCall({ botId: "bot-1", botName: "Max", transport: "livekit" })).toBeUndefined();
    endCall();
  });

  it("starting a built-in call ends the room call, and the other way round", () => {
    startCall({ botId: "bot-1", botName: "Max", transport: "livekit" });
    startCall({ botId: "bot-2", botName: "Eve", transport: "builtin" }, quiet);
    expect(room.endCall).toHaveBeenCalled();
    expect(getSnapshot()?.botId).toBe("bot-2");
    startCall({ botId: "bot-1", botName: "Max", transport: "livekit" });
    expect(getSnapshot()?.botId).toBe("bot-1");
    expect(getSnapshot()?.phase).toBe("thinking");
    endCall();
    expect(getSnapshot()).toBeNull();
  });
});
