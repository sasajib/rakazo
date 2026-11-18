"""Gate for the local speech plugins, run inside the agent image (no Rakazo account needed).

    docker compose run --rm --entrypoint python agent scripts/check_local_speech.py

Checks, against the real service and the real LiveKit plugin classes:

1. STT: `make_stt()` is the streaming plugin; audio is pushed as LiveKit frames at real time, and the test
   reports the interim transcripts, the final transcript, its latency after `flush()` and its words against
   the sentence that was spoken. Fails if the final arrives later than 1.2 s after the flush (that threshold
   is the whole point of streaming: a batch decode of the same utterance takes ~2 s here) or if words are
   missing.
2. TTS: `make_tts()` speaks one sentence; the test reports the time to the first audio frame and the total
   audio length, and fails if the first frame takes longer than 1.5 s or the audio is short.

Both are measured through the same classes the call uses, so a green run means the call path can speak and
hear - it does not prove a Rakazo run answers, which is what `scripts/call_assert.py` covers.
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
import urllib.request

import numpy as np
from livekit import rtc

SPOKEN = (
    "Okay Shakil, here is the plan. I will create a new voice testing agent called Harness Check, "
    "then I will run two short calls against it."
)
BASE = "http://rakazo-speech-local:8890"


def synth(text: str, voice: str = "amy") -> tuple[bytes, int]:
    body = json.dumps({"input": text, "voice": voice, "response_format": "wav"}).encode()
    req = urllib.request.Request(f"{BASE}/v1/audio/speech", data=body, headers={"Content-Type": "application/json"})
    raw = urllib.request.urlopen(req, timeout=180).read()
    import io
    import wave

    with wave.open(io.BytesIO(raw)) as w:
        rate = w.getframerate()
        return w.readframes(w.getnframes()), rate


async def check_stt() -> list[str]:
    from agent import make_stt  # the module under test, with the deployment's env

    failures: list[str] = []
    stt, detection = make_stt()
    print(f"1. STT plugin: {type(stt).__name__} (turn detection: {detection or 'VAD + endpointing'})")
    if type(stt).__name__ != "LocalStreamingSTT":
        print("   note: not the streaming plugin (LOCAL_STT_STREAM=0?)")
    else:
        # The wiring that matters: LiveKit only flushes a stream that declares it, and a streaming STT that is
        # never flushed never produces its final transcript.
        caps = stt.capabilities
        print(f"   capabilities: streaming={caps.streaming} interim={caps.interim_results} manual_flush={caps.manual_flush}")
        if not (caps.streaming and caps.manual_flush):
            failures.append("capabilities must be streaming=True and manual_flush=True to be flushed on VAD end")

    pcm, rate = synth(SPOKEN)
    x = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    n = int(round(len(x) * 16000 / rate))
    x16 = (np.clip(np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x), -1, 1) * 32767).astype(np.int16)
    frame = 320  # 20 ms at 16 kHz
    print(f"   speaking {len(x16) / 16000:.1f}s into the stream")

    stream = stt.stream()
    finals: list[str] = []
    interims: list[str] = []
    first_interim = 0.0
    flush_at = 0.0

    async def reader() -> None:
        nonlocal first_interim
        async for event in stream:
            from livekit.agents import stt as stt_mod

            if event.type == stt_mod.SpeechEventType.INTERIM_TRANSCRIPT:
                text = event.alternatives[0].text
                interims.append(text)
                if not first_interim:
                    first_interim = time.monotonic() - started
            elif event.type == stt_mod.SpeechEventType.FINAL_TRANSCRIPT:
                finals.append(event.alternatives[0].text)
                print(f"   final {time.monotonic() - flush_at:.2f}s after the flush: {finals[-1][:80]!r}")
                return

    started = time.monotonic()
    read = asyncio.create_task(reader())
    for offset in range(0, len(x16), frame):
        chunk = x16[offset : offset + frame]
        stream.push_frame(rtc.AudioFrame(chunk.tobytes(), 16000, 1, len(chunk)))
        await asyncio.sleep(len(chunk) / 16000)  # real time, like a caller
    for _ in range(25):  # the caller stops; the VAD sees half a second of silence
        silence = np.zeros(frame, dtype=np.int16)
        stream.push_frame(rtc.AudioFrame(silence.tobytes(), 16000, 1, frame))
        await asyncio.sleep(0.02)
    flush_at = time.monotonic()
    stream.flush()
    try:
        await asyncio.wait_for(read, timeout=15)
    except asyncio.TimeoutError:
        failures.append("no final transcript within 15 s of the flush")
    await stream.aclose()

    latency = time.monotonic() - flush_at if finals else 0.0
    print(f"   {len(interims)} interim transcripts, first after {first_interim:.2f}s")
    text = finals[-1] if finals else ""
    spoken = [w.strip(".,").lower() for w in SPOKEN.split()]
    heard = text.lower()
    missing = [w for w in spoken if w not in heard]
    if missing:
        failures.append(f"final lost words: {missing[:8]}")
    if finals and latency > 1.2:
        failures.append(f"final took {latency:.2f}s after the flush (budget 1.2 s)")
    return failures


async def check_tts() -> list[str]:
    from agent import make_tts

    failures: list[str] = []
    tts = make_tts()
    print(f"2. TTS plugin: {type(tts).__name__}")
    sentence = "On it, Shakil. I will create the voice testing agent now and report back when it is done."
    started = time.monotonic()
    first = 0.0
    samples = 0
    rate = 0
    async for event in tts.synthesize(sentence):
        if first == 0.0 and getattr(event, "frame", None) is not None:
            first = time.monotonic() - started
            rate = event.frame.sample_rate
        if getattr(event, "frame", None) is not None:
            samples += event.frame.samples_per_channel
    seconds = samples / rate if rate else 0.0
    print(f"   first audio {first:.2f}s, {seconds:.2f}s of audio at {rate} Hz")
    if first > 1.5:
        failures.append(f"first audio after {first:.2f}s (budget 1.5 s)")
    if seconds < 2.0:
        failures.append(f"only {seconds:.2f}s of audio for a 12 s sentence")
    return failures


async def main() -> int:
    from livekit.agents.utils import http_context

    async with http_context.open():  # the plugins borrow the worker's session; outside a job there is none
        failures = await check_stt() + await check_tts()
    print("== verdict ==")
    for line in failures:
        print(f"  FAIL {line}")
    if not failures:
        print("  PASS")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
