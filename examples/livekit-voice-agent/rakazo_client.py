"""A small headless Rakazo client: Better Auth signed bearer, oRPC calls, event stream.

Only what a voice call needs. Mirrors `packages/core/src/call-session.ts` (`callTurn`),
`packages/core/src/call-nonce.ts` (`callClientNonce`) and `packages/core/src/speech-text.ts`
(`spokenDecision`). Wire format verified against Rakazo `app:edge` (build 20261108215101):

- `POST /rpc/<group>/<procedure>` with body `{"json": <input>, "meta": []}` → `{"json": <output>}`.
- `POST /rpc/threads/subscribe` answers `text/event-stream`; each `event: message` carries
  `data: {"json": <ProductEvent>}`. A `heartbeat` event arrives every 20 s.
- `POST /api/auth/sign-in/email` with `origin: rakazo://` returns the signed session token in the
  `set-auth-token` response header; it is sent back as `Authorization: Bearer <token>`.

The pure helpers (`call_client_nonce`, `call_turn`, `parse_sse`, `progress_text`, ...) take plain
dicts, so they are unit-testable without a server.
"""

from __future__ import annotations

import json
import re
import secrets
import uuid
from collections.abc import AsyncIterator, Iterable
from dataclasses import dataclass, field
from typing import Any

import httpx

CALL_CLIENT_NONCE_PREFIX = "call:"
HEARTBEAT_EVENT = "heartbeat"
RUN_TERMINAL = ("run.completed", "run.failed", "run.cancelled")
WORKING_RUN_STATUSES = ("queued", "leased", "running")


# --- pure helpers -------------------------------------------------------------------------------


def new_call_id() -> str:
    """A call id Rakazo accepts in `threads/endCall`: non-empty, no ':'."""
    return uuid.uuid4().hex


def new_client_id() -> str:
    return secrets.token_hex(12)


def call_client_nonce(call_id: str) -> str:
    """`call:<callId>:<clientId>` — the nonce that turns a send into a spoken call turn."""
    if ":" in call_id:
        raise ValueError(f'callId must not contain ":": {call_id}')
    return f"{CALL_CLIENT_NONCE_PREFIX}{call_id}:{new_client_id()}"


def call_id_from_client_nonce(nonce: str | None) -> str | None:
    if not nonce or not nonce.startswith(CALL_CLIENT_NONCE_PREFIX):
        return None
    rest = nonce[len(CALL_CLIENT_NONCE_PREFIX) :]
    at = rest.rfind(":")
    return None if at == -1 else (rest[:at] or None)


def is_run_working(status: str | None) -> bool:
    return status in WORKING_RUN_STATUSES


def is_secret_ask_block(block: dict[str, Any]) -> bool:
    return block.get("kind") == "ask" and block.get("input") == "secret" and not block.get("approvalEffectId")


def is_approval_ask_block(block: dict[str, Any]) -> bool:
    actions = block.get("actions") or []
    if block.get("kind") != "ask" or not block.get("approvalEffectId") or not actions:
        return False
    ids = {a.get("id") for a in actions}
    return "allow" in ids and "deny" in ids and ids <= {"allow", "always", "deny"}


_YES = re.compile(
    r"^¡?(yes|yeah|yep|yup|ok|okay|sure|do it|go ahead|approve|confirmed|affirmative|sí|vale|okey|de acuerdo|adelante|hazlo|confirmo|aprobado)(?![^\W_])",
    re.IGNORECASE,
)
_NO = re.compile(
    r"^¡?(no|nope|nah|cancel|stop|don't|do not|reject|deny|negative|cancela|cancelar|cancélalo|rechaza|rechazado|mejor no|detente)(?![^\W_])",
    re.IGNORECASE,
)


def spoken_decision(transcript: str) -> str | None:
    """'yes' / 'no' for a short spoken answer, else None (questions and long sentences never count)."""
    text = transcript.strip()
    if not text or "?" in text or "¿" in text or len(text.split()) > 6:
        return None
    if _YES.match(text):
        return "yes"
    if _NO.match(text):
        return "no"
    return None


@dataclass(frozen=True)
class CallTurn:
    """What the caller's finished utterance does; see `callTurn` in call-session.ts."""

    kind: str  # enter_code | approve_on_screen | answer | follow_up | send
    run_id: str | None = None
    message_id: str | None = None
    answer: str | None = None
    # An approval ask's choices and what it is asking for, so a caller can decide out loud.
    actions: list[dict[str, Any]] = field(default_factory=list)
    question: str = ""


def _unanswered_ask(block: dict[str, Any]) -> bool:
    return block.get("kind") == "ask" and block.get("status") != "answered"


def _pending_ask(thread: dict[str, Any] | None, run: dict[str, Any] | None):
    if not run or run.get("status") != "waiting_input":
        return None
    for message in reversed((thread or {}).get("messages") or []):
        if message.get("runId") == run["id"] and any(_unanswered_ask(b) for b in message.get("blocks") or []):
            return {
                "message": message,
                "run_id": run["id"],
                "blocks": [b for b in message["blocks"] if _unanswered_ask(b)],
            }
    return None


def pending_secret_ask(thread: dict[str, Any] | None) -> bool:
    runs = [(thread or {}).get("run"), *((thread or {}).get("activeRuns") or [])]
    return any(
        any(is_secret_ask_block(b) for b in ask["blocks"])
        for run in runs
        if (ask := _pending_ask(thread, run))
    )


def secret_ask_of(thread: dict[str, Any] | None) -> dict[str, Any] | None:
    """The parked run's secret card: its run, message, and what it is asking for."""
    runs = [(thread or {}).get("run"), *((thread or {}).get("activeRuns") or [])]
    for run in runs:
        ask = _pending_ask(thread, run)
        block = next((b for b in (ask or {}).get("blocks") or [] if is_secret_ask_block(b)), None)
        if ask and block:
            name = block.get("text") or (block.get("credential") or {}).get("name") or ""
            return {"run_id": ask["run_id"], "message_id": ask["message"]["id"], "what": str(name)}
    return None


def has_pending_approval(thread: dict[str, Any] | None) -> bool:
    runs = [(thread or {}).get("run"), *((thread or {}).get("activeRuns") or [])]
    return any(
        any(is_approval_ask_block(b) for b in ask["blocks"]) for run in runs if (ask := _pending_ask(thread, run))
    )


def call_turn(thread: dict[str, Any] | None, text: str) -> CallTurn:
    secret = secret_ask_of(thread)
    if secret:
        return CallTurn("enter_code", run_id=secret["run_id"], message_id=secret["message_id"], question=secret["what"])
    ask = _pending_ask(thread, (thread or {}).get("run"))
    if ask and any(is_approval_ask_block(b) for b in ask["blocks"]):
        approval = next((b for b in ask["blocks"] if is_approval_ask_block(b)), {})
        return CallTurn(
            "approve_on_screen",
            run_id=ask["run_id"],
            message_id=ask["message"]["id"],
            actions=list(approval.get("actions") or []),
            question=str(approval.get("text") or ""),
        )
    if ask:
        return CallTurn(
            "answer",
            run_id=ask["run_id"],
            message_id=ask["message"]["id"],
            answer=spoken_decision(text) or text,
        )
    run = (thread or {}).get("run") or {}
    return CallTurn("follow_up", run_id=run.get("id")) if is_run_working(run.get("status")) else CallTurn("send")


def progress_text(payload: dict[str, Any]) -> str | None:
    """Spoken text carried by a `thread.progress` event, or None for activity/status lines.

    The first flush of a reply uses `{text}`, later ones `{delta}` (run-turn.ts, run-progress.ts).
    `{text, activity: true}` is a tool status line and is never spoken.
    """
    if not payload.get("streaming") or payload.get("activity"):
        return None
    text = payload.get("delta")
    if text is None:
        text = payload.get("text")
    return text or None


def activity_text(payload: dict[str, Any]) -> str | None:
    """The tool status line of a `thread.progress` event (`{text, activity: true}`), else None."""
    if payload.get("activity") and payload.get("text"):
        return str(payload["text"])
    return None


def text_from_blocks(blocks: Iterable[dict[str, Any]]) -> str:
    """The speakable text of a bot message: text blocks and the question of an ask block."""
    parts = [b.get("text", "") for b in blocks if b.get("kind") in ("text", "ask") and b.get("text")]
    return "\n".join(p.strip() for p in parts if p.strip())


def parse_sse(lines: Iterable[str]) -> Iterable[dict[str, Any]]:
    """Yield `{"event": name, "data": parsed_json}` from server-sent-event lines.

    Comment lines (`: ...`) are ignored. A blank line ends an event. `data` is JSON-decoded and the
    oRPC `{"json": ...}` envelope is unwrapped when present.
    """
    event: str | None = None
    data: list[str] = []
    for raw in lines:
        line = raw.rstrip("\r\n")
        if line == "":
            if data:
                payload: Any = json.loads("\n".join(data))
                if isinstance(payload, dict) and "json" in payload:
                    payload = payload["json"]
                yield {"event": event or "message", "data": payload}
            event, data = None, []
            continue
        if line.startswith(":"):
            continue
        field, _, value = line.partition(":")
        value = value[1:] if value.startswith(" ") else value
        if field == "event":
            event = value
        elif field == "data":
            data.append(value)


# --- HTTP client --------------------------------------------------------------------------------


class RakazoError(RuntimeError):
    def __init__(self, status: int, body: Any):
        super().__init__(f"Rakazo HTTP {status}: {str(body)[:300]}")
        self.status = status
        self.body = body


class RakazoClient:
    """Async client bound to one user (bearer) and one space."""

    def __init__(
        self,
        base_url: str,
        *,
        token: str | None = None,
        space_id: str | None = None,
        client_build: str = "web/livekit-voice-agent",
        timeout: float = 30.0,
    ):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.space_id = space_id
        self.client_build = client_build
        self._http = httpx.AsyncClient(base_url=self.base_url, timeout=timeout)

    async def aclose(self) -> None:
        await self._http.aclose()

    def _headers(self) -> dict[str, str]:
        headers = {"content-type": "application/json", "x-rakazo-client-build": self.client_build}
        if self.token:
            headers["authorization"] = f"Bearer {self.token}"
        if self.space_id:
            headers["x-rakazo-space-id"] = self.space_id
        return headers

    # auth
    async def sign_in(self, email: str, password: str) -> str:
        response = await self._http.post(
            "/api/auth/sign-in/email",
            json={"email": email, "password": password},
            headers={"content-type": "application/json", "origin": "rakazo://"},
        )
        if response.status_code != 200:
            raise RakazoError(response.status_code, response.text)
        token = response.headers.get("set-auth-token")
        if not token:
            raise RakazoError(response.status_code, "sign-in returned no set-auth-token header")
        self.token = token
        return token

    async def get_session(self) -> dict[str, Any] | None:
        """`GET /api/auth/get-session`: the user for this bearer, or None when it is invalid."""
        response = await self._http.get("/api/auth/get-session", headers=self._headers())
        if response.status_code != 200:
            raise RakazoError(response.status_code, response.text)
        body = response.json()
        return body if body else None

    # oRPC
    async def rpc(self, path: str, input: Any = None) -> Any:
        response = await self._http.post(
            f"/rpc/{path}", content=json.dumps({"json": input, "meta": []}), headers=self._headers()
        )
        try:
            body = response.json()
        except ValueError:
            body = response.text
        if response.status_code >= 400:
            raise RakazoError(response.status_code, body)
        return body.get("json") if isinstance(body, dict) else body

    async def spaces_list(self) -> dict[str, Any]:
        return await self.rpc("spaces/list", None)

    async def bots_list(self) -> list[dict[str, Any]]:
        return await self.rpc("bots/list", None)

    async def bots_create(self, name: str, instructions: str = "") -> dict[str, Any]:
        return await self.rpc("bots/create", {"name": name, "instructions": instructions})

    async def threads_head(self, bot_id: str) -> dict[str, Any]:
        return await self.rpc("threads/head", {"botId": bot_id})

    async def threads_get(self, bot_id: str) -> dict[str, Any]:
        return await self.rpc("threads/get", {"botId": bot_id})

    async def threads_send(
        self,
        bot_id: str,
        text: str,
        client_nonce: str,
        answer_now: bool | None = None,
        leave_cards: bool = False,
    ) -> dict[str, Any]:
        """`leave_cards`: a card the bot is waiting on stays open; this is a request of its own."""
        return await self.rpc(
            "threads/send",
            {
                "botId": bot_id,
                "text": text,
                "clientNonce": client_nonce,
                **({} if answer_now is None else {"answerNow": answer_now}),
                **({"leaveCards": True} if leave_cards else {}),
            },
        )

    async def threads_follow_up(
        self, bot_id: str, text: str, client_nonce: str, answer_now: bool | None = None
    ) -> dict[str, Any]:
        return await self.rpc(
            "threads/followUp",
            {
                "botId": bot_id,
                "text": text,
                "clientNonce": client_nonce,
                **({} if answer_now is None else {"answerNow": answer_now}),
            },
        )

    async def threads_answer(
        self, bot_id: str, run_id: str, message_id: str, answer: str, client_nonce: str
    ) -> dict[str, Any]:
        return await self.rpc(
            "threads/answer",
            {"botId": bot_id, "runId": run_id, "messageId": message_id, "answer": answer, "clientNonce": client_nonce},
        )

    async def threads_stop(self, bot_id: str) -> dict[str, Any]:
        return await self.rpc("threads/stop", {"botId": bot_id})

    async def threads_call_note(self, bot_id: str, call_id: str, note_id: str, text: str) -> dict[str, Any]:
        """Leave a line the voice agent said in the call's chat, so heard and written stay one thread."""
        return await self.rpc(
            "threads/callNote",
            {"botId": bot_id, "callId": call_id, "noteId": note_id, "text": text[:2000]},
        )

    async def threads_end_call(self, bot_id: str, call_id: str, duration_seconds: int | None = None) -> dict[str, Any]:
        input: dict[str, Any] = {"botId": bot_id, "callId": call_id}
        if duration_seconds is not None:
            input["durationSeconds"] = max(0, int(duration_seconds))
        return await self.rpc("threads/endCall", input)

    async def subscribe(self, bot_id: str, cursor: int) -> AsyncIterator[dict[str, Any]]:
        """Long-lived `threads/subscribe` stream; yields ProductEvent dicts (heartbeats included)."""
        headers = {**self._headers(), "accept": "text/event-stream"}
        async with self._http.stream(
            "POST",
            "/rpc/threads/subscribe",
            content=json.dumps({"json": {"botId": bot_id, "cursor": cursor}, "meta": []}),
            headers=headers,
            timeout=httpx.Timeout(30.0, read=None),
        ) as response:
            if response.status_code != 200:
                raise RakazoError(response.status_code, await response.aread())
            async for item in _aparse_sse(response.aiter_lines()):
                yield item["data"]


async def _aparse_sse(lines: AsyncIterator[str]) -> AsyncIterator[dict[str, Any]]:
    """Async twin of `parse_sse`, feeding one line at a time."""
    buffer: list[str] = []
    async for line in lines:
        buffer.append(line)
        if line.rstrip("\r\n") == "":
            for item in parse_sse(buffer):
                yield item
            buffer = []
