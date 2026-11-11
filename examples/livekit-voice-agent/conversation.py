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


_WORD = re.compile(r"[a-z0-9][a-z0-9'-]*", re.I)


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


_QUESTION_START = re.compile(
    r"^(?:what|why|how|when|where|who|which|whose|can|could|do|does|did|is|are|was|were|will|would|"
    r"should|shall|may|might|have|has|tell me|explain|give me|show me|list|summari[sz]e|read me)\b",
    re.I,
)

# Sounds that keep a conversation going without adding a subject: "hmm", "okay", "go on".
_FILLER = re.compile(
    r"^(?:hmm+|mhm+|uh+huh|ok(?:ay)?|right|sure|yes|yeah|yep|no|nah|go on|continue|carry on|"
    r"keep going|and\??|and then\??|what else\??|go ahead|i see|alright|fine|got it)[\s.!?,]*$",
    re.I,
)

# A question about the world ("what is…", "why did…") is not a request for work, however it reads.
_FACT_QUESTION = re.compile(
    r"^(?:what|why|how|when|where|who|which|whose|is|are|was|were|do|does|did)\b", re.I
)

# Verbs that name work; the clause carrying one is the task, whatever the caller said around it.
_TASK_VERBS = frozenset(
    """
    add analyse analyze answer book build buy call cancel check clean close compare compile connect
    copy create cut delete deploy describe design draft draw edit email export find finish fix follow
    generate get give install list look make merge move open order organise organize plan post prepare
    print publish read remove rename reply report research review run save schedule search send set
    setup show sort start stop summarise summarize tell test translate update upload write
    """.split()
)

# Asking to be told something is a question, not a task: these are never work on their own.
_INFORMATIONAL_VERBS = frozenset({"tell", "show", "describe", "explain", "list", "read", "answer"})
_WORK_VERBS = _TASK_VERBS - _INFORMATIONAL_VERBS

_NOISE_PREFIX = re.compile(
    r"^(?:(?:uh|uhh|um|umm|ah|ahh|eh|er|erm|hmm|hm|mm|like|so|well|okay|ok)\b[,. ]*)+", re.I
)


def asks_question(text: str) -> bool:
    """Whether a spoken turn is asking something, rather than just keeping the line open."""
    said = (text or "").strip()
    if not said:
        return False
    if "?" in said:
        return True
    return bool(_QUESTION_START.search(said))


def is_filler(text: str) -> bool:
    """Whether a turn adds no subject of its own ("hmm", "okay", "go on")."""
    return bool(_FILLER.match((text or "").strip()))


def asks_for_work(text: str) -> bool:
    """Whether the turn is asking the agent to *do* something, not to say something."""
    said = (text or "").strip()
    if not said:
        return False
    said = _NOISE_PREFIX.sub("", said)
    if _FACT_QUESTION.search(said):
        return False
    words = {re.sub(r"[^a-z]", "", word.lower()) for word in said.split()}
    return bool(words & _WORK_VERBS)


# What a caller says to have the rest of an interrupted report.
_CONTINUE_REQUEST = re.compile(
    r"^(?:go on|continue|carry on|keep going|yes(?: please)?|yeah|sure|please do|ok(?:ay)?|"
    r"the rest|read it|say it)\b[\s.!?]*$",
    re.I,
)


_APPROVE = re.compile(r"\b(?:approve|allow|yes|yeah|okay|ok|go ahead|do it|proceed|fine)\b", re.I)
_ALWAYS = re.compile(r"\b(?:always|every time|from now on|don'?t ask again)\b", re.I)
_DENY = re.compile(r"\b(?:deny|no|nope|don'?t|stop|cancel|reject|not now)\b", re.I)


def spoken_decision_action(text: str, actions: list[dict]) -> str | None:
    """The action id a caller just chose out loud, or None when they did not clearly decide.

    An approval card is the app's way of asking; a caller on the phone answers the same question
    with a word. Only an explicit word counts — "hmm" is not consent to archive a bot.
    """
    said = (text or "").strip()
    if not said:
        return None
    ids = {str(action.get("id")) for action in actions if action.get("id")}
    if not ids:
        return None
    if _ALWAYS.search(said) and "always" in ids:
        return "always"
    if _DENY.search(said) and "deny" in ids:
        return "deny"
    if _APPROVE.search(said) and "allow" in ids:
        return "allow"
    return None


_LABEL_BREAK = re.compile(r"\b(?:and then|and also|then|so that|so we|so i|because|while|but)\b|[,;.!?]", re.I)
_LABEL_LEAD = re.compile(r"^(?:please|can you|could you|would you|will you|i want you to|i want to|we want to|i'd like you to|i need you to|let's|lets|go ahead and|just)\s+", re.I)
_LABEL_FILLER = re.compile(r",?\s*\b(?:uh+|um+|er+|erm|hmm+)\b[,.]?", re.I)
_LABEL_GREETING = re.compile(r"^(?:hey|hi|hello|okay|ok|so)\b[,. ]*(?:chief\b[,. ]*)?", re.I)
MAX_LABEL_WORDS = 10


def task_label(text: str) -> str:
    """How the caller's request is named when the bot reports on it later.

    Built from their own words (the clause that carries the work verb), so \"I was giving you an
    update on your request to create a voice test agent\" names the thing they asked for. Never a
    fixed template around the whole transcript, which restates fillers.
    """
    said = _LABEL_FILLER.sub("", (text or "").strip())
    said = _LABEL_GREETING.sub("", _NOISE_PREFIX.sub("", said)).strip()
    for _ in range(3):  # "hey chief, please could you ..." strips layer by layer
        trimmed = _LABEL_LEAD.sub("", said).strip()
        if trimmed == said:
            break
        said = trimmed
    words = said.split()
    start = next(
        (i for i, word in enumerate(words) if re.sub(r"[^a-z]", "", word.lower()) in _WORK_VERBS), None
    )
    if start is None:
        return "your last request"
    clause = _LABEL_BREAK.split(" ".join(words[start:]))[0].split()
    phrase = " ".join(clause[:MAX_LABEL_WORDS]).strip().rstrip(".?!,")
    if not phrase:
        return "your last request"
    phrase = re.sub(r"\ban (?=[b-df-hj-np-tv-z])", "a ", phrase)  # \"create an, uh, voice\" -> \"an voice\"
    return f"your request to {phrase[0].lower() + phrase[1:]}"


_STOP_REQUEST = re.compile(
    r"^(?:(?:no |ok(?:ay)? |hey )?(?:stop|cancel|skip|forget)(?: it| that| this)?|never ?mind|that'?s enough|enough)\b",
    re.I,
)


_MOVE_ON = re.compile(
    r"\b(?:already|added|done|skip|cancel|never ?mind|forget|stop|instead|try again|check|test|"
    r"carry on|move on|without|not now|can'?t|don'?t have)\b",
    re.I,
)


def wants_to_move_on(text: str) -> bool:
    """Whether a caller facing a request for a secret is declining it, not typing it by voice."""
    return bool(_MOVE_ON.search(text or ""))


def asks_to_stop(text: str) -> bool:
    """Whether the caller is waving off what was being told (\"never mind\", \"skip that\")."""
    return bool(_STOP_REQUEST.match((text or "").strip()))


_TOOL_PHRASES = {
    "spawn_bot": "creating the agent",
    "create_bot": "creating the agent",
    "list_fleet": "checking your fleet",
    "list_bots": "checking your fleet",
    "find_tool": "looking for the right tool",
    "scratchpad": "making notes",
    "shell": "working on the computer",
    "bash": "working on the computer",
    "browser": "browsing the web",
    "web_search": "searching the web",
    "read_file": "reading a file",
    "write_file": "writing a file",
    "update_bot": "updating the agent",
}


def humanize_activity(text: str) -> str:
    """A tool status line (\"using spawn_bot\") as something a person would say, or nothing.

    An unrecognised snake_case name is dropped rather than read aloud: \"using spawn underscore bot\"
    tells the caller nothing.
    """
    said = re.sub(r"\s+", " ", (text or "").strip()).rstrip(".…")
    said = re.sub(r"^(?:using|running|calling|tool:?)\s+", "", said, flags=re.I)
    key = said.lower().replace(" ", "_").replace("-", "_")
    if key in _TOOL_PHRASES:
        return _TOOL_PHRASES[key]
    if re.fullmatch(r"[a-z0-9]+(?:[_.][a-z0-9]+)+", said.lower()) or "_" in said:
        return ""
    return said


def heartbeat_line(label: str, activity: str, count: int) -> str:
    """A short progress line for a caller who has heard nothing for a while.

    Built from what is true — which task, and what the run last said it was doing — not from
    anything the caller said. Varies by count so it is never the same sentence twice.
    """
    doing = humanize_activity(activity)
    if len(doing) > 70 or not doing:
        doing = ""
    on = label or "that"
    if count == 0:
        return f"Still working on {on}" + (f" — {doing[0].lower() + doing[1:]}." if doing else ".")
    if count == 1:
        return "Still going" + (f" — {doing[0].lower() + doing[1:]}." if doing else ", it's taking a little longer.")
    if count == 2:
        return f"Nothing wrong, {on} just needs a bit more time."
    return f"Still on {on}. I'll tell you the moment it's done."


def asks_to_continue(text: str) -> bool:
    """Whether the caller is asking for the rest of something, rather than a new question."""
    return bool(_CONTINUE_REQUEST.match((text or "").strip())) and not asks_question(text)


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


_LONG_ID = re.compile(r"^([`'\"(]*)([A-Za-z0-9_-]{20,})([`'\".,;:!?)]*)$")


def speakable(text: str) -> str:
    """Make a line fit for the ear. A raw 25-character id read out letter by letter is noise: say
    which one it is by its ending, as a person would. The chat keeps the full id."""

    def fix(match: re.Match[str]) -> str:
        lead, body, trail = match.groups()
        if not any(ch.isdigit() for ch in body) or " " in body:
            return match.group(0)
        return f"{lead}id ending {body[-4:]}{trail}"

    return " ".join(_LONG_ID.sub(fix, word) for word in text.split(" "))


class SentenceGate:
    """Streamed text in whole sentences, so a sentence the caller has already heard can be dropped.

    A bot restates itself ("I haven't checked the fleet this turn, so ...") at the end of answer
    after answer. Chunks arrive split anywhere, so text is held until a sentence ends; `take` hands
    back the unfinished remainder, to be joined with whatever continues it.
    """

    def __init__(self) -> None:
        self._buffer = ""

    def push(self, text: str) -> str:
        """Add a chunk; return the complete sentences so far (trailing space kept), keep the rest."""
        self._buffer += text
        parts = re.split(r"(?<=[.!?])(\s+)", self._buffer)
        # parts alternates sentence, separator, sentence, ... ; the last item is unfinished
        done = "".join(parts[:-1]) if len(parts) > 1 else ""
        self._buffer = parts[-1] if len(parts) > 1 else self._buffer
        return done

    def take(self) -> str:
        rest, self._buffer = self._buffer, ""
        return rest


class SpokenLines:
    """What this call has already said, so the same thing is never delivered twice.

    A progress line and the final message often open with the same words, and an event can be seen
    twice (once inside a turn, once while the call is idle). Either way the caller must hear it once.
    """

    def __init__(self, overlap: int = 60) -> None:
        self._said: list[str] = []
        self._overlap = overlap

    @staticmethod
    def normalise(text: str) -> str:
        return " ".join(re.sub(r"[^a-z0-9 ]", " ", (text or "").lower()).split())

    def has(self, text: str) -> bool:
        said = self.normalise(text)
        if not said:
            return True
        for previous in self._said:
            if said == previous:
                return True
            if len(said) >= 20 and said in previous:
                return True
            head = min(self._overlap, len(said), len(previous))
            if head >= 20 and (said.startswith(previous[:head]) or previous.startswith(said[:head])):
                return True
        return False

    def add(self, text: str) -> None:
        said = self.normalise(text)
        if said:
            self._said.append(said)


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
    asked: bool = False


@dataclass
class TaskNote:
    """The latest thing a background run of this bot said, kept out of the conversation."""

    run_id: str
    text: str
    at: float


@dataclass
class Segment:
    """One thought the agent voiced, and what kind it was.

    `report` is the only kind that is put back when the caller cuts it off: an update on a task is
    theirs to hear in full, an answer they asked for or a "still working" line is not.
    """

    kind: str  # ack | answer | report | line | beat
    text: str
    run_id: str | None = None
    label: str = ""
    # Streamed text arrives in chunks that split words ("Bo" + "th"): a chunk that goes on from the
    # one before is joined to it without a space when the speech is reconstructed.
    joined: bool = False


@dataclass
class Task:
    """Work the caller asked for on this call, tracked from the request to the report on it."""

    run_id: str
    label: str
    started: float
    status: str = "running"  # running | done
    # The last thing the run wrote itself (its confirmation, then its result) and what it is doing.
    last_message: str = ""
    activity: str = ""
    # The finished result still has to be told to the caller; set once, cleared when told.
    report: str = ""


@dataclass
class ConversationState:
    """The call's conversation: turns, the active topic, and task notes it may be asked about."""

    max_turns: int = 12
    max_notes: int = 6
    turns: deque[Turn] = field(default_factory=lambda: deque(maxlen=12))
    replies: deque[str] = field(default_factory=lambda: deque(maxlen=12))
    active_topic: str = ""
    current: Turn | None = None
    # True while the last thing the caller asked is still the thing being answered.
    answering: bool = False
    # The report the caller interrupted, kept as text so a later topic change cannot drop it, and
    # whether the offer to finish it was made.
    report_run_id: str | None = None
    report_text: str = ""
    report_offered: bool = False
    notes: dict[str, TaskNote] = field(default_factory=dict)
    # The work asked for on this call, by run id, in the order it was asked.
    tasks: dict[str, Task] = field(default_factory=dict)
    report_label: str = ""
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
        asked = asks_question(spoken)
        turn = Turn(id=self._next_id, text=spoken, kind=kind, topic=topic, at=at, asked=asked)
        # A question starts (or restarts) the answer; filler keeps it going while it lasts.
        self.answering = asked or (self.answering and is_filler(spoken))
        self._next_id += 1
        self.turns.append(turn)
        self.current = turn
        if kind == "new_topic":
            # The interrupted update is still theirs to ask for: a new question does not throw the
            # rest of it away, it only moves what is being talked about.
            self.active_topic = topic
            # A new subject means each still-note is about something else; a status question
            # cannot be answered with it.
            self._drop_notes()
        return turn

    def wants_answer(self, text: str) -> bool:
        """Whether this turn must be answered, rather than listening to the work.

        A question always is. Filler is, but only while a question is still open — "hmm" after
        "what is the capital?" is the caller waiting on that answer, while "hmm" after a task report
        is the caller letting the work carry on.
        """
        if asks_question(text):
            return True
        return self.answering and is_filler(text)

    # --- tasks ---------------------------------------------------------------------------------

    def register_task(self, run_id: str | None, utterance: str, now: float | None = None) -> Task | None:
        """Track the run a spoken request started, under a name the caller will recognise."""
        if not run_id:
            return None
        known = self.tasks.get(run_id)
        if known:
            return known  # a second request steered into the same run keeps the first name
        at = time.monotonic() if now is None else now
        task = Task(run_id=run_id, label=task_label(utterance), started=at)
        self.tasks[run_id] = task
        while len(self.tasks) > 12:
            self.tasks.pop(next(iter(self.tasks)))
        return task

    def running_tasks(self, except_run: str | None = None) -> list[Task]:
        return [t for t in self.tasks.values() if t.status == "running" and t.run_id != except_run]

    def note_task_message(self, run_id: str | None, text: str) -> None:
        task = self.tasks.get(run_id or "")
        if task and text.strip():
            task.last_message = text.strip()

    def note_task_activity(self, run_id: str | None, text: str) -> None:
        task = self.tasks.get(run_id or "")
        if task and text.strip():
            task.activity = text.strip()

    def finish_task(self, run_id: str | None, tell: bool) -> Task | None:
        """The run ended. When its result was not heard (the caller was busy elsewhere), keep it to
        be reported once; a result already spoken in its own turn is simply closed."""
        task = self.tasks.get(run_id or "")
        if not task or task.status == "done":
            return task
        task.status = "done"
        if tell and task.last_message:
            task.report = task.last_message
        return task

    def take_pending_report(self) -> Task | None:
        """The oldest finished task whose result has not been told yet."""
        for task in self.tasks.values():
            if task.report:
                return task
        return None

    def report_told(self, run_id: str) -> None:
        task = self.tasks.get(run_id)
        if task:
            task.report = ""

    def label_of(self, run_id: str | None) -> str:
        task = self.tasks.get(run_id or "")
        return task.label if task else ""

    def note_report_interrupted(self, run_id: str | None, text: str = "") -> None:
        """Remember that the caller cut a report short, with what of it was heard.

        The text is kept here rather than read back from the task notes: a new subject clears those
        notes, and the interrupted report must survive that to be offered later.
        """
        if not run_id:
            return
        said = (text or "").strip() or (self.notes.get(run_id).text if run_id in self.notes else "")
        self.report_run_id = run_id
        self.report_text = said
        self.report_offered = False
        self.report_label = self.label_of(run_id)

    def paused_report(self) -> str | None:
        """The text of the interrupted report, as far as this call has seen it."""
        if not self.report_run_id:
            return None
        return self.report_text or None

    def has_paused_report(self) -> bool:
        return self.report_run_id is not None and self.paused_report() is not None

    def resume_preface(self) -> str:
        """What is said before an interrupted report carries on: which report it is."""
        if self.report_label:
            return f"I was giving you an update on {self.report_label}. Let me continue."
        return "I was in the middle of an update. Let me continue."

    def take_report_offer(self, bot_name: str = "") -> str | None:
        """One sentence offering the rest of an interrupted report, once per interruption."""
        if self.report_offered or not self.has_paused_report():
            return None
        self.report_offered = True
        who = f"{bot_name} still" if bot_name else "I still"
        return f"{who} has the rest of that update — say go on and I'll finish it."

    def resume_report(self) -> str | None:
        """The interrupted report, for a caller who asked for it. Clears the pause."""
        text = self.paused_report()
        self.report_run_id = None
        self.report_text = ""
        self.report_offered = False
        self.report_label = ""
        return text

    def drop_paused_report(self) -> None:
        """The caller moved on: the interrupted report is not offered again."""
        self.report_run_id = None
        self.report_text = ""
        self.report_offered = False

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

    def task_status(self, now: float | None = None) -> str | None:
        """One honest sentence about the work this call asked for, for when the caller asks."""
        at = time.monotonic() if now is None else now
        running = [t for t in self.tasks.values() if t.status == "running"]
        waiting = [t for t in self.tasks.values() if t.status == "done" and t.report]
        parts: list[str] = []
        if len(running) == 1:
            task = running[0]
            said = humanize_activity(task.activity)
            doing = f", currently {said.lower()}" if said else ""
            parts.append(f"I'm still working on {task.label}{doing}. It's been about {int(at - task.started)} seconds")
        elif running:
            parts.append("I'm working on " + str(len(running)) + " things: " + "; ".join(t.label for t in running))
        if waiting:
            parts.append(("Finished and waiting to be reported: " if parts else "") + "; ".join(t.label for t in waiting))
        if not parts:
            return None
        return ". ".join(parts).rstrip(".") + "."

    # --- introspection -------------------------------------------------------------------------

    def conversation(self) -> tuple[Turn, ...]:
        """The conversation so far: what the caller said, nothing the bot was doing."""
        return tuple(self.turns)

    def trace(self) -> list[str]:
        """A readable log line per turn, for the agent's debug output."""
        return [f"{turn.id} {turn.kind} topic={turn.topic!r} {turn.text[:60]!r}" for turn in self.turns]
