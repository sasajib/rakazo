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
import uuid
from collections import deque
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
from livekit.agents.types import FlushSentinel
from livekit.plugins import deepgram, openai, silero

from conversation import (
    ConversationState,
    Segment,
    SentenceGate,
    SpokenLines,
    Task,
    asks_for_work,
    asks_to_continue,
    is_filler,
    asks_to_stop,
    belongs_to_turn,
    heartbeat_line,
    speakable,
    spoken_decision_action,
    wants_to_move_on,
)
from rakazo_client import (
    HEARTBEAT_EVENT,
    activity_text,
    RUN_TERMINAL,
    CallTurn,
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
FLUSH_AFTER_S = float(os.environ.get("RAKAZO_FLUSH_AFTER_S", "0.6"))
# Silence is the thing a caller reads as "it died". While work runs: the first progress line after
# this long without a word, then one at this interval, a handful at most.
HEARTBEAT_FIRST_S = float(os.environ.get("RAKAZO_HEARTBEAT_FIRST_S", "9"))
HEARTBEAT_EVERY_S = float(os.environ.get("RAKAZO_HEARTBEAT_EVERY_S", "14"))
HEARTBEAT_QUIET_S = float(os.environ.get("RAKAZO_HEARTBEAT_QUIET_S", "6"))
HEARTBEAT_MAX = 6
PHRASE_IDLE_S = float(os.environ.get("RAKAZO_PHRASE_IDLE_S", "2.5"))
SPEECH_WORDS_PER_S = 2.5
TTS_START_S = 2.0

# A line from another run of this bot read out on the call: a confirmation, not a report.
SIBLING_LINE_MAX_CHARS = 220

def secret_ask_line(what: str) -> str:
    """Say once what the parked run is waiting for, and every way out of it."""
    named = f"your {what}" if what else "a secret, like a password or token"
    return (
        f"I'm waiting on {named}. A secret can't be said out loud, so it has to be typed into the card in the chat: "
        "tap the arrow at the top of the call to open it. If you've already added it another way, or want to skip it, "
        "just tell me and I'll drop that request and carry on."
    )
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
        # How often the same approval card has been read out on this call.
        self._approval_asks: dict[str, int] = {}
        self._secret_asks: dict[str, int] = {}
        # Everything this call has already said, so nothing is delivered twice.
        self._spoken = SpokenLines()
        self._cursor = -1
        self._pump: asyncio.Task[None] | None = None
        self.hangup_requested = asyncio.Event()
        self._marks: dict[str, float] = {}
        # The segments of the last few speeches, so a cut-off report can be resumed from where the
        # audio stopped. And a speech told by the idle session rather than by a caller's turn.
        self._speech_log: deque[list[Segment]] = deque(maxlen=8)
        self._scripted: list[Segment] | None = None
        self._scripted_active = False
        self._last_voiced = time.monotonic()
        # When what has been handed to the speaker should have finished playing (estimated: the
        # agent stays in the "speaking" state for a whole turn, silent gaps included, so the state
        # cannot say whether the caller is actually hearing something).
        self._voiced_until = 0.0
        self._turn_activity = ""
        self._user_changed = 0.0
        self._mirrors: set[asyncio.Task[None]] = set()

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
                    # A line this agent mirrored into the chat comes back on the stream: it is
                    # already being said (or was), never news to speak.
                    body = event.get("payload") or {}
                    if (
                        event.get("type") == "thread.message.created"
                        and not event.get("runId")
                        and body.get("callId") == self.call.call_id
                    ):
                        continue
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
        """Remember what a run that is not this turn's said, so it can be reported later.

        Work the caller asked for on this call is tracked as a task: its result is kept to be told
        once ("About your request to ..."), whatever else is being talked about when it lands. A
        short line from a run nobody asked for here — the bot confirming something typed in chat —
        is queued to be spoken as it is. Anything longer stays a note.
        """
        payload = event.get("payload") or {}
        etype = event.get("type")
        run_id = event.get("runId")
        task = self.state.tasks.get(run_id or "")
        if task is not None:
            if etype == "thread.message.created" and payload.get("role") == "bot":
                self.state.note_task_message(run_id, text_from_blocks(payload.get("blocks") or []))
            elif etype == "thread.progress":
                if payload.get("activity"):
                    self.state.note_task_activity(run_id, activity_text(payload) or "")
                else:
                    text = progress_text(payload)
                    if text:
                        self.state.note_task_event(run_id, text)
            elif etype in RUN_TERMINAL:
                self._finish_task(run_id, failed=etype != "run.completed")
            return
        if etype == "thread.message.created" and payload.get("role") == "bot":
            said = text_from_blocks(payload.get("blocks") or [])
            # Short and stated: a confirmation or a one-line update. A report stays a note.
            # Anything this run already said, or this call already spoke, is not news.
            if (
                said
                and len(said) <= SIBLING_LINE_MAX_CHARS
                and event.get("runId") != self._turn_run_id
                and not self._spoken.has(said)
            ):
                self.to_speak.put_nowait(said)
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

    def _finish_task(self, run_id: str | None, failed: bool = False) -> None:
        """A task's run ended: keep its result to be told unless the caller already heard it."""
        task = self.state.finish_task(run_id, tell=True)
        if task is None:
            return
        if failed and not task.report:
            task.report = "It stopped before it could finish."
        if task.report and self._spoken.has(task.report):
            task.report = ""  # said inside its own turn
        self.state.forget_task(run_id)
        logger.info(
            "task %s finished (%s); %s",
            task.label,
            "failed" if failed else "ok",
            "result waits to be told" if task.report else "result already heard",
        )

    # --- what is owed to the caller ----------------------------------------------------------

    def take_backlog(self) -> list[Segment]:
        """What the caller is still owed, in the order it should be said, removed from the books.

        First the report they interrupted (said as a continuation: which report it is, then the
        rest), then results of tasks that finished while they were busy with something else (each
        introduced by the task it belongs to). Said once.
        """
        out: list[Segment] = []
        if self.state.has_paused_report():
            label = self.state.report_label
            run_id = self.state.report_run_id
            preface = self.state.resume_preface()
            rest = self.state.resume_report()
            if rest:
                out.append(Segment("line", preface, run_id, label))
                out.append(Segment("report", rest, run_id, label))
        while True:
            task = self.state.take_pending_report()
            if task is None:
                break
            text, task.report = task.report, ""
            # The run's result often restates what the caller was just told (it answered the same
            # question): say only what is new.
            fresh = [
                sentence
                for sentence in re.split(r"(?<=[.!?])\s+", text)
                if sentence.strip() and not self._spoken.has(sentence)
            ]
            text = " ".join(fresh).strip()
            if not text:
                continue
            out.append(Segment("line", f"About {task.label}:", task.run_id, task.label))
            out.append(Segment("report", text, task.run_id, task.label))
        return out

    def on_speech_cut(self, heard: str) -> None:
        """The caller cut speech off. Whatever part of a report they had not heard stays theirs.

        `heard` is what the audio actually reached (LiveKit's forwarded transcript). The segments
        that make up that speech are found by what they begin with, then the unheard rest of any
        report in them is put back as the interrupted report. An answer is never put back.
        """
        heard_words = _norm(heard).split()
        logger.info(
            "speech cut: %d words heard of %d speeches logged: %r … %r",
            len(heard_words),
            len(self._speech_log),
            heard[:60],
            heard[-60:],
        )
        if not heard_words:
            return
        tail = re.findall(r"[a-z0-9]+", heard.lower())[-6:]
        if not tail:
            return
        for segments in reversed(self._speech_log):
            # The speech as it was spoken, with where each segment sits in it. Chunks of one stream
            # are joined as they came; separate thoughts are separated by a space.
            full = ""
            spans: list[tuple[int, int]] = []
            for seg in segments:
                if full and not seg.joined:
                    full += " "
                spans.append((len(full), len(full) + len(seg.text)))
                full += seg.text
            tokens = list(re.finditer(r"[a-z0-9]+", full.lower()))
            words = [t.group(0) for t in tokens]
            at = next(
                (
                    k
                    for k in range(len(words) - len(tail), -1, -1)
                    if words[k : k + len(tail)] == tail
                ),
                None,
            )
            if at is None:
                continue
            cut = tokens[at + len(tail) - 1].end()  # character position where the audio stopped
            remaining: list[str] = []
            run_id: str | None = None
            label = ""
            for seg, (start, end) in zip(segments, spans):
                if seg.kind != "report" or end <= cut:
                    continue
                rest = seg.text[max(0, cut - start) :].lstrip(" .,;:!?-—").strip()
                if rest:
                    remaining.append(rest)
                    run_id, label = seg.run_id, seg.label
            if remaining and run_id:
                self.state.note_report_interrupted(run_id, " ".join(remaining))
                self.state.report_label = label
                logger.info("report on %s cut off; %d words still to tell", label, len(" ".join(remaining).split()))
            return
        logger.info("speech cut: could not place it in any speech this call logged")

    def _account_speech(self, text: str) -> None:
        """Note that `text` was handed to the speaker, and roughly when it will have been said."""
        now = time.monotonic()
        words = len(text.split())
        # A cold start costs the TTS a couple of seconds before the first sound.
        start = self._voiced_until if self._voiced_until > now else now + TTS_START_S
        self._voiced_until = start + words / SPEECH_WORDS_PER_S
        self._last_voiced = now

    def mirror(self, text: str) -> None:
        """Write a spoken line into the chat without making the caller wait for it."""

        async def post() -> None:
            try:
                await self.client.threads_call_note(
                    self.call.bot_id, self.call.call_id, uuid.uuid4().hex[:16], text
                )
                logger.info("mirrored to chat: %s", text[:70])
            except Exception as exc:  # chat is a copy; a failed copy must never silence the call
                logger.warning("could not mirror to chat (%s): %s", exc, text[:60])

        task = asyncio.create_task(post(), name="rakazo-mirror")
        self._mirrors.add(task)
        task.add_done_callback(self._mirrors.discard)

    def log_speech(self, segments: list[Segment]) -> None:
        self._speech_log.append(segments)

    # --- nodes ---------------------------------------------------------------------------------

    async def _emit(
        self,
        segments: list[Segment],
        kind: str,
        text: str,
        run_id: str | None = None,
        label: str = "",
        joined: bool = False,
    ) -> AsyncIterable[str | FlushSentinel]:
        """Speak one thought: remember what it was (so a cut-off report can be resumed), say it, and
        flush it to the speaker now instead of when more text arrives."""
        if not text.strip():
            return
        segments.append(Segment(kind, text, run_id, label, joined))
        self._account_speech(text)
        # What a run wrote is already in the chat. What this agent says on its own account (a
        # progress line, which report it is returning to, a status answer) is not: leave it there,
        # so everything the caller hears is also written.
        if kind in ("line", "beat") or (kind == "answer" and not run_id):
            self.mirror(text)
        yield text
        yield FlushSentinel()

    async def llm_node(
        self, chat_ctx: llm.ChatContext, tools: list[llm.Tool], model_settings: ModelSettings
    ) -> AsyncIterable[str | FlushSentinel]:
        # A scripted speech (the idle session telling a finished result) is not a caller's turn.
        scripted = self._scripted
        if scripted is not None:
            self._scripted = None
            segments: list[Segment] = []
            self.log_speech(segments)
            self._scripted_active = True
            try:
                for seg in scripted:
                    async for chunk in self._emit(segments, seg.kind, seg.text, seg.run_id, seg.label):
                        yield chunk
                    self._spoken.add(seg.text)
            except (asyncio.CancelledError, GeneratorExit):
                logger.info("scripted speech cut off by the caller")
                raise
            finally:
                self._scripted_active = False
            return

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
        segments = []
        self.log_speech(segments)
        self._last_voiced = t0

        # "Go on" after an interrupted update asks for the rest of that update, not for a new turn.
        if asks_to_continue(utterance) and self.state.has_paused_report():
            rest = self.state.resume_report()
            if rest:
                self.state.record_reply(rest)
                async for chunk in self._emit(segments, "report", rest, self.state.report_run_id):
                    yield chunk
                self.state.end_turn(turn.id)
                return
        if asks_to_stop(utterance):
            self.state.drop_paused_report()

        # "What are you working on?" is answered from what this call has seen, in one sentence,
        # instead of sending a turn that would read the whole thread's task history back.
        if turn.kind == "status":
            line = self.state.task_status() or self.state.status_line(self.call.bot_name)
            if line:
                self.state.record_reply(line)
                async for chunk in self._emit(segments, "answer", line):
                    yield chunk
                self.state.end_turn(turn.id)
                return

        snapshot = await self.client.threads_get(self.call.bot_id)
        decision = call_turn(snapshot, utterance)
        leave_cards = False
        card_note = ""

        if decision.kind == "enter_code":
            # A run is parked on a secret card. A secret is never said into a call (it would pass
            # through speech-to-text and the transcript), and a message sent while a run waits on an
            # ask IS its answer. But the card must not block the caller either: say once what it is
            # waiting for, and let anything that is a request of its own go ahead. The card stays in
            # the chat for whoever is at the screen until a new request sets it aside.
            key = decision.message_id or ""
            told = self._secret_asks.get(key, 0)
            about_the_card = not (asks_for_work(utterance) or wants_to_move_on(utterance))
            if told == 0 and about_the_card:
                self._secret_asks[key] = 1
                async for chunk in self._emit(segments, "answer", secret_ask_line(decision.question)):
                    yield chunk
                self.state.end_turn(turn.id)
                return
            # A request of its own: it goes ahead BESIDE the open card, which stays in the chat for
            # whoever is at the screen. Neither waits on the other.
            logger.info("request beside the open secret card (%r)", decision.question)
            leave_cards = True
            card_note = f"The {decision.question or 'secret'} request stays open in the chat for when you're at the screen."
            decision = CallTurn("send")
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
                    async for chunk in self._emit(
                        segments, "answer", "I couldn't record that decision. Please approve it in the app."
                    ):
                        yield chunk
                    self.state.end_turn(turn.id)
                    return
                run_id = decision.run_id
            elif self._approval_asks.get(decision.message_id or "", 0) >= 1 and not is_filler(utterance):
                # Told once already, and this is neither a decision nor a murmur: a request of its
                # own. It goes ahead beside the open approval, which stays for the screen; nothing
                # is approved by carrying on.
                logger.info("request beside the open approval %r", decision.question[:60])
                leave_cards = True
                card_note = "That approval stays open in the chat for when you're at the screen."
                decision = CallTurn("send")
            else:
                asking = decision.question or "something it wants to do"
                # Never the same sentence twice: after the second ask, point at the card instead.
                self._approval_asks[decision.message_id or ""] = (
                    self._approval_asks.get(decision.message_id or "", 0) + 1
                )
                # Say how to reach it: the card lives in the chat, which the call covers until it
                # is shrunk. "Approve on screen" alone left the caller with nowhere to look.
                if self._approval_asks[decision.message_id or ""] > 2:
                    line = (
                        "I still need that decision and I won't keep asking — tap the arrow at the top "
                        "of the call to open the chat, and the card is there with approve and deny on it."
                    )
                else:
                    line = (
                        f"That needs your okay — {asking}. Say approve, or deny and I'll take it, "
                        "or tap the arrow at the top of the call to open the chat and use the card."
                    )
                async for chunk in self._emit(segments, "answer", line):
                    yield chunk
                self.state.end_turn(turn.id)
                return

        nonce = call_client_nonce(self.call.call_id)
        # Tag the turn: a question (or filler that follows one) must be answered by its own run;
        # anything else keeps the busy run reporting what it is doing.
        answer_now = self.state.wants_answer(utterance)
        run_id = None
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
                    self.call.bot_id, utterance, nonce, answer_now=answer_now, leave_cards=leave_cards
                )
                # A send can also score a talk run when the bot turned busy a moment earlier.
                run_id = receipt.get("talkRunId") or receipt.get("runId")
        except RakazoError as exc:
            logger.error("rakazo send failed: %s", exc)
            async for chunk in self._emit(
                segments, "answer", "Sorry, I could not reach the assistant. Please try again."
            ):
                yield chunk
            self.state.end_turn(turn.id)
            return

        self._turn_run_id = run_id
        # Work the caller asked for is a task from here on: named, so the bot can say which one it
        # is reporting on, and tracked, so finishing it is never lost behind another conversation.
        task = None
        others: list[Task] = []
        if asks_for_work(utterance) and decision.kind != "answer":
            others = self.state.running_tasks(except_run=run_id)
            task = self.state.register_task(run_id, utterance, now=t0)
            if task:
                logger.info("task started: %s (run %s)", task.label, run_id)
        # A turn that is not answering the caller is reporting on the work: interrupting it should
        # leave the rest of that report finishable.
        reporting = not answer_now
        streamed: list[str] = []
        first_delta_at: float | None = None
        deadline = t0 + TURN_TIMEOUT_S
        # Text sits in the TTS sentence tokenizer until a following sentence or a flush arrives, so
        # the last sentence before the bot goes quiet (the confirmation, while it works for half a
        # minute) was never voiced. Flush as soon as the stream pauses.
        unflushed = False
        gate = SentenceGate()
        last_delta_at = 0.0
        said_first = False
        heartbeats = 0

        async def voice(text: str, kind: str) -> AsyncIterable[str]:
            """Say `text` a sentence at a time, skipping any the caller has already heard."""
            nonlocal unflushed
            for sentence in re.split(r"(?<=[.!?])\s+", text):
                if not sentence.strip():
                    continue
                if self._spoken.has(sentence):
                    logger.info("not repeating: %s", sentence[:70])
                    continue
                self._spoken.add(sentence)
                segments.append(
                    Segment(kind, sentence + " ", run_id, self.state.label_of(run_id), joined=unflushed)
                )
                logger.info("speaking (%s): %s", kind, sentence[:70])
                self._account_speech(sentence)
                yield sentence + " "
                unflushed = True

        next_beat = t0 + HEARTBEAT_FIRST_S
        try:
            while True:
                now = time.monotonic()
                remaining = deadline - now
                if remaining <= 0:
                    logger.warning("turn timed out waiting for Rakazo", extra={"runId": run_id})
                    break
                wait = remaining
                if unflushed or gate.held:
                    wait = min(wait, FLUSH_AFTER_S)
                else:
                    wait = min(wait, max(0.2, max(next_beat, self._voiced_until + HEARTBEAT_QUIET_S) - now))
                try:
                    event = await asyncio.wait_for(self.events.get(), wait)
                except asyncio.TimeoutError:
                    if unflushed or gate.held:
                        held = gate.held
                        if held and not held.rstrip().endswith((".", "!", "?")):
                            # A sentence still being written: a short pause between chunks is the model
                            # thinking ("I u" ... "nderstood"), not the end. Speak it only after a real
                            # pause, and then only whole words.
                            if time.monotonic() - last_delta_at < PHRASE_IDLE_S:
                                continue
                            text_out = gate.take_words()
                        else:
                            text_out = gate.take()
                        async for chunk in voice(text_out, "report" if reporting else "answer"):
                            yield chunk
                        unflushed = False
                        yield FlushSentinel()
                        continue
                    if not self.state.is_current(turn.id):
                        return
                    now = time.monotonic()
                    # Still talking is not silence: queued speech (a long confirmation) plays for
                    # seconds after it was handed over, and a progress line stacked behind it only
                    # tells the caller what they are already hearing.
                    if now < self._voiced_until:
                        continue
                    # The caller is waiting in silence: tell them what is going on, in order of
                    # usefulness — the report they were in the middle of, a result that arrived for
                    # something else, then a plain progress line.
                    if said_first or first_delta_at is None:
                        backlog = self.take_backlog() if (said_first and task is not None) else []
                        if backlog:
                            for seg in backlog:
                                async for chunk in self._emit(segments, seg.kind, seg.text, seg.run_id, seg.label):
                                    yield chunk
                                self._spoken.add(seg.text)
                            continue
                    if now >= next_beat and now - self._voiced_until >= HEARTBEAT_QUIET_S and heartbeats < HEARTBEAT_MAX:
                        current = self.state.tasks.get(run_id or "")
                        line = heartbeat_line(
                            current.label if current else "",
                            current.activity if current else self._turn_activity,
                            heartbeats,
                        )
                        heartbeats += 1
                        next_beat = now + HEARTBEAT_EVERY_S
                        logger.info("progress update #%d: %s", heartbeats, line)
                        async for chunk in self._emit(segments, "beat", line, run_id):
                            yield chunk
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
                # routine, another bot's report, a helper, an earlier task — is noted, and told
                # when it is its turn, never spoken as if the caller had asked for it right now.
                if not belongs_to_turn(event.get("runId"), run_id):
                    self._note_background(event)
                    continue
                if not self.state.is_current(turn.id):
                    logger.info("turn %d superseded; dropping its reply", turn.id)
                    # Not lost: what the run said is kept for the report on it.
                    self._note_background(event)
                    return
                if etype == "thread.progress":
                    if payload.get("activity"):
                        self._turn_activity = activity_text(payload) or self._turn_activity
                        self.state.note_task_activity(run_id, self._turn_activity)
                        continue
                    text = progress_text(payload)
                    if text:
                        if first_delta_at is None:
                            first_delta_at = time.monotonic()
                            self._marks["first_delta"] = first_delta_at
                            logger.info("rakazo first delta after %.2fs", first_delta_at - t0)
                        streamed.append(text)
                        last_delta_at = time.monotonic()
                        ready = gate.push(text)
                        if ready:
                            async for chunk in voice(ready, "report" if reporting else "answer"):
                                yield chunk
                elif etype == "thread.message.created" and payload.get("role") == "bot":
                    final = text_from_blocks(payload.get("blocks") or [])
                    self.state.note_task_message(run_id, final)
                    rest = _unspoken_remainder("".join(streamed), final)
                    # A separate bot message is not a continuation of what was streamed: the run's
                    # confirmation and its result are two messages, and the caller must hear both.
                    # But the same text often arrives twice — as progress deltas, then as the
                    # finished message — and saying it again is the repetition callers hear.
                    already_streamed = SpokenLines.normalise(final) in SpokenLines.normalise(
                        "".join(streamed)
                    )
                    if not rest and final and not already_streamed and not self._spoken.has(final):
                        rest = final
                    # What the stream held back mid-sentence continues straight into the tail of the
                    # finished message (a split word stays one word).
                    held = gate.take()
                    if rest or held:
                        logger.info("speaking (message %s): %s", etype, (held + rest)[:70])
                        streamed.append(rest)
                        kind = "report" if (reporting and said_first) else ("ack" if not said_first else "answer")
                        async for chunk in voice(held + rest, kind):
                            yield chunk
                        yield FlushSentinel()
                        unflushed = False
                        if not said_first:
                            said_first = True
                            # A second job while one is running: say so, so they know both are in hand.
                            if card_note:
                                async for chunk in self._emit(segments, "line", card_note):
                                    yield chunk
                                card_note = ""
                            if task is not None and others:
                                line = (
                                    f"That will take a little while, and I'm still on {others[0].label}. "
                                    "I'll tell you how each one goes."
                                )
                                async for chunk in self._emit(segments, "line", line):
                                    yield chunk
                elif etype in RUN_TERMINAL:
                    async for chunk in voice(gate.take(), "report" if reporting else "answer"):
                        yield chunk
                    logger.info("%s after %.2fs", etype, time.monotonic() - t0, extra={"runId": run_id})
                    if self.state.tasks.get(run_id or ""):
                        self.state.finish_task(run_id, tell=False)
                        self.state.forget_task(run_id)
                    else:
                        self.state.forget_task(run_id)
                    break
                elif etype == "run.waiting_input":
                    # The ask card text arrived in thread.message.created; the run now waits for us.
                    break
        except (asyncio.CancelledError, GeneratorExit):
            # The caller cut this turn short. Which part of a report they had not heard is worked out
            # from what the audio reached (see on_speech_cut); an answer they asked for is never
            # held to come back later as if it were a report they missed.
            logger.info("turn %d interrupted; %d chars voiced", turn.id, len("".join(streamed)))
            raise
        finally:
            self.state.record_reply("".join(streamed))
            self._spoken.add("".join(streamed))
            self.state.end_turn(turn.id)
            self._turn_activity = ""

        # Everything this call still owes the caller, now that they have their answer: the update they
        # interrupted (which one it was, then the rest) and results that arrived for other tasks.
        if card_note:  # the run never spoke a whole message first: say it now
            async for chunk in self._emit(segments, "line", card_note):
                yield chunk
            card_note = ""
        self._collect_pending()
        for seg in self.take_backlog():
            async for chunk in self._emit(segments, seg.kind, seg.text, seg.run_id, seg.label):
                yield chunk
            self._spoken.add(seg.text)

    async def tts_node(self, text: AsyncIterable[str], model_settings: ModelSettings):
        first = True

        async def readable() -> AsyncIterable[str]:
            # Chunks arrive split anywhere ("Bo" + "th"), so a long id can only be recognised once
            # its whole word is here: hold back the unfinished last word until its boundary.
            held = ""
            async for chunk in text:
                held += chunk
                cut = max(held.rfind(" "), held.rfind("\n"))
                if cut >= 0:
                    yield speakable(held[: cut + 1])
                    held = held[cut + 1 :]
            if held:
                yield speakable(held)

        async for frame in Agent.default.tts_node(self, readable(), model_settings):
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
    """What of the final message was not streamed yet: all of it, a tail, or nothing.

    A tail keeps its leading space when the streamed text ended on a word boundary, so joining the
    two never reads "named" + "Probe" as "namedProbe".
    """
    if not final:
        return ""
    s, f = _norm(streamed), _norm(final)
    if not s:
        return final
    if f.startswith(s) and len(f) > len(s):
        rest = f[len(s) :]
        return rest.rstrip() if rest[:1] == " " else rest
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
        agent._user_changed = time.monotonic()

    @session.on("speech_created")
    def _on_speech(ev):  # type: ignore[no-untyped-def]
        def done(handle):  # type: ignore[no-untyped-def]
            if handle.interrupted:
                logger.info("speech interrupted by the caller (barge-in)", extra={"speechId": handle.id})
                # What the audio reached: the rest of any report in it stays owed to the caller.
                heard = " ".join(
                    (getattr(item, "text_content", None) or "")
                    for item in handle.chat_items
                    if getattr(item, "role", None) == "assistant"
                )
                try:
                    agent.on_speech_cut(heard)
                except Exception as exc:  # bookkeeping must never end a call
                    logger.warning("could not note the cut-off report: %s", exc)
            if agent.hangup_requested.is_set():
                ctx.shutdown(reason="bot ended the call")

        ev.speech_handle.add_done_callback(done)

    async def speak_sibling_lines() -> None:
        """Say what is owed to the caller while no turn owns the conversation.

        Events are otherwise only read inside a turn, so a task finishing (or the bot confirming
        something typed in chat) while the call is quiet would never be seen. This drains them,
        then tells the finished results — each introduced by the task it belongs to — and the short
        lines of other runs, when the speaker is free and the caller is not talking.
        """
        while True:
            try:
                if agent.state.current is None and not agent._scripted_active:
                    # No turn is reading the stream: take what arrived so it is not lost.
                    while not agent.events.empty():
                        agent._note_background(agent.events.get_nowait())
                    quiet = (
                        session.agent_state == "listening"
                        and session.user_state != "speaking"
                        and time.monotonic() - agent._user_changed > 1.8  # a transcript may still be landing
                    )
                    if quiet:
                        backlog = agent.take_backlog()
                        if backlog:
                            logger.info(
                                "telling the caller what is owed: %s",
                                " | ".join(f"{seg.kind}:{seg.text[:50]}" for seg in backlog),
                            )
                            agent._scripted = backlog
                            session.generate_reply(instructions="tell the caller what is owed")
                        elif not agent.to_speak.empty():
                            said = agent.to_speak.get_nowait()
                            logger.info("speaking a line from another run: %s", said[:80])
                            agent._spoken.add(said)
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
