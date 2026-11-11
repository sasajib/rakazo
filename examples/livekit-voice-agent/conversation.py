"""What the caller and the bot are talking about, kept apart from what the bot is doing.

A Rakazo bot writes everything into one thread: the caller's turns, the bot's replies, and the
progress of every run it has going — routines, other bots' reports, background helpers. A call
only ever needs the first two. Treating the third as conversation is how a bot ends up reading
out yesterday's task updates instead of answering the question it was just asked.

This module holds the call's conversation state:

* one turn at a time, each with an id, so a reply that arrives late cannot answer a newer question;
* the active topic, so a follow-up is recognised as a follow-up and a new subject is not;
* task events, coalesced per run and never spoken unless the caller asks about them.

Nothing here imports LiveKit or the Rakazo client: it is a state machine over strings and times,
so it can be tested without a call.
"""

from __future__ import annotations

import re
import time
from collections import deque
from dataclasses import dataclass, field

# Words that say nothing about the subject of a sentence.
_STOPWORDS = frozenset(
    """
    a about after again all also am an and any are as at be been before being but by can could
    did do does doing done for from get got had has have having he her here him his how i if in
    into is it its just know let like me more most my no not now of off on once one only or other
    our out over own please same she should so some something still such tell than that the their
    them then there these they thing think this those to too under up us very was we well were
    what when where which while who why will with would yes you your
    """.split()
)

# A question about progress, not about the subject. Answered from the task notes this call saw.
_STATUS_PATTERNS = (
    re.compile(r"\bwhat (?:are|were) you (?:doing|working on|up to)\b", re.I),
    re.compile(r"\bwhat(?:'s| is) (?:the )?(?:status|progress|update)\b", re.I),
    re.compile(r"\bhow(?:'s| is) (?:it|that|the \w+) going\b", re.I),
    re.compile(r"\b(?:any|an) update\b", re.I),
    re.compile(r"\bare you (?:still )?(?:working|busy|there)\b", re.I),
    re.compile(r"\bhow (?:far|long)\b.*\b(?:done|finish|take|left|going)\b", re.I),
    re.compile(r"\bwhat(?:'s| is) happening\b", re.I),
)

# Words that point back at what is already being discussed.
_CONTINUATION = re.compile(
    r"\b(?:that|this|it|its|those|these|them|they|and|also|then|so|same|again|instead|"
    r"more|another|else|but|because|why|really|actually)\b",
    re.I,
)

# Words a caller uses to leave the subject ("what about ...", "now tell me ...").
_TOPIC_SHIFT = re.compile(r"\b(?:what about|how about|now|next|instead|by the way|different question)\b", re.I)

_WORD = re.compile(r"[a-z0-9][a-z0-9'-]*", re.I)

MAX_TOPIC_WORDS = 4


def _words(text: str) -> list[str]:
    return _WORD.findall(text.lower())


def significant_words(text: str) -> tuple[str, ...]:
    """The words of a sentence that say what it is about, in the order they appear."""
    seen: list[str] = []
    for word in _words(text):
        if word in _STOPWORDS or len(word) < 3:
            continue
        if word not in seen:
            seen.append(word)
    return tuple(seen)


def topic_of(text: str) -> str:
    """A short handle for what a sentence is about: its first few significant words."""
    return " ".join(significant_words(text)[:MAX_TOPIC_WORDS])


def asks_for_status(text: str) -> bool:
    """Whether the caller is asking how the work is going rather than asking about the subject."""
    return any(pattern.search(text) for pattern in _STATUS_PATTERNS)


def continues_topic(text: str, topic: str) -> bool:
    """Whether a sentence carries on the active topic instead of starting a new one."""
    if not topic:
        return False
    if _TOPIC_SHIFT.search(text):
        return False
    active = set(topic.split())
    if active & set(significant_words(text)):
        return True
    # A turn that points back at what was said ("and why?", "how much does that cost?") belongs to
    # the topic; one that names its own subject does not. A shift marker ("what about...") was
    # already treated as a new subject above.
    return bool(_CONTINUATION.search(text))


def belongs_to_turn(event_run_id: str | None, run_id: str | None) -> bool:
    """Whether a streamed event is output of the run this turn started.

    Strict on purpose: an event with no run id, or from a run the call did not start, is not an
    answer to the question being answered. A loose match is how a background task's progress gets
    spoken as if it were the reply.
    """
    return bool(run_id) and event_run_id == run_id


@dataclass(frozen=True)
class Turn:
    """One thing the caller said, and what it was taken to be."""

    id: int
    text: str
    kind: str  # "status" | "continue" | "new_topic"
    topic: str
    at: float


@dataclass
class TaskNote:
    """The latest thing a background run of this bot said, kept out of the conversation."""

    run_id: str
    text: str
    at: float


@dataclass
class ConversationState:
    """The call's conversation: turns, the active topic, and task notes it may be asked about."""

    max_turns: int = 12
    max_notes: int = 6
    turns: deque[Turn] = field(default_factory=lambda: deque(maxlen=12))
    replies: deque[str] = field(default_factory=lambda: deque(maxlen=12))
    active_topic: str = ""
    current: Turn | None = None
    notes: dict[str, TaskNote] = field(default_factory=dict)
    _next_id: int = 1

    def __post_init__(self) -> None:
        # The factories above fix the caps; keep the two in step when a caller passes its own.
        self.turns = deque(maxlen=self.max_turns)
        self.replies = deque(maxlen=self.max_turns)

    # --- turns ---------------------------------------------------------------------------------

    def begin_turn(self, text: str, now: float | None = None) -> Turn:
        """Start the turn for what the caller just said, closing whichever turn was open.

        The previous turn is dead from this moment: a generator still streaming it checks
        `is_current` and stops, so a delayed reply can never be spoken as the answer to this one.
        """
        at = time.monotonic() if now is None else now
        spoken = text.strip()
        if asks_for_status(spoken):
            kind = "status"
        elif self.active_topic and not continues_topic(spoken, self.active_topic):
            kind = "new_topic"
        else:
            kind = "continue" if self.active_topic else "new_topic"
        topic = self.active_topic if kind in ("status", "continue") else topic_of(spoken)
        turn = Turn(id=self._next_id, text=spoken, kind=kind, topic=topic, at=at)
        self._next_id += 1
        self.turns.append(turn)
        self.current = turn
        if kind == "new_topic":
            self.active_topic = topic
            # A new subject means each still-note is about something else; a status question
            # cannot be answered with it.
            self._drop_notes()
        return turn

    def is_current(self, turn_id: int) -> bool:
        """Whether this turn is still the one being answered."""
        return self.current is not None and self.current.id == turn_id

    def end_turn(self, turn_id: int) -> None:
        """Close a turn that finished or was interrupted, leaving the topic in place."""
        if self.current is not None and self.current.id == turn_id:
            self.current = None

    def record_reply(self, text: str) -> None:
        """Keep what the bot actually said, so the conversation trace is turns and replies only."""
        spoken = text.strip()
        if spoken:
            self.replies.append(spoken)

    # --- task notes ----------------------------------------------------------------------------

    def note_task_event(self, run_id: str | None, text: str, now: float | None = None) -> bool:
        """Remember what a non-conversational run said. Never spoken on its own.

        Coalesced per run: a run that reports ten times leaves one note, so asking for status
        cannot dump ten updates into the caller's ear.
        """
        if not run_id or not text.strip():
            return False
        at = time.monotonic() if now is None else now
        self.notes[run_id] = TaskNote(run_id=run_id, text=text.strip(), at=at)
        while len(self.notes) > self.max_notes:
            oldest = min(self.notes.values(), key=lambda note: note.at)
            self.notes.pop(oldest.run_id, None)
        return True

    def forget_task(self, run_id: str | None) -> None:
        """Drop a run's note: it finished, so its progress is no longer "what is happening"."""
        if run_id:
            self.notes.pop(run_id, None)

    def _drop_notes(self) -> None:
        self.notes.clear()

    def status_line(self, bot_name: str = "") -> str | None:
        """One sentence about the work, for when the caller asks. None when there is nothing to say."""
        if not self.notes:
            return None
        latest = max(self.notes.values(), key=lambda note: note.at)
        subject = f"{bot_name} is" if bot_name else "Still"
        text = latest.text.rstrip(".")
        if len(self.notes) == 1:
            return f"{subject} working on this: {text}."
        return f"{subject} working on {len(self.notes)} things. Latest: {text}."

    # --- introspection -------------------------------------------------------------------------

    def conversation(self) -> tuple[Turn, ...]:
        """The conversation so far: what the caller said, nothing the bot was doing."""
        return tuple(self.turns)

    def trace(self) -> list[str]:
        """A readable log line per turn, for the agent's debug output."""
        return [f"{turn.id} {turn.kind} topic={turn.topic!r} {turn.text[:60]!r}" for turn in self.turns]
