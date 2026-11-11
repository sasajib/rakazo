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

    async def threads_send(self, bot_id: str, text: str, nonce: str) -> dict:
        self.sends.append(text)
        assert self.agent is not None
        for item in self.script:
            self.agent.events.put_nowait(item)
        return {"runId": "run-ours"}

    async def threads_follow_up(self, bot_id: str, text: str, nonce: str) -> dict:
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

    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
        raise SystemExit(1)
    print("all checks passed")


if __name__ == "__main__":
    asyncio.run(main())
