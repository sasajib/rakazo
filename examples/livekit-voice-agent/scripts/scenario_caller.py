#!/usr/bin/env python3
"""A caller that lives the whole conversation, not one utterance at a time.

The scenario (what Shakil actually does on a call):

  1. asks the bot to create another voice agent (task);
  2. as soon as the bot has confirmed it out loud, asks something else while the work runs;
  3. lets the bot answer, then report on the task;
  4. cuts the report off with a third question, mid-sentence;
  5. waits for the answer and for the bot to return to the report.

Everything is event-driven: the caller speaks when the *agent's own words* say it is time (the
agent's live captions, streamed as the audio is spoken), never on a fixed delay, so the run is the
same whether the model took 8 seconds or 40. Prints one JSON line per event for
`scenario_assert.py` to judge; runs in the agent image (needs livekit rtc).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import time
from pathlib import Path

import httpx
from livekit import rtc

SAMPLE_RATE = 48000
FRAME_SAMPLES = SAMPLE_RATE * 20 // 1000
T0 = time.monotonic()


def emit(kind: str, **fields: object) -> None:
    print(json.dumps({"t": round(time.monotonic() - T0, 2), "e": kind, **fields}), flush=True)


def words_after(text: str, marker: str) -> int:
    at = text.lower().find(marker.lower())
    return -1 if at < 0 else len(text[at + len(marker) :].split())


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--token-url", required=True)
    ap.add_argument("--bearer-file", required=True)
    ap.add_argument("--bot-id", required=True)
    ap.add_argument("--space-id", required=True)
    ap.add_argument("--task-pcm", required=True)
    ap.add_argument("--question-pcm", required=True)
    ap.add_argument("--interrupt-pcm", required=True)
    ap.add_argument("--report-marker", default="About your request")
    ap.add_argument("--resume-marker", default="Let me continue")
    ap.add_argument("--max-seconds", type=float, default=240)
    args = ap.parse_args()

    bearer = Path(args.bearer_file).read_text().strip()
    async with httpx.AsyncClient(timeout=30) as http:
        response = await http.post(
            f"{args.token_url.rstrip('/')}/token",
            json={"botId": args.bot_id, "spaceId": args.space_id},
            headers={"authorization": f"Bearer {bearer}", "x-rakazo-space-id": args.space_id},
        )
        response.raise_for_status()
        grant = response.json()
    emit("token", room=grant["room"])

    room = rtc.Room()
    speaking = asyncio.Event()
    last_loud = [0.0]
    # Live captions of the agent, in the order spoken: [(t, text-so-far-of-this-segment)].
    live: dict[str, str] = {}
    order: list[str] = []
    changed = asyncio.Event()
    emitted: set[str] = set()

    async def drain(track: rtc.Track) -> None:
        async for ev in rtc.AudioStream(track):
            raw = memoryview(ev.frame.data)
            data = raw if raw.format == "h" else raw.cast("B").cast("h")
            if any(abs(s) > 400 for s in data[:: max(1, len(data) // 64)]):
                last_loud[0] = time.monotonic()
                if not speaking.is_set():
                    speaking.set()
                    emit("agent_speaking_start")
            elif speaking.is_set() and time.monotonic() - last_loud[0] > 0.8:
                speaking.clear()
                emit("agent_speaking_end")

    @room.on("track_subscribed")
    def _sub(track, pub, participant):  # type: ignore[no-untyped-def]
        if track.kind == rtc.TrackKind.KIND_AUDIO:
            asyncio.ensure_future(drain(track))

    def on_text(reader: rtc.TextStreamReader, identity: str) -> None:
        async def read() -> None:
            attrs = reader.info.attributes or {}
            seg = attrs.get("lk.segment_id", reader.info.stream_id)
            is_agent = not identity.startswith("user-") and identity != room.local_participant.identity
            acc = ""
            async for chunk in reader:
                acc += chunk
                if is_agent:
                    if seg not in live:
                        order.append(seg)
                    live[seg] = acc
                    changed.set()
            emitted.add(seg)
            emit("caption", who="agent" if is_agent else "user", seg=seg, text=acc)

        asyncio.ensure_future(read())

    room.register_text_stream_handler("lk.transcription", on_text)
    await room.connect(grant["url"], grant["token"], options=rtc.RoomOptions(auto_subscribe=True))
    source = rtc.AudioSource(SAMPLE_RATE, 1)
    track = rtc.LocalAudioTrack.create_audio_track("mic", source)
    await room.local_participant.publish_track(
        track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
    )
    silence = rtc.AudioFrame.create(SAMPLE_RATE, 1, FRAME_SAMPLES)
    playing: list[bytes] = []
    stop = asyncio.Event()

    async def mic() -> None:
        while not stop.is_set():
            if playing:
                chunk = playing.pop(0)
                await source.capture_frame(rtc.AudioFrame(chunk, SAMPLE_RATE, 1, len(chunk) // 2))
            else:
                await source.capture_frame(silence)

    mic_task = asyncio.create_task(mic())

    async def say(name: str, pcm: str) -> None:
        data = Path(pcm).read_bytes()
        step = FRAME_SAMPLES * 2
        emit("utterance_start", name=name, during_agent_speech=speaking.is_set())
        for i in range(0, len(data), step):
            chunk = data[i : i + step]
            playing.append(chunk + b"\x00" * (step - len(chunk)))
        while playing:
            await asyncio.sleep(0.05)
        emit("utterance_end", name=name)

    def agent_text_since(mark: int) -> str:
        return " ".join(live[s] for s in order[mark:])

    async def wait_text(pred, since: int, timeout: float, label: str) -> bool:  # type: ignore[no-untyped-def]
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if pred(agent_text_since(since)):
                return True
            changed.clear()
            try:
                await asyncio.wait_for(changed.wait(), 0.5)
            except asyncio.TimeoutError:
                pass
        emit("timeout", waiting_for=label)
        return False

    async def wait_speaking(timeout: float) -> bool:
        try:
            await asyncio.wait_for(speaking.wait(), timeout)
            return True
        except asyncio.TimeoutError:
            return False

    deadline = time.monotonic() + args.max_seconds
    # The greeting.
    if await wait_speaking(30):
        while speaking.is_set():
            await asyncio.sleep(0.1)
    await asyncio.sleep(0.6)

    # 1. the task
    mark1 = len(order)
    speaking.clear()
    await say("task", args.task_pcm)
    heard = await wait_speaking(min(45, deadline - time.monotonic()))
    emit("ack_started", heard=heard)
    # let the confirmation finish — the agent has stopped speaking for a moment AND its words so far
    # end a sentence (a gap between TTS chunks mid-sentence is not the end) — then ask something else
    # while the work is still running
    if heard:
        end = time.monotonic() + 30
        while time.monotonic() < end:
            await asyncio.sleep(0.2)
            text = agent_text_since(mark1).strip()
            if (
                not speaking.is_set()
                and time.monotonic() - last_loud[0] > 1.5
                and text.endswith((".", "!", "?"))
            ):
                break
    await asyncio.sleep(0.8)

    # 2. a second question, while the task runs
    mark2 = len(order)
    await say("question", args.question_pcm)

    # 3. wait for the report on the task to begin, and for some of it to be spoken
    ok = await wait_text(
        lambda t: words_after(t, args.report_marker) >= 7,
        mark2,
        max(10, deadline - time.monotonic() - 60),
        "report on the task",
    )
    emit("barge_in", report_started=ok)

    # 4. cut the report off mid-sentence
    mark3 = len(order)
    await say("interrupt", args.interrupt_pcm)

    # 5. the answer, then the return to the report
    await wait_text(
        lambda t: words_after(t, args.resume_marker) >= 6,
        mark3,
        max(10, deadline - time.monotonic()),
        "return to the report",
    )
    # let the report finish: silent for a few seconds, and the words so far end a sentence
    end = time.monotonic() + 45
    while time.monotonic() < end:
        await asyncio.sleep(0.3)
        text = agent_text_since(mark3).strip()
        if not speaking.is_set() and time.monotonic() - last_loud[0] > 4 and text.endswith((".", "!", "?")):
            break
    await asyncio.sleep(1)
    stop.set()
    await mic_task
    # whatever the agent was still saying has no closing caption: record what was heard so far
    for seg in order:
        if seg not in emitted:
            emit("caption", who="agent", seg=seg, text=live[seg], partial=True)
    await room.disconnect()
    emit("done")


if __name__ == "__main__":
    asyncio.run(main())
