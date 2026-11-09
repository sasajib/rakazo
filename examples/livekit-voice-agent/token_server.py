"""Token server + static page for the browser side of a Rakazo voice call.

Public listener (put it behind your TLS proxy / tunnel):

- `GET  /`                 the call page (`web/index.html`)
- `GET  /config`           `{livekitUrl}` for the page
- `POST /rakazo/sign-in`   `{email, password}` → `{token}`; proxies Better Auth so the page needs no CORS
- `GET  /rakazo/spaces`    bearer → Rakazo `spaces/list` (spaces with their bots)
- `POST /token`            bearer + `{botId, spaceId}` → `{url, token, room, callId}`; refuses an invalid
                           bearer with 401 (checked against `GET /api/auth/get-session`)

Internal listener (never exposed; the agent worker reads it over the docker network):

- `GET /internal/calls/<callId>` with `x-voice-internal-token` → the caller's bearer, space and bot

A LiveKit token is minted for room `rakazo-<callId>` with the Rakazo key pair and an explicit
agent dispatch (`RoomAgentDispatch(agent_name)`), so the worker joins that room and only that room.
"""

from __future__ import annotations

import asyncio
from datetime import timedelta
import logging
import os
import secrets
import time
from pathlib import Path

from aiohttp import web
from dotenv import load_dotenv
from livekit import api
from livekit.protocol.agent_dispatch import RoomAgentDispatch
from livekit.protocol.room import RoomConfiguration

from rakazo_client import RakazoClient, RakazoError, new_call_id

load_dotenv()
logger = logging.getLogger("rakazo-voice.token")

RAKAZO_API_URL = os.environ.get("RAKAZO_API_URL", "http://127.0.0.1:3311")
LIVEKIT_URL = os.environ.get("LIVEKIT_URL", "ws://127.0.0.1:7880")
LIVEKIT_PUBLIC_URL = os.environ.get("LIVEKIT_PUBLIC_URL", LIVEKIT_URL)
LIVEKIT_API_KEY = os.environ.get("LIVEKIT_API_KEY", "")
LIVEKIT_API_SECRET = os.environ.get("LIVEKIT_API_SECRET", "")
AGENT_NAME = os.environ.get("LIVEKIT_AGENT_NAME", "rakazo-voice")
INTERNAL_TOKEN = os.environ.get("VOICE_INTERNAL_TOKEN", "")
PUBLIC_PORT = int(os.environ.get("TOKEN_PUBLIC_PORT", "8080"))
INTERNAL_PORT = int(os.environ.get("TOKEN_INTERNAL_PORT", "8081"))
BIND = os.environ.get("TOKEN_BIND", "0.0.0.0")
CALL_TTL_S = 6 * 3600
WEB_DIR = Path(__file__).parent / "web"

calls: dict[str, dict] = {}  # callId → {bearer, spaceId, botId, botName, userName, createdAt}


def _bearer(request: web.Request) -> str | None:
    header = request.headers.get("authorization", "")
    return header[7:].strip() if header.lower().startswith("bearer ") and len(header) > 7 else None


def _prune() -> None:
    cutoff = time.time() - CALL_TTL_S
    for call_id in [k for k, v in calls.items() if v["createdAt"] < cutoff]:
        del calls[call_id]


async def index(_: web.Request) -> web.StreamResponse:
    return web.FileResponse(WEB_DIR / "index.html")


async def config(_: web.Request) -> web.Response:
    return web.json_response({"livekitUrl": LIVEKIT_PUBLIC_URL, "agentName": AGENT_NAME})


async def sign_in(request: web.Request) -> web.Response:
    body = await request.json()
    client = RakazoClient(RAKAZO_API_URL)
    try:
        token = await client.sign_in(str(body.get("email", "")), str(body.get("password", "")))
        return web.json_response({"token": token})
    except RakazoError as exc:
        return web.json_response({"error": "sign-in failed"}, status=401 if exc.status in (400, 401, 403) else 502)
    finally:
        await client.aclose()


async def spaces(request: web.Request) -> web.Response:
    bearer = _bearer(request)
    if not bearer:
        return web.json_response({"error": "missing bearer"}, status=401)
    client = RakazoClient(RAKAZO_API_URL, token=bearer)
    try:
        return web.json_response(await client.spaces_list())
    except RakazoError as exc:
        return web.json_response({"error": "rakazo refused"}, status=401 if exc.status in (401, 403) else 502)
    finally:
        await client.aclose()


async def token(request: web.Request) -> web.Response:
    bearer = _bearer(request)
    if not bearer:
        return web.json_response({"error": "missing bearer"}, status=401)
    body = await request.json()
    bot_id, space_id = str(body.get("botId", "")), str(body.get("spaceId", ""))
    if not bot_id or not space_id:
        return web.json_response({"error": "botId and spaceId are required"}, status=400)

    client = RakazoClient(RAKAZO_API_URL, token=bearer, space_id=space_id)
    try:
        session = await client.get_session()
        if not session or not session.get("user"):
            return web.json_response({"error": "invalid Rakazo session"}, status=401)
        bots = await client.bots_list()  # also proves membership of the space
    except RakazoError as exc:
        return web.json_response({"error": "invalid Rakazo session"}, status=401 if exc.status in (401, 403) else 502)
    finally:
        await client.aclose()
    bot = next((b for b in bots if b["id"] == bot_id), None)
    if not bot:
        return web.json_response({"error": "bot not in this space"}, status=404)

    user = session["user"]
    call_id = new_call_id()
    room = f"rakazo-{call_id}"
    _prune()
    calls[call_id] = {
        "bearer": bearer,
        "spaceId": space_id,
        "botId": bot_id,
        "botName": bot.get("name", ""),
        "userName": user.get("name", ""),
        "createdAt": time.time(),
    }
    grant = api.VideoGrants(room_join=True, room=room, can_publish=True, can_subscribe=True, can_publish_data=True)
    jwt = (
        api.AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
        .with_identity(f"user-{user['id']}")
        .with_name(user.get("name") or user.get("email") or "caller")
        .with_grants(grant)
        .with_room_config(RoomConfiguration(agents=[RoomAgentDispatch(agent_name=AGENT_NAME)]))
        .with_ttl(timedelta(hours=2))
        .to_jwt()
    )
    logger.info("minted token for room %s (bot %s)", room, bot.get("name"))
    return web.json_response({"url": LIVEKIT_PUBLIC_URL, "token": jwt, "room": room, "callId": call_id})


async def internal_call(request: web.Request) -> web.Response:
    given = request.headers.get("x-voice-internal-token", "")
    if not INTERNAL_TOKEN or not secrets.compare_digest(given, INTERNAL_TOKEN):
        return web.json_response({"error": "forbidden"}, status=403)
    call = calls.get(request.match_info["call_id"])
    if not call:
        return web.json_response({"error": "unknown call"}, status=404)
    return web.json_response(call)


def build_public_app() -> web.Application:
    app = web.Application(client_max_size=64 * 1024)
    app.router.add_get("/", index)
    app.router.add_get("/config", config)
    app.router.add_post("/rakazo/sign-in", sign_in)
    app.router.add_get("/rakazo/spaces", spaces)
    app.router.add_post("/token", token)
    return app


def build_internal_app() -> web.Application:
    app = web.Application()
    app.router.add_get("/internal/calls/{call_id}", internal_call)
    return app


async def main() -> None:
    if not (LIVEKIT_API_KEY and LIVEKIT_API_SECRET):
        raise SystemExit("LIVEKIT_API_KEY and LIVEKIT_API_SECRET are required")
    if not INTERNAL_TOKEN:
        raise SystemExit("VOICE_INTERNAL_TOKEN is required (shared with the agent worker)")
    runners = []
    for app, port in ((build_public_app(), PUBLIC_PORT), (build_internal_app(), INTERNAL_PORT)):
        runner = web.AppRunner(app, access_log=None)
        await runner.setup()
        await web.TCPSite(runner, BIND, port).start()
        runners.append(runner)
    logger.info("token server: public :%d, internal :%d, livekit %s", PUBLIC_PORT, INTERNAL_PORT, LIVEKIT_PUBLIC_URL)
    try:
        await asyncio.Event().wait()
    finally:
        for runner in runners:
            await runner.cleanup()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    asyncio.run(main())
