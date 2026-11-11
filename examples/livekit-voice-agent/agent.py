"""LiveKit Agents worker that puts a Rakazo bot on a duplex voice call.

Pipeline per room `rakazo-<callId>`:

    mic → Silero VAD → Deepgram STT (Flux or Nova-3) → RakazoAgent.llm_node → TTS → speaker

`llm_node` does not call a model. It sends the finished utterance to Rakazo with a `call:` nonce
(`threads/send`, or `followUp` / `answer` when the bot is working or asking — the same rules as
the web client's `callTurn`), then yields the reply's `thread.progress` deltas from one long-lived
`threads/subscribe` stream so TTS starts before the run finishes. Barge-in is the session's own
VAD-based interruption: the unspoken remainder is dropped, the Rakazo run is left to finish.

Run with `python agent.py start` (or `dev`). Rooms are joined only by explicit dispatch
(`LIVEKIT_AGENT_NAME`, default `rakazo-voice`), so the worker never joins other tenants' rooms on
a shared SFU; it also refuses any room not named `rakazo-*`.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from collections.abc import AsyncIterable
from dataclasses import dataclass
from typing import Any

import httpx
from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    JobContext,
    JobProcess,
    ModelSettings,
    TurnHandlingOptions,
    cli,
    llm,
)
from livekit.plugins import deepgram, openai, silero

from conversation import (
    ConversationState,
    asks_to_continue,
    belongs_to_turn,
    spoken_decision_action,
)
from rakazo_client import (
    HEARTBEAT_EVENT,
    RUN_TERMINAL,
    RakazoClient,
    RakazoError,
    call_client_nonce,
    call_turn,
    progress_text,
    text_from_blocks,
)

load_dotenv()
logger = logging.getLogger("rakazo-voice")

ROOM_PREFIX = "rakazo-"
AGENT_NAME = os.environ.get("LIVEKIT_AGENT_NAME", "rakazo-voice")
RAKAZO_API_URL = os.environ.get("RAKAZO_API_URL", "http://127.0.0.1:3311")
TURN_TIMEOUT_S = float(os.environ.get("RAKAZO_TURN_TIMEOUT_S", "120"))

# A line from another run of this bot read out on the call: a confirmation, not a report.
SIBLING_LINE_MAX_CHARS = 220

ENTER_CODE_LINE = "The bot is asking for a code or password. Hang up, then enter it on screen."
APPROVE_ON_SCREEN_LINE = "That needs your approval. Approve or deny it on screen."


@dataclass
class CallContext:
    """Who is on the call, and which bot: comes from the token server, or from the environment."""

    call_id: str
    bearer: str
    space_id: str
    bot_id: str
    bot_name: str = ""
    user_name: str = ""
    """The bot called: what it opens with, spoken instead of the greeting. Empty for a user's call."""
    opening: str = ""


class _RakazoIsTheModel(llm.LLM):
    """Placeholder: `AgentSession` needs an LLM instance, but `RakazoAgent.llm_node` never calls it."""

    @property
    def model(self) -> str:
        return "rakazo"

    @property
    def provider(self) -> str:
        return "rakazo"

    def chat(self, **_: Any) -> llm.LLMStream:
        raise RuntimeError("RakazoAgent.llm_node replaces the LLM; chat() must not be called")


class RakazoAgent(Agent):
    def __init__(self, call: CallContext, client: RakazoClient) -> None:
        super().__init__(instructions="")  # Rakazo holds the bot's instructions; nothing to prompt here
        self.call = call
        self.client = client
        self.events: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        # What this bot said in another run of the same thread (a task confirmed in chat during a
        # call). Spoken by the idle session, never spoken over an answer.
        self.to_speak: asyncio.Queue[str] = asyncio.Queue()
        # The call's conversation, kept apart from what the bot's other runs are doing.
        self.state = ConversationState()
        self._turn_run_id: str | None = None
        self._cursor = -1
        self._pump: asyncio.Task[None] | None = None
        self.hangup_requested = asyncio.Event()
        self._marks: dict[str, float] = {}

    # --- Rakazo event stream ------------------------------------------------------------------

    async def start_events(self) -> None:
        head = await self.client.threads_head(self.call.bot_id)
        self._cursor = head["cursor"]
        self._pump = asyncio.create_task(self._pump_events(), name="rakazo-subscribe")

    async def stop_events(self) -> None:
        if self._pump:
            self._pump.cancel()
            try:
                await self._pump
            except (asyncio.CancelledError, Exception):
                pass

    async def _pump_events(self) -> None:
        """One `threads/subscribe` per call; reconnects from the last seq if the stream drops."""
        backoff = 1.0
        while True:
            try:
                async for event in self.client.subscribe(self.call.bot_id, self._cursor):
                    backoff = 1.0
                    if event.get("type") == HEARTBEAT_EVENT:
                        continue
                    seq = event.get("seq")
                    if isinstance(seq, int):
                        self._cursor = max(self._cursor, seq)
                    await self.events.put(event)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # network blip, api restart
                logger.warning("subscribe dropped, reconnecting in %.0fs: %s", backoff, exc)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 15.0)

    def _collect_pending(self) -> None:
        """Take whatever arrived since the last turn as task notes, never as the next answer."""
        while not self.events.empty():
            event = self.events.get_nowait()
            self._note_background(event)

    def _note_background(self, event: dict[str, Any]) -> None:
        """Remember what a run that is not this turn's said, so it can be reported on request.

        A short progress line — the bot confirming a task it was given in chat, while this call is
        going — is queued to be spoken: the person is on the phone with this bot and should hear
        what it just told them in writing. Anything longer stays a note.
        """
        payload = event.get("payload") or {}
        if event.get("type") == "thread.message.created" and payload.get("role") == "bot":
            said = text_from_blocks(payload.get("blocks") or [])
            # Short and stated: a confirmation or a one-line update. A report stays a note.
            if said and len(said) <= SIBLING_LINE_MAX_CHARS:
                self.to_speak.put_nowait(said)
        payload = event.get("payload") or {}
        etype = event.get("type")
        run_id = event.get("runId")
        if etype == "thread.progress":
            text = progress_text(payload)
        elif etype == "thread.message.created" and payload.get("role") == "bot":
            text = text_from_blocks(payload.get("blocks") or [])
        elif etype in RUN_TERMINAL:
            self.state.forget_task(run_id)
            return
        else:
            return
        if text:
            self.state.note_task_event(run_id, text)

    # --- nodes ---------------------------------------------------------------------------------

    async def llm_node(
        self, chat_ctx: llm.ChatContext, tools: list[llm.Tool], model_settings: ModelSettings
    ) -> AsyncIterable[str]:
        utterance = _last_user_text(chat_ctx)
        if not utterance:
            return
        t0 = time.monotonic()
        self._marks = {"turn_start": t0}
        # This turn owns the conversation from here: an older turn's generator sees is_current
        # false and stops, so a slow answer can never be spoken as the reply to a newer question.
        turn = self.state.begin_turn(utterance, now=t0)
        logger.info(
            "turn %d: %s on %r",
            turn.id,
            turn.kind,
            turn.topic,
            extra={"utterance": utterance, "callId": self.call.call_id},
        )

        # "Go on" after an interrupted update asks for the rest of that update, not for a new turn.
        if asks_to_continue(utterance) and self.state.has_paused_report():
            rest = self.state.resume_report()
            if rest:
                self.state.record_reply(rest)
                yield rest
                return

        # "What are you working on?" is answered from what this call has seen, in one sentence,
        # instead of sending a turn that would read the whole thread's task history back.
        if turn.kind == "status":
            line = self.state.status_line(self.call.bot_name)
            if line:
                self.state.record_reply(line)
                yield line
                return

        snapshot = await self.client.threads_get(self.call.bot_id)
        decision = call_turn(snapshot, utterance)

        if decision.kind == "enter_code":
            yield ENTER_CODE_LINE
            return
        if decision.kind == "approve_on_screen":
            # A caller can decide this out loud: the card is the app's way of asking, not the only
            # one. Without an explicit word, say what is being asked so they can answer.
            choice = spoken_decision_action(utterance, decision.actions)
            if choice:
                logger.info("spoken approval: %s for %r", choice, decision.question[:60])
                try:
                    await self.client.threads_answer(
                        self.call.bot_id,
                        decision.run_id or "",
                        decision.message_id or "",
                        choice,
                        call_client_nonce(self.call.call_id),
                    )
                except RakazoError as exc:
                    logger.warning("spoken approval failed: %s", exc)
                    yield "I couldn't record that decision. Please approve it in the app."
                    return
                run_id = decision.run_id
            else:
                asking = decision.question or "something it wants to do"
                yield f"That needs your okay — {asking}. Say approve, or deny, and I'll take that."
                return

        nonce = call_client_nonce(self.call.call_id)
        # Tag the turn: a question (or filler that follows one) must be answered by its own run;
        # anything else keeps the busy run reporting what it is doing.
        answer_now = self.state.wants_answer(utterance)
        run_id: str | None = None

        run_id: str | None = None
        self._collect_pending()
        try:
            if decision.kind == "answer":
                await self.client.threads_answer(
                    self.call.bot_id,
                    decision.run_id or "",
                    decision.message_id or "",
                    decision.answer or utterance,
                    nonce,
                )
                run_id = decision.run_id
            elif decision.kind == "follow_up":
                # The bot is busy. The receipt names the run that answers THIS turn when the
                # server started one for it (a call turn always gets one), so the caller hears the
                # answer to what they said instead of the busy run's work finishing.
                receipt = await self.client.threads_follow_up(
                    self.call.bot_id, utterance, nonce, answer_now=answer_now
                )
                run_id = receipt.get("talkRunId") or receipt.get("runId") or decision.run_id
            else:
                receipt = await self.client.threads_send(
                    self.call.bot_id, utterance, nonce, answer_now=answer_now
                )
                # A send can also score a talk run when the bot turned busy a moment earlier.
                run_id = receipt.get("talkRunId") or receipt.get("runId")
        except RakazoError as exc:
            logger.error("rakazo send failed: %s", exc)
            yield "Sorry, I could not reach the assistant. Please try again."
            return

        self._turn_run_id = run_id
        # A turn that is not answering the caller is reporting on the work: interrupting it should
        # leave the rest of that report finishable.
        reporting = not answer_now
        streamed: list[str] = []
        first_delta_at: float | None = None
        deadline = t0 + TURN_TIMEOUT_S
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    logger.warning("turn timed out waiting for Rakazo", extra={"runId": run_id})
                    break
                try:
                    event = await asyncio.wait_for(self.events.get(), remaining)
                except asyncio.TimeoutError:
                    continue
                etype = event.get("type")
                payload = event.get("payload") or {}

                if etype == "thread.call.ended":
                    farewell = (payload.get("farewell") or "").strip()
                    if payload.get("callId") == self.call.call_id and farewell:
                        logger.info("bot hung up", extra={"callId": self.call.call_id})
                        yield farewell
                        self.hangup_requested.set()
                        return
                    continue
                # Only the run this turn started is this turn's answer. Everything else — a
                # routine, another bot's report, a helper — is noted for a status question and
                # never spoken as if the caller had asked for it.
                if not belongs_to_turn(event.get("runId"), run_id):
                    self._note_background(event)
                    continue
                if not self.state.is_current(turn.id):
                    logger.info("turn %d superseded; dropping its reply", turn.id)
                    return
                if etype == "thread.progress":
                    text = progress_text(payload)
                    if text:
                        if first_delta_at is None:
                            first_delta_at = time.monotonic()
                            self._marks["first_delta"] = first_delta_at
                            logger.info("rakazo first delta after %.2fs", first_delta_at - t0)
                        streamed.append(text)
                        yield text
                elif etype == "thread.message.created" and payload.get("role") == "bot":
                    final = text_from_blocks(payload.get("blocks") or [])
                    rest = _unspoken_remainder("".join(streamed), final)
                    if rest:
                        if not streamed:
                            logger.info("no deltas; speaking final message", extra={"runId": run_id})
                        streamed.append(rest)
                        yield rest
                elif etype in RUN_TERMINAL:
                    logger.info("%s after %.2fs", etype, time.monotonic() - t0, extra={"runId": run_id})
                    self.state.forget_task(run_id)
                    break
                elif etype == "run.waiting_input":
                    # The ask card text arrived in thread.message.created; the run now waits for us.
                    break
        except (asyncio.CancelledError, GeneratorExit):
            # Whatever the caller cut short — a report, an answer, a long explanation — stays
            # finishable instead of vanishing. "go on" replays it; otherwise the next answer offers it.
            held = "".join(streamed)
            # Nothing was sent, so nothing is being cut short: the caller simply started again.
            if held.strip() and run_id:
                self.state.note_report_interrupted(run_id, held)
            logger.info(
                "turn %d interrupted; %d chars spoken, rest held for 'go on'",
                turn.id,
                len(held),
            )
            raise
        finally:
            self.state.record_reply("".join(streamed))
            self.state.end_turn(turn.id)

        # Answering a question does not silently bury the update the caller interrupted: the rest is
        # offered once, after the answer they asked for. Reached only when the turn ran to its end.
        offer = self.state.take_report_offer(self.call.bot_name)
        if offer:
            self.state.record_reply(offer)
            yield offer

    async def tts_node(self, text: AsyncIterable[str], model_settings: ModelSettings):
        first = True
        async for frame in Agent.default.tts_node(self, text, model_settings):
            if first:
                first = False
                now = time.monotonic()
                start = self._marks.get("turn_start")
                delta = self._marks.get("first_delta")
                if start:
                    logger.info(
                        "first tts audio frame: +%.2fs after end of utterance (rakazo first delta +%s)",
                        now - start,
                        f"{delta - start:.2f}s" if delta else "n/a",
                    )
            yield frame


def _last_user_text(chat_ctx: llm.ChatContext) -> str:
    for item in reversed(chat_ctx.items):
        if getattr(item, "type", None) == "message" and getattr(item, "role", None) == "user":
            return (item.text_content or "").strip()
    return ""


def opening_line(opening: str, greeting: str) -> str:
    """What the agent says on joining: the bot's opening on its own call, else the greeting."""
    return opening.strip() or greeting


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _unspoken_remainder(streamed: str, final: str) -> str:
    """What of the final message was not streamed yet: all of it, a tail, or nothing."""
    if not final:
        return ""
    s, f = _norm(streamed), _norm(final)
    if not s:
        return final
    if f.startswith(s) and len(f) > len(s):
        return f[len(s) :].strip()
    return ""


# --- providers ------------------------------------------------------------------------------------


def make_stt():
    model = os.environ.get("DEEPGRAM_STT_MODEL", "flux-general-en")
    key = os.environ["DEEPGRAM_API_KEY"]
    if model.startswith("flux"):
        return deepgram.STTv2(model=model, api_key=key), "stt"  # Flux: semantic end-of-turn
    return deepgram.STT(model=model, api_key=key, interim_results=True), None  # session picks VAD


def make_tts():
    provider = os.environ.get("TTS_PROVIDER", "deepgram")
    if provider == "kokoro":
        return openai.TTS(
            base_url=os.environ.get("KOKORO_BASE_URL", "http://kokoro-tts:8880/v1"),
            api_key=os.environ.get("KOKORO_API_KEY", "not-needed"),
            model=os.environ.get("KOKORO_MODEL", "kokoro"),
            voice=os.environ.get("KOKORO_VOICE", "af_heart"),
            response_format="pcm",
        )
    return deepgram.TTS(
        model=os.environ.get("DEEPGRAM_TTS_VOICE", "aura-2-orion-en"), api_key=os.environ["DEEPGRAM_API_KEY"]
    )


# --- call resolution ------------------------------------------------------------------------------


async def resolve_call(room_name: str) -> CallContext:
    """The token server registered this call when it minted the caller's token. Without a token
    server (livekit-cli tests), fall back to RAKAZO_EMAIL / RAKAZO_PASSWORD / RAKAZO_BOT_NAME."""
    call_id = room_name[len(ROOM_PREFIX) :]
    internal = os.environ.get("VOICE_INTERNAL_URL")
    if internal:
        async with httpx.AsyncClient(timeout=10) as http:
            response = await http.get(
                f"{internal.rstrip('/')}/internal/calls/{call_id}",
                headers={"x-voice-internal-token": os.environ.get("VOICE_INTERNAL_TOKEN", "")},
            )
        if response.status_code == 200:
            data = response.json()
            return CallContext(
                call_id=call_id,
                bearer=data["bearer"],
                space_id=data["spaceId"],
                bot_id=data["botId"],
                bot_name=data.get("botName", ""),
                user_name=data.get("userName", ""),
                opening=str(data.get("opening") or "").strip(),
            )
        logger.warning("token server has no record of call %s (%s); trying env fallback", call_id, response.status_code)

    email, password = os.environ.get("RAKAZO_EMAIL"), os.environ.get("RAKAZO_PASSWORD")
    if not (email and password):
        raise RuntimeError("no call context from the token server and RAKAZO_EMAIL/PASSWORD unset")
    client = RakazoClient(RAKAZO_API_URL)
    try:
        await client.sign_in(email, password)
        nav = await client.spaces_list()
        space = nav["current"]
        want = os.environ.get("RAKAZO_BOT_NAME", "Voice")
        bot = next((b for b in space["bots"] if b["name"] == want), None)
        if not bot:
            raise RuntimeError(f"bot {want!r} not found in space {space['name']!r}")
        return CallContext(call_id, client.token or "", space["id"], bot["id"], bot["name"], "")
    finally:
        await client.aclose()


# --- worker ---------------------------------------------------------------------------------------

server = AgentServer()


def prewarm(proc: JobProcess) -> None:
    proc.userdata["vad"] = silero.VAD.load()


server.setup_fnc = prewarm


@server.rtc_session(agent_name=AGENT_NAME)
async def entrypoint(ctx: JobContext) -> None:
    room_name = ctx.job.room.name
    if not room_name.startswith(ROOM_PREFIX):
        logger.warning("refusing room %r: not a %s* room", room_name, ROOM_PREFIX)
        ctx.shutdown(reason="not a rakazo room")
        return

    call = await resolve_call(room_name)
    ctx.log_context_fields = {"room": room_name, "callId": call.call_id, "botId": call.bot_id}
    client = RakazoClient(RAKAZO_API_URL, token=call.bearer, space_id=call.space_id)
    agent = RakazoAgent(call, client)
    await agent.start_events()

    stt, turn_detection = make_stt()
    turn_handling: TurnHandlingOptions = {
        # Barge-in: VAD-based, so the caller can cut a long reply short (the remainder is dropped).
        # An interruption is final: the framework default pauses playback and RESUMES it when no
        # transcript is committed within 2 s, which on a laptop mic reads as "it ignored me and
        # kept talking". A caller who speaks over the bot means it.
        "interruption": {
            "enabled": True,
            "mode": "vad",
            "min_duration": float(os.environ.get("VOICE_INTERRUPT_MIN_S", "0.4")),
            "resume_false_interruption": False,
            "false_interruption_timeout": None,
        },
        # Rakazo needs the finished utterance; never start a turn on an interim transcript.
        "preemptive_generation": {"enabled": False},
    }
    if turn_detection is not None:
        turn_handling["turn_detection"] = turn_detection
    session: AgentSession = AgentSession(
        vad=ctx.proc.userdata["vad"],
        stt=stt,
        llm=_RakazoIsTheModel(),
        tts=make_tts(),
        turn_handling=turn_handling,
    )

    @session.on("user_input_transcribed")
    def _on_transcribed(ev):  # type: ignore[no-untyped-def]
        if ev.is_final:
            logger.info("user said: %s", ev.transcript)

    @session.on("agent_state_changed")
    def _on_state(ev):  # type: ignore[no-untyped-def]
        logger.info("agent %s -> %s", ev.old_state, ev.new_state)

    @session.on("user_state_changed")
    def _on_user_state(ev):  # type: ignore[no-untyped-def]
        # "speaking" while the agent is speaking is the moment barge-in should fire.
        logger.info("user %s -> %s (agent is %s)", ev.old_state, ev.new_state, session.agent_state)

    @session.on("speech_created")
    def _on_speech(ev):  # type: ignore[no-untyped-def]
        def done(handle):  # type: ignore[no-untyped-def]
            if handle.interrupted:
                logger.info("speech interrupted by the caller (barge-in)", extra={"speechId": handle.id})
            if agent.hangup_requested.is_set():
                ctx.shutdown(reason="bot ended the call")

        ev.speech_handle.add_done_callback(done)

    async def speak_sibling_lines() -> None:
        """Speak what this bot wrote in another run, between turns.

        Events are otherwise only read inside a turn, so a task confirmed in chat while the call is
        quiet would never be seen. This drains them while no turn owns the conversation, keeps the
        short ones to say, and says them when the speaker is free.
        """
        while True:
            try:
                if agent.state.current is None:
                    # No turn is reading the stream: take what arrived so it is not lost.
                    while not agent.events.empty():
                        agent._note_background(agent.events.get_nowait())
                    if session.agent_state == "listening" and not agent.to_speak.empty():
                        said = agent.to_speak.get_nowait()
                        logger.info("speaking a line from another run: %s", said[:80])
                        session.say(said, allow_interruptions=True)
                await asyncio.sleep(0.4)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # a spoken courtesy must never end the call
                logger.warning("sibling line not spoken: %s", exc)
                await asyncio.sleep(1.0)

    speak_task = asyncio.create_task(speak_sibling_lines(), name="rakazo-sibling-lines")
    ctx.add_shutdown_callback(lambda: (speak_task.cancel(), None))

    started_at = time.monotonic()

    async def end_call() -> None:
        await agent.stop_events()
        try:
            await client.threads_end_call(call.bot_id, call.call_id, int(time.monotonic() - started_at))
            logger.info("threads/endCall sent", extra={"callId": call.call_id})
        except RakazoError as exc:
            logger.warning("threads/endCall failed: %s", exc)
        finally:
            await client.aclose()

    ctx.add_shutdown_callback(end_call)

    await ctx.connect()
    await session.start(agent=agent, room=ctx.room)
    # A bot-initiated call opens with the bot's own line (Rakazo already wrote it to the thread
    # as the call request); say() keeps it an assistant turn, so it is never sent back as the user.
    first_line = opening_line(call.opening, os.environ.get("VOICE_GREETING", "Connected. Go ahead."))
    if first_line:
        if call.opening:
            logger.info("speaking the bot's opening: %s", first_line, extra={"callId": call.call_id})
        session.say(first_line, allow_interruptions=True)


if __name__ == "__main__":
    cli.run_app(server)
