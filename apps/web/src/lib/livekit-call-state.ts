import type { CallExchange } from "@rakazo/core";
import type { CallState } from "./call-session.js";

/**
 * Pure state mapping for a LiveKit call, so the room glue in livekit-call-session.ts stays thin
 * and this part is unit-tested without a browser or a room.
 *
 * The agent (livekit-agents AgentSession) publishes its state as the participant attribute
 * `lk.agent.state` and both sides' transcripts as `lk.transcription` text streams carrying
 * `lk.segment_id` and `lk.transcription_final`.
 */

export const AGENT_STATE_ATTRIBUTE = "lk.agent.state";
export const TRANSCRIPTION_TOPIC = "lk.transcription";
export const SEGMENT_ID_ATTRIBUTE = "lk.segment_id";
export const TRANSCRIPTION_FINAL_ATTRIBUTE = "lk.transcription_final";

export type CallPhase = CallState["phase"];

/** The agent's `lk.agent.state`, mapped onto the phases CallCard already renders. */
export function phaseFromAgentState(value: string | undefined): CallPhase | null {
  switch (value) {
    case "listening":
    case "idle":
      return "listening";
    case "thinking":
    case "initializing":
      return "thinking";
    case "speaking":
      return "speaking";
    default:
      return null;
  }
}

export interface TranscriptSegment {
  id: string;
  role: CallExchange["role"];
  text: string;
  final: boolean;
}

export interface TranscriptView {
  /** What the caller is saying right now; empty once their utterance is final. */
  heard: string;
  /** The bot's latest line, if this segment came from the bot; absent leaves the caption alone. */
  caption?: string;
  exchanges: CallExchange[];
}

/**
 * Keeps one call's transcript in arrival order. A segment arrives many times while it streams
 * (interim user transcripts, the bot's words as they are spoken); each arrival carries the
 * segment's full text so far and replaces the previous one.
 */
export function createLivekitTranscript() {
  const segments = new Map<string, TranscriptSegment>();
  return {
    apply(segment: TranscriptSegment): TranscriptView {
      const previous = segments.get(segment.id);
      // A final arriving before a late interim must stay final.
      segments.set(segment.id, {
        ...segment,
        final: segment.final || Boolean(previous?.final),
      });
      const all = [...segments.values()];
      const liveUser = all.findLast((entry) => entry.role === "user" && !entry.final);
      const view: TranscriptView = {
        heard: liveUser?.text ?? "",
        exchanges: all
          .filter((entry) => entry.text.trim())
          .map(({ role, text }) => ({ role, text })),
      };
      if (segment.role === "bot") view.caption = segment.text;
      return view;
    },
    clear() {
      segments.clear();
    },
  };
}

/** The text stream's attributes, as livekit-client hands them over. */
export function segmentFromStream(
  info: { id: string; attributes?: Record<string, string> },
  role: CallExchange["role"],
  text: string,
): TranscriptSegment {
  const attributes = info.attributes ?? {};
  return {
    id: attributes[SEGMENT_ID_ATTRIBUTE] || info.id,
    role,
    text,
    final: attributes[TRANSCRIPTION_FINAL_ATTRIBUTE] === "true",
  };
}
