import { t } from "@lingui/core/macro";
import type { BotAvatarSet } from "@rakazo/contracts";
import type { Room } from "livekit-client";
import type { CallState } from "./call-session.js";
import {
  AGENT_STATE_ATTRIBUTE,
  createLivekitTranscript,
  phaseFromAgentState,
  segmentFromStream,
  TRANSCRIPTION_TOPIC,
} from "./livekit-call-state.js";
import { reportClientError } from "./monitoring";
import { errorText } from "./user-error";
import { fetchLivekitCallGrant } from "./voice-agent.js";

/**
 * A call held in a LiveKit room with the deployment's voice agent (examples/livekit-voice-agent).
 *
 * The browser only moves audio and shows what the agent reports: the agent listens, talks to the
 * bot's thread as the caller, speaks the reply, handles barge-in, and closes the call server-side
 * (threads/endCall) when the room empties. This module exposes the same CallState as the
 * built-in call-session.ts, which delegates here while a room call is active, so CallCard and
 * CallLayout render either transport unchanged.
 */

let state: CallState | null = null;
let room: Room | null = null;
/** Cancels a call still fetching its grant or connecting. */
let starting: AbortController | null = null;
let audio: HTMLMediaElement[] = [];
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
}

export function startCall(call: LivekitCallStart): void {
  endCall();
  transcript.clear();
  state = {
    botId: call.botId,
    botName: call.botName,
    botColor: call.botColor ?? "",
    botAvatarSet: call.botAvatarSet,
    connectedAt: null,
    phase: "ringing",
    muted: false,
    minimized: false,
    transcriptOpen: false,
    caption: "",
    heard: "",
    exchanges: [],
  };
  emit();
  const controller = new AbortController();
  starting = controller;
  void connect(call.botId, controller).catch((error: unknown) => {
    if (controller.signal.aborted || starting !== controller) return;
    starting = null;
    reportClientError(error, "voice.turn");
    // Shown where the built-in call shows its own failures, then the call closes.
    set({ caption: errorText(error, t`Could not start the call`), phase: "listening" });
    setTimeout(() => {
      if (state && state.botId === call.botId && !room) dropCall();
    }, 2_500);
  });
}

async function connect(botId: string, controller: AbortController) {
  const grant = await fetchLivekitCallGrant(botId, controller.signal);
  if (controller.signal.aborted) return;
  const { Room, RoomEvent, Track } = await import("livekit-client");
  if (controller.signal.aborted) return;
  const next = new Room({
    adaptiveStream: false,
    dynacast: false,
    // Speakers feed the bot's voice back into the mic; without these the agent hears itself.
    audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const agentJoined = (attributes: Readonly<Record<string, string>>) => {
    const phase = phaseFromAgentState(attributes[AGENT_STATE_ATTRIBUTE]);
    if (!phase || !state) return;
    if (state.phase === "ringing") set({ connectedAt: Date.now() });
    // The reply is over: its caption goes with it, as the built-in speaker's idle does.
    set(phase === "listening" ? { phase, caption: "" } : { phase });
  };
  next.on(RoomEvent.ParticipantConnected, (participant) => agentJoined(participant.attributes));
  next.on(RoomEvent.ParticipantAttributesChanged, (_changed, participant) => {
    if (participant.identity !== next.localParticipant.identity)
      agentJoined(participant.attributes);
  });
  next.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind !== Track.Kind.Audio) return;
    const element = track.attach();
    audio.push(element);
    element.play?.()?.catch(() => undefined);
  });
  // The agent left: it hung up (the bot's end_call) or crashed. Either way the call is over here;
  // the agent files threads/endCall itself, so this side never does.
  next.on(RoomEvent.ParticipantDisconnected, () => {
    if (room === next && next.remoteParticipants.size === 0) void endCall();
  });
  next.on(RoomEvent.Disconnected, () => {
    if (room === next) dropCall();
  });
  next.on(RoomEvent.MediaDevicesError, (error) => {
    reportClientError(error, "voice.microphone");
    set({ caption: errorText(error, t`Microphone failed`) });
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
  await next.connect(grant.url, grant.token, { autoSubscribe: true });
  if (controller.signal.aborted) {
    await next.disconnect();
    return;
  }
  room = next;
  starting = null;
  for (const participant of next.remoteParticipants.values()) agentJoined(participant.attributes);
  try {
    await next.localParticipant.setMicrophoneEnabled(!state?.muted);
  } catch (error) {
    reportClientError(error, "voice.microphone");
    set({ caption: errorText(error, t`Microphone failed`) });
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
  for (const element of audio) {
    element.pause?.();
    element.remove();
  }
  audio = [];
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
    reportClientError(error, "voice.microphone");
    set({ caption: errorText(error, t`Microphone failed`) });
  });
}

export function toggleTranscript(): void {
  if (!state) return;
  set({ transcriptOpen: !state.transcriptOpen });
}

export function setCallMinimized(minimized: boolean): void {
  if (!state) return;
  set({ minimized });
}
