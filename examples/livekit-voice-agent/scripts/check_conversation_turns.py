"""Drive `RakazoAgent.llm_node` without a call, and check what it speaks.

The pure state machine is covered by `tests/test_conversation.py`. This script covers the wiring:
which streamed events reach the caller's ear, what happens to a turn that is superseded, and what a
status question answers with. It needs the livekit package (the agent imports it), so run it in the
agent image:

    docker run --rm -v "$PWD:/app" -w /app rakazo-voice-agent python scripts/check_conversation_turns.py
"""

from __future__ import annotations

import asyncio
import sys
import types
from types import SimpleNamespace

sys.path.insert(0, "/app")

from agent import CallContext, RakazoAgent  # noqa: E402
from conversation import Segment  # noqa: E402

CALL = CallContext(call_id="call-1", bearer="", space_id="space-1", bot_id="bot-1", bot_name="Voice")


class FakeClient:
    """Just enough Rakazo for one turn: an idle thread, a send receipt, and no follow-ups.

    The events a turn streams are enqueued by `threads_send`, the way the real subscribe stream
    delivers them — after the send, never before it.
    """

    def __init__(self, script: list[dict] | None = None) -> None:
        self.sends: list[str] = []
        self.script = script or []
        self.agent: RakazoAgent | None = None

    async def threads_get(self, bot_id: str) -> dict:
        return {"cursor": 0, "messages": [], "run": None}

    async def threads_send(self, bot_id: str, text: str, nonce: str, answer_now=None, leave_cards: bool = False) -> dict:
        self.sends.append(text)
        self.left_cards = leave_cards
        assert self.agent is not None
        for item in self.script:
            self.agent.events.put_nowait(item)
        return {"runId": "run-ours"}

    async def threads_follow_up(self, bot_id: str, text: str, nonce: str, answer_now=None) -> dict:
        raise AssertionError("an idle thread must not need followUp")

    async def threads_answer(self, *args, **kwargs) -> dict:
        raise AssertionError("nothing is waiting on an answer")


def chat_ctx(text: str):
    item = SimpleNamespace(type="message", role="user", text_content=text)
    return SimpleNamespace(items=[item])


def event(etype: str, run_id: str | None, **payload) -> dict:
    return {"type": etype, "runId": run_id, "payload": payload}


def progress(text: str) -> dict:
    return {"text": text, "streaming": True}


async def collect(agent: RakazoAgent, text: str) -> list[str]:
    chunks: list[str] = []
    async for chunk in agent.llm_node(chat_ctx(text), [], None):
        if isinstance(chunk, str):  # a FlushSentinel is a speaker instruction, not words
            chunks.append(chunk)
    return chunks


async def main() -> None:
    failures: list[str] = []

    def check(name: str, condition: bool, detail: str = "") -> None:
        print(f"{'ok  ' if condition else 'FAIL'} {name}{'' if condition else f' — {detail}'}")
        if not condition:
            failures.append(name)

    # 1. A background run's progress is noted, never spoken; our run's reply is spoken.
    client = FakeClient(
        [
            event("thread.progress", "run-background", **progress("Crawling page 5")),
            event("thread.progress", "run-ours", **progress("Dhaka is the capital.")),
            event(
                "thread.message.created",
                "run-ours",
                role="bot",
                blocks=[{"kind": "text", "text": "Dhaka is the capital."}],
            ),
            event("run.completed", "run-ours"),
        ]
    )
    agent = RakazoAgent(CALL, client)
    client.agent = agent
    spoken = "".join(await collect(agent, "What is the capital of Bangladesh?"))
    check("speaks its own run's reply", "Dhaka" in spoken, spoken)
    check("never speaks a background run's progress", "Crawling" not in spoken, spoken)
    check(
        "remembers the background run as a note",
        any("Crawling" in note.text for note in agent.state.notes.values()),
        repr(agent.state.notes),
    )
    check("sent the utterance once", len(client.sends) == 1, repr(client.sends))

    # 2. A status question is answered from those notes, in one sentence, without a new turn.
    client = FakeClient()
    agent = RakazoAgent(CALL, client)
    client.agent = agent
    # The topic comes first, then the background work reports while that topic is active; a new
    # subject is what drops notes, not the act of talking.
    agent.state.begin_turn("Tell me about the pricing site")
    agent.state.note_task_event("run-background", "Crawling page 5 of the pricing site")
    spoken = "".join(await collect(agent, "What are you working on?"))
    check("answers a status question from what it saw", "pricing site" in spoken.lower(), spoken)
    check("does not send a status question to Rakazo", client.sends == [], repr(client.sends))
    check("keeps it to one sentence", spoken.count(".") <= 1, spoken)

    # 3. A superseded turn stops instead of answering the newer question.
    client = FakeClient(
        [
            event("thread.progress", "run-ours", **progress("Dhaka is the capital.")),
            event("thread.progress", "run-ours", **progress(" It has 170 million people.")),
            event("run.completed", "run-ours"),
        ]
    )
    agent = RakazoAgent(CALL, client)
    client.agent = agent
    generator = agent.llm_node(chat_ctx("Tell me about Bangladesh"), [], None)
    first = await generator.__anext__()
    agent.state.begin_turn("Actually, what is the weather in Dhaka?")
    rest: list[str] = []
    try:
        async for chunk in generator:
            rest.append(chunk)
    except StopAsyncIteration:
        pass
    check("the superseded turn spoke its first chunk", "Dhaka" in first, first)
    check("and then stopped", rest == [], repr(rest))

    # 4. A task that finishes while the caller is on something else is told afterwards, by name,
    #    once — and the talk answer comes first.
    client = FakeClient(
        [
            event("thread.progress", "run-task", **progress("On it.")),
            event("thread.message.created", "run-task", role="bot", blocks=[{"kind": "text", "text": "Harness Check is created and checked in the fleet, id ending abc."}]),
            event("run.completed", "run-task"),
            event("thread.progress", "run-ours", **progress("New Delhi is the capital.")),
            event("run.completed", "run-ours"),
        ]
    )
    agent = RakazoAgent(CALL, client)
    client.agent = agent
    agent.state.register_task("run-task", "create a voice testing agent called harness check", now=0)
    spoken = " ".join(await collect(agent, "What is the capital of India?"))
    check("answers the question first", spoken.index("New Delhi") < spoken.index("Harness Check"), spoken)
    check("then reports the finished task by name", "About your request to create a voice testing agent" in spoken, spoken)
    check("reports it once", spoken.count("Harness Check is created") == 1, spoken)
    check("nothing is left owed", agent.state.take_pending_report() is None)

    # 5. Cutting a report off keeps the unheard part; the next turn returns to it, naming it.
    client = FakeClient(
        [
            event("thread.progress", "run-ours", **progress("Four.")),
            event("run.completed", "run-ours"),
        ]
    )
    agent = RakazoAgent(CALL, client)
    client.agent = agent
    agent.state.register_task("run-task", "create a voice assistant", now=0)
    report = "The assistant has three voices. It greets callers by name. It also keeps a call log."
    segments = [
        Segment("line", "About your request to create a voice assistant:", "run-task", "your request to create a voice assistant"),
        Segment("report", report, "run-task", "your request to create a voice assistant"),
    ]
    agent.log_speech(segments)
    agent.on_speech_cut("About your request to create a voice assistant: The assistant has three voices.")
    check("keeps the unheard part", agent.state.paused_report() == "It greets callers by name. It also keeps a call log.", repr(agent.state.paused_report()))
    spoken = " ".join(await collect(agent, "What is two plus two?"))
    check("answers the interruption first", spoken.index("Four") < spoken.index("I was giving you an update"), spoken)
    check("names the report it returns to", "I was giving you an update on your request to create a voice assistant. Let me continue." in spoken, spoken)
    check("continues from where it stopped", spoken.endswith("It also keeps a call log.") and "three voices" not in spoken.split("Let me continue.")[1], spoken)

    # 6. Cut off while the intro line is still being said: the whole report is still owed, and a
    #    sentence the caller already heard in the answer is not said again.
    agent = RakazoAgent(CALL, FakeClient())
    agent.state.register_task("run-task", "create a voice assistant", now=0)
    label = "your request to create a voice assistant"
    segments = [
        Segment("answer", "New Delhi is the capital of India.", "run-ours"),
        Segment("line", f"About {label}:", "run-task", label),
        Segment("report", "It has three voices. It keeps a call log.", "run-task", label),
    ]
    agent.log_speech(segments)
    agent.on_speech_cut(f"New Delhi is the capital of India. About {label}:")
    check("a cut inside the intro keeps the whole report", agent.state.paused_report() == "It has three voices. It keeps a call log.", repr(agent.state.paused_report()))
    agent = RakazoAgent(CALL, FakeClient())
    agent._spoken.add("New Delhi is the capital of India.")
    agent.state.register_task("run-task", "create a voice assistant", now=0)
    agent.state.note_task_message("run-task", "New Delhi is the capital of India. Both agents are created and verified.")
    agent.state.finish_task("run-task", tell=True)
    told = " ".join(seg.text for seg in agent.take_backlog())
    check("a result does not repeat what was just answered", "New Delhi" not in told and "created and verified" in told, told)

    # 6b. Streamed chunks split words ("B" + "oth"): the cut must still be placed.
    agent = RakazoAgent(CALL, FakeClient())
    agent.state.register_task("run-task", "create a voice assistant", now=0)
    label = "your request to create a voice assistant"
    segments = [
        Segment("ack", "You want a new voice bot, so I'm checking the fleet first.", "run-task", label),
        Segment("report", "B", "run-task", label),
        Segment("report", "oth are created. The creation calls returned ok.", "run-task", label, joined=True),
    ]
    agent.log_speech(segments)
    agent.on_speech_cut("You want a new voice bot, so I'm checking the fleet first.Both are created. The")
    check("a cut inside split chunks is placed", agent.state.paused_report() == "creation calls returned ok.", repr(agent.state.paused_report()))

    # 7. A run parked on a secret card never blocks the caller: a question about it gets one honest
    #    answer; a request of their own goes ahead (the card is set aside), and no word is ever sent
    #    as the secret.
    class ParkedClient(FakeClient):
        def __init__(self) -> None:
            super().__init__([event("thread.progress", "run-ours", **progress("Creating it now.")), event("run.completed", "run-ours")])
            self.stopped = 0

        async def threads_get(self, bot_id: str) -> dict:
            if self.stopped:
                return {"cursor": 0, "messages": [], "run": None}
            return {
                "cursor": 0,
                "run": {"id": "run-parked", "status": "waiting_input"},
                "messages": [{"id": "m1", "runId": "run-parked", "blocks": [{"kind": "ask", "input": "secret", "text": "MCP token", "status": "pending"}]}],
            }

        async def threads_stop(self, bot_id: str) -> dict:
            self.stopped += 1
            return {"ok": True}

    client = ParkedClient()
    agent = RakazoAgent(CALL, client)
    client.agent = agent
    spoken = " ".join(await collect(agent, "Are you stuck?"))
    check("a question about a parked secret is answered once", "MCP token" in spoken and client.sends == [] and client.stopped == 0, spoken)
    spoken = " ".join(await collect(agent, "Please create a new voice agent called Test"))
    check("a request of its own goes ahead beside the open card", len(client.sends) == 1 and client.left_cards is True, f"sends={client.sends}")
    check("the card is NOT cancelled", client.stopped == 0, f"stopped={client.stopped}")
    check("it is answered, not stonewalled, and says the card stays", "Creating it now" in spoken and "stays open" in spoken, spoken)

    # 9. A half sentence is held, not sent: the caller carries on, and Rakazo gets ONE request with both halves.
    client = FakeClient(
        [
            event("thread.message.created", "run-ours", role="bot", blocks=[{"kind": "text", "text": "Yes, all of it."}]),
            event("run.completed", "run-ours"),
        ]
    )
    agent = RakazoAgent(CALL, client)
    client.agent = agent
    half = asyncio.create_task(collect(agent, "Did you study"))
    await asyncio.sleep(0.3)
    half.cancel()  # the caller started speaking again: the framework cancels the pending turn
    try:
        await half
    except asyncio.CancelledError:
        pass
    check("a half sentence is not sent on its own", client.sends == [], repr(client.sends))
    spoken = "".join(await collect(agent, "Sana's full research?"))
    check(
        "the rest is sent joined to the half, once",
        client.sends == ["Did you study Sana's full research?"],
        repr(client.sends),
    )
    check("and answered", "all of it" in spoken, spoken)

    # 10. A finished sentence is not delayed.
    client = FakeClient([event("run.completed", "run-ours")])
    agent = RakazoAgent(CALL, client)
    client.agent = agent
    started = asyncio.get_event_loop().time()
    await collect(agent, "Why are you researching?")
    check("a finished sentence goes out at once", len(client.sends) == 1 and asyncio.get_event_loop().time() - started < 1.0)

    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
        raise SystemExit(1)
    print("all checks passed")


if __name__ == "__main__":
    asyncio.run(main())
