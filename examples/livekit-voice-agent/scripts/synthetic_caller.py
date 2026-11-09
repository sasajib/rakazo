"""Synthetic caller for an end-to-end test without a browser.

Joins room `rakazo-<callId>` as a user (token from the token server, or minted locally with the
LiveKit key), publishes a microphone track that plays PCM files (48 kHz, mono, s16le) with silence
in between, subscribes to the agent's audio, and prints timestamps:

    utterance_end         the last sample of an utterance was sent
    agent_first_audio     first non-silent audio frame received from the agent
    transcript            text streams on lk.transcription (both sides, as captions would show)

Usage (from the example dir, with the venv):

    python scripts/synthetic_caller.py --pcm hello.pcm --pcm followup.pcm --gap 2.0 \
        --token-url http://127.0.0.1:3320 --bearer-file ./bearer.txt --bot-id <id> --space-id <id>

`--barge-in N` starts the N-th utterance as soon as the agent starts speaking, instead of waiting
for the agent to finish, to exercise interruption.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path

import httpx
from livekit import api, rtc

SAMPLE_RATE = 48000
FRAME_MS = 20
FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS // 1000

t_start = time.monotonic()


def stamp(event: str, **fields: object) -> None:
    print(f"[{time.monotonic() - t_start:7.3f}s] {event} {json.dumps(fields) if fields else ''}", flush=True)


async def get_token(args: argparse.Namespace) -> tuple[str, str, str]:
    if args.token_url:
        bearer = Path(args.bearer_file).read_text().strip()
        async with httpx.AsyncClient(timeout=30) as http:
            response = await http.post(
                f"{args.token_url.rstrip('/')}/token",
                json={"botId": args.bot_id, "spaceId": args.space_id},
                headers={"authorization": f"Bearer {bearer}"},
            )
            response.raise_for_status()
            grant = response.json()
        return args.livekit_url or grant["url"], grant["token"], grant["room"]
    room = args.room or f"rakazo-{os.urandom(8).hex()}"
    from livekit.protocol.agent_dispatch import RoomAgentDispatch
    from livekit.protocol.room import RoomConfiguration

    jwt = (
        api.AccessToken(os.environ["LIVEKIT_API_KEY"], os.environ["LIVEKIT_API_SECRET"])
        .with_identity("synthetic-caller")
        .with_grants(api.VideoGrants(room_join=True, room=room))
        .with_room_config(RoomConfiguration(agents=[RoomAgentDispatch(agent_name=args.agent_name)]))
        .to_jwt()
    )
    return args.livekit_url or os.environ.get("LIVEKIT_URL", "ws://127.0.0.1:7880"), jwt, room


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pcm", action="append", required=True, help="48k mono s16le file; repeatable")
    parser.add_argument("--gap", type=float, default=1.5, help="silence after the agent finishes before the next utterance")
    parser.add_argument("--barge-in", type=int, default=0, help="1-based index of the utterance to start while the agent speaks")
    parser.add_argument("--barge-in-after", type=float, default=1.0, help="seconds of agent speech before barging in")
    parser.add_argument("--token-url")
    parser.add_argument("--bearer-file")
    parser.add_argument("--bot-id")
    parser.add_argument("--space-id")
    parser.add_argument("--room")
    parser.add_argument("--livekit-url")
    parser.add_argument("--agent-name", default=os.environ.get("LIVEKIT_AGENT_NAME", "rakazo-voice"))
    parser.add_argument("--tail", type=float, default=8.0, help="seconds to keep listening after the last utterance")
    args = parser.parse_args()

    url, token, room_name = await get_token(args)
    stamp("token", room=room_name, url=url)

    room = rtc.Room()
    agent_speaking = asyncio.Event()
    agent_first_audio: list[float] = []
    agent_last_audio = [0.0]

    async def drain_remote(track: rtc.Track) -> None:
        stream = rtc.AudioStream(track)
        async for ev in stream:
            frame = ev.frame
            raw = memoryview(frame.data)
            data = raw if raw.format == "h" else raw.cast("B").cast("h")
            loud = any(abs(s) > 400 for s in data[:: max(1, len(data) // 64)])
            if loud:
                now = time.monotonic()
                agent_last_audio[0] = now
                if not agent_first_audio:
                    agent_first_audio.append(now)
                    stamp("agent_first_audio")
                if not agent_speaking.is_set():
                    agent_speaking.set()
                    stamp("agent_speaking_start")
            elif agent_speaking.is_set() and time.monotonic() - agent_last_audio[0] > 0.8:
                agent_speaking.clear()
                stamp("agent_speaking_end")

    @room.on("track_subscribed")
    def _on_track(track: rtc.Track, pub: rtc.RemoteTrackPublication, participant: rtc.RemoteParticipant) -> None:
        stamp("track_subscribed", participant=participant.identity, kind=str(track.kind))
        if track.kind == rtc.TrackKind.KIND_AUDIO:
            asyncio.ensure_future(drain_remote(track))

    @room.on("participant_connected")
    def _on_participant(p: rtc.RemoteParticipant) -> None:
        stamp("participant_connected", identity=p.identity)

    segments: dict[str, str] = {}

    def on_text(reader: rtc.TextStreamReader, participant_identity: str) -> None:
        async def read() -> None:
            text = await reader.read_all()
            seg = (reader.info.attributes or {}).get("lk.segment_id", reader.info.stream_id)
            final = (reader.info.attributes or {}).get("lk.transcription_final") == "true"
            segments[seg] = text
            if final:
                stamp("transcript", who=participant_identity, text=text)

        asyncio.ensure_future(read())

    room.register_text_stream_handler("lk.transcription", on_text)

    await room.connect(url, token, options=rtc.RoomOptions(auto_subscribe=True))
    stamp("connected", identity=room.local_participant.identity)

    source = rtc.AudioSource(SAMPLE_RATE, 1)
    track = rtc.LocalAudioTrack.create_audio_track("mic", source)
    await room.local_participant.publish_track(track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
    stamp("mic_published")

    silence = rtc.AudioFrame.create(SAMPLE_RATE, 1, FRAME_SAMPLES)
    playing: list[bytes] = []
    stop = asyncio.Event()

    async def mic_loop() -> None:
        # Always feed frames so VAD sees a continuous stream; utterances are queued into `playing`.
        while not stop.is_set():
            if playing:
                chunk = playing.pop(0)
                frame = rtc.AudioFrame(chunk, SAMPLE_RATE, 1, len(chunk) // 2)
                await source.capture_frame(frame)
                if not playing:
                    stamp("utterance_end")
            else:
                await source.capture_frame(silence)

    mic_task = asyncio.create_task(mic_loop())

    def queue_pcm(path: str) -> None:
        data = Path(path).read_bytes()
        step = FRAME_SAMPLES * 2
        for i in range(0, len(data), step):
            chunk = data[i : i + step]
            if len(chunk) < step:
                chunk = chunk + b"\x00" * (step - len(chunk))
            playing.append(chunk)
        stamp("utterance_start", file=os.path.basename(path), seconds=round(len(data) / 2 / SAMPLE_RATE, 2))

    async def wait_agent_done(timeout: float = 90) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if agent_speaking.is_set():
                while agent_speaking.is_set() and time.monotonic() < deadline:
                    await asyncio.sleep(0.05)
                return
            await asyncio.sleep(0.05)
        stamp("timeout_waiting_for_agent")

    # Wait for the agent's greeting (its first audio) before speaking.
    await wait_agent_done(60)
    await asyncio.sleep(0.5)

    for index, pcm in enumerate(args.pcm, start=1):
        if args.barge_in == index:
            # start while the agent is still speaking its previous reply
            deadline = time.monotonic() + 90
            while not agent_speaking.is_set() and time.monotonic() < deadline:
                await asyncio.sleep(0.02)
            await asyncio.sleep(args.barge_in_after)
            stamp("barge_in", during_agent_speech=agent_speaking.is_set())
            queue_pcm(pcm)
            while playing:
                await asyncio.sleep(0.05)
            await wait_agent_done()
            continue
        queue_pcm(pcm)
        while playing:
            await asyncio.sleep(0.05)
        # wait for the reply: agent starts speaking, then stops
        deadline = time.monotonic() + 90
        while not agent_speaking.is_set() and time.monotonic() < deadline:
            await asyncio.sleep(0.02)
        if index < len(args.pcm) and args.barge_in == index + 1:
            continue  # next utterance barges in
        await wait_agent_done()
        await asyncio.sleep(args.gap)

    await asyncio.sleep(args.tail)
    stop.set()
    await mic_task
    await room.disconnect()
    stamp("disconnected")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(130)
