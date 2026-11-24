"""Streaming speech-to-text for the local speech service (Parakeet), as a LiveKit plugin.

Why this exists: `openai.STT` against the same service is a *batch* recogniser - LiveKit buffers the whole
utterance, sends it at end of speech, and the caller waits for a full-clip decode (1.5-3 s for 15-25 s of
speech on this box). This class instead keeps one WebSocket open for the call and pushes audio into it at
real time, so the service has already decoded most of the utterance when the caller stops; its final
transcript comes back ~0.2 s after LiveKit's VAD flushes us.

Wire protocol (see `server.py` in /home/sasajib/the-data/rakazo-speech-local):

    -> binary: s16le mono PCM at 16 kHz           -> {"type": "ready"|"partial"|"final"|"flushed"}
    -> {"type": "flush"} at end of speech

LiveKit's `SpeechStream` base class owns the retry/teardown machinery: `_run` is one connection attempt, the
input channel yields audio frames and flush sentinels, and events are pushed into `_event_ch`.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Callable

import aiohttp
from livekit.agents import APIConnectionError, APIConnectOptions, stt
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS, NOT_GIVEN, NotGivenOr

logger = logging.getLogger("rakazo.voice.stt")

# The STT side has its own flush sentinel, nested in the stream class (the one in `types` belongs to LLM/TTS).
_FLUSH_SENTINEL = getattr(stt.RecognizeStream, "_FlushSentinel", ())

SAMPLE_RATE = 16000  # handed to the base class, which resamples LiveKit's 48 kHz frames for us


class LocalStreamingSTT(stt.STT):
    """Parakeet over the local service's streaming endpoint.

    `name_rules` are applied to every transcript here rather than in the agent, so interim captions and the
    text the bot's model sees agree about the bots' names.
    """

    def __init__(
        self,
        *,
        url: str,
        language: str = "en",
        name_rules: list[tuple[object, str]] | None = None,
        fix_names: Callable[[str, list[tuple[object, str]]], str] | None = None,
    ) -> None:
        # `manual_flush` is not optional: LiveKit only calls `flush()` on a stream whose capabilities say so
        # (`STTCapabilities.manual_flush` defaults to False), and a streaming STT that is never flushed never
        # emits its final transcript - the turn then commits with whatever interim text happened to exist.
        super().__init__(
            capabilities=stt.STTCapabilities(streaming=True, interim_results=True, manual_flush=True)
        )
        self._ws_url = _ws_url(url)
        self._language = language
        self._name_rules = name_rules or []
        self._fix_names = fix_names

    @property
    def model(self) -> str:
        return "parakeet"

    @property
    def provider(self) -> str:
        return "rakazo-speech-local"

    async def _recognize_impl(self, buffer, *, language=None, conn_options=None):  # type: ignore[no-untyped-def,override]
        """One-shot fallback, used by `recognize()` (a clip) and by `StreamAdapter` if `stream()` is bypassed."""
        import httpx  # already a dependency; imported here so the module loads without it

        url = self._http_url()
        async with httpx.AsyncClient(timeout=60) as http:
            files = {"file": ("a.wav", buffer.to_wav_bytes(), "audio/wav")}
            response = await http.post(url, files=files, data={"model": "parakeet", "language": self._language})
            response.raise_for_status()
            text = response.json().get("text", "")
        return stt.SpeechEvent(
            type=stt.SpeechEventType.FINAL_TRANSCRIPT,
            request_id="local-batch",
            alternatives=[stt.SpeechData(language=self._language, text=self._fixed(text))],
        )

    def stream(
        self,
        *,
        language: NotGivenOr[str] = NOT_GIVEN,
        conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
    ) -> "LocalSpeechStream":
        return LocalSpeechStream(
            stt=self,
            conn_options=conn_options,
            ws_url=self._ws_url,
            language=self._language,
            fix=self._fixed,
        )

    def _fixed(self, text: str) -> str:
        if self._fix_names is None:
            return text
        return self._fix_names(text, self._name_rules)

    def _http_url(self) -> str:
        base = self._ws_url[: -len("/v1/audio/transcriptions/stream")]
        return base.replace("ws://", "http://").replace("wss://", "https://") + "/v1/audio/transcriptions"


class LocalSpeechStream(stt.SpeechStream):
    def __init__(
        self,
        *,
        stt: LocalStreamingSTT,
        conn_options: APIConnectOptions,
        ws_url: str,
        language: str,
        fix: Callable[[str], str],
    ) -> None:
        super().__init__(stt=stt, conn_options=conn_options, sample_rate=SAMPLE_RATE)
        self._ws_url = ws_url
        self._language = language
        self._fix = fix
        self._request_id = 0

    async def _run(self) -> None:
        async with aiohttp.ClientSession() as session:
            async with session.ws_connect(self._ws_url, max_msg_size=0, heartbeat=20) as ws:
                logger.info("local stt stream connected %s", self._ws_url)
                send_task = asyncio.create_task(self._send(ws))
                recv_task = asyncio.create_task(self._receive(ws))
                try:
                    done, _ = await asyncio.wait({send_task, recv_task}, return_when=asyncio.FIRST_EXCEPTION)
                    for task in done:  # surface the failure, the base class retries on APIError
                        if task.exception():
                            raise task.exception()  # type: ignore[misc]
                    if recv_task in done:
                        # the service hung up on its own: make the base class reconnect to it
                        raise APIConnectionError("local speech service closed the stream")
                finally:
                    for task in (send_task, recv_task):
                        if not task.done():
                            task.cancel()

    async def _send(self, ws: aiohttp.ClientWebSocketResponse) -> None:
        async for item in self._input_ch:
            if _FLUSH_SENTINEL and isinstance(item, _FLUSH_SENTINEL):
                await ws.send_str(json.dumps({"type": "flush"}))
                continue
            await ws.send_bytes(item.data.tobytes())

    async def _receive(self, ws: aiohttp.ClientWebSocketResponse) -> None:
        async for message in ws:
            if message.type == aiohttp.WSMsgType.BINARY:
                continue
            if message.type != aiohttp.WSMsgType.TEXT:
                continue
            event = json.loads(message.data)
            kind = event.get("type")
            if kind == "partial":
                text = self._fix(event.get("text", ""))
                if text:
                    self._event_ch.send_nowait(
                        stt.SpeechEvent(
                            type=stt.SpeechEventType.INTERIM_TRANSCRIPT,
                            request_id=f"local-{id(self)}-{self._request_id}",
                            alternatives=[stt.SpeechData(language=self._language, text=text)],
                        )
                    )
            elif kind == "final":
                text = self._fix(event.get("text", ""))
                self._request_id += 1
                if not text:
                    continue
                self._mark_provider_progress()
                self._event_ch.send_nowait(
                    stt.SpeechEvent(
                        type=stt.SpeechEventType.FINAL_TRANSCRIPT,
                        request_id=f"local-{id(self)}-{self._request_id}",
                        alternatives=[stt.SpeechData(language=self._language, text=text)],
                    )
                )
            elif kind == "error":
                logger.warning("local stt stream error: %s", event)


def _ws_url(base: str) -> str:
    """`LOCAL_SPEECH_URL` is the OpenAI-compatible HTTP base; the stream lives beside it."""
    url = base.rstrip("/")
    if url.endswith("/v1"):
        url = url[: -len("/v1")]
    if url.startswith("http://"):
        url = "ws://" + url[len("http://") :]
    elif url.startswith("https://"):
        url = "wss://" + url[len("https://") :]
    return url + "/v1/audio/transcriptions/stream"
