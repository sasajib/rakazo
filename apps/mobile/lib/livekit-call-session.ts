import { t } from "@lingui/core/macro";
import type { BotAvatarSet } from "@rakazo/contracts";
import {
  AGENT_STATE_ATTRIBUTE,
  createLivekitTranscript,
  phaseFromAgentState,
  segmentFromStream,
  TRANSCRIPTION_TOPIC,
} from "@rakazo/core";
import type { Room, RoomOptions } from "livekit-client";
import type { ApiRequestContext } from "./api";
import { captureApiRequestContext } from "./api";
import type { CallState } from "./call-session";
import { hapticSuccess } from "./haptics";
import { reportMobileError } from "./monitoring";
import { errorText } from "./user-error";
import type { LivekitCallGrant } from "./voice-agent";
import { fetchLivekitCallGrant } from "./voice-agent";

/**
 * A call held in a LiveKit room with the deployment's voice agent (examples/livekit-voice-agent),
 * mirroring apps/web/src/lib/livekit-call-session.ts.
 *
 * The phone only moves audio and shows what the agent reports: the agent listens, talks to the
 * bot's thread as the caller, speaks the reply, handles barge-in, and closes the call server-side
 * (threads/endCall) when the room empties. This module exposes the same CallState as the
 * built-in call-session.ts, which delegates here while a room call is active, so CallCard
 * renders either transport unchanged.
 */

/** Everything that touches the device, the native SDK or the server, so the glue stays testable. */
export type LivekitCallDeps = {
  grant: (botId: string, signal: AbortSignal, callId?: string) => Promise<LivekitCallGrant>;
  /** True once the microphone may be used; the room is not joined without it. */
  requestMicrophone: () => Promise<boolean>;
  /** Puts the device in voice-call audio mode (earpiece/speaker routing, echo cancelling). */
  audioSession: (action: "start" | "stop") => Promise<void>;
  createRoom: (options: RoomOptions) => Promise<Room>;
};

let state: CallState | null = null;
let room: Room | null = null;
/** Cancels a call still fetching its grant or connecting. */
let starting: AbortController | null = null;
let deps: LivekitCallDeps | null = null;
const transcript = createLivekitTranscript();
const watchers = new Set<() => void>();

export function subscribe(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}

export function getSnapshot(): CallState | null {
  return state;
}

export function isActive(): boolean {
  return state !== null;
}

function emit() {
  for (const watcher of [...watchers]) watcher();
}

function set(patch: Partial<CallState>) {
  if (!state) return;
  state = { ...state, ...patch };
  emit();
}

export interface LivekitCallStart {
  botId: string;
  botName: string;
  botColor?: string;
  botAvatarSet?: BotAvatarSet;
  /**
   * The bot called and the user picked up: the room takes the request's call id and the agent
   * opens with the bot's line.
   */
  answered?: { callId: string };
  /** The Space and session the call belongs to; captured now when absent. */
  requestContext?: ApiRequestContext;
}

export function startCall(call: LivekitCallStart, overrides: Partial<LivekitCallDeps> = {}): void {
  endCall();
  transcript.clear();
  deps = { ...productionDeps(call.requestContext), ...overrides };
  state = {
    botId: call.botId,
    botName: call.botName,
    botColor: call.botColor ?? "",
    botAvatarSet: call.botAvatarSet,
    // Nothing to hear yet: the waveform holds still until the agent reports its state.
    phase: "thinking",
    muted: false,
    transcriptOpen: false,
    caption: t`Connecting…`,
    heard: "",
    exchanges: [],
  };
  emit();
  const controller = new AbortController();
  starting = controller;
  void connect(call.botId, controller, call.answered?.callId).catch((error: unknown) => {
    if (controller.signal.aborted || starting !== controller) return;
    starting = null;
    reportMobileError(error, "voice.turn");
    // Shown where the built-in call shows its own failures, then the call closes.
    set({ caption: errorText(error, t`Could not start the call.`), phase: "listening" });
    setTimeout(() => {
      if (state && state.botId === call.botId && !room) dropCall();
    }, 2_500);
  });
}

async function connect(botId: string, controller: AbortController, callId?: string) {
  const own = deps;
  if (!own) return;
  const { signal } = controller;
  if (!(await own.requestMicrophone())) {
    throw new Error(t`Allow microphone access to call a bot.`);
  }
  if (signal.aborted) return;
  const grant = await own.grant(botId, signal, callId);
  if (signal.aborted) return;
  const { RoomEvent } = await import("livekit-client");
  const next = await own.createRoom({
    adaptiveStream: false,
    dynacast: false,
    // The speaker feeds the bot's voice back into the microphone; without these the agent
    // hears itself.
    audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  if (signal.aborted) return;
  const agentReported = (attributes: Readonly<Record<string, string>>) => {
    const phase = phaseFromAgentState(attributes[AGENT_STATE_ATTRIBUTE]);
    if (!phase || !state) return;
    // The reply is over: its caption goes with it, as the built-in speaker's idle does.
    set(phase === "listening" ? { phase, caption: "" } : { phase });
  };
  next.on(RoomEvent.ParticipantConnected, (participant) => agentReported(participant.attributes));
  next.on(RoomEvent.ParticipantAttributesChanged, (_changed, participant) => {
    if (participant.identity !== next.localParticipant.identity)
      agentReported(participant.attributes);
  });
  // The agent left: it hung up (the bot's end_call) or crashed. Either way the call is over here;
  // the agent files threads/endCall itself, so this side never does.
  next.on(RoomEvent.ParticipantDisconnected, () => {
    if (room === next && next.remoteParticipants.size === 0) endCall();
  });
  next.on(RoomEvent.Disconnected, () => {
    if (room === next) dropCall();
  });
  next.on(RoomEvent.MediaDevicesError, (error) => {
    reportMobileError(error, "voice.microphone");
    set({ caption: errorText(error, t`Microphone failed.`) });
  });
  next.registerTextStreamHandler(TRANSCRIPTION_TOPIC, async (reader, participant) => {
    // The agent sends the caller's own transcript under the caller's identity.
    const role = participant.identity === next.localParticipant.identity ? "user" : "bot";
    let text = "";
    const show = () => {
      if (room !== next || !state) return;
      const view = transcript.apply(segmentFromStream(reader.info, role, text));
      set(view.caption === undefined ? { heard: view.heard, exchanges: view.exchanges } : view);
    };
    for await (const chunk of reader) {
      text += chunk;
      show();
    }
    show();
  });
  await own.audioSession("start").catch((error: unknown) => {
    reportMobileError(error, "voice.microphone");
  });
  await next.connect(grant.url, grant.token, { autoSubscribe: true });
  if (signal.aborted) {
    await next.disconnect();
    return;
  }
  room = next;
  starting = null;
  hapticSuccess();
  // The agent may have joined first; a connecting caption that outlives it would be stale.
  if (state?.caption === t`Connecting…`) set({ caption: "" });
  for (const participant of next.remoteParticipants.values()) agentReported(participant.attributes);
  try {
    await next.localParticipant.setMicrophoneEnabled(!state?.muted);
  } catch (error) {
    reportMobileError(error, "voice.microphone");
    set({ caption: errorText(error, t`Microphone failed.`) });
  }
}

/** Leaves the room; the agent notices and closes the call on the server. */
export function endCall(): void {
  starting?.abort();
  starting = null;
  const leaving = room;
  room = null;
  if (leaving) void leaving.disconnect().catch(() => undefined);
  dropCall();
}

/** Clears this device's view of the call. */
function dropCall(): void {
  const own = deps;
  deps = null;
  if (own && state) void own.audioSession("stop").catch(() => undefined);
  transcript.clear();
  if (state) {
    state = null;
    emit();
  }
}

export function toggleMute(): void {
  if (!state) return;
  const muted = !state.muted;
  set({ muted, heard: muted ? "" : state.heard });
  void room?.localParticipant.setMicrophoneEnabled(!muted).catch((error: unknown) => {
    reportMobileError(error, "voice.microphone");
    set({ caption: errorText(error, t`Microphone failed.`) });
  });
}

export function toggleTranscript(): void {
  if (!state) return;
  set({ transcriptOpen: !state.transcriptOpen });
}

let globalsRegistered = false;

/** The WebRTC globals livekit-client expects, from the native SDK; once per process. */
async function loadNativeSdk() {
  const sdk = await import("@livekit/react-native");
  if (!globalsRegistered) {
    sdk.registerGlobals();
    globalsRegistered = true;
  }
  return sdk;
}

function productionDeps(requestContext?: ApiRequestContext): LivekitCallDeps {
  return {
    grant: async (botId, signal, callId) =>
      fetchLivekitCallGrant(
        botId,
        requestContext ?? (await captureApiRequestContext()),
        signal,
        callId,
      ),
    requestMicrophone: async () => {
      const { AudioModule } = await import("expo-audio");
      return (await AudioModule.requestRecordingPermissionsAsync()).granted;
    },
    audioSession: async (action) => {
      const { AndroidAudioTypePresets, AudioSession } = await loadNativeSdk();
      if (action === "stop") {
        await AudioSession.stopAudioSession();
        return;
      }
      await AudioSession.configureAudio({
        android: { audioTypeOptions: AndroidAudioTypePresets.communication },
        ios: { defaultOutput: "speaker" },
      });
      await AudioSession.startAudioSession();
    },
    createRoom: async (options) => {
      await loadNativeSdk();
      const { Room } = await import("livekit-client");
      return new Room(options);
    },
  };
}
