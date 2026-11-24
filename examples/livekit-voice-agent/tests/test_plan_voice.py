"""Fork: plan cards on a call, and the half-sentence join that lost a request (2026-11-25).

Needs the livekit package (agent.py imports it): run inside the agent image, e.g.
    docker run --rm -v "$PWD:/app" -w /app --entrypoint sh rakazo-voice-agent -c \
      "python -m ensurepip >/dev/null; python -m pip install -q pytest; python -m pytest -q -p no:cacheprovider tests"
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from conversation import merge_held, plan_reply_word
from rakazo_client import pending_plan_of, text_from_blocks

agent_mod = pytest.importorskip("agent")

CALL = agent_mod.CallContext(call_id="call-1", bearer="", space_id="space-1", bot_id="bot-1", bot_name="Umar")

PLAN = {
    "kind": "plan",
    "planId": "plan-1",
    "title": "Dan Martell video subtitles",
    "steps": [
        {"text": "Open YouTube history in your browser and find the video", "agent": "YouTube Specialist"},
        {"text": "Download the subtitles and analyse them", "agent": "YouTube Specialist"},
    ],
    "revision": 1,
    "status": "pending",
    "spoken": "I'll have the YouTube Specialist find it in your history, then get the subtitles. Shall I go ahead?",
}


# --- the 2026-11-25 failure: the first half of the request was dropped ----------------------------

FIRST = "Hey you are Can you please Uh browse the YouTube from my account there is a There is history, and from that history, there is a video named"
REST = "one-person business with AI agents by Dan Martell. So, can you please give the video link to YouTube expert and download the subtitle file and analyze analyze tell him to analyze and report me back."


def test_a_long_continuation_keeps_the_first_half():
    # Held at 05.5 s, the caller went on speaking at once and finished 29 s later.
    joined = merge_held(FIRST, 5.5, REST, now=34.5, resumed_at=5.5)
    assert joined.startswith("Hey you are") and "history" in joined and joined.endswith("report me back.")


def test_a_late_new_turn_is_still_its_own():
    # Silence for 20 s, then a new sentence: not the same thought.
    assert merge_held(FIRST, 5.5, "What time is it?", now=30.0, resumed_at=25.5) == "What time is it?"


def test_without_a_resume_time_the_old_rule_applies():
    assert merge_held(FIRST, 5.5, REST, now=34.5) == REST


class HoldClient:
    def __init__(self) -> None:
        self.sends: list[str] = []
        self.agent = None

    async def threads_get(self, bot_id):
        return {"cursor": 0, "messages": [], "run": None}

    async def threads_send(self, bot_id, text, nonce, answer_now=None, leave_cards=False):
        self.sends.append(text)
        self.agent.events.put_nowait({"type": "run.completed", "runId": "run-ours", "payload": {}})
        return {"runId": "run-ours"}


def chat_ctx(text: str):
    return SimpleNamespace(items=[SimpleNamespace(type="message", role="user", text_content=text)])


async def drain(agent, text):
    out = []
    async for chunk in agent.llm_node(chat_ctx(text), [], None):
        if isinstance(chunk, str):
            out.append(chunk)
    return out


def test_agent_sends_the_whole_request_after_a_long_continuation(monkeypatch):
    async def scenario():
        client = HoldClient()
        agent = agent_mod.RakazoAgent(CALL, client)
        client.agent = agent
        # The agent's clock runs 29 s ahead for the second utterance (asyncio uses the same clock,
        # so it is shifted, never frozen).
        real = agent_mod.time.monotonic
        shift = {"s": 0.0}
        monkeypatch.setattr(agent_mod.time, "monotonic", lambda: real() + shift["s"])
        # The half sentence: the agent waits a moment; the caller carries on, so LiveKit cancels it.
        agent._user_state = "speaking"
        first = asyncio.ensure_future(drain(agent, FIRST))
        await asyncio.sleep(0.05)
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        assert agent._held is not None
        # The rest ends 29 s later.
        shift["s"] = 29.0
        agent._user_state = "listening"
        await asyncio.wait_for(drain(agent, REST), timeout=30)
        return client.sends

    sends = asyncio.run(scenario())
    assert len(sends) == 1
    assert "history" in sends[0] and "Dan Martell" in sends[0], sends


# --- plan cards ----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "said,word",
    [
        ("Yes.", "approve"),
        ("yes go ahead", "approve"),
        ("Okay, do it.", "approve"),
        ("Sounds good", "approve"),
        ("Uh, go ahead.", "approve"),
        ("Change step 2 to download the English subtitles only", "change"),
        ("No, first open the history tab", "change"),
        ("No.", "reject"),
        ("cancel it", "reject"),
        ("What is the capital of India?", None),
        ("Did he report back?", None),
    ],
)
def test_plan_reply_words(said, word):
    assert plan_reply_word(said) == word


def test_a_plan_card_is_spoken_by_its_short_version():
    assert text_from_blocks([PLAN]).startswith("I'll have the YouTube Specialist")
    assert text_from_blocks([{**PLAN, "status": "approved"}]) == ""
    no_spoken = {k: v for k, v in PLAN.items() if k != "spoken"}
    assert "Shall I go ahead?" in text_from_blocks([no_spoken])


def test_pending_plan_is_the_newest_card_only():
    older = {"blocks": [PLAN]}
    newer = {"blocks": [{**PLAN, "planId": "plan-2", "status": "approved"}]}
    assert pending_plan_of({"messages": [older]})["planId"] == "plan-1"
    assert pending_plan_of({"messages": [older, newer]}) is None


class PlanClient:
    def __init__(self) -> None:
        self.sends: list[tuple[str, bool]] = []
        self.decisions: list[tuple[str, str]] = []
        self.agent = None

    async def threads_get(self, bot_id):
        return {"cursor": 0, "messages": [{"id": "m1", "role": "bot", "blocks": [PLAN]}], "run": None}

    async def plans_decide(self, plan_id, decision):
        self.decisions.append((plan_id, decision))
        return {**PLAN, "status": "approved", "decidedVia": "voice"}

    async def threads_send(self, bot_id, text, nonce, answer_now=None, leave_cards=False):
        self.sends.append((text, leave_cards))
        self.agent.events.put_nowait(
            {
                "type": "thread.message.created",
                "runId": "run-ours",
                "payload": {"role": "bot", "blocks": [{"kind": "text", "text": "Starting now."}]},
            }
        )
        self.agent.events.put_nowait({"type": "run.completed", "runId": "run-ours", "payload": {}})
        return {"runId": "run-ours"}


def test_a_spoken_yes_approves_the_pending_plan_and_is_sent():
    async def scenario():
        client = PlanClient()
        agent = agent_mod.RakazoAgent(CALL, client)
        client.agent = agent
        spoken = await asyncio.wait_for(drain(agent, "Yes, go ahead."), timeout=30)
        return client, "".join(spoken)

    client, spoken = asyncio.run(scenario())
    assert client.decisions == [("plan-1", "approve")]
    assert [text for text, _ in client.sends] == ["Yes, go ahead."]
    assert "Starting now" in spoken


def test_yes_with_a_paused_report_still_answers_the_plan():
    async def scenario():
        client = PlanClient()
        agent = agent_mod.RakazoAgent(CALL, client)
        client.agent = agent
        agent.state.register_task("run-task", "create a voice assistant", now=0)
        segments = [
            agent_mod.Segment("report", "It has three voices. It keeps a call log.", "run-task", "your request"),
        ]
        agent.log_speech(segments)
        agent.on_speech_cut("It has three voices.")
        assert agent.state.has_paused_report()
        await asyncio.wait_for(drain(agent, "yes"), timeout=30)
        return client

    client = asyncio.run(scenario())
    assert client.decisions == [("plan-1", "approve")]
    assert client.sends and client.sends[0][0] == "yes"


def test_a_spoken_change_is_sent_not_approved():
    async def scenario():
        client = PlanClient()
        agent = agent_mod.RakazoAgent(CALL, client)
        client.agent = agent
        await asyncio.wait_for(drain(agent, "Change step 2 to only download the English subtitles."), timeout=30)
        return client

    client = asyncio.run(scenario())
    assert client.decisions == []
    assert client.sends[0][0].startswith("Change step 2")
