# LiveKit voice agent for Rakazo

A duplex voice front-end for Rakazo bots, built on [LiveKit Agents](https://docs.livekit.io/agents/). You talk; the bot answers in speech while its reply is still streaming; you can interrupt it mid-sentence. Rakazo stays the brain: the agent is a headless Rakazo client that sends each finished utterance as a **call turn** and speaks the `thread.progress` deltas as they arrive.

Rakazo's built-in calls are half-duplex: a turn ends after 1.2 s of silence, the reply is spoken once its run finishes, and barge-in relies on the browser recognizer's interim results ([voice and calls](../../docs/voice-and-calls.md)). This example keeps the product unchanged and adds a different transport next to it:

- **Semantic end of turn** with Deepgram Flux (`turn_detection="stt"`), falling back to Nova-3 + VAD.
- **Streaming reply**: the first spoken words start on the first `thread.progress` delta, not at `run.completed`.
- **Barge-in** by the session's VAD; the unspoken remainder is dropped, exactly as the web client does.
- **Same server rules as the Call button**: `threads/send` with a `call:<callId>:<id>` nonce, `followUp` while a run works, `answer` for an open question, approvals and secret codes stay on screen, `threads/endCall` on hang-up. Nothing in `apps/` or `packages/` changes.

Deepgram STT/TTS first (hosted, low latency); a self-hosted Kokoro TTS is one config flag away.

## Architecture

```
 Browser                                           your host
 ───────                                           ─────────
 https://talk.example.com  ───(TLS proxy/tunnel)──► token_server.py  :8080   page, /token, Rakazo proxy
 wss://lk.example.com      ───(TLS proxy/tunnel)──► livekit-server   :7880   signalling
 WebRTC media (SRTP)       ───── UDP 7882 / TCP 7881 ──────► livekit-server   rooms: rakazo-<callId>
                                                                  │
                            agent.py (livekit-agents worker, explicit dispatch "rakazo-voice")
                            ┌────────────────────────────────────────────────────────────┐
                            │ Silero VAD → Deepgram STT (Flux)                           │
                            │ → RakazoAgent.llm_node                                      │
                            │     POST /rpc/threads/send | followUp | answer (call nonce) │
                            │     POST /rpc/threads/subscribe  (SSE: thread.progress …)   │
                            │ → TTS: Deepgram Aura-2  | Kokoro (openai.TTS, base_url)     │
                            └──────────────────────────┬─────────────────────────────────┘
                                                       ▼  Authorization: Bearer <signed session>
                                              Rakazo api (+ worker, postgres)
```

One call = one LiveKit room `rakazo-<callId>` = one Rakazo call id. The token server validates the caller's Rakazo session (`GET /api/auth/get-session`), checks the bot is in the space (`bots/list`), mints a LiveKit token with an explicit agent dispatch, and keeps the caller's bearer in memory so the worker can act **as that user**: the call's messages land in the user's own chat with the bot, grouped into the usual "Voice chat" card.

## Files

| File | What |
|---|---|
| `agent.py` | The worker. `RakazoAgent.llm_node` replaces the LLM: Rakazo turn + event stream → yielded text. `tts_node` only adds timing logs. |
| `rakazo_client.py` | Signed-bearer sign-in, oRPC envelope, `threads/subscribe` SSE parsing, and the pure rules (`call_client_nonce`, `call_turn`, approval/secret detection) mirrored from `packages/core`. |
| `token_server.py` | aiohttp: serves `web/index.html`, `POST /token`, proxies sign-in and `spaces/list` for the page, and an internal `GET /internal/calls/<id>` for the worker. |
| `web/index.html` | One page on `livekit-client` from a CDN: sign in or paste a bearer, pick a bot, start, captions for both sides, mute, hang up. |
| `scripts/synthetic_caller.py` | Headless caller for tests: publishes PCM files as a mic, logs when the agent's audio starts, can barge in. |
| `tests/` | pytest for the pure parts, with fixtures recorded from a live server. |

## Setup

Prerequisites: a reachable Rakazo API, a LiveKit server (self-hosted or Cloud) with an API key pair for this agent, a Deepgram API key, Docker.

1. `cp .env.example .env` and fill it in. Generate `VOICE_INTERNAL_TOKEN` with `openssl rand -hex 24`.
2. `cp docker-compose.example.yml docker-compose.yml`, then `docker compose up -d --build`. The image bundles the Silero VAD weights.
3. Put TLS in front of the token server (`:3320` by default) and of LiveKit's signalling port, and set `LIVEKIT_PUBLIC_URL` to the `wss://` address browsers will use. Media goes straight to the LiveKit host's UDP/TCP ports; see the LiveKit [ports and firewall](https://docs.livekit.io/transport/self-hosting/ports-firewall/) page.
4. Open the page, sign in with a Rakazo account (or paste the signed session bearer from the mobile app), pick a bot, **Start call**, allow the microphone.

Rakazo side: nothing to install. `PHONE_CALLS_ENABLED=true` on the API and worker is needed for `threads/endCall` (the hang-up summary and "Voice chat" card); the call turns themselves work without it.

Local development without Docker:

```sh
uv sync
uv run python agent.py download-files
uv run python token_server.py &      # :8080 public, :8081 internal
uv run python agent.py dev
uv run pytest
```

### Sharing a LiveKit server with another app

Add a second key pair to the server's `LIVEKIT_KEYS` (a YAML map) rather than reusing the other app's key, keep the worker's `agent_name` set (explicit dispatch: the worker is never auto-dispatched into other rooms), and note the worker also refuses any room not named `rakazo-*`.

## How a turn works

1. The session's STT finalizes an utterance (Flux decides end-of-turn from acoustics and semantics).
2. `llm_node` fetches `threads/get` and applies `call_turn` (the same decision as `packages/core/src/call-session.ts`):
   - a run is `waiting_input` on a **secret** ask → speak "hang up, then enter it on screen"; nothing is sent;
   - on an **approval** ask → "approve or deny it on screen";
   - on any other ask → `threads/answer` (a short "yes"/"no" is normalized like the web client);
   - a run is working → `threads/followUp` (steers that run);
   - otherwise → `threads/send`.
   Every send carries `clientNonce = "call:<callId>:<clientId>"`, so the worker adds Rakazo's voice-call instruction (one to three spoken sentences, `end_call` available).
3. The reply is read from a single long-lived `threads/subscribe` stream per call: `thread.progress {text|delta, streaming}` is yielded to TTS as it arrives; the final `thread.message.created` fills any part that was not streamed (silent runs stream nothing); `run.completed|failed|cancelled` ends the turn. `thread.call.ended` with a farewell means the bot hung up: the farewell is spoken and the agent leaves.
4. When the caller leaves the room the worker sends `threads/endCall {callId, durationSeconds}`.

### Bot-initiated calls (`call_user`)

When the bot rings the user, Rakazo's web client answers (`threads/answerCall`) and then asks its API for a room token **with the request's `callId`**; the API verifies the request stands at `answered` in that user's chat and forwards `{botId, spaceId, callId, opening}` to `POST /token` with `x-voice-internal-token`. The token server accepts a caller-named call only from that trusted broker (403 otherwise, 409 if another user already holds the room), names the room `rakazo-<callId>` and stores `opening` in the registry; the worker then speaks `opening` instead of `VOICE_GREETING` as its first line (`session.say`, an assistant turn, never sent to Rakazo). Everything else (turn nonces, `threads/endCall`) reuses the same `callId`, so the transcript and the call's record group under the bot's request. Headless: `scripts/synthetic_caller.py --call-id <callId> --token-url http://api/api/voice/agent ...`.

Barge-in cancels the TTS and the generator; the Rakazo run is not stopped (its text is in the chat), and the remainder is never spoken, like the web client. Saying just "stop" while a run is active is interpreted by the server as Stop.

## Measured on a self-hosted box (2026-11-09)

Rakazo `app:edge` with an OpenAI-compatible model via a gateway, LiveKit 1.13.6 on the same host, Deepgram Flux + Aura-2, synthetic caller:

- end of utterance → STT final: ~0.7 s; → first Rakazo delta: 3–8 s (the run itself); → first TTS audio frame: first delta + ~0.6 s.
- barge-in: the caller spoke 1 s into the reply; the session logged `speech interrupted by the caller (barge-in)` within ~30 ms of the STT final, and the second utterance was delivered as `followUp` because the run was still working.

Rakazo's run start dominates; the voice pipeline adds about a second in total.

## Switching to Kokoro

Set `TTS_PROVIDER=kokoro` and `KOKORO_BASE_URL` (any OpenAI-compatible `/v1/audio/speech`, e.g. [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI)); the agent then uses `livekit.plugins.openai.TTS(base_url=…, model="kokoro", voice=KOKORO_VOICE, response_format="pcm")`. The HTTP TTS plugin has no input streaming, but the session still sends sentence by sentence and streams the response body. Measured on an 8-vCPU host with no GPU (Kokoro-FastAPI v0.10.0, `TARGET_MIN_TOKENS=20`, `TARGET_MAX_TOKENS=80`): first audio ~0.6 s for a short sentence, ~1.5 s for a 15-word one, so a turn starts speaking roughly 0.7 s later than with Deepgram Aura-2 — acceptable for conversation and free. Kokoro-FastAPI older than v0.9 does not stream: it renders the whole request before the first byte, so upgrade before using it here.

## Limits

- No API keys exist in Rakazo; the agent acts with a user's signed session (7-day Better Auth TTL, refreshed on use). The token server keeps bearers in memory only, for 6 h.
- Call records live in the token server's memory: restart it and in-flight calls lose their worker context (the worker then falls back to `RAKAZO_EMAIL`/`RAKAZO_PASSWORD` if set, otherwise the job fails).
- One worker handles one call per room; it does not reconnect a dropped browser.
- Approvals and codes are deliberately not accepted by voice.
- The web page is a test harness, not a Rakazo UI; embedding this into `apps/web`'s call card would be the next step.
