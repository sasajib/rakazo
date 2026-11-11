"""Unit tests for the pure parts of the Rakazo client.

Fixtures under `tests/fixtures/` were recorded against a live Rakazo (`app:edge`, build
20261108215101) with the Voice bot: `subscribe_stream.sse` is a raw `threads/subscribe` response
(bot intro ask card, a call-nonce send, deltas, final message, heartbeat);
`call_turn_events.json` is the event list one call turn produced, as parsed by `RakazoClient`.
The approval / secret ask blocks are shaped after `packages/core/src/action-approval.ts`
(`isApprovalAskBlock`, `isSecretAskBlock`) because the Voice bot has no tools that raise them.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from rakazo_client import (
    RUN_TERMINAL,
    call_client_nonce,
    call_id_from_client_nonce,
    call_turn,
    is_approval_ask_block,
    is_secret_ask_block,
    new_call_id,
    parse_sse,
    pending_secret_ask,
    progress_text,
    spoken_decision,
    text_from_blocks,
)

FIXTURES = Path(__file__).parent / "fixtures"


# --- nonce ---------------------------------------------------------------------------------------


def test_call_nonce_shape_and_round_trip():
    call_id = new_call_id()
    assert ":" not in call_id
    nonce = call_client_nonce(call_id)
    prefix, cid, suffix = nonce.split(":")
    assert prefix == "call" and cid == call_id and len(suffix) == 24
    assert call_id_from_client_nonce(nonce) == call_id
    assert call_client_nonce(call_id) != nonce  # a fresh client id each time: never replays a send


def test_call_nonce_rejects_colon():
    with pytest.raises(ValueError):
        call_client_nonce("a:b")


def test_call_id_from_other_nonces():
    assert call_id_from_client_nonce(None) is None
    assert call_id_from_client_nonce("web:abc") is None
    assert call_id_from_client_nonce("call:marker") is None


def test_recorded_user_message_carries_call_id():
    fixture = json.loads((FIXTURES / "call_turn_events.json").read_text())
    user_messages = [
        e for e in fixture["events"] if e["type"] == "thread.message.created" and e["payload"]["role"] == "user"
    ]
    assert user_messages[0]["payload"]["callId"] == fixture["callId"] == call_id_from_client_nonce(fixture["clientNonce"])


# --- callTurn ------------------------------------------------------------------------------------


def thread(run_status=None, blocks=None, active=None):
    run = {"id": "run1", "status": run_status} if run_status else None
    messages = [{"id": "m1", "runId": "run1", "blocks": blocks}] if blocks else []
    return {"run": run, "activeRuns": active or [], "messages": messages}


APPROVAL = {
    "kind": "ask",
    "text": "Allow sending the email?",
    "status": "pending",
    "approvalEffectId": "eff1",
    "actions": [{"id": "allow", "label": "Allow"}, {"id": "always", "label": "Always"}, {"id": "deny", "label": "Deny"}],
}
SECRET = {"kind": "ask", "text": "Enter the code", "status": "pending", "input": "secret"}
QUESTION = {"kind": "ask", "text": "Which city?", "status": "pending", "actions": [{"id": "choice-1", "label": "Dhaka"}]}


def test_turn_is_send_when_idle():
    assert call_turn(None, "hello").kind == "send"
    assert call_turn(thread("completed"), "hello").kind == "send"


def test_turn_is_follow_up_while_working():
    for status in ("queued", "leased", "running"):
        turn = call_turn(thread(status), "also check the weather")
        assert turn.kind == "follow_up" and turn.run_id == "run1"


def test_turn_answers_open_question_with_spoken_decision_or_text():
    turn = call_turn(thread("waiting_input", [QUESTION]), "Dhaka please")
    assert (turn.kind, turn.run_id, turn.message_id, turn.answer) == ("answer", "run1", "m1", "Dhaka please")
    assert call_turn(thread("waiting_input", [QUESTION]), "Yeah, sure.").answer == "yes"
    assert call_turn(thread("waiting_input", [QUESTION]), "Nope").answer == "no"


def test_answered_ask_is_not_pending():
    answered = {**QUESTION, "status": "answered"}
    assert call_turn(thread("waiting_input", [answered]), "ok").kind == "send"


def test_approval_must_happen_on_screen():
    assert is_approval_ask_block(APPROVAL)
    assert not is_approval_ask_block({**APPROVAL, "actions": [{"id": "allow"}, {"id": "deny"}, {"id": "later"}]})
    assert not is_approval_ask_block(QUESTION)
    turn = call_turn(thread("waiting_input", [APPROVAL]), "yes")
    assert turn.kind == "approve_on_screen" and turn.message_id == "m1"


def test_secret_ask_closes_the_mic_even_from_another_active_run():
    assert is_secret_ask_block(SECRET)
    assert not is_secret_ask_block({**SECRET, "approvalEffectId": "x"})
    assert call_turn(thread("waiting_input", [SECRET]), "1234").kind == "enter_code"
    other = {
        "run": {"id": "run1", "status": "running"},
        "activeRuns": [{"id": "run2", "status": "waiting_input"}],
        "messages": [{"id": "m2", "runId": "run2", "blocks": [SECRET]}],
    }
    assert pending_secret_ask(other)
    assert call_turn(other, "1234").kind == "enter_code"


def test_recorded_intro_ask_card_is_answerable():
    """The bot's creation intro (recorded) is a plain choice ask: a spoken reply answers it."""
    events = [e["data"] for e in parse_sse((FIXTURES / "subscribe_stream.sse").read_text().splitlines())]
    ask_event = next(e for e in events if e["type"] == "thread.message.created" and e["payload"]["blocks"][0]["kind"] == "ask")
    snapshot = {
        "run": {"id": ask_event["runId"], "status": "waiting_input"},
        "messages": [{"id": ask_event["payload"]["messageId"], "runId": ask_event["runId"], "blocks": ask_event["payload"]["blocks"]}],
    }
    turn = call_turn(snapshot, "Dictation and notes")
    assert turn.kind == "answer" and turn.message_id == ask_event["payload"]["messageId"]
    assert not is_approval_ask_block(ask_event["payload"]["blocks"][0])


@pytest.mark.parametrize(
    "text,expected",
    [("yes", "yes"), ("Sure thing", "yes"), ("okay do it", "yes"), ("no", "no"), ("Cancel that", "no"),
     ("yes?", None), ("surely not a decision, this is a long sentence here", None), ("Dhaka", None), ("", None),
     ("nothing", None)],
)
def test_spoken_decision(text, expected):
    assert spoken_decision(text) == expected


# --- event stream --------------------------------------------------------------------------------


def test_parse_recorded_sse_stream():
    events = list(parse_sse((FIXTURES / "subscribe_stream.sse").read_text().splitlines()))
    assert all(e["event"] == "message" for e in events)
    types = [e["data"]["type"] for e in events]
    assert types[0] == "run.started"
    assert types.count("thread.progress") == 6
    assert "run.completed" in types and "heartbeat" in types
    assert types.index("heartbeat") > types.index("run.completed")
    envelope = events[0]["data"]
    assert {"id", "spaceId", "threadId", "botId", "seq", "type", "createdAt", "payload"} <= set(envelope)


def test_parse_sse_handles_comments_multiline_data_and_crlf():
    raw = [": keepalive\r", "event: message\r", "data: {\"json\": {\"a\": 1,", "data:  \"b\": 2}}\r", "\r", "data: [1]", ""]
    assert list(parse_sse(raw)) == [{"event": "message", "data": {"a": 1, "b": 2}}, {"event": "message", "data": [1]}]


def test_progress_deltas_vs_final_message_from_recording():
    fixture = json.loads((FIXTURES / "call_turn_events.json").read_text())
    run_id = fixture["receipt"]["runId"]
    spoken = []
    final = None
    for event in fixture["events"]:
        assert event["runId"] == run_id
        if event["type"] == "thread.progress":
            text = progress_text(event["payload"])
            if text:
                spoken.append(text)
        elif event["type"] == "thread.message.created" and event["payload"]["role"] == "bot":
            final = text_from_blocks(event["payload"]["blocks"])
        elif event["type"] in RUN_TERMINAL:
            break
    # first flush is {text}, later ones {delta}; together they are the final message
    assert "text" in fixture["events"][4]["payload"] and "delta" in fixture["events"][5]["payload"]
    assert "".join(spoken) == final == "The capital of Bangladesh is Dhaka."
    assert [e["type"] for e in fixture["events"]][-1] == "run.completed"


def test_progress_text_rules():
    assert progress_text({"text": "Y", "streaming": True}) == "Y"
    assert progress_text({"delta": "es", "streaming": True}) == "es"
    assert progress_text({"text": "Searching the web", "activity": True}) is None
    assert progress_text({"text": "not streaming"}) is None
    assert progress_text({"delta": "", "streaming": True}) is None


def test_text_from_blocks_skips_non_speech_blocks():
    blocks = [
        {"kind": "steps", "items": []},
        {"kind": "text", "text": "  Done. "},
        {"kind": "card", "title": "x"},
        {"kind": "ask", "text": "Anything else?", "status": "pending"},
    ]
    assert text_from_blocks(blocks) == "Done.\nAnything else?"


def test_a_parked_secret_card_names_what_it_wants():
    from rakazo_client import call_turn, secret_ask_of

    thread = {
        "run": {"id": "r1", "status": "waiting_input"},
        "messages": [
            {
                "id": "m1",
                "runId": "r1",
                "blocks": [{"kind": "ask", "input": "secret", "text": "BrowserOS Neo MCP token", "status": "pending"}],
            }
        ],
    }
    assert secret_ask_of(thread) == {"run_id": "r1", "message_id": "m1", "what": "BrowserOS Neo MCP token"}
    turn = call_turn(thread, "hello")
    assert turn.kind == "enter_code" and turn.question == "BrowserOS Neo MCP token" and turn.run_id == "r1"
