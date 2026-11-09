import { describe, expect, it } from "vitest";
import {
  createLivekitTranscript,
  phaseFromAgentState,
  segmentFromStream,
} from "./livekit-call-state";

describe("phaseFromAgentState", () => {
  it("maps the agent's lk.agent.state onto the call card's phases", () => {
    expect(phaseFromAgentState("listening")).toBe("listening");
    expect(phaseFromAgentState("idle")).toBe("listening");
    expect(phaseFromAgentState("thinking")).toBe("thinking");
    expect(phaseFromAgentState("initializing")).toBe("thinking");
    expect(phaseFromAgentState("speaking")).toBe("speaking");
  });

  it("ignores participants that are not the agent", () => {
    expect(phaseFromAgentState(undefined)).toBeNull();
    expect(phaseFromAgentState("")).toBeNull();
    expect(phaseFromAgentState("dancing")).toBeNull();
  });
});

describe("segmentFromStream", () => {
  it("keys a segment by lk.segment_id and reads the final flag", () => {
    const attributes = { "lk.segment_id": "SG_1", "lk.transcription_final": "true" };
    expect(segmentFromStream({ id: "stream-9", attributes }, "user", "hi")).toEqual({
      id: "SG_1",
      role: "user",
      text: "hi",
      final: true,
    });
  });

  it("falls back to the stream id and treats a missing flag as interim", () => {
    expect(segmentFromStream({ id: "stream-9" }, "bot", "hello")).toEqual({
      id: "stream-9",
      role: "bot",
      text: "hello",
      final: false,
    });
  });
});

describe("createLivekitTranscript", () => {
  it("shows the caller's interim words as heard and files the final line as an exchange", () => {
    const transcript = createLivekitTranscript();
    expect(transcript.apply({ id: "u1", role: "user", text: "what is", final: false })).toEqual({
      heard: "what is",
      exchanges: [{ role: "user", text: "what is" }],
    });
    const final = transcript.apply({
      id: "u1",
      role: "user",
      text: "what is the time",
      final: true,
    });
    expect(final.heard).toBe("");
    expect(final.caption).toBeUndefined();
    expect(final.exchanges).toEqual([{ role: "user", text: "what is the time" }]);
  });

  it("streams the bot's words into the caption and keeps the exchange order", () => {
    const transcript = createLivekitTranscript();
    transcript.apply({ id: "u1", role: "user", text: "hello", final: true });
    expect(transcript.apply({ id: "b1", role: "bot", text: "Hi", final: false })).toEqual({
      heard: "",
      caption: "Hi",
      exchanges: [
        { role: "user", text: "hello" },
        { role: "bot", text: "Hi" },
      ],
    });
    const done = transcript.apply({ id: "b1", role: "bot", text: "Hi there.", final: true });
    expect(done.caption).toBe("Hi there.");
    expect(done.exchanges).toEqual([
      { role: "user", text: "hello" },
      { role: "bot", text: "Hi there." },
    ]);
  });

  it("keeps a segment final when a late interim update arrives", () => {
    const transcript = createLivekitTranscript();
    transcript.apply({ id: "u1", role: "user", text: "yes please", final: true });
    const late = transcript.apply({ id: "u1", role: "user", text: "yes", final: false });
    expect(late.heard).toBe("");
    expect(late.exchanges).toEqual([{ role: "user", text: "yes" }]);
  });

  it("leaves blank segments out of the transcript and forgets everything on clear", () => {
    const transcript = createLivekitTranscript();
    expect(
      transcript.apply({ id: "u1", role: "user", text: "  ", final: false }).exchanges,
    ).toEqual([]);
    transcript.apply({ id: "u2", role: "user", text: "bye", final: true });
    transcript.clear();
    expect(
      transcript.apply({ id: "b1", role: "bot", text: "Hello", final: false }).exchanges,
    ).toEqual([{ role: "bot", text: "Hello" }]);
  });
});
