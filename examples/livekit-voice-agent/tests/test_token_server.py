"""Token server: a caller-named call (the bot's own call the user answered) is accepted only from
the trusted broker, keeps its id as the room, and carries the opening to the agent."""

from __future__ import annotations

import asyncio

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

import token_server
from agent import opening_line
from token_server import CALL_ID_RE, validate_named_call

CALL_ID = "6f1d2c3b-4a5e-4f60-9b7c-8d9e0f1a2b3c"


def test_call_id_shape_is_rakazos():
    assert CALL_ID_RE.match(CALL_ID)
    assert CALL_ID_RE.match("abc_123-XYZ")
    for bad in ("call:" + CALL_ID, "short", "a" * 201, "with space", ""):
        assert not CALL_ID_RE.match(bad), bad


def test_unnamed_call_passes_through():
    assert validate_named_call({"botId": "b"}, trusted=False) is None
    assert validate_named_call({"botId": "b"}, trusted=True) is None


def test_named_call_needs_the_broker_and_a_valid_id():
    refused = validate_named_call({"callId": CALL_ID}, trusted=False)
    assert isinstance(refused, web.Response) and refused.status == 403
    bad = validate_named_call({"callId": "call:" + CALL_ID}, trusted=True)
    assert isinstance(bad, web.Response) and bad.status == 400
    assert validate_named_call({"callId": 42}, trusted=True).status == 400  # type: ignore[union-attr]
    assert validate_named_call({"callId": CALL_ID, "opening": ["no"]}, trusted=True).status == 400  # type: ignore[union-attr]


def test_named_call_trims_the_opening():
    assert validate_named_call({"callId": CALL_ID, "opening": "  Hi there.  "}, trusted=True) == (CALL_ID, "Hi there.")
    assert validate_named_call({"callId": CALL_ID}, trusted=True) == (CALL_ID, "")
    _, opening = validate_named_call({"callId": CALL_ID, "opening": "x" * 500}, trusted=True)  # type: ignore[misc]
    assert len(opening) == 240


def test_agent_opens_with_the_bots_line_or_the_greeting():
    assert opening_line("Hi, about the invoice.", "Connected. Go ahead.") == "Hi, about the invoice."
    assert opening_line("   ", "Connected. Go ahead.") == "Connected. Go ahead."
    assert opening_line("", "") == ""


class _FakeRakazo:
    """Stands in for RakazoClient: a valid session for user u1 with bot b1 in the space."""

    def __init__(self, *_: object, **__: object) -> None:
        pass

    async def get_session(self):
        return {"user": {"id": "u1", "name": "Shakil", "email": "s@example.com"}}

    async def bots_list(self):
        return [{"id": "b1", "name": "Voice"}]

    async def aclose(self):
        pass


@pytest.fixture
def served(monkeypatch):
    monkeypatch.setattr(token_server, "RakazoClient", _FakeRakazo)
    monkeypatch.setattr(token_server, "LIVEKIT_API_KEY", "devkey")
    monkeypatch.setattr(token_server, "LIVEKIT_API_SECRET", "secret-long-enough-for-hs256-signing-1234")
    monkeypatch.setattr(token_server, "INTERNAL_TOKEN", "internal")
    monkeypatch.setattr(token_server, "calls", {})
    return token_server


async def _post_token(app: web.Application, body: dict, headers: dict | None = None):
    async with TestClient(TestServer(app)) as client:
        response = await client.post(
            "/token", json=body, headers={"authorization": "Bearer caller.sig", **(headers or {})}
        )
        return response.status, await response.json()


def test_token_route_keeps_the_answered_calls_id_and_registers_its_opening(served):
    body = {"botId": "b1", "spaceId": "s1", "callId": CALL_ID, "opening": "Hi, about the invoice."}
    status, grant = asyncio.run(_post_token(served.build_public_app(), body, {"x-voice-internal-token": "internal"}))
    assert status == 200, grant
    assert grant["callId"] == CALL_ID and grant["room"] == f"rakazo-{CALL_ID}"
    registered = served.calls[CALL_ID]
    assert registered["opening"] == "Hi, about the invoice."
    assert registered["bearer"] == "caller.sig" and registered["botId"] == "b1"


def test_token_route_refuses_a_named_call_without_the_broker_token(served):
    body = {"botId": "b1", "spaceId": "s1", "callId": CALL_ID}
    status, _ = asyncio.run(_post_token(served.build_public_app(), body))
    assert status == 403
    assert CALL_ID not in served.calls


def test_token_route_refuses_another_users_room(served):
    served.calls[CALL_ID] = {"userId": "someone-else", "createdAt": 1e12}
    body = {"botId": "b1", "spaceId": "s1", "callId": CALL_ID}
    status, _ = asyncio.run(_post_token(served.build_public_app(), body, {"x-voice-internal-token": "internal"}))
    assert status == 409
    assert served.calls[CALL_ID]["userId"] == "someone-else"


def test_unnamed_call_still_mints_a_fresh_id(served):
    status, grant = asyncio.run(_post_token(served.build_public_app(), {"botId": "b1", "spaceId": "s1"}))
    assert status == 200
    assert grant["room"] == f"rakazo-{grant['callId']}" and ":" not in grant["callId"]
    assert served.calls[grant["callId"]]["opening"] == ""


def test_internal_registry_serves_the_opening_without_the_user_id(served):
    served.calls[CALL_ID] = {"bearer": "x", "userId": "u1", "opening": "Hello.", "createdAt": 1e12}

    async def go():
        async with TestClient(TestServer(served.build_internal_app())) as client:
            denied = await client.get(f"/internal/calls/{CALL_ID}")
            ok = await client.get(f"/internal/calls/{CALL_ID}", headers={"x-voice-internal-token": "internal"})
            return denied.status, ok.status, await ok.json()

    denied, ok, data = asyncio.run(go())
    assert denied == 403 and ok == 200
    assert data["opening"] == "Hello." and "userId" not in data
