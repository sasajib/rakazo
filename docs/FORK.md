# Fork ledger and upstream-sync workflow (sasajib/rakazo)

This file is the source of truth for **what this fork changes on top of upstream
`elie222/rakazo`** and **how to take a new upstream release mechanically**. Keep it current:
every fork commit that lands on `main` adds or edits a row here in the same commit.

- Fork: `git@github.com:sasajib/rakazo.git` (`origin`), upstream `https://github.com/elie222/rakazo.git` (`upstream`).
- Working clone on bee: `/home/sasajib/the-data/rakazo-src/rakazo`.
- Deployment (compose stack, `.env`, backups, host units): `/home/sasajib/the-data/rakazo`
  (private repo `sasajib/rakazo-bee`); it carries `FORK-CHANGES.md`, which points here.
- Rebuild base: fork `main` was rebuilt on upstream `7dbc01748` (2026-11-24, "Fix CLI lookup in the
  macOS desktop stack (#6605)"). The pre-rebuild fork is branch `archive/main-pre-1124` (`3664b2a25`).
- `git log --oneline upstream/main..main` lists every fork commit; the groups below cover all of them.

Conventions every fork change follows (keeps syncs cheap):
1. New code goes in **new files beside upstream's** (`*-fork`-style modules such as `bot-skill-access.ts`,
   `memory-ledger/`, `shell-jobs/`, `host-display.ts`); upstream files get **small hooks** (an import, one
   call, one extra field) marked with a `Fork:` comment where useful.
2. Schema changes are **additive migrations only**, idempotent (`IF NOT EXISTS`), dated after upstream's
   newest, and every new RLS table is listed in `ROW_SECURITY_MODELS`.
3. Every env var the API/worker reads is listed by literal name in the `x-app-environment` anchor of
   `infra/compose/docker-compose.yml`, `.prod.yml` and `.images.yml` (`infra/updater/src/compose-env.test.ts`).
4. Every new oRPC procedure is added to the protected-call inventory in
   `packages/testkit/src/product/authorization.test.ts`.
5. Prompt or tool changes regenerate `packages/adapters/src/runs/assembly/__prompt_surface__/` (review the diff).
6. `ops/post-sync-check.py` carries a grep marker for each feature's seams, so a merge that drops one fails loudly.

---

## 1. Feature ledger

Format per feature: **purpose · commits · files/seams · env/settings · migrations · tests · live check ·
known conflicts**. "Seams" are the upstream files the fork edits; everything else is fork-only files.

### 1.1 LiveKit duplex calls + voice agent
- **Purpose:** the in-app Call button (web + mobile) and bot-initiated calls run on a LiveKit room with a
  separate voice agent (STT/TTS, barge-in) instead of upstream's half-duplex dictation loop.
- **Commits:** `daec9e310` (calls + example agent), `2a1b0c0a8` (mobile LiveKit, Done button, ring logging),
  `6dc010ef4` (a reply carrying a question card is still spoken), `f05e734f0` (plan cards spoken; spoken yes
  approves a pending plan; half-sentence join measured to when the caller resumed, see 1.20).
- **Seams:** `apps/api/src/app.ts` (mounts `calls/voice-agent.ts`: `GET /api/voice/agent`, `POST /api/voice/agent/token`),
  `apps/api/src/env.ts`, `apps/web/src/lib/calls/call-session.ts` (delegates to `livekit-call-session.ts`),
  `CallCard/CallLayout/IncomingCall.tsx`, `Shell.tsx`, `use-bot-call.ts`, `apps/web/server/preview-middleware.ts`
  + `packages/contracts/src/clients/content-security-policy.ts` (wss in `RAKAZO_CSP_CONNECT_SRC`),
  `packages/adapters/src/calls/call-request.ts`, `runs/assembly/run-runtime.ts`, `runs/executor/executor-deps.ts`,
  `packages/core/src/calls/{call-request,livekit-call-state}.ts`, mobile `lib/calls/*`, `app.config.ts`,
  `modules/rakazo-notifications/android/**` (Done action, call service, `rakazo_action_done` string in every `values-*`).
  Example agent: `examples/livekit-voice-agent/` (the deployed copy at `~/the-data/rakazo-voice/app` is ahead; rsync it in).
- **Env:** `VOICE_AGENT_URL` (api + worker), `VOICE_AGENT_INTERNAL_TOKEN`, `RAKAZO_CSP_CONNECT_SRC=wss://lk.mindshare.website` (web).
- **Migrations:** none.
- **Tests:** `apps/api/src/calls/voice-agent.test.ts`, `apps/web/src/lib/calls/{call-session,voice-agent}.test.ts`,
  `packages/core/src/calls/*.test.ts`, mobile `livekit-call-session.test.ts`, `call-session-transport.test.ts`,
  `android-platform-contract.test.ts`; agent: `pytest tests/` + `scripts/scenario_assert.py` (end-to-end gate).
- **Live check:** `docker logs rakazo-api-1 | grep -c api/voice/agent/token` after a call; `scenario_assert.py` PASS.
- **Sync 2026-11-26b:** upstream #6804 mounts a cross-site cookie guard on `/api/voice/*` inside `mountVoiceHttpRoutes`
  (now takes `env`). It is mounted before `mountVoiceAgentRoutes` in `app.ts`, so it also covers the fork's
  `/api/voice/agent` and `/api/voice/agent/token` (a browser request from an untrusted origin gets 403; bearer callers
  such as the mobile app and the voice agent are not cookie requests). Keep that order.
- **Conflicts:** upstream edits to `call-session.ts`, `CallCard.tsx`, the CSP module and every new Android locale dir
  (needs `rakazo_action_done`). Mobile strings are Lingui macros (`t\`...\``), never plain `t("...")`.

### 1.2 Per-bot execution slots + same-thread live-lease writer guard
- **Purpose:** `bots.concurrency` (1–8) slots per bot; a second run never writes in a thread where another run of the
  bot holds a live lease.
- **Commit:** `ad1c53eb1`.
- **Seams:** `packages/adapters/src/computers/computer-lifecycle.ts` (slot lease, `sameThreadWriterBlocks`),
  `runs/lifecycle/run-recovery.ts` (slot-aware blockers), `runs/wakeups/{run-wakeup,job-reconciler}.ts`,
  `runs/assembly/run-assembly-capabilities.ts`, `apps/api/src/computers/{computer-control,computer-status}.ts`,
  `apps/api/src/routes/bots.ts`, `packages/contracts/src/bots/bot.ts`, `packages/db/src/bots/bot-repository.ts`,
  `schema.prisma` (`Bot.concurrency`, `ComputerExecutionLease.slot`). Rules: `packages/core/src/runs/agent-concurrency.ts`.
- **Migration:** `20270105090000_agent_concurrency` (`UNIQUE (computerId, botId, slot)`).
- **Tests:** `core/src/runs/agent-concurrency.test.ts`, `computer-lifecycle{,.postgres}.test.ts`, `run-recovery.test.ts`,
  `testkit/src/product/executor-lifecycle.test.ts`, `journeys.test.ts`.
- **Live check:** `post-sync-check.py` (marker `planLeaseSlot`); overlapping-runs query per bot after a burst.
- **Sync 2026-11-26b (upstream #6817, "a person's message before scheduled work"):** upstream makes background work
  without a lease throw `ComputerBusyError` while a person's run of the bot waits for the computer (`lockOwnedRun`).
  Ported onto the slots: `lockOwnedRun(…, "count")` returns how many people's runs wait, and
  `backgroundYieldsSlot` (`core/src/runs/agent-concurrency.ts`) makes background work yield only while the free slots
  are no more than those people. One slot (the default) = upstream's rule exactly. Several slots: a person's run held
  back by the one-writer rule does not freeze the bot's other conversations and lanes. The dedicated-screen path keeps
  upstream's plain yield. Tests: `agent-concurrency.test.ts` ("backgroundYieldsSlot"), upstream's
  `computer-lifecycle.postgres.test.ts` case ("leaves a free computer to a person's waiting run…").
- **Conflicts:** any upstream lookup by the old compound key `computerId_botId` (use `findFirst`); upstream wrapping
  lifecycle code in `withTransactionRetry`; test doubles needing `findMany/findFirst` on the lease delegate.

### 1.3 Talk lane, acknowledgement/supervision, `callNote`, `leaveCards`
- **Purpose:** a lease-free, tool-free `talk` run answers a message while the bot's main run works (>= 8 s, or
  at once for questions); call notes land in chat; a call request can start beside a parked card.
- **Commit:** `4c6f393d0` (+ voice fixes in 1.4).
- **Seams:** `apps/api/src/threads/thread-target.ts` (`createTalkRunBeside`, `leaveCards`, `messageBypassesTakeoverWait`),
  `apps/api/src/routes/threads.ts` (`callNote`), `packages/adapters/src/runs/assembly/{run-assembly-capabilities,run-assembly-context,run-context}.ts`,
  `talk-run.prompt.ts` (fork file), `runs/lifecycle/{run-attempt,run-progress,run-recovery}.ts`, `runs/tools/run-tools.ts`,
  `runs/turn/{run-model-turn,run-unfinished-task}.ts`, `runtime/pi/pi-runtime.ts` (`sessionSuffix`),
  `packages/adapter-kit/src/types.ts`, `contracts/src/runs/runs.ts` (`talk` trigger), `contracts/src/threads/{thread-send,threads-rpc}.ts`,
  `core/src/runs/{run-state,run-supervision}.ts`, `core/src/calls/voice-chat-groups.ts`, `db/src/threads/events.ts`.
- **Env:** none. **Migration:** none.
- **Tests:** `core/src/runs/run-supervision.test.ts`, `voice-chat-groups.test.ts`, `tool-step-outcomes.test.ts`,
  `apps/api/src/calls/calls.test.ts`, `db/src/threads/events.test.ts` (`talkRunId` in return shapes), authorization inventory (`threads/callNote`).
- **Live check:** `run.execution_started` with `run.trigger: talk` in api logs while another run holds the computer.
- **Continuation rule, two exclusions (2026-11-26, `fix/journeys-1126`):** "a person's run that announced work and used
  no tool is continued once" (`core/src/runs/run-supervision.ts` `needsContinuation`, `adapters/.../run-unfinished-task.ts`)
  does not fire for (a) a run that stopped for the person: `pausedForPerson`, read from the run's own events
  `PAUSED_FOR_PERSON_EVENT_TYPES` (`computer.takeover.requested`/`released`, `run.waiting_input`), queried only when the
  rule would otherwise fire. Before, only tool calls of the last attempt counted, so a takeover that was not a tool
  call (scripted runtime) or a resumed attempt that lost the paused attempt's steps got a second `follow_up` run asking
  for the same takeover. (b) a statement that uses a work word as a noun ("this is a safe test", "thanks for the
  update"): `requestsWork` counts a work word only where it opens a clause or follows a word that takes a verb
  (`BEFORE_A_VERB`; "I/we need|want …" still counts a noun). Tests: `run-supervision.test.ts`, journeys 4 (asserts one
  run), 4b, 4d, 13c.
- **Conflicts:** `thread-target.ts` and `run-model-turn.ts` change upstream almost every release; a `Record<RunTrigger, …>`
  in upstream tests needs `talk: false`.

### 1.4 Calls: cards beside the call, takeover not released by call turns, voice mirror rules
- **Purpose:** during a call, computer/takeover, image, file, child-bot, chart and ask cards render beside the call card;
  a spoken turn (`call:` nonce) never steers or releases a `waiting_takeover` run; the voice agent mirrors only `line`
  and status `answer` segments into chat (prefaces and heartbeats stay speech-only).
- **Commits:** `953a41e72`, `6dc010ef4`.
- **Seams:** `packages/core/src/calls/voice-chat-groups.ts` (`groupVoiceChats` keeps non-spoken kinds out; mobile
  `latestSpokenCallReply` must pass `{cardsApart: false}`), `apps/api/src/threads/thread-target.ts`, example agent files.
- **Tests:** `voice-chat-groups.test.ts`, `apps/api/src/threads/takeover-chat.postgres.test.ts`, agent `tests/test_conversation.py`.
- **Live check:** a call while a takeover card is pending: card visible in chat, run still `waiting_takeover` after "where is the browser?".
- **Conflicts:** upstream changes to message block kinds (new kinds default to "card apart" only if added to the list).

### 1.5 Standing orders, notice ledger, done tick, end_call guard, search_history soft-fail
- **Purpose:** one `STANDING.md` per space written by `standing_set` (rules replace by key, tiers, links); a 24 h notice
  ledger in every prompt; `✅` tick that never wakes a bot; `end_call` guard.
- **Commit:** `5c09b3a59`.
- **Seams:** `packages/adapters/src/memory/memory-context.prompt.ts`, `runs/assembly/{run-assembly-history,run-instructions.prompt}.ts`,
  `runs/tools/{run-tool-selection,run-tools-memory,run-tools-messaging}.ts`, `runtime/pi/tools/pi-runtime-tools.ts`,
  `tools/builtin-conversation.tool-definition.ts` (standing_set), `tools/builtin.tool-definition.ts`,
  `contracts/src/bots/builtin-tools.ts`, `contracts/src/threads/reactions.ts`, `apps/api/src/threads/thread-reactions.ts`,
  `apps/web/src/pages/shell/chat/transcript.tsx`, `core/src/runs/action-approval.ts`, `core/src/skills/agent-skill.prompt.ts`.
  Fork files: `memory/{standing-orders,standing-curator,standing-embeddings,standing-graph,notice-ledger}.ts`, `calls/call-end-intent.ts`.
- **Env:** `STANDING_EMBEDDINGS_URL` (optional pgvector suggestions).
- **Migration:** `20270105090100_standing_embeddings`.
- **Tests:** `memory/standing-*.test.ts`, `notice-ledger.test.ts`, `run-tools-standing.test.ts`, `call-end-intent.test.ts`.
- **Live check:** markers `standing_set`, `notice-ledger`; `STANDING.md` row in `memory_documents`.
- **Ops:** `ops/standing-graph.py`, `ops/weekly-self-audit.py` (Monday cron). Stack-side: standing orders `r-bee-desktop-browser`,
  `r-bee-desktop-browser-screen` live in the DB (STANDING.md), seed text `STANDING-seed-content.md` in the stack repo.
- **Sync 2026-11-26b (upstream #6740, "Space-wide rules in shared memory with remember"):** upstream dropped
  `save_shared_memory` and gave `remember` a `shared` flag that edits the Space's memory documents, described as the
  place for "rules, decisions and facts … all bots should follow". **Decision: standing orders stay the binding rule
  store.** Taken: the `shared` flag and the removal of `save_shared_memory` (its handler, label, approval-list entries
  and `sharedMemorySaveError` are gone with upstream). Kept/ported: (1) `remember {shared: true, path: "STANDING.md"}`
  is refused with "STANDING.md changes only through standing_set" before anything is read (the guard
  `save_shared_memory` carried; `delete_shared_memory` keeps its own); (2) the `shared` description now reads "facts
  about the user or team that all bots should know. A standing rule or a settled decision goes to standing_set, not
  here."; (3) with `MEMORY_LEDGER=1` an owner's `remember` still goes to the fact ledger first, with or without
  `shared` (the ledger is already Space-wide), so on bee `shared` only reaches the documents in a run that received
  outside text. Test: `run-tools-standing.test.ts` ("standing orders and upstream's shared memory"). Upstream #6745's
  longer `remember` wording (no open loops, no approval logs) is taken as is.
- **Conflicts:** upstream splits/renames built-in tool definition files; re-apply in the area file that now holds the tool.

### 1.6 Lanes, per-bot admission gate, `bot_queue`, `message_bot` duplicate check, live-call relay
- **Purpose:** `runs.lane` per site/task; one run per lane at a time, other lanes in parallel; `bot_queue` tool; an exact
  repeat request is refused; a call relays to a bot without blocking.
- **Commits:** `6ff31b5a8`, `0d04c0ed9` (a `bot_message` request waits only on its own lane in a shared chat), part of `760359359`.
- **Seams:** `runs/lifecycle/run-lifecycle.ts` (`admissionHold` in `claimRun`), `runs/lifecycle/chat-wait.ts`
  (upstream #5625 `claimWaitsForChat`: fork makes `bot_message` runs of another lane not wait), `messaging/bot-messages.ts`
  (`findQueuedDuplicate`, `CALL_RELAY_GUIDANCE`, `threadHasLiveCall`), `runs/tools/run-tools-messaging.ts`,
  `tools/builtin-fleet.tool-definition.ts` (`lane`, `force` on message_bot; `bot_queue`), `contracts/src/bots/builtin-tools.ts`,
  `core/src/bots/bot-messages.prompt.ts`. Fork files: `runs/lifecycle/run-gate.ts`, `messaging/bot-queue.ts`.
- **Migration:** `20270105090200_run_lane`.
- **Tests:** `run-gate.test.ts`, `bot-queue.test.ts`, `bot-messages.test.ts`, `chat-wait.postgres.test.ts`.
- **Live check:** `post-sync-check.py` live queue test (4 sends -> 3 runs; same lane serial; other lane parallel).
- **Conflicts:** `chat-wait.ts` / `run-lifecycle.ts` (upstream reworks claim logic); hand-rolled tx doubles lack
  `$executeRaw` (the gate skips itself then, by design).

### 1.7 Core tools pinned (no `find_tool` needed)
- **Purpose:** `scratchpad_*`, `call_user`, `message_bot`, `schedule_cancel`, `schedule_update`, `standing_set`, `bot_queue`
  are always listed (upstream defers them behind `find_tool`).
- **Commit:** `1b463b48b`.
- **Seams:** `packages/adapters/src/tools/builtin-tool-bridge.ts` (`CORE_BUILTIN_TOOL_NAMES`) + its test byte cap.
- **Tests:** `builtin-tool-bridge.test.ts` (pinned list + byte budget), `pi-runtime-tool-dispatch.test.ts`,
  `testkit/src/runtime/executor-turn-checkpoint.test.ts` (uses `render_plot` as the "still deferred" example).
- **Sync 2026-11-26b:** cap `49_880` (measured 49_820; upstream's own 38_322). Upstream #6768 explains unavailable
  built-ins in `find_tool` (merged untouched; the deployment-disabled tools of 1.16 get its "turned off for this bot").
- **Conflicts:** upstream resets the byte cap: keep upstream's comment, measure, set cap = real size + small margin.

### 1.8 Audit log events
- **Purpose:** log-only events for the behaviour audit: `agent.tool.completed` error class/attempt/args hash,
  `memory.save`, `memory.prompt.built`, `run.prompt_manifest`, `run.audit_summary`, `honcho.request.failed`.
- **Commit:** `67aafc9a5`.
- **Seams:** `runs/executor/executor.ts`, `runs/turn/run-model-turn.ts`, `run-unfinished-task.ts`, `runs/tools/{run-tools,run-tools-memory}.ts`,
  `memory/memory-context.ts`, `run-assembly-history.ts`, `tools/lazy-tool-catalog.ts`, `honcho-client.ts`.
  Fork files: `runs/turn/{run-audit,run-audit-log,run-audit-run,tool-completion-audit,tool-error-class,error-redaction}.ts`.
- **Tests:** the matching `*.test.ts`; `deferred-tool-count.test.ts`.
- **Live check:** `docker logs rakazo-api-1 | grep run.prompt_manifest` (field list: stack repo `AUDIT-LOG-EVENTS.md`).
  Consumer: `sasajib/rakazo-audit` (`/home/sasajib/the-data/rakazo-audit`, unit `bee-rakazo-audit`).

### 1.9 Prompt-surface snapshot + ops scripts
- **Commit:** `7f19c885d` (+ `bce118de8`, `a5d42086d` extend `post-sync-check.py`).
- **Files:** `packages/adapters/src/runs/assembly/prompt-surface.test.ts` + `__prompt_surface__/`, `ops/post-sync-check.py`,
  `ops/rakazo_rpc.py` (opens and closes its OWN Neo tab; same file as the stack repo's `ops/rakazo_rpc.py`, keep both
  in step; test `ops/test_rakazo_rpc.py` + `ops/testdata/neo-run-samples.json`), `ops/weekly-self-audit.py`, `ops/standing-graph.py`,
  `ops/pgvector-swap.sh`, `ops/postgres-graph/Dockerfile` (`rakazo/postgres-graph:16-pgv-age1.6`, pgvector + AGE),
  `ops/memory-ledger-eval/`.
- **Fix 2026-11-26 (`fix/post-live-1126`): `ops/rakazo_rpc.py`.** The fork copy was stale (`page.evaluate`, which neo
  no longer has; it broke the live part of `post-sync-check.py`): replaced by the stack copy (`page.evaluateInPage`).
  In both copies `_run` now reads both result shapes of neo's `run` tool (`read_result`): inline
  `{ok, value}` and, over ~20 KB, `{ok, writtenToFile, path, contentLength}` whose file holds `ok\nreturn: <value as
  JSON>`. Before, a large result (`threads/get` on a long thread) raised "neo run failed: None" after a pointless
  retry. Test without a browser: `python3 ops/test_rakazo_rpc.py` (recorded SSE answers of both shapes + a failed
  run; 3 of 5 fail on the old `_run`).
- **Conflicts:** none in upstream code; the snapshot fails on every upstream prompt change (review, then `-u`).

### 1.10 Memory ledger (shared Space fact ledger, phases 1–2)
- **Purpose:** quote-gated facts per space written by a separate memory model after runs; `<memory_facts>` block after
  standing orders; `remember`/`recall_memory` act on the ledger; conflicts with confirmed facts go to the owner on a card.
- **Commits:** `e8fa098fe`, `bce118de8`, `af4f4d357`, `8a4d443ce`, `bf8bffff8`, `dec2bf529`, `a85858ae4`, `b0edd86fc`, `760359359`.
- **Seams:** `runs/assembly/run-assembly-history.ts` (`withLedgerMemory`, `placeLedgerBlock`), `runs/lifecycle/run-complete.ts`
  (`learnAfterRun(ctx)`), `runs/tools/run-tools-memory.ts` (`rememberToolViaLedger`, `recallToolViaLedger`),
  `memory/memory-tools.ts`, `bots/child-bots.ts` (`!deleteMemories && !ledgerEnabled()`: no `Archived bots/...` re-filing),
  `core/src/runs/run-supervision.ts`, `db/src/database/row-security.ts` (`memory_facts`, `memory_fact_links`, `memory_ledger_jobs`).
  Fork dir: `packages/adapters/src/memory-ledger/` (NOTICE: concepts adapted, see file).
- **Env:** `MEMORY_LEDGER=1`, `MEMORY_LEDGER_MODEL_URL`, `MEMORY_LEDGER_MODEL`, `MEMORY_LEDGER_MODEL_API_KEY[_FILE]`,
  `MEMORY_LEDGER_MODEL_CONNECTION`, `MEMORY_LEDGER_MODEL_TIMEOUT_MS`, `MEMORY_LEDGER_MODEL_MAX_TOKENS`,
  `MEMORY_LEDGER_MODEL_RETRIES`, `MEMORY_EMBEDDINGS_URL/_MODEL/_API_KEY[_FILE]/_TIMEOUT_MS`,
  `MEMORY_LEDGER_PACK_BUDGET_MS` (2500 on bee), `MEMORY_LEDGER_CORE_MAX_BYTES`, `MEMORY_LEDGER_PACK_MAX_BYTES`,
  `MEMORY_LEDGER_PACK_LIMIT`, `MEMORY_LEDGER_FAST_PACK_LIMIT`.
- **Migration:** `20261231235500_memory_ledger` (raw SQL tables, no Prisma models; hard-requires pgvector);
  `20270128090000_memory_ledger_idempotency` (`memory_facts.textKey` + partial unique index, `memory_ledger_jobs.wroteAt`).
- **Tests:** `memory-ledger/*.test.ts`, `ledger.postgres.test.ts`, `seams.postgres.test.ts` (pgvector DB), `run-hooks.test.ts`,
  `ops/memory-ledger-eval/run_eval.py`; live matrix in stack repo `MEMORY-LIVE-TEST-1124.md`.
- **Live check:** `memory.ledger.*` api log lines; `select count(*) from memory_facts`.
- **Rule for tests:** messages sent as the owner become shared facts. After any throwaway-bot test:
  `update memory_facts set status='retracted', "validTo"=now() where "writtenByBotName"='<bot>' and status in ('confirmed','tentative','disputed')`.
- **Conflicts:** upstream moves memory/assembly files often (`runs/assembly/`, `runs/lifecycle/run-complete.ts`); re-place the hooks.
- **Fix 2026-11-26 (`fix/post-live-1126`): the memory model's completion budget.** `memory.ledger.model_unusable` 7 times
  in 25 min with `finish_reason: length` and empty content: the GLM reasoning model spent all 8000 completion tokens
  thinking. Now `MEMORY_LEDGER_MODEL_MAX_TOKENS` (default 16000, clamp 256..200000; `config.ts`, literal-name read, in
  the three compose anchors) sets `max_tokens`, and `chatWithBudget` (`model.ts`) repeats a call that ended on the budget
  with NO answer once with twice the budget before the job is marked failed (a cut-off answer, an empty answer that was
  not cut, or an HTTP error is not repeated). Log `memory.ledger.model_retry` (`llm.max_tokens`, `llm.retry_max_tokens`);
  `model_unusable` now carries `llm.max_tokens` and `llm.retried`. The skill curator (1.19) calls the same helper with
  the same setting (was a fixed 8000; log `skill.curator.model_retry`). Worst case per job: two model calls, each with
  its own timeout. Tests: `memory-ledger/model.test.ts` ("a reasoning model that spends the whole budget thinking", 4
  cases + the env), `skill-curator/curator.test.ts` (same for the curator), `compose-env.test.ts`. Stack: add the
  `MEMORY_LEDGER_MODEL_MAX_TOKENS:` line to the stack compose anchor only if the default is to be changed.
- **Fix 2026-11-27 (`fix/leftovers-1126`): the memory model call survives overload.** Live 2026-11-26: 3 of 24
  jobs failed on their first attempt (`http.status 429` twice, `TimeoutError` once); only an empty `length` answer was
  repeated. `chatWithBudget` (`model.ts`, shared with the skill curator) now repeats HTTP 429/408/425/5xx, a timeout
  and a failed connection up to `MEMORY_LEDGER_MODEL_RETRIES` times (default 3, clamp 0..8; `config.ts`, literal-name
  read, in the three compose anchors), waiting 1 s, 2 s, 4 s ... times a random 0.5-1, or what `Retry-After` asks
  (seconds or a date). Everything stays inside a wall budget: 5 minutes for a ledger or curator job
  (`MODEL_CALL_BUDGET_MS`, well under the 15 minutes after which a running job is taken again), 20 s for the
  `remember` tool; a repeat that could not finish in what is left, or a `Retry-After` over 60 s, is not waited for
  and each late attempt gets only the remaining time as its timeout. HTTP 400/401/404 and the caller's own cancel
  are not repeated. Log `memory.ledger.model_retry` / `skill.curator.model_retry` `{reason: rate_limited |
  server_error | timeout | network | length, attempt, wait_ms, http.status}` (`gave_up: budget` when it stops
  early). A job whose model still fails is `failed`, and the catch-up pass offers it again after 10, then 20
  minutes, up to 3 attempts (it was never final after one failure: the row seen `failed` after 1 attempt was
  waiting for the next learning run of that person in the Space, which is what triggers catch-up). With the
  idempotency fix a repeated job cannot write twice. Tests: `memory-ledger/model-retry.test.ts` (11; 8 fail on the
  old code), `compose-env.test.ts`. Stack: add `MEMORY_LEDGER_MODEL_RETRIES:` to the stack compose anchor only to
  change the default.
- **Fix 2026-11-27 (`fix/leftovers-1126`): a ledger job writes once.** Live 2026-11-26: 18 live facts were copies
  of another live fact (14 word for word, written in the same second by two or three jobs), all from late jobs. Cause:
  `loadOwnerMessages` read "the run's source message and everything after it" as the run's own words, taken from the
  24 newest owner messages of the thread. Right when the job runs as the run ends; wrong for a job caught up hours
  later (failed first on the 30 s model timeout): each late job read the same newest stretch, which belonged to
  later runs, and none read its own message. On 11-26, 113 of 157 facts cite a message sent after their run had
  finished. Nothing stopped the copies: no key, check-then-insert without a lock, and the model words and names
  (slug) a fact differently each call, so the word-overlap and same-subject rules did not match. Now:
  (1) `seams.ts` passes `until: job.createdAt` (the run's end) for a caught-up job, so it reads its own run's
  messages only; (2) `writer.ts` does the whole write stage in `store.writeTransaction` (one transaction under a
  per-Space `pg_advisory_xact_lock`), with `claimWrite` setting `memory_ledger_jobs.wroteAt` in that transaction: an
  attempt that committed and then failed or timed out is not written again by its retry (`already_written` in
  `memory.ledger.learned`); a fallback after a model failure writes without claiming, so the model's retry still
  lands; (3) `scoring.ts` duplicate rules gain "same evidence" (same source message, overlapping quote, same words)
  and "near" (bge-m3 cosine >= `NEAR_DUPLICATE_SIMILARITY` 0.92 with the same numbers/dates: same stemmed words =
  more evidence, otherwise the supersede/conflict rules as for a shared subject); (4) `insertFactOnce` + the
  partial unique index `memory_facts_live_text_key` (`spaceId`, `textKey`) refuse a second live fact with the same
  words at the database; (5) a failed job comes back after 10, then 20 minutes (`staleJobs`, `MAX_JOB_ATTEMPTS` 3).
  Embeddings are fetched before the transaction. Rows written before the migration have `textKey` NULL (matched by
  the writer's text rules). Tests: `memory-ledger/idempotency.test.ts` (9, all fail on the old code),
  `ledger.postgres.test.ts` ("writes a fact once", real index, lock and rollback). Cleanup of existing copies:
  `ops/memory-ledger-dedupe.py` (dry run by default; `--apply` backs the rows up to JSONL, then marks copies
  `superseded` + `validTo` + a `supersedes` link from the fact that stays; never touches open conflicts, facts the
  owner was asked about, or a confirmed fact worded differently). Tuning: 0.92 was measured on bee's bge-m3
  (paraphrases 0.925-0.935, "Dhaka"/"Chittagong" 0.83, PDF/Word 0.89); a different embedding model needs it re-measured.
- **Fix 2026-11-25 (image `main-1125c`): candidate lookups ranked by relevance.** `store.ts` `findLive`/`findRetired` ordered
  OR-of-words FTS hits by `updatedAt DESC LIMIT n`; with >20 live facts sharing "owner/wants/assistant", a `remember remove`
  quoting an older fact word for word got no candidate ("no entry matches", fell back to MEMORY.md). Now: subject/id hits,
  then `ts_rank_cd`, then newest. Also improves the writer's duplicate/conflict lookup. Guard: `ledger.postgres.test.ts`
  ("older fact is still found", fails on the old order).

### 1.11 Background shell jobs (slice A)
- **Purpose:** a shell call that runs long is promoted to a job; its result re-enters as a message (wake run), so a long
  command does not keep the run and chat busy.
- **Commits:** `32d1d285f`, `367d66f6a` (env read by literal name), `b39d8a4de` (jobs behind the routing sandbox).
- **Seams:** `apps/api/src/threads/{thread-stop,thread-target}.ts`, `packages/adapter-kit/src/{background-jobs,types}.ts`,
  `runs/assembly/{run-replies.prompt,run-runtime}.ts`, `runs/tools/{run-tool-selection,run-tools-computer,run-tools}.ts`,
  `runs/turn/run-model-turn.ts`, `runs/wakeups/background-job-handlers.ts`, `runtime/pi/tools/{pi-runtime-tool-parameters,pi-runtime-tools}.ts`
  (pi's own schema needs the new param), `tools/{builtin-computer,builtin-jobs,builtin}.tool-definition.ts`, `builtin-tool-bridge.ts`,
  `contracts/src/bots/builtin-tools.ts`, `contracts/src/runs/runs.ts`, `core/src/runs/{action-approval,agent-concurrency}.ts`.
  Fork dir: `packages/adapters/src/shell-jobs/`.
- **Env:** `SHELL_BACKGROUND_JOBS` (0 = off), `SHELL_BACKGROUND_AFTER_MS`, `SHELL_JOB_MAX_MS`, `SHELL_JOBS_PER_BOT`,
  `SHELL_JOBS_PER_SPACE`, `SHELL_JOB_MAX_WAKES`.
- **Migration:** `20270110090000_shell_jobs`.
- **Tests:** `shell-jobs/*.test.ts`, `shell-jobs.postgres.test.ts`, `shell-jobs.fake-computer.test.ts`, `wakeup{,.postgres}.test.ts`.
- **Live check:** shell `sleep 45` in a bot: run ends early, a `job_result` wake run follows. Desktop (host) computers skip
  background jobs by design. Report: stack `BACKGROUND-JOBS-BUILD.md`.
- **Conflicts:** pi runtime tool parameter schema; `run-tools-computer.ts`.

### 1.12 `computer_observe {share: true}`
- **Purpose:** posts the exact observed frame into the chat (replaces shell screenshot + attach_file).
- **Commit:** `6544d587e`.
- **Seams:** `runs/tools/{run-tools-computer,run-tools-files}.ts`, `tools/builtin-computer.tool-definition.ts`,
  `runs/assembly/run-instructions.prompt.ts`.
- **Tests:** `runs/executor/executor.test.ts` (share case).
- **Live check:** ask a bot "show me the screen": a PNG message appears in chat.

### 1.13 Reverted: cookie-sync between bots' browsers — DO NOT REDO
- **Commits:** `4beefbd81`, reverted by `3b1845cb6` (`packages/core/src/node/login-sync*`).
- **Why:** Google's session protection logged out the copies within minutes and the daemon copied that sign-out back
  into the source profile (owner lost his YouTube login). One login for all bots = one real browser instance (1.14/1.15).

### 1.14 BrowserOS neo in the computer image (team-shared screen)
- **Purpose:** the Team Computer runs ONE BrowserOS neo for every bot: screen key `team-shared`, one profile, a tab per bot,
  screen work held per bot (15 s wait, then 409 naming the holder).
- **Commits:** `d18063db9`, `ff4158584` (tab to front by Ctrl+Tab stepping), `e0267e859` (pin each agent-browser session to its tab).
- **Files:** `infra/sandboxes/computer/{Dockerfile,rakazo-browser,rakazo-focus-or-launch,rakazo-page-browser}` (browserclaw .deb,
  sha256-pinned, build arg `BROWSEROS=none`), `infra/sandboxes/supervisor/src/{shared-screen.ts,routes.ts}`,
  `adapters/src/computers/computer-workspace.ts`, `providers/computer/docker/docker-sandbox.ts`, `core/src/node/desktop-runtime.ts`.
- **Env:** `SANDBOX_TEAM_SHARED_BROWSER` (supervisor; `0` = per-bot screens), `RAKAZO_BROWSER_BINARY=chromium` (opt out),
  `AGENT_BROWSER_PIN_TAB=1` (inside the helper), `.env` `RAKAZO_COMPUTER_IMAGE=rakazo/computer`, `RAKAZO_COMPUTER_IMAGE_TAG=neo-1124m`.
- **Tests:** `shared-screen.test.ts`, `computer-spec.test.ts`, `focus-or-launch.test.ts`, `test_owner_tabs.py`, `test_focus_or_launch.py`,
  `computer-workspace.test.ts`, `docker-sandbox.test.ts`. Run rakazo-browser tests with `RAKAZO_BROWSER_BINARY=chromium`
  and kill leftovers (`pgrep -af 'scratch/rakazo-browser-'`, never his `--restore-last-session` neo).
- **Live check:** two throwaway bots, httpbin cookie set/read; concurrent cold start; `ps` shows one browserclaw main process.
- **Status on bee:** superseded for live use by 1.15 (bots run on bee's desktop), but kept in the fork and the image.

### 1.15 Host computer = bee's desktop :1 (live screen, Take over, computer_observe/act)
- **Purpose:** the bots' computer is bee's own X display :1 through upstream's "Use this computer" host server, plus a fork
  `HostDisplay` that serves the screen (view-only + per-lease control x11vnc, websockify token gateway).
- **Commits:** `31a7c254d`, `7066d6365`, `a5d42086d` (post-sync markers).
- **Seams:** `packages/adapters/src/computers/host/{host-computer-protocol,host-computer-runner,host-computer-sandbox,host-computer-server}.ts`
  (`displayConnect/Control/Observe/Input/Act`), `runs/assembly/{run-assembly-capabilities,run-instructions.prompt}.ts`
  (graphical tools for kind `desktop` when `userMachineServesScreen`), `apps/api/src/computers/computer-status.ts`
  (`userMachineScreen`), `apps/web/src/lib/computers/computer-sandbox.ts` (`screenlessUserMachine()`), `computer-overlay/panel.tsx`,
  `use-computer-controls.tsx`, `contracts/src/computers/computer.ts`, `adapters/package.json`.
  Fork files: `computers/host/{host-display,host-display-setting}.ts`.
- **Env:** `SANDBOX_HOST_SCREEN=1`, `SANDBOX_HOST_URL=http://host.docker.internal:7093`, `SANDBOX_HOST_TOKEN`;
  host unit: `RAKAZO_HOST_SCREEN_PORT=7094`. DB: `deployment_settings."computerHost"='this-mac'`.
- **Tests:** `host-display.test.ts`, `host-computer.test.ts`, `computer-status.test.ts`, `computer-sandbox.test.ts`, `sandbox-faults.test.ts`.
- **Live check:** `computer/screenUrl` -> `/novnc/session/view/...` 200; computer_observe share=true posts a 1280x658 PNG;
  markers `userMachineServesScreen(`, `displayConnect`, `screenlessUserMachine(`.
- **Stack-side:** `host-computer/` in the stack repo (bundle built by `node build.mjs` from this fork's adapters), user unit
  `bee-rakazo-host-computer` (172.17.0.1:7093, docker0 only), `host-computer/rakazo-tab-shot` (bot-tab screenshots over neo CDP).
- **Conflicts:** upstream changes to the host computer protocol/server (desktop app work lands there).

### 1.16 `RAKAZO_DISABLED_BUILTIN_TOOLS` (deployment-wide disabled built-ins)
- **Purpose:** switch built-in tools off for every bot, including bots created later (bot creation copies no disabled tools).
- **Commits:** `8265deeb2`, `ee156382d` (must be applied in BOTH `resolveRunCapabilities` and `selectRunTools`).
- **Seams:** `packages/adapters/src/runs/assembly/run-assembly-capabilities.ts`; compose anchors.
- **Env:** `RAKAZO_DISABLED_BUILTIN_TOOLS=browser_act,browser_navigate,browser_snapshot,launch_app,open_path,user_computer_act,user_computer_observe` (bee).
- **Tests:** `runs/assembly/deployment-disabled-tools.test.ts`, `compose-env.test.ts`.
- **Live check:** `run.prompt_manifest` `tools.exposed` count drops (82 -> 77) on a fresh bot. Marker `RAKAZO_DISABLED_BUILTIN_TOOLS` (2 files).

### 1.16b Saved logins through an MCP browser (`vault_fill`)
- **Why:** with the page browser off for the deployment (1.16) the only fill path, `browser_act fill_secret/fill_code`,
  is gone: agents saw a login in `list_secrets`, could not type it, and asked for Take over every time (or invented
  arguments for the MCP browser's `act`).
- **Purpose:** built-in tool `vault_fill {secret?, server?, page, fills: [{ref, field} | {ref, code: true}]}`: a saved
  login's fields, its authenticator code, or (no `secret`) the one-time code the user entered for this run, typed into
  a page of a browser the agent drives through an MCP server. The value is put in on the server side and never
  returned or logged. Nothing names a server or a site: which servers are browsers, and their tool/argument names, is
  env. Per call: (1) focus the field and run a probe script in the page through the run's own connector session
  (same MCP session, assignment and tool allowlist as the agent's own calls) -> page origin + focused element;
  (2) real `resolveLoginFill` / `resolveCodeFill` / `loginCodeClaim` (same approval, limits, `credential.used` record
  as `browser_act`); (3) refuse unless the page origin is HTTPS and is the login's site (or an `alsoOn` site; the
  approved site for a login that asks first); a password only into `input[type=password]`, a username only into
  text/email/tel (or a select), a code into text/tel/number/password; nothing into a read-only field or a field in
  another site's frame; (4) the server's fill call with the value (`sensitive: true`, `diff: "none"` by default);
  origin re-checked before every field; (5) redaction forms added to the run's secrets before anything is sent, so
  later snapshots/reads are scrubbed. Result: `{ok, site, filled: [{ref, field}]}` or `{ok: false, uncertain, error, completed}`.
  A login marked "ask first" asks with the same card as `browser_act` (`askingLoginUse`, one approval per call).
- **Offered** only when a configured server is among the run's connector tools (directly, or named as a source of the
  folded catalog); pinned in `CORE_BUILTIN_TOOL_NAMES` (no `find_tool`); approval-exempt like `browser_act`
  (still gated in runs outside text started; result taints the run). `secretGuidance` gets a sign-in recipe when
  `browser_act` is off and `vault_fill` is offered; the secret tools' result notes that say `browser_act fill_*`
  are reworded for such a run (`withVaultFillWording`).
- **Commits:** `77a39bef1` (feature), `654c56f1e` (connector-level test, one lookup per server tool). Branch
  `feat/vault-fill-mcp-browser`; not deployed when written (report: stack `FIX-1126-vault-fill.md`).
- **Files (fork):** `packages/adapters/src/secrets/vault/vault-mcp-fill.ts` (config, probe, server calls),
  `runs/tools/run-tools-vault-fill.ts` (handler, approval steps, wording), `tools/builtin-vault-fill.tool-definition.ts`.
- **Seams:** `tools/builtin.tool-definition.ts`, `tools/builtin-tool-bridge.ts` (pinned), `runs/tools/run-tools.ts` (handlers +
  wording wrapper), `runs/tools/run-tool-selection.ts` (`vaultFillBrowser`), `runs/assembly/run-assembly-capabilities.ts`
  (`vaultFillBrowserInRun`), `runs/tools/run-tool-request.ts` (`askingLoginUse` page hook + the `vault_fill` approval block),
  `runs/assembly/run-instructions.prompt.ts` (`secretGuidance`, `vaultFillOffered`), `runs/turn/run-model-turn.ts`,
  `runtime/pi/tools/pi-runtime-tools.ts` (label, sequential), `contracts/src/bots/builtin-tools.ts`,
  `core/src/runs/action-approval.ts`, the three compose anchors.
- **Env:** `VAULT_FILL_MCP_BROWSERS` = comma list of MCP server slugs / installed MCP source names (bee: `browser-mcp`);
  empty = feature off, tool never offered. `VAULT_FILL_MCP_BROWSER_SHAPES` = optional JSON `{"<server>|*": {focus, inspect,
  fill: {tool, args}, elementCheck}}` with placeholders `{page} {ref} {value} {script} {function}`; default = BrowserOS
  neo's shape (`act` focus/fill, `evaluate_in_page {page, code}`, else `evaluate`). Unreadable shapes switch the feature off (logged `vault_fill.config_invalid`).
- **Fix 2026-11-26 (`fix/post-live-1126`, found by the live test of `main-1126a`): the default script step resolves by
  availability.** BrowserOS neo has no `evaluate` tool (it is `evaluate_in_page {page, code}`); the live run failed with
  "The evaluate tool of browser-mcp is not available to this bot" and the deployment worked around it with
  `VAULT_FILL_MCP_BROWSER_SHAPES`. Now a step's `tool` may be ONE name or a LIST of alternative names (`stepTools`); the
  first the server offers to this bot is used and remembered for the call. Default inspect =
  `["evaluate_in_page", "evaluate"]`, so no override is needed on bee; an override (one name or a list) is still
  honoured and replaces the default list. When none is offered the error names every tool tried
  ("None of the tools tried on <server> is available to this bot (tried: evaluate_in_page, evaluate)"). Tests:
  `run-tools-vault-fill.test.ts` ("uses the script tool the server offers, with no shape configured": FAILS on the old
  default; "names every tool it tried…"; "still honours a shape that names one tool…"), connector test wording.
- **Migrations:** none.
- **Tests:** `runs/tools/run-tools-vault-fill.connector.test.ts` (real `McpConnector` + HTTP MCP server: one session for the
  agent's call and the fill, allowlist held), `runs/tools/run-tools-vault-fill.test.ts` (fake MCP browser behind the real `ConnectorRegistry` and catalog
  lookup, real vault/encryption/`resolveLoginFill`/code claims: right origin, wrong origin, http, forged origin record,
  unknown login/field, field types, page moving mid-call, server refusal/timeout, ask-first through `prepareToolRequest`,
  TOTP once + restore, run code, server allowlist, shapes, offering, wording, guidance), `prompt-surface.test.ts`
  (`__prompt_surface__/vault-fill.md`), `compose-env.test.ts`.
- **Logs:** `vault_fill` (runId, botId, server, fills, outcome, completed); never a value.
- **Live check:** throwaway HTTPS login page + a login saved for its origin; agent: `list_secrets` -> tab -> snapshot ->
  `vault_fill` -> click submit; page shows the values, chat/tool results/logs do not; a second login on another origin is refused.
- **Sync 2026-11-26b (upstream #6818 broke the server match; fixed):** upstream now labels an MCP catalog source by
  the server's display name (`route.catalogGroup` = "Browser MCP", not the slug `browser-mcp`). `vault_fill` matched
  the configured name against that label, so after the merge it was neither offered nor able to call the server
  (caught by `run-tools-vault-fill.connector.test.ts`). Now the server is read from the tool's own id
  (`mcp__<slug>__<tool>`; `tools/catalog-sources.ts` `connectorToolServerKey`) or its label, and the folded catalog's
  search tool carries `route.catalogSources` (fork field in `adapter-kit/src/types.ts`, set in `lazyCatalogTools`), so
  the offer no longer depends on the catalog's description text. `VAULT_FILL_MCP_BROWSERS` keeps naming the slug.
  Tests: "knows the server by its slug when its source is labelled by display name" (direct, folded past the name
  budget, and a real fill), the connector test, `lazy-tool-catalog.test.ts` (one upstream expectation gained the field).
- **Known limits:** needs a server that can run a script in the page (origin + focused element); with `elementCheck: false`
  field types are not checked. Origin check and fill are separate server calls (a page that navigates between them is
  caught only if the ref goes stale). Fields in cross-origin frames and saved cards are not filled. The MCP server
  itself receives the value (it types it), so only list servers you trust with passwords.
- **Conflicts:** upstream edits to `askingLoginUse`/`prepareToolRequest`, `secretGuidance`, `selectBuiltinToolsForRun`
  options, `resolveLoginFill`'s return shape, the lazy catalog's `__catalog_execute` route (used to resolve the server's tools).

### 1.17 Per-agent skills (this release)
- **Purpose:** each agent can be limited to chosen skills. No selection = every skill of its space (upstream behaviour).
  A selection = only the chosen stored skills (user + plugin) plus every **built-in** skill the owner has not unticked
  (built-ins added later stay on until unticked). A bot that creates a skill with `skill_create` gets it added to its own
  selection. An unassigned skill is not in the prompt catalog, is not expanded from `/Name` or a routine's `@Name`, and
  `skill_read` refuses it by name or id ("not assigned to this agent"); `skill_update`/`skill_delete` cannot reach it.
  Spawned/duplicated bots start with no selection (all skills), unless `RAKAZO_NEW_BOT_SKILLS=builtins`: then EVERY new
  agent (web, API, `spawn_bot`, import, duplicate: all go through `createBot` in `db/src/bots/bot-repository.ts`) gets an
  empty selection at creation = built-in skills only; the owner adds skills as needed and the selection persists. Bee runs
  with `builtins` (owner's choice 2026-11-25). Existing agents are not touched. Env listed in all 3 compose files + stack
  compose; test `db/src/bots/new-bot-skills.postgres.test.ts` (unit + PG; fails on code without the hook).
- **Files (fork):** `packages/adapters/src/tools/bot-skill-access.ts` (`loadBotSkillSelection`, `filterSkillsForBot`,
  `botMaySeeSkill`, `addSkillToBotSelection`), `packages/contracts/src/skills/bot-skills.ts` (`botSkillsProcedures`),
  `apps/api/src/bots/bot-skills.ts` (`createBotSkillsService`), `apps/web/src/pages/shell/bots/bot-skills-section.tsx`
  (`BotSkillsSection`), `apps/web/src/components/integrations/skill-agents-line.tsx` (Skills window "Used by").
- **Seams:** `adapters/src/tools/skill-tools.ts` (`SkillOwner.botId`; filter in `listAgentSkillRecords` + `skillReadFromTool`;
  create checks names space-wide then adds to the selection), `runs/assembly/run-assembly-records.ts` (passes `botId`,
  loads `botSkillSelection`), `runs/assembly/run-assembly-context.ts` (non-owner chat runs: built-ins filtered too),
  `runs/assembly/run-routines.ts`, `runs/tools/run-tools-tasks.ts` (skill_* tools pass `botId`), `tasks/task-catalog.ts`,
  `adapters/src/index.ts`, `contracts/src/skills/skills-rpc.ts` (spreads `botSkillsProcedures` into `agentSkills`),
  `contracts/src/index.ts`, `apps/api/src/routes/memory.ts` (3 handlers), `apps/web/src/pages/shell/bots/bot-panel.tsx`
  (one section), `apps/web/src/pages/space/KnowledgeSection.tsx` (one line), `schema.prisma` (2 models + 3 back-relations),
  `db/src/database/row-security.ts` (`BotSkillSelection`, `BotSkill`).
- **API:** `agentSkills/forBot {botId}` -> `{botId, all, skillIds}`; `agentSkills/setForBot {botId, all, skillIds}`
  (bot owner only; ids must be skills of the bot's space, built-ins as `builtin:<name>`); `agentSkills/agents` -> per skill
  the agents that can use it.
- **Migration:** `20270115090000_bot_skills` (`bot_skill_selections` PK botId -> bots cascade; `bot_skills` (botId, skillId)
  -> selection cascade and agent_skills cascade; RLS by `spaceId` + system bypass). Deleting a chosen skill keeps the bot
  restricted (never widens to all).
- **Tests:** `adapters/src/tools/bot-skill-access.test.ts` (unit; fails on the pre-feature code),
  `apps/api/src/bots/bot-skills.postgres.test.ts` (RLS, prompt catalog, skill_read refusal, cascades, validation),
  `packages/testkit/src/product/authorization.test.ts` (inventory + cross-space), `row-security.postgres.test.ts` (table list).
- **Caveat:** a run assembled before a selection change keeps its old catalog for that run (skill_read checks live). `bots/create` starts an intro run at once, so in a test set the selection, then judge from the *next* run.
- **Live check:** two throwaway skills/bots; assign X to A only; A's `run.prompt_manifest`/answer lists X, B's does not;
  B's `skill_read X` returns the refusal. Markers in `post-sync-check.py`. Web: agent settings -> "Skills" section.
- **Mobile:** not changed (the mobile bot settings screen has no skills list; all-skills default applies).
- **Conflicts:** upstream edits to `skill-tools.ts` (catalog/read functions), the Promise.all in `run-assembly-records.ts`,
  `skills-rpc.ts` `agentSkills` object, `memory.ts` handlers, the `bot-panel.tsx` section list.

### 1.17a Agents assign skills to other agents (`bot_skills`, `spawn_bot` `skills`)
- **Purpose:** a bot that manages other bots attaches and removes their skills itself instead of telling the owner to
  tick them in settings. `bot_skills {action: list|add|remove|set, bot_id|bot_name, skills[], all, exact_builtins}`:
  `list` = the target's skills + every skill of the Space (name, 140-char description, `builtin`, `assigned`);
  `add`/`remove` take names (any case), ids or `builtin:<name>`; `set` replaces the stored skills (`all: true` = drop
  the selection = every Space skill; built-ins keep their state unless `exact_builtins: true`, which is the settings
  screen's exact-list behaviour). An unknown name changes nothing and the error names up to 3 close matches. `add` on
  an agent that has every skill is a no-op (never narrows it). `spawn_bot {skills: [...]}` stores the selection in the
  bot's creation transaction (`createBot`'s `seed`), i.e. before its first run row exists; a wrong name creates no bot.
- **Permission (decision):** `bot_skills` is a member of `FLEET_TOOL_NAMES`, so it gets upstream's bot-management rule
  unchanged: offered only when the bot's `fleetManagement` is on (default on) and the run is the owner's or unattended;
  checked live per call (`run-tool-request.ts`); refused for subagents; target resolved by `resolveBot` = an active
  bot of the run's Space. On top, the settings screen's rule: the target must belong to the run's member (upstream's
  fleet tools reach any member's bot in the Space; this one does not). Self is allowed (a manager is a bot of its
  Space). With the switch off a bot has no `bot_skills`, also not for bots it created; `spawn_bot`'s `skills` still
  works because `spawn_bot` is not behind the switch.
- **Approval:** none in an owner-started run (`action-approval.ts` approval-exempt list, like `organize_bot`; not a
  `isFleetApprovalTool`, so no card summary). Unattended runs (routine/webhook/bot_message/spawn/tickets) and runs that
  received outside text hold it for the owner like every fleet write. Result is own-state (does not taint the run).
- **Files (fork):** `packages/adapters/src/tools/bot-skill-assign.ts` (`readBotSkills`, `setBotSkills`,
  `writeBotSkillSelection`, `resolveSkillRefs`, `resolveNewBotSkills`, `botSkillsFromTool`); `apps/api/src/bots/bot-skills.ts`
  now calls `readBotSkills`/`setBotSkills` (one write path for UI and tool).
- **Seams:** `contracts/src/bots/builtin-tools.ts` (`FLEET_TOOL_NAMES` +1), `adapters/src/tools/fleet-tools.ts`
  (`isFleetApprovalTool` excludes it), `tools/builtin-fleet.tool-definition.ts` (definition; `spawn_bot.skills`; `spawn_bot`
  and `update_bot.bot_id` wording), `tools/builtin-tool-bridge.ts` (pinned; only bots with bot management are offered it)
  + test cap 49_100 (measured 49_047, +874; after the 1126 merge 49_140, measured 49_081), `runs/tools/run-tools-fleet.ts` (handler; `spawn_bot` resolves skills and
  passes `seed`), `bots/child-bots.ts` (`spawnBot` `seed` passthrough, 3 lines), `runtime/pi/tools/pi-runtime-tools.ts`
  (label, sequential, `spawn_bot.skills`), `pi-runtime-tool-parameters.ts` (`spawn_bot.skills`, `prepareFleetArguments`
  branch), `core/src/runs/action-approval.ts` (2 lists), `core/src/calls/speech-text.ts`, `runtime/scripted-runtime.ts`
  (test phrases), `adapters/src/index.ts`, prompt-surface snapshots (4 tool files).
- **Audit:** log line `bot_skills.changed {actorBotId, targetBotId, spaceId, runId, action, all, added, removed, total}`
  (counts only; `action: "spawn"` for `spawn_bot`), written only when something changed.
- **Tests:** `adapters/src/tools/bot-skill-assign.test.ts`, `apps/api/src/bots/bot-skill-assign.postgres.test.ts` (RLS:
  add/remove/set/list, other member, other Space, unknown name, spawn order), `testkit/src/product/journeys.test.ts`
  "skills of other bots" (3 journeys through the real gate and executor), `run-tool-request.test.ts`,
  `action-approval.test.ts`, `pi-runtime-tool-schema.test.ts`, `builtin-tool-bridge.test.ts`.
- **Web:** nothing new; agent settings -> Skills reads `agentSkills/forBot` on open, so a tool-made change shows after a
  reload (no live push to an already-open panel).
- **Live check:** ask a managing agent "attach skill X to <agent>": `bot_skills.changed` in the api/worker container logs,
  no approval card, the agent's settings -> Skills shows X ticked, its next run lists X.
- **Conflicts:** `FLEET_TOOL_NAMES`, the pinned list + byte cap (re-measure), `spawn_bot` definition/arguments, the two
  `action-approval.ts` lists, `spawnBot` input in `child-bots.ts`.

### 1.19 Skill curator: auto-learned skills, chat teaching, taught -> skill
- **Purpose:** Hermes-style procedural memory. After an owner-started chat run (`user`/`follow_up`) that was non-trivial
  (>= `SKILL_CURATOR_MIN_TOOL_CALLS` tool calls, default 6), or where the owner corrected HOW the work is done ("no, always
  …", "next time …", "from now on …"; tool steps in the bot's last replies count too), or asked ("make this a skill",
  "remember how to do this"), a background curator (same OmniRoute GLM as the memory ledger, max_tokens 8000) reads the
  owner's own messages, the run's tool outline (tool, redacted + bounded args, outcome) and the agent's skills, and proposes
  create {name, "Use when…", steps + pitfalls} / patch {full new body} / nothing. Server gates: quote gate on the owner's
  words (skipped only for explicit asks and lessons), secret filter, only user skills the agent can see, name clash refused,
  one open card per skill. Modes per agent + a Space default (default Ask): **Off** nothing; **Ask** a `learned_skill`
  card (Keep / Edit = inline SKILL.md editor / Discard; patches show a +/- summary); **Auto** saves and posts a notice with
  Undo, and may patch ONLY skills the curator learned itself (`learned_skills`); a skill the owner wrote always gets an Ask
  card. Kept/saved skills join the agent's own list when it has one (1.17) and show provenance (agent, date, patches) in
  the Skills window ("Open in Skills" on the card = `?skills&skill=<id>`).
  Procedure vs fact: the curator is shown standing orders + earlier ledger lessons/preferences and skips what they cover;
  when a skill is saved from a correction it retracts the SAME run's ledger lesson/preference fact with the same quote
  (`skill.curator.ledger_dedup`), after waiting (<= 45 s) for that run's ledger job.
  Chat teaching: "Let me teach you how to <task>" opens a lesson (`skill_teaching_sessions`; the prompt tells the agent to
  follow the steps and not to skill_create itself; a bar above the composer shows it); "save as skill"/"I'm done" or the
  bar's **Save as skill** turns the owner's messages since the start (+ the agent's replies and tool steps) into a draft
  card (reason `teach_done`); "cancel the lesson" / **Cancel lesson** closes it. Screen teaching: upstream refuses desktop
  hosts; the fork allows a desktop host that serves its screen (`teachingRefuses` = runsOnUserMachine && !userMachineServesScreen)
  in the API and shows "Teach a task" via `screenlessUserMachine`; a saved taught skill gets **Save as skill**
  (`skillLearning/fromTaught`, deterministic playbook -> SKILL.md, the taught one is kept).
  Prompt (only when SKILL_CURATOR=1): say a skill was saved only when skill_create/update succeeded this run or a
  `[skill curator: … - saved]` line says so; the card replays in history with its true status.
- **Commits:** `c2649a799` (feature), `953624a7b` (procedure-vs-fact prompt, model reason log), `3cea8bd73` (ledger facts of the stretch being read are not rules; lesson keep retracts the ledger copies; lesson bar layout). Deployed as `main-1124r` (2026-11-25).
- **Files (fork):** `packages/adapters/src/skill-curator/{config,triggers,outline,model,store,curator,seams,run-hooks,index}.ts`,
  `packages/contracts/src/skills/skill-learning.ts` (`skillLearningProcedures`, `LearnedSkillBlockSchema`),
  `apps/api/src/bots/skill-learning.ts` (`createSkillLearningService`), web `components/messages/LearnedSkillCard.tsx`,
  `pages/shell/bots/bot-learning-section.tsx` (`BotLearningSection`), `pages/shell/chat/teaching-bar.tsx` (`TeachingBar`).
- **Seams:** `runs/lifecycle/run-complete.ts` (`curateAfterRun(ctx)` after `learnAfterRun`), `runs/assembly/run-assembly-records.ts`
  (+1 Promise.all entry `skillLearningPromptState`), `runs/assembly/run-assembly-context.ts` (line joined to `agentSkillsLine`),
  `adapters/src/index.ts`, `contracts/src/threads/message-blocks.ts` (+`learned_skill` kind), `contracts/src/skills/skills-rpc.ts`
  (`skillLearning` group), `contracts/src/index.ts`, `core/src/messages/{attachments,message-quote}.ts`, `apps/api/src/routes/memory.ts`
  (7 handlers), `apps/api/src/bots/taught-skills.ts` (`teachingRefuses`), web `message-view.tsx` (one branch), `bot-panel.tsx`
  (one section), `Shell.tsx` + `chat/chat-column.tsx` (`lesson` prop), `KnowledgeSection.tsx` (`LearnedSkillLine`,
  `LinkedSkillOpener`), `components/integrations/skill-agents-line.tsx`, `components/teach/{SkillDraftCard,TeachComputerOverlay}.tsx`,
  `db/src/database/row-security.ts`, compose anchors.
- **API:** `skillLearning/settings {botId?}`, `setMode {botId?, mode|null}`, `decide {proposalId, decision, content?}`, `learned`,
  `teaching {botId, threadId}`, `teach {botId, threadId, action: start|save|cancel, task?}`, `fromTaught {taughtSkillId}`.
- **Env:** `SKILL_CURATOR=1` (off by default), optional `SKILL_CURATOR_MIN_TOOL_CALLS`, `SKILL_CURATOR_MODEL_URL`,
  `SKILL_CURATOR_MODEL`, `SKILL_CURATOR_MODEL_API_KEY` (default: the memory ledger's model settings).
- **Migration:** `20270120090000_skill_learning` (raw SQL, no Prisma models: `skill_learning_settings`, `skill_learning_jobs`,
  `skill_learning_proposals`, `learned_skills`, `skill_teaching_sessions`; RLS by `spaceId` + system bypass; cascades on
  space/bot; `learned_skills` cascades with its skill).
- **Fix 2026-11-27:** the curator's model call repeats on HTTP 429/5xx, timeout and network failure like the ledger's
  (`MEMORY_LEDGER_MODEL_RETRIES`, same helper, 5-minute budget; see 1.10).
- **Fix 2026-11-26:** the curator model's `max_tokens` is the ledger's `MEMORY_LEDGER_MODEL_MAX_TOKENS` (default 16000,
  was a fixed 8000) with the same one retry at twice the budget (see 1.10); log `skill.curator.model_retry`.
- **Logs:** `skill.curator.decided` (reason, mode, outcome, why, action, proposal, skill, ms), `skill.curator.decision`,
  `skill.curator.teaching_started|cancelled`, `skill.curator.model_unusable|model_failed`, `skill.curator.ledger_dedup`.
- **Tests:** `skill-curator/curator.test.ts` (triggers, gates, model I/O, outline redaction, prompt line, config),
  `skill-curator/curator.postgres.test.ts` (Ask -> Keep -> learned + agent list; Auto patch of its own skill + Undo; owner's
  skill -> Ask even in Auto; Off; lesson uniqueness; RLS; cascades), `apps/api/src/bots/skill-learning.postgres.test.ts`,
  `core/src/messages/learned-skill-history.test.ts`, authorization inventory (+7 procedures), `row-security.postgres.test.ts`.
- **Live check:** throwaway agent: multi-step task + "no, always X first" -> card -> Keep -> `learned_skills` row; a later
  task -> `skill_read` in logs; another correction -> patch card; lesson -> draft card; Auto -> saved without a card wait;
  Off -> nothing. Retract the throwaway agent's `memory_facts` after. All five passed on bee 2026-11-25 (stack RAKAZO.md),
  plus screen teaching on the desktop host (start -> snapshots -> stop -> save -> fromTaught).
- **Known limits:** GLM's judgement decides create vs none (`skill.curator.model_reason` says why); the curator sees only the
  owner's text + a tool outline, so steps can carry one-off names from the run; a taught playbook's goal text becomes
  "Use when <goal>" verbatim; the mobile app shows no card.
- **Conflicts:** `run-complete.ts` hook order, the `run-assembly-records.ts` Promise.all, `agentSkillsLine` in
  `run-assembly-context.ts`, upstream adding message block kinds (exhaustive switches in core), `taught-skills.ts` desktop gate.
- **Mobile:** not changed; the mobile app renders nothing for a `learned_skill` block (decide on the web).

### 1.20 Plan confirmation, superseding a request, known-workflow trust
- **Why:** 2026-11-25 Umar got only the second half of a spoken request (the voice agent dropped the held first
  half; fix under "Voice agent" below), delegated the wrong workflow to YouTube Specialist, and the owner's correction then
  queued 2 min 21 s behind the wrong run in the same lane.
- **Purpose:** (1) before an owner-started run hands work to another agent (`message_bot` intent request) or starts
  multi-step work, the agent calls `plan_propose`: a `plan` card (numbered steps, who does each, inputs) posted with
  the run's id, so a call speaks its short version; the run ends (nothing parks). The owner approves by **click**
  (`plans/decide` -> his message "Approved. Go ahead…" starts the run), by **voice** (the call agent hears
  yes/go ahead, calls `plans/decide {via: voice}` and sends his words) or by **text** (the run's assembly matches
  his message with `planReplyIntent`: approve / change / reject / other). Change (card **Change** = edit the steps,
  or "change step 2 to …") -> status `changes`, the prompt tells the agent to `plan_propose {revises}`; the
  revision replaces the card. The approved plan is bound to the run that carries it out (`executingRunId`), and only
  such a run may `message_bot` a request (`planGateForMessageBot`; refusal = `ok:false` + `PLAN_REQUIRED_NOTE`).
  **Changed by 1.22:** a live approved plan also covers later runs' requests to the agents it involves.
  (2) `message_bot {replaces: <request id | id prefix | "latest">}`: in the delivery transaction the earlier
  request of the SAME sender to the same recipient is cancelled (queued) or stopped (running; the run's 1 s lease
  watch aborts it, computer work torn down after commit, like threads/stop), its auto-return is suppressed
  (`botOutcomeReturnedAt`), and the correction is delivered with the preface "This replaces my earlier request
  <id8> (…), which I stopped…". Nothing holds it then (gate lane free, chat-wait sees a cancelled run). Every
  `message_bot` now returns `requestId`. (3) Known workflows: `plan_propose {workflow: <skill name>}`; a clean
  approval (revision 1, approved as proposed) adds 1 to `plan_trust(botId, workflow)`; a change/reject resets it;
  at `threshold` (default 3) under **Ask until trusted** the next proposal is `auto` (approved by `trust`, bound to
  the proposing run, card shown as a notice). Owner revokes per workflow (Skills window line or agent settings).
- **Commits:** `f05e734f0` (feature), docs/ops follow-up in the next commit. Deployed as `main-1124s` (2026-11-25); live (a)-(d) passed on bee (stack RAKAZO.md).
- **Settings:** per agent, agent settings -> **Plans** (next to Learning): Default (= Ask until trusted) / Always ask /
  Ask until trusted / Never ask, and the approvals threshold; trusted workflows listed with counters + Revoke.
  Skills window: under a skill, "<agent>: approved n of 3 times" / "runs it without asking" + Revoke.
- **Files (fork):** `packages/contracts/src/plans/plans.ts` (`planProcedures`, `PlanBlockSchema`, modes),
  `packages/adapters/src/plans/{intent,plans,index}.ts`, `packages/adapters/src/messaging/bot-supersede.ts`,
  `apps/api/src/bots/plans.ts` (`createPlansService`), web `components/messages/PlanCard.tsx`,
  `pages/shell/bots/bot-plans-section.tsx` (`BotPlansSection`).
- **Seams:** `runs/assembly/run-assembly-context.ts` (`planPromptState` + `planInstruction` joined to `agentSkillsLine`),
  `messaging/bot-messages.ts` (`replaces` input; supersede after the refusal checks, inside the tx; `requestId`),
  `runs/tools/run-tools-messaging.ts` (`plan_propose` handler; gate in `message_bot`), `tools/builtin-conversation.tool-definition.ts`
  (`plan_propose`), `tools/builtin-fleet.tool-definition.ts` (`replaces`), `tools/builtin-tool-bridge.ts` (pinned),
  `runtime/pi/tools/pi-runtime-tools.ts` (label), `contracts/src/bots/builtin-tools.ts`, `contracts/src/threads/message-blocks.ts`
  (+`plan`), `contracts/src/skills/skills-rpc.ts` (`plans` group), `contracts/src/index.ts`, `core/src/messages/{attachments,message-quote}.ts`
  (`planHistoryText`), `core/src/runs/action-approval.ts`, `apps/api/src/routes/threads.ts` (`plans` handlers use `send`),
  web `message-view.tsx`, `bot-panel.tsx`, `KnowledgeSection.tsx` + `skill-agents-line.tsx` (`SkillTrustLine`),
  `db/src/database/row-security.ts`, `adapters/src/index.ts`. `ops/post-sync-check.py` live queue test sets the sender bot to Never ask.
- **API:** `plans/settings {botId}`, `plans/setMode {botId, mode|null, threshold?}`, `plans/decide {planId, decision:
  approve|change|reject, text?, via?: click|voice}`, `plans/trust`, `plans/revokeTrust {botId, workflow}` (owner of the bot only).
- **Env:** none (per-agent setting; Never ask = old behaviour). **Migration:** `20270125090000_plan_confirm`
  (`agent_plans`, `plan_settings`, `plan_trust`; raw SQL, RLS by spaceId + system bypass, cascades with space/bot/thread).
- **Logs:** `plan.proposed`, `plan.decided` (decision, via, workflow, revision, run), `plan.gate_refused`,
  `bot_message.superseded` (replaced run, was_running, age, new run), `plan.trust_revoked`.
- **Voice agent (deployed copy + example):** `rakazo_client.text_from_blocks` speaks a pending/auto plan card's `spoken`
  line; `pending_plan_of(snapshot)`; `plans_decide`; `conversation.plan_reply_word`; `llm_node` reads the chat when the
  words look like a plan answer, so "yes" approves the plan instead of resuming a paused report or being a status turn.
  **Half-sentence fix:** `merge_held(..., resumed_at)` measures the 10 s window to when the caller started speaking
  again, not to the end of the rest (a 29 s continuation dropped "browse YouTube from my account … history … a video named").
- **Tests:** `plans/plans.test.ts` (intent, prompt, trust rule), `plans/plans.postgres.test.ts` (propose -> spoken change ->
  revision -> call-turn "yes" approves + binds -> gate refuses before/permits after -> supersede running request ->
  3 approvals -> 4th auto -> change resets -> Always/Never; RLS), `messaging/bot-supersede.postgres.test.ts` (FAILS on
  the pre-feature code: old run stays `running`), `builtin-tool-bridge.test.ts` (pinned + cap 47_320), prompt-surface
  snapshots, authorization inventory (+5). Agent: `tests/test_plan_voice.py` (the incident replay FAILS on the old agent:
  only the second half was sent).
- **Live check:** throwaway planner A + worker B: multi-step request -> card -> Approve click -> A messages B; "change step 2"
  -> revised card -> approve; long task to B then correction with replaces -> B's first run cancelled within seconds, new
  run started; workflow skill approved 3x -> 4th `auto` notice and delegation without asking. Retract test bots' facts.
- **Known limits:** the gate covers delegation only (multi-step work without delegation is asked of the model by prompt,
  not enforced); the owner cannot supersede a bot's request directly (only its sender; he can Stop in the recipient's
  chat); a typed reply is matched by words (a vague "ok but…" counts as change, a question leaves it pending); trust counts
  only plans that name the workflow; mobile renders no plan card (decide on the web or say it).
- **Conflicts:** `message_bot`/`bot-messages.ts` delivery transaction, the `agentSkillsLine` join in `run-assembly-context.ts`,
  `run-tools-messaging.ts` handlers, upstream message block kinds (exhaustive switches), pinned tool cap.

### 1.21 Cards that wait on the person are never hidden with their run (2026-11-26 audit, finding 1)
- **Why:** an agent that another agent had asked for work posted an approval card and said "approve the card in this
  chat"; the card was in the database and never reached the client. The server page filter for runs with trigger
  `bot_message` kept an explicit list (receipts, ask, text, chart, app, file, image, page) and dropped every other
  card (`mcp_approval`, `app_connect`, `computer`, `choice`, `tool_question`, `connect`, fork `plan`, `learned_skill`,
  `skill_draft`, `import_setup`), while the clients' fold already wanted them inline. Upstream has the same fault.
- **Purpose:** ONE rule in `@rakazo/core` (`messages/message-visibility.ts`): `NEEDS_PERSON_BY_KIND`, a record keyed by
  every `MessageBlock` kind (a new kind does not compile until it is classified), with `isNeedsPersonBlock`,
  `isOpenNeedsPersonBlock` (still pending), `isPeerRunVisibleBlock` (receipts + needs-person + reply content) and
  `NEEDS_PERSON_BLOCK_KINDS`. Every place that hides a run the person did not start uses it: `threads/get` and
  `threads/messages` (`withoutPeerRunMessages`), live events (`shouldForwardPeerThreadEvent`,
  `shouldForwardBackgroundThreadEvent`), the clients' `foldPeerReplies` (web + mobile), `isBackgroundInputBlock`
  (now the same rule), and `publishMessage` (background filter + unread default). No agent, server or card is named.
- **Unread + notification:** `defaultMarkUnread` (`runs/assembly/run-messages.ts`): a message from a `bot_message` run
  marks the chat unread when it carries such a card (text replies of delegated work still do not). New
  `runs/lifecycle/owner-card-notice.ts` `notifyOpenOwnerCards`, called from `completeRun`: a `bot_message` or
  background run that ends with a card still open sends one `help` notification ("<Agent> needs you", the card's
  name, never its contents) to the run's owner and logs `run.owner_card_waiting` (count, kinds). Ask, takeover and
  tool-question cards keep their own notifications (they pause the run; it is not complete while they are open).
- **Delegated run that posts a card:** unchanged on purpose: it ends, its reply goes back to the sender, the card now
  shows in the recipient's chat, that chat turns unread and the owner is notified.
- **Seams:** `apps/api/src/threads/thread-message-pages.ts` (two kind lists replaced by the core rule),
  `packages/adapters/src/runs/assembly/run-messages.ts`, `runs/lifecycle/run-complete.ts` (one call).
- **Env / migration:** none.
- **Tests:** `apps/api/src/threads/thread-message-pages.test.ts` ("returns a %s card a delegated run posted, and
  forwards it live": 7 kinds, all FAIL on the old code), `core/src/messages/message-visibility.test.ts` (a sample
  for every kind in the list, fold keeps each, settled cards no longer open), `runs/lifecycle/owner-card-notice.test.ts`.
- **Live check:** throwaway agents A and B; A asks B (message_bot) for something that makes B call `add_mcp_server`
  for a new endpoint: the approval card is in B's chat without a reload (`threads/get` returns the `mcp_approval`
  message), B's chat is unread, api log has `run.owner_card_waiting`. Marker `isNeedsPersonBlock`.
- **Not changed:** sidebar preview text (`bot-previews.ts`) still takes text from asks only: a card has no preview
  text; the unread dot is what shows. Mobile still has no renderer for `plan` / `learned_skill` cards (1.19, 1.20).
- **Conflicts:** upstream adding a message block kind (add it to `NEEDS_PERSON_BY_KIND`; tsc fails until then) or
  editing the two filters in `thread-message-pages.ts` (keep the core call, drop any re-grown kind list).

### 1.22 One approval covers the task: follow-ups, corrections, `replaces` of a finished request (audit finding 2)
- **Why:** an approved plan was bound to ONE run (`executingRunId`). The owner's next message in the same chat (a
  correction, "tell it to use the existing server") started a new run with no plan bound, `message_bot` was refused
  with `PLAN_REQUIRED_NOTE`, and the agent had to post a new card: 5 `plan.gate_refused` in 33 h, one card each.
  `message_bot {replaces}` also failed ("Not replaced: no open request…") once the recipient had finished.
- **Rule now (`planGateCheck` in `plans/plans.ts`; `planGateForMessageBot` returns its refusal note):** a request
  goes out under (1) the plan bound to this run, or an approved plan of the chat still unbound (as before, any
  agent); or (2) a plan of this chat approved less than `PLAN_LIVE_MS` (6 h, counted from the approval) ago that
  **involves the recipient** (`planInvolves`): a step names the agent as who does it, or a request already went to
  that agent under the plan. (2) holds for later owner-started runs, so corrections and follow-ups need no card.
  An agent the plan does not involve still needs a plan, with or without `replaces`. Nothing is covered while a
  NEWER plan of the chat waits for the owner's answer (pending / changes).
- **Always ask stays strict (decision):** its documented meaning is "every hand-off waits for a plan card". Under
  Always ask only a correction (`replaces`) of a request to an involved agent is covered; a plain follow-up needs a
  new plan. Ask until trusted (the default for every agent) gets the full follow-up cover. Never ask: no gate.
- **What a plan covers is recorded:** `agent_plans.recipients` (JSON array of agent ids), written by
  `recordPlanRecipient` after every request `message_bot` sends under a plan (`store.addRecipient`, once per agent).
- **`replaces` of a finished request:** `findReplaceableRequest` looks at open requests, then at ended ones of the
  same sender. Ended (or it ends between lookup and cancel, or `latest` with nothing earlier): the correction is
  delivered as a NEW request with the preface "This corrects my earlier request <id8> (…), which you already
  finished…", the result carries `earlierRequestFinished: true` and says so in `note`. A named id that matches
  nothing is still an error, and another sender's request can still not be replaced.
- **Prompt:** `planInstruction` says an approved plan covers the whole task for the agents it involves; a later run
  gets "Plan <id> … is approved and still covers this task for: <agents>… do not propose a new plan for that"
  (`PlanPromptState.covering`, from `withCoveringPlan`). `PLAN_REQUIRED_NOTE` reworded. `message_bot.replaces`
  description +55 bytes (pinned-tool cap 48_230 still holds: 48_228).
- **Seams:** `runs/tools/run-tools-messaging.ts` (gate gets the recipient; records it after the send),
  `messaging/bot-messages.ts` (finished branch, result fields), `messaging/bot-supersede.ts`,
  `tools/builtin-fleet.tool-definition.ts`, prompt-surface snapshots (4 tool files: only the `message_bot` schema hash and byte totals).
- **Migration:** `20270126090000_plan_coverage` (`ALTER TABLE agent_plans ADD COLUMN IF NOT EXISTS recipients JSONB
  NOT NULL DEFAULT '[]'`; no new table, the RLS of `agent_plans` applies; rollback = previous image, column ignored).
- **Logs:** `plan.gate_covered` (plan, basis follow_up|correction, recipient), `plan.gate_refused` (+ latest status,
  replaces), `bot_message.correction_after_finished`.
- **Tests:** `plans/plans.postgres.test.ts` second case (approve -> send -> new owner run -> follow-up to the same
  agent allowed; an agent that only received a request is covered; an uninvolved agent refused with and without
  replaces; replaces of a finished request by `latest` and by id delivers; foreign request refused; newer pending
  plan blocks; rejected newer plan does not; Always ask strict; cover ends after 6 h). On the old code the follow-up
  assertion fails with the old refusal note. `plans/plans.test.ts` (`planInvolves`, prompt lines).
- **Live check:** planner A (Ask until trusted) + workers B and C: plan naming B -> Approve -> A messages B; then
  type a correction: A sends it to B with no new card (`plan.gate_covered` in the api log); ask A to hand the same
  thing to C: refused, new card. After B finished: "also do X" -> delivered, result says the earlier one had finished.
- **Known limits:** plans approved before this deploy have no recorded recipients (covered only through the agent
  names in their steps) for their remaining 6 h; "follow-up" is not judged by content: any request to an involved
  agent within 6 h of the approval goes out; the executing run may still message any agent (unchanged).
- **Conflicts:** as 1.20 (`message_bot` delivery transaction, `run-tools-messaging.ts`), pinned tool byte cap.

### 1.23 An approved MCP server is reused, not approved again (`MCP_REUSE_APPROVED_SERVERS`) (audit finding 3)
- **Why:** MCP access is per agent (`bot_mcp_servers`) unless `allBots`, and `add_mcp_server` always registered a NEW
  `mcp_servers` row plus a pending card, even for an endpoint the same owner had already approved in the Space. A
  second agent needed a second approval, and agents registered duplicates under new names. A `spawn_bot` child got
  none of its creator's servers.
- **Purpose:** (1) `add_mcp_server` (`addMcpServerFromTool`): when the endpoint, normalised (`normalizeMcpEndpoint`:
  scheme, host, port, path, sorted query; no fragment, no trailing slash), matches a server that is available in this
  Space, owned by the run's owner, enabled, not stdio, and approved (`allBots`, or at least one `bot_mcp_servers` row
  of this owner in this Space), the EXISTING server is assigned to the calling agent (`allowAllTools`, as an approval
  card grants; an existing assignment is left as it is) and the result is `{ok: true, reused: true, server_id, name,
  next_step}`. No server row, no card, no credential stored (a secret or headers passed with the call are ignored).
  (2) `spawn_bot` from a run the owner started (`ctx.source.ownerStartedRun`): the new agent gets the creator's
  assignments to enabled remote servers with the same tool limits (`copyApprovedMcpAssignments`), before its first
  run is queued. The UI's Duplicate already copies assignments; this follows it.
- **Security boundary (documented in `mcp/mcp-server-reuse.ts`):** same owner AND same Space only
  (`availableInSpace` of the run, the rule every MCP read uses); only enabled, already-approved servers (one still
  waiting on its card is not reused); never stdio (reuse and inheritance both skip local servers); never another
  owner's server; the approved server's own credential is used and cannot be read or replaced by the call.
  **What changes for the owner:** approval is per endpoint for his agents in a Space, no longer per agent.
- **Same run or next run:** the connector reads assignments from the database on every catalog call, so a run that
  already has the MCP catalog tools (`connectors_search_tools` / `connectors_execute_tool`, i.e. the agent had more
  than 20 MCP tools at assembly) can use the reused server at once, and `next_step` names those tools. A run without
  them has a fixed tool list: `next_step` says the tools arrive on the agent's next turn. Not changed: no
  continuation run is queued (the approval path's `queueMcpConnectedRun` lives in the API).
- **Env:** `MCP_REUSE_APPROVED_SERVERS` (api + worker; default ON, unset = on; `0` / `false` / `off` restores
  upstream behaviour for both parts). Listed in the three fork compose anchors.
- **Files (fork):** `packages/adapters/src/mcp/mcp-server-reuse.ts`. **Seams:** `mcp/mcp-server-tool.ts` (one call
  before the credential is stored, one optional parameter), `runs/tools/run-tools-integrations.ts` (passes the
  catalog tool names when the run has them), `bots/child-bots.ts` (`inheritMcpServers`), `runs/tools/run-tools-fleet.ts`,
  `infra/compose/docker-compose{,.prod,.images}.yml`.
- **Migration:** none. **Logs:** `mcp.server_reused` (server, newly_assigned, all_bots), `mcp.assignments_inherited`.
- **Tests:** `mcp/mcp-server-reuse.postgres.test.ts` (reuse with a differently spelled endpoint and a call-supplied
  secret: one server, no card, nothing stored; narrowed assignment untouched; other Space, other owner, pending
  server, disabled server: not reused; `allBots` needs no row; env `0` -> new server + card; spawn inherits remote
  assignments with limits, not stdio, not from a run the owner did not start, not with the env off). FAILS on the
  old code at the first reuse assertion. `mcp/mcp-server-reuse.test.ts` (env switch, endpoint normalising).
- **Live check:** agent A has an approved remote server. Tell agent B to add the same URL: result `reused: true`, no
  card, `select count(*) from mcp_servers` unchanged, a `bot_mcp_servers` row for B, api log `mcp.server_reused`;
  B uses a tool of it on its next turn. `spawn_bot` from A in an owner chat: child has the row(s).
- **Known limits:** a second ACCOUNT on the same endpoint cannot be added by an agent while reuse is on (the call's
  secret is ignored): add it in Settings, or set the env to `0`. An endpoint whose first server still waits on its
  card is not reused (a second request for it still registers its own). A child created by a delegated
  (`bot_message`) run inherits nothing.
- **Organization servers (upstream #6827):** never reused or assigned by this feature; see 1.29 for the rule.
- **Conflicts:** upstream edits to `addMcpServerFromTool` (keep the reuse call before `secretStore.put`) and to
  `spawnBot`'s input; `availableInSpace` semantics.

### 1.24 One large file no longer blocks every checkpoint of a host computer (audit finding 6)
- **Why:** `computer.checkpoint_deferred` 55 times in 33 h with `SandboxFileTooLargeError` ("computer file exceeds
  8388608 bytes"). A home on a host ("desktop") computer is saved through the host protocol; its export
  (`walkDesktopWorkspace` with the runner's `maxFileBytes`) threw at the first file over 8 MiB, so the WHOLE home was
  not saved, at every checkpoint, for as long as one such file (a video, a yt-dlp json) existed.
- **The cap stays:** 8 MiB (`HOST_COMPUTER_MAX_FILE_BYTES`) is a transport limit of the host protocol only (one file
  = one base64 JSON frame, frames capped at 12 MiB). Docker and other providers stream large files and are untouched.
- **Purpose:** the export skips files over the cap and saves the rest. Request field `exportWorkspace
  {skipLargeFiles: true}` (`host-computer-protocol.ts`); the runner (`host-computer-runner.ts`) walks with
  `DesktopSandboxProvider.exportWorkspaceSkippingLarge` (size from `stat`, the file is never read) and ends with one
  frame `{skippedLarge: {count, bytes, paths}}`; the client (`host-computer-sandbox.ts`) logs
  `computer.checkpoint_skipped_large` (`files.skipped`, `files.skipped_bytes`, `file.max_bytes`, computer id;
  no paths, no contents; once per computer per state, repeated after 6 h or when the numbers change:
  `host-export-skipped.ts`) and hands each path to the save as an `omitted` entry. The save
  (`checkpointComputerWorkspace`) keeps its EARLIER saved version of such a file when it has one
  (`workspace-large-files.ts` `keepSavedVersion`): a file that grew past the cap is not dropped from the saved copy,
  which is what upstream's failing save protected.
- **Version skew is safe both ways:** an app with the flag talking to a host bundle without it: the old host drops
  the unknown field and fails the export as before (still deferred, nothing lost). A host with the fix talking to an
  older app: no flag, old behaviour. **Deploy: rebuild the stack's `host-computer` bundle and restart
  `bee-rakazo-host-computer` after the app image, or the skip does not take effect.**
- **What is not saved:** the skipped files themselves. They stay on the host computer's disk only; the saved copy
  (used if the computer is ever replaced or moved to another kind) holds their last version from before they
  grew, or nothing if they were always large. The warn log is the signal.
- **Files (fork):** `computers/workspace-large-files.ts`, `computers/host/host-export-skipped.ts`. **Seams:**
  `providers/computer/desktop/desktop-sandbox.ts` (`walkDesktopWorkspace` optional `skipped`, one new method),
  `computers/host/{host-computer-protocol,host-computer-runner,host-computer-sandbox}.ts`,
  `computers/computer-workspace.ts` (one branch in the export loop).
- **Env / migration:** none.
- **Tests:** `computers/host/host-computer.test.ts` (real server + client: export goes past the large file;
  without the flag the old refusal; trailer frame has count, bytes, paths; **upstream's test "preserves the saved
  workspace when a native file grows…" is rewritten**: the save now succeeds, the grown file keeps its saved version,
  small files beside a never-saved large one are saved; both FAIL on the old code), `host-export-skipped.test.ts`
  (one warn, no repeat, protocol parse), `workspace-large-files.test.ts` (kept version, link and outside path refused).
- **Live check:** after the host bundle is rebuilt: `docker logs rakazo-worker-1 rakazo-api-1 | grep -c
  computer.checkpoint_deferred` stops growing for `SandboxFileTooLargeError`; one `computer.checkpoint_skipped_large`
  line with the count; `computers."homeRevision"` (or the saved home's mtime) advances after a run that wrote files.
- **Conflicts:** upstream edits to `walkDesktopWorkspace`, the `exportWorkspace` case of the runner, the request union
  in `host-computer-protocol.ts`, and the rewritten upstream test.

### 1.25 Plan mode Notify and the deployment default `PLAN_DEFAULT_MODE`
- **Why (owner, 2026-11-26):** "the system should be proactive; now everything asks for permission despite the obvious
  decision… I don't want to babysit agents, they are my co-workers." Plan cards were one of the two prompts left.
- **Purpose:** a fourth plan mode, `notify` (beside always / until_trusted / never). The agent still calls
  `plan_propose` and the card is still posted (and its short version spoken on a call), but as a NOTICE: status `auto`,
  `decidedVia: "notify"`, bound to the proposing run (`executingRunId`), which carries on in the same turn and may
  `message_bot` at once. No question, no waiting. A revision (`revises`) is a notice too. The owner corrects
  afterwards: `message_bot {replaces}` and the 1.22 cover apply unchanged. **Trust counters do not move** (a notice is
  not his approval; `plan_trust` is only written by `applyPlanDecision`). Before the plan is posted a hand-off is
  still held, with `PLAN_NOTICE_FIRST_NOTE` ("post the plan first… then send this again in the same turn").
- **Deployment default:** env `PLAN_DEFAULT_MODE` (always | until_trusted | notify | never; unset, empty or unknown =
  until_trusted as before), read by literal name in `planDefaultMode`; `effectivePlanMode(mode)` = the agent's own
  setting, else that default. A per-agent setting always wins. Listed in the three fork compose anchors.
- **Prompt:** `planInstruction` in notify mode: "Plans (notify, no approval needed): … approved at once: carry it out
  in the same turn… Do NOT ask whether to go ahead, do not wait… do not end your turn for approval". The
  `plan_propose` tool description no longer says "end your turn with one short question" (it now says the result
  tells which); the tool result in notify mode says "Carry it out NOW in this same turn". Progress label "Writing
  the plan". `spokenNotice` turns the spoken line into a statement ending "I am starting now." (a closing question
  the agent wrote is dropped).
- **Web:** agent settings -> Plans: option "Notify (show the plan, do not wait)" + one-line explanation; "Default
  (…)" names the deployment default (`PlanSettings.defaultMode`). `PlanCard`: a notify plan renders like the
  trusted-workflow notice ("Running: …", no buttons, "For your information: started without waiting…").
- **Voice agent:** no change needed, example and deployed copy alike. `pending_plan_of` keys on `status == "pending"`
  only, so a notify plan (`auto`) is never treated as waiting; `text_from_blocks` already speaks `auto` plans from
  their `spoken` line, which is now a statement.
- **Seams:** `contracts/src/plans/plans.ts` (enum, `decidedVia`, `defaultMode`), `adapters/src/plans/plans.ts`,
  `apps/api/src/bots/plans.ts`, `tools/builtin-conversation.tool-definition.ts`, `runtime/pi/tools/pi-runtime-tools.ts`
  (label), web `bot-plans-section.tsx`, `PlanCard.tsx`, compose anchors, 4 prompt-surface tool snapshots (-21 bytes).
- **Migration:** `20270127090000_plan_notify` (widens two CHECK constraints: `plan_settings.mode` and
  `agent_plans.decidedVia` accept `notify`; no table or column change). Rollback = previous image: it reads an
  unknown mode as "no setting".
- **Logs:** `plan.proposed` carries `plan.via` (trust | notify), `plan.gate_refused` carries `plan.mode`.
- **Tests:** `plans/plans.postgres.test.ts` third case (env default -> propose -> `auto`/`notify`, bound, card a
  notice with a statement, gate allows at once, trust unchanged, correction covered, revision a notice, per-agent
  override both ways, unset = until_trusted). FAILS on the old code (`expected 'until_trusted' to be 'notify'`).
  `plans/plans.test.ts` (env parsing, override, prompt wording, spoken notice).
- **Live check:** set a throwaway agent to Notify (`plans/setMode {botId, mode: "notify"}`), ask it to hand work to
  another agent: card shows "Running: …" with no buttons, the other agent's run starts in the same turn
  (`plan.proposed` with `plan.via: notify`), nothing waits. To make it the default for every agent without a setting:
  `.env PLAN_DEFAULT_MODE=notify` (+ the line in the stack's compose file).
- **Known limits:** mobile draws no plan card (unchanged). An agent whose mode was set explicitly (e.g. Ask until
  trusted) keeps it; the env only reaches agents on "Default". Not judged: whether a plan is wise.
- **Conflicts:** as 1.20 / 1.22.

### 1.26 An MCP server the owner asked for himself is connected without a question (`MCP_OWNER_REQUEST_AUTO_APPROVE`)
- **Why:** same owner requirement as 1.25. `add_mcp_server` posted a pending approval card even when the owner had
  just typed "add this server" in the chat: an obvious decision asked twice.
- **Rule (`mcp/mcp-owner-request.ts`, `ownerRequestVerdict`):** with the env on, the new server is assigned to the
  calling agent in the same transaction (`bot_mcp_servers`, all tools) and its card is posted already `connected` (a
  notice, not a question) when ALL hold: the run is owner-started (`ctx.source.ownerStartedRun`) with the owner
  present (trigger `user`, `follow_up` or `call_end`); it is not a messaging-channel run; no outside content has
  entered the run (`ctx.trust.receivedOutsideMessage()` false, the check standing_set and the other owner-only tools
  use; a failed lookup counts as tainted); the server needs no OAuth step (`needsOAuthProbe` false, i.e. the call
  carries a static credential); `assign_to_self` is not false. Result `{ok, connected: true, server_id, next_step}`;
  `next_step` says it is connected and whether its tools are usable now (run has the `connectors_*` catalog tools)
  or from the next turn. Everything else keeps the pending card: another agent's request, a new agent's first task,
  a routine, a webhook, a chat-app message, a tainted run, a server with no static credential.
- **Env:** `MCP_OWNER_REQUEST_AUTO_APPROVE` (api + worker; default OFF = upstream behaviour; `1` / `true` / `on`
  turns it on), literal-name read, in the three fork compose anchors.
- **Log:** `mcp.server.auto_approved` (`run.id`, `bot.id`, `mcp.server_id`, `mcp.reason`: `owner_request` | `reused`;
  the 1.23 reuse path logs it too). No names, endpoints or secrets.
- **Files (fork):** `mcp/mcp-owner-request.ts`. **Seams:** `mcp/mcp-server-tool.ts` (verdict, assignment + card status
  inside the existing transaction, result), `mcp/mcp-server-reuse.ts` (log), `runs/tools/run-tools-integrations.ts`
  (passes the run's facts), compose anchors. **Migration:** none.
- **Tests:** `mcp/mcp-owner-request.test.ts` (every branch of the rule; taint looked up last; unknown = tainted),
  `mcp/mcp-owner-request.postgres.test.ts` (owner request -> assignment + connected card + log without the secret;
  bot_message, routine, webhook, messaging channel, tainted, no credential, no facts, env off -> pending card and no
  assignment; `assign_to_self: false` -> neither). FAILS on the old code (`expected { ok: true, … } to match
  { ok: true, connected: true }`).
- **Live check:** `.env MCP_OWNER_REQUEST_AUTO_APPROVE=1` (+ the line in the stack compose file). In an agent's own
  chat: "add the MCP server <url> with this token": the card shows connected, no Approve button, api log
  `mcp.server.auto_approved` with `owner_request`. The same request relayed through another agent: pending card.
- **Known limits:** a server with no static credential always keeps the card, because without probing it the code
  cannot tell "needs OAuth" from "needs nothing"; the agent's run does not get the new tools mid-turn unless it
  already has the catalog tools (no continuation run is queued, unlike a card click); the rule trusts the model's
  reading of the owner's words (he asked for *a* server; the URL the agent passes is the agent's).
- **Conflicts:** upstream edits to `addMcpServerFromTool`'s transaction or to `isOwnerStartedRun` / `RunTrust`.

### 1.27 An open tab moves onto a new deploy by itself (`WEB_AUTO_RELOAD`)
- **Commit:** `a56d18695`.
- **Why:** after every deploy the owner had to be told to reload his open tabs. Upstream already has the handshake
  (`x-rakazo-build` on every API reply, `/build-id` on the web server, `lib/platform/client-update.ts`), but it learns
  the new build only from API replies and reloads only a tab that is hidden, navigating, or five minutes idle with
  no draft anywhere; a tab the owner comes back to stayed on old code, with nothing on screen saying so.
- **What the fork adds (`client-update-fork.ts`, pure rule `decideClientUpdate`):** the tab reads `/build-id` when it
  becomes visible or its window gets focus (not more often than 5 s), every 5 min, and (30 s apart) after an API reply
  that names a newer build or is a 400/404 (a likely contract mismatch). When the web server serves a newer build:
  an idle, safe tab that just became visible/focused reloads at once; a tab that cannot reload shows a toast
  "New version available / Reload" (takes no focus, blocks nothing) and reloads by itself about 3-6 s after the
  thing in the way ended; a visible tab in use with nothing at stake shows the toast and reloads on its next
  navigation (upstream's rule). **Never automatic** while: a call is ringing/connecting/live, any `textarea` or
  editable element on the page holds text, a send is in flight or attachments are picked, dictation is
  recording/transcribing, a dialog is open, or this person controls a computer's screen (`holdReload()`). These rules
  also bind upstream's own hidden/navigation/idle reloads (`forkAllows` in `safe()`); upstream's "refused build"
  (HTTP 426) path is untouched. Every reload still goes through upstream's guarded path (web server must serve the
  newer build, one attempt per build pair, one automatic reload per 30 s, never offline), so no loop is possible.
- **Service worker:** unchanged. Navigations always go to the network and `/build-id` is not precached, so a reload
  under the old worker gets the new `index.html` and its new hashed assets; the new worker takes over on the next
  navigation of the last open window (upstream's `SKIP_WAITING` pattern).
- **Env:** `WEB_AUTO_RELOAD` (web server only; default on; `0` = open tabs only show the toast, never reload
  themselves). Read by literal name in `apps/web/server/preview-middleware.ts`; sent to tabs as the response header
  `x-rakazo-auto-reload: 0` on `/build-id`, which every tab reads before any automatic reload, so the switch works
  on tabs already open and needs no rebuild. In the `web` service of `docker-compose.yml`, `.prod.yml`, `.images.yml`,
  `.standalone.yml` (the web container has its own short list, not the `x-app-environment` anchor). No new route, no
  CSP change (`/build-id` is same-origin).
- **Files (fork):** `apps/web/src/lib/platform/{client-update-fork,client-update-fork-wiring,auto-reload-header}.ts`,
  `apps/web/server/auto-reload.ts`. **Seams:** `client-update.ts` (moments `visible`/`released`, `forkAllows` in
  `safe()`, `attempt()`, `installFork`, `servedBuild` through the fork), `server/preview-middleware.ts` (setting +
  one middleware), `pages/shell/computers/use-computer-controls.tsx` (one `holdReload` effect),
  `server/screen-proxy-token.test.ts` (settings literal), 4 compose files. **Migration:** none.
- **Tests:** `client-update-fork.test.ts` (rule table; the fork tracker linked to upstream's real tracker: same build
  -> nothing; idle + visible/focus -> reload; typed text -> toast, no reload on navigation, reload after it clears;
  live call -> toast only through every moment, reload after it ends; failed check -> nothing; API ahead of web
  server -> waits; 404 -> check; no API traffic -> background check; switch off -> toast only, also when upstream's
  check is the one that reads it; no build id -> off), `server/auto-reload.test.ts` (header on `/build-id` only when
  off), `infra/updater/src/compose-web-env.fork.test.ts` (literal read + 4 compose files).
- **Not on mobile or desktop:** the desktop app bundles its renderer (a reload cannot change it; the fork tracker is
  off when `window.rakazoDesktop` is set; it updates through the app's own updater). The mobile app downloads an
  over-the-air update when it returns to the foreground and runs it on the next launch (`apps/mobile/lib/api/client-update.ts`).
- **Rollback (owner decision 2026-11-27, `fix/leftovers-1126`):** an OLDER served build moves the tab too. In the
  fork path only: `/build-id` naming an older build than the bundle counts as an update once two answers in a row,
  at least 30 s apart (`FORK_STABLE_MS`), named that same build; any other answer in between starts over, so the
  mixed answers of a rolling restart never send a tab back. After the first sighting the tab asks again every 35 s
  (`FORK_CONFIRM_MS`); an API reply naming any other build (not only a newer one) also prompts a check. Then the
  same rules as above (same toast, never during a call / typed text / dialog / screen control, `WEB_AUTO_RELOAD=0`
  = toast only; reload when hidden, on becoming visible, or after the thing in the way ended). Loop guard: the reload
  goes through `attemptRollback` (fork method in `client-update.ts`; re-reads `/build-id`, must still be the
  confirmed older build) and `claimRollbackReload` (session storage `rk:client-update-rollbacks`): once per target
  build for the life of the tab, at most 3 per hour, none without session storage; the shared recovery guard (one
  automatic reload per 30 s, never offline) applies as before, and a reload it refuses is not counted. A newer
  build still needs no second sighting, and upstream's own paths (`noteServerBuild`, `tryAt`, the 426 path, its
  `attempted` pair) are untouched: they only know "newer". A visible tab in use shows the toast and reloads when
  hidden (upstream's navigation reload is not extended to rollbacks). Tests: `client-update-fork.test.ts` "a rollback
  moves an open tab too" (10) and "the rollback reload guard" (3); 12 of them fail on the previous code.
- **Known limits:** a rollback is followed only by tabs whose bundle has this code (from image `main-1126d` on). A `textarea` that shows saved text (an instructions editor left open)
  counts as typed text, so that tab shows the toast instead of reloading. A draft saved in another chat (local
  storage, it survives a reload) does not block a hidden or navigating reload, as upstream; it still blocks upstream's idle reload.
- **Live check:** see `FIX-1126-reload-askfirst.md` in the stack repo (open a tab, deploy, come back to it).
- **Conflicts:** upstream edits to `client-update.ts` (`safe()`, `clientUpdates()` factory, `install()`), to the
  web server's settings object, or a new upstream "update available" UI (then drop the fork toast, keep the rules).

### 1.28 "Ask first" on a saved item holds in Never ask; a login named loosely is the saved login it means
- **Commit:** `d04c12a04`.
- **Why (live test 2026-11-26, vault retest c + b):** on an account in Never ask, a login set to Ask first was typed
  with no card: `planActionGate` returned `allow` for mode `never` before the mandatory check, for `browser_act` and
  `vault_fill` alike (upstream's own docs say the card shows "also in Never ask"; its gate test said the opposite).
  And a fill that named a login by its title got "Login is unavailable", which hid that only the name was wrong.
- **Rule 1 (`core/src/runs/action-approval.ts`, `itemAsksFirst`):** a call that uses a saved item whose owner set the
  item itself to Ask first asks in every approval mode. `ToolRequest.itemAsksFirst` is set by the prepare step for a
  login that asks first (`browser_act` fill_secret/fill_code, `vault_fill`) and for a saved card whose row still
  carries `policy: "ask"`. Nothing else about Never ask changes: a login or card without that setting, purchases,
  ask rules and new sites run as before; a block rule still refuses; a call outside text could have steered is still
  refused before any card. Unattended runs (routine, webhook, another agent, ticket) keep the existing behaviour:
  the card is posted and expires unanswered after `UNATTENDED_APPROVAL_EXPIRE_AFTER_MS` (default 30 min); nothing is typed.
- **Rule 2 (`secrets/vault/vault-login-names.ts`):** before the approval and the fill, `withSavedLoginNames` replaces
  a login name that is not an exact saved name (or this run's unsaved login) with the one usable login whose name or
  title matches without case, spacing or punctuation; none or several: unchanged. The refusal then lists names (and
  titles) only, never a value: the logins saved for the page's site, else every usable login (20 at most), or says
  that several match. A login the bot may not use is neither matched nor listed. Old text kept when nothing is saved.
- **Env:** none. **Migration:** none. **Prompt surface:** unchanged (no tool text changed).
- **Files (fork):** `secrets/vault/vault-login-names.ts`. **Seams:** `core/src/runs/action-approval.ts`
  (`planActionGate`), `runs/tools/run-tool-gate.ts` (one argument), `runs/tools/run-tool-request.ts` (flag in three
  places, `withSavedLoginNames` call), `secrets/vault/vault-login-fill.ts` (the refusal), `docs/approvals.md`.
- **Tests:** `runs/tools/vault-item-ask-first.fork.test.ts` (real vault + prepare + gate: Never/Ask/Auto x
  browser_act/vault_fill; plain login and plain card unchanged in Never ask; card set to Ask first; unattended
  triggers; title/case), `core/src/runs/action-approval.test.ts` (2 cases), `run-tool-gate.test.ts` (upstream's
  "runs it without asking in Never ask" now expects the ask), `run-tools-vault-fill.test.ts` (flag; approved replay
  fills; by title, case, spacing, default host title; two matches; unknown name lists the site's names; no value in
  any message; blocked login), `secrets/vault/vault-login-names.postgres.test.ts` (the lookups on the real schema
  under a tenant; runs with `VERIFY_DATABASE=1 DATABASE_URL=...`, it is not in the integration harness list).
  4 + 12 of them fail on the old code.
- **Not covered by a test:** the card's Allow/Deny round trip under Never ask with a database (from the gate on it
  is the same code Ask and Auto use).
- **Conflicts:** upstream edits to `planActionGate`'s `never` line or to the login/card block of
  `prepareToolRequest`; upstream restoring its own Never-ask test.

### 1.29 Organization MCP servers: the reply no longer fails; one unreadable row never takes the list (UPSTREAM BUG, local patch)
- **Status: upstream bug carried as a local patch. Drop the `mcp-servers.ts` hunk at the next sync if upstream
  fixed it** (check: `git diff <merge-base> upstream/main -- apps/api/src/integrations/mcp-servers.ts
  packages/contracts/src/account/space-availability.ts packages/db/src/spaces/availability.ts`, then run
  `--spec=mcp-organization-servers.fork` on pure upstream: its first case must pass there). The list guard and the
  reuse rule below are fork features and stay.
- **Defect (found 2026-11-26 on `main-1126b`, same on pure upstream `50de80b1f`, still there at `6d816462a`):**
  upstream #6827 (`20270102120000_organization_mcp_servers`) lets an organization own a server: the row has
  `organizationId` and NULL `userId` / `spaceId`. `mcpServerDto` (upstream `apps/api/src/integrations/mcp-servers.ts:107`
  at `50de80b1f`) always sent `availability: spaceAvailability(row)`; for such a row `spaceAvailability`
  (`packages/db/src/spaces/availability.ts:29-42`) returns `spaceIds: []`, and the reply schema
  `SpaceAvailabilitySchema` (`packages/contracts/src/account/space-availability.ts:7`) demands `.min(1)`. So
  `mcp/servers/createForOrganization` stored the row and answered `500 Output validation failed`
  (`availability.spaceIds: Too small`), and from then on `mcp/servers/list` (and `update`, `test`, `agents` on that
  server) answered 500 for every member of the organization: Settings showed no MCP server at all. Upstream's tests
  never send a real organization row through the reply schema (the web e2e relabels an own server). No fork code is
  involved: the fork does not touch these three files.
- **Patch (minimal):** `mcpServerDto` sends `availability` only when the row is in at least one Space. The field is
  optional in `McpServerSchema`; web and mobile hide the Space control for an organization's server and read
  `availability` as optional. `spaceId` keeps upstream's "reads as in the viewer's Space".
- **Fork rule on top: `mcp/servers/list` never fails because one row is unreadable.**
  `integrations/mcp-server-list-fork.ts` (`readableMcpServers`): each row is turned into its reply and checked
  against `McpServerSchema` on its own; a row that fails (or whose secret summary throws) is left out and logged as
  `mcp.server_unreadable` (`mcp.server_id`, `mcp.reason`: `reply_schema` | `read_failed`, `mcp.fields`: field paths
  only, never a value). Seam: one call in the `list` handler of `apps/api/src/routes/mcp.ts`.
- **Reuse / inheritance (1.23) and organization servers, decided:** an organization's server is usable by every
  non-guest member's agents through upstream's own rule (`allBots` + `mcpServerIn`); the fork grants nothing on it.
  Reuse never targets it (`findApprovedMcpServer` stays on `availableInSpace` = the run owner's own servers), so the
  fork never writes an assignment for a server the run's owner does not own; `add_mcp_server` for the organization's
  address gets upstream's answer ("Your organization already added this MCP server as …", URL-normalised spelling
  only: a trailing slash is another address for upstream and registers the member's own server with a card).
  `spawn_bot` inheritance copies only the member's OWN `bot_mcp_servers` rows; for an organization's server only
  while it is `allBots`, where such a row is a tool limit the member set, so the new agent starts within the same
  limit (before: the child got no row and therefore every tool). Owner-request auto-approve (1.26) only acts on the
  server the call itself creates, never on an organization's. `vault_fill` (1.16b) reads its server from the run's
  tool list, not from `mcp_servers`. No other fork code reads `mcp_servers` (checked: `git diff 50de80b1f` for
  `mcpServer` / `availableInSpace` / `bot_mcp_servers`).
- **Files (fork):** `apps/api/src/integrations/mcp-server-list-fork.ts`. **Seams:** `integrations/mcp-servers.ts`
  (`mcpServerDto`), `routes/mcp.ts` (`list`), `packages/adapters/src/mcp/mcp-server-reuse.ts`
  (`copyApprovedMcpAssignments` filter + boundary notes). **Migration / env:** none.
- **Tests:** `apps/api/src/integrations/mcp-organization-servers.fork.postgres.test.ts` (router with the real reply
  schema: an admin creates an organization server, admin and member list it, `availability/items`, `update`; a row
  with `revision: 0` beside them is left out of the list). On pure upstream `50de80b1f` and on fork `main-1126b`:
  2 of 2 fail with the error above; with only the DTO patch the second still fails; now 2 of 2 pass.
  `packages/adapters/src/mcp/mcp-organization-reuse.fork.postgres.test.ts` (reuse finds nothing, `add_mcp_server`
  gets upstream's answer and writes nothing, spawn copies the member's own limit only, not for a server that is not
  `allBots`, another member's row untouched; fails on the old filter: `expected [] to deeply equal [ … ]`).
  `integrations/mcp-server-list-fork.test.ts` (no database: DTO for an organization row passes `McpServerSchema`,
  own row unchanged, guard leaves out and logs).
- **Live check:** as an organization owner, Settings → MCP servers → Add server → Available to: the organization →
  saved with the "Organization" label, the list still opens for him and for a member; api log has no
  `Output validation failed`. `docker logs rakazo-api-1 | grep mcp.server_unreadable` is empty in normal use.
- **Known limits:** a row left out of the list is invisible in Settings until fixed (the log line names it);
  `connect`, `update`, `test` on a row that is itself unreadable still fail for that one row.
- **Conflicts:** upstream fixing `mcpServerDto` or `SpaceAvailabilitySchema` its own way (take upstream's, keep the
  test); upstream edits to the `list` handler's `Promise.all`.

### 1.30 A removed bot is not read again: no `rpc routines/list not found` warnings (UPSTREAM BUG, local patch)
- **Status: upstream behaviour carried as a local patch** (none of `apps/api/src/rpc-errors.ts`,
  `apps/api/src/spaces/space-change-procedures.ts`, `packages/core/src/routines/routine-mention-batcher.ts`,
  `packages/core/src/primitives/query-refresh.ts`, `apps/web/src/lib/query/space-changes.ts`,
  `apps/web/src/pages/shell/composer/use-composer-mentions.ts` differed from `upstream/main` `6d816462a` before this change). At a sync, check whether upstream changed the
  batcher's "retries only omitted bots" rule or the `IsolationError` log; if it did, drop the matching hunk.
- **What happened:** every removal of a bot (`bots.remove`, from any client or script) logged 1 to 2 `rpc routines/list
  not found` warnings per already-removed bot, plus the request's own 404 warning (live 2026-11-26: 3 for two bots,
  7 for four, 13 for a larger clean-up). Chain: `bots.remove` makes the server signal `routines` changed
  (`space-change-procedures.ts`) beside the roster signal; an open client reads every `routines.list` query again
  at once (`spaceChanged`), while its roster, re-read 50 ms later, still holds the removed bot; the batch read
  `routines/listForMentions` leaves that bot out; the mention batcher then asks `routines/list` for each bot left
  out (or, for four reads or fewer, never batches at all); `getBot` throws `IsolationError`; `handleRpcError` warns.
- **Client (web):** `createRoutineMentionBatcher(..., { omittedIsGone: true })`: a bot the batch leaves out
  is answered `RoutineBotGoneError` (status 404, not retried) without a request, and two or more reads always go as
  one batch; a single read and a server without the batch keep the per-bot endpoint. Web: `use-space-roster.ts`
  drops every cached per-bot read of a bot that left the roster (`lib/query/bot-queries.ts` `dropBotQueries`:
  cancel + remove, any query whose input names that `botId`), after the render that dropped it; leaving the bot's
  open chat was already done by `refreshBots` (`routeChatListed`). Mobile is unchanged: it shares the batcher but
  loads its mention catalog on first use from the current roster and has no "routines changed" re-read of every
  bot, so the chain above does not run there; the option is off for it (8 upstream tests pin its bot-by-bot reads
  for small rosters). A mobile read for a gone bot is the server's info line.
- **Server:** `getBot`/`getBotView` throw `BotNotFoundError` (an `IsolationError`, same name and message). For a
  read procedure (`list*`, `get*`, `head`, `history`, `status`, `read`, `search`, `count`) `handleRpcError` logs
  `rpc <path> bot not found` at info and marks the request (`markExpectedClientMiss`, `packages/logging/src/hono.ts`)
  so `http.request.completed` is info too. The client gets the same 404 `NOT_FOUND`. Still a warning: anything else
  missing for a bot that exists (plain `IsolationError`), and any write that names a missing bot.
- **Seams:** `packages/core/src/routines/routine-mention-batcher.ts` (option + error class),
  `use-composer-mentions.ts` (the option), `use-space-roster.ts` (one effect),
  `packages/db/src/database/scope.ts` + `bots/bot-repository.ts` (2 throws), `apps/api/src/rpc-errors.ts`,
  `packages/logging/src/hono.ts`.
- **Tests:** `routine-mention-batcher.test.ts` ("a bot the batch leaves out, when the batch is trusted", 3),
  `use-composer-mentions.test.tsx` ("does not ask for the routines of a bot removed a moment ago": the live case,
  fails on the old code), `lib/query/bot-queries.test.ts` (3), `use-space-roster.test.tsx` ("drops the cached reads
  of a bot that left the roster, and moves off its chat"), `apps/api/src/log-unexpected-rpc-error.test.ts` ("a read
  for a bot that is gone", 4), `packages/db/src/bots/bot-repository.test.ts`.
- **Live check:** remove a throwaway bot with a web tab open, then
  `docker logs --since 2m rakazo-api-1 | grep -c 'routines/list not found'` → 0 (an `rpc routines/list bot not
  found` info line may appear when the client had a single bot listed). A tab still on the old bundle keeps asking
  until it reloads; its lines are info, not warn.
- **Not covered:** the roster of one bot (a single read keeps the per-bot endpoint: one info line); other per-bot
  reads a client may make for a bot removed while its chat is open (`threads/get`): same info line, no client change.

### 1.36 File tools take the paths the shell takes, and run after the command beside them (2026-11-28 audit, C1)
- **Why:** 26 Nov 15:00 to 28 Nov 02:00 UTC: `attach_file` failed 9 of 15 calls, `read_file` 49, `list_files` 4,
  `write_file` 1, while `shell` read the same files. Two causes, both measured from the audit store (argument
  hashes matched against the files on disk, call start times compared inside each run):
  1. **Same-step race (33 of 63 failures; 26 succeeded unchanged one step later).** Pi runs one model step's tool
     calls at the same moment. "shell: make the screenshot / copy the file" + "read_file / attach_file: use it"
     in one step read the file before the command had written it (file call started within 2 ms of the shell call
     and ended before it).
  2. **A path the shell accepts was refused (at least 10).** `teamWorkspaceInstruction` tells agents the shell
     reaches shared work as `../../shared/`; `normalizeWorkspacePath` refused every `..`, so that path failed in
     `read_file` and `write_file` ("Path escapes the computer workspace") and in `attach_file`, which reported
     it as "file not found or unreadable" (it swallowed every error, a file over the size limit too).
  The other 20 could not be matched (arguments are not logged); the old error named neither the path tried
  nor the folder searched.
- **One resolution (`resolveBotWorkspacePath`, `computers/screens/computer-support.ts`), used by the shell's `cwd`
  and every tool that takes a path** (`read_file`, `write_file`, `list_files`, `attach_file`, `render_plot`,
  `open_path`, page images, `message_bot` files): `..` is resolved by name against the folder the shell starts in
  (the bot's folder on a Team Computer, the root on a private one). It is accepted when it ends in the bot's own
  folder or in `shared/`; every other result is refused as before (another bot's folder is still reached as
  `bots/<id>/...` only, unchanged). `shared/...`, `bots/...`, a leading `/`, `~` and `/home/rakazo` keep upstream's
  meaning. A host computer reports the real path of the computer home (`environment` → `workspace`), so an
  absolute path printed by `pwd` maps back. Nothing new is reachable: only new spellings of paths the same tool
  already reached; a link that leaves is still refused by the provider (real path check, untouched).
- **Errors name the path and the base (`runs/tools/file-path-failure.ts`):** `file not found: "book/ch9.md" was
  looked up at "bots/<id>/book/ch9.md" in the computer home; relative paths start in your folder bots/<id> (the
  shell's working directory); shared/... and bots/... start at the computer home…`. A refusal says what the path
  resolved to. `attach_file` now tells a missing file, a refused path and a file over the limit apart. These
  come back as a tool result `{error, path}` (they were thrown before; the model saw the bare message either way).
- **Order (`runtime/pi/tools/computer-write-order.ts`):** `shell`, `write_file` and `render_plot` are
  `executionMode: "sequential"`, upstream's own mechanism (as `remember`, `computer_act`): a step that holds one
  runs in the order written. A step of reads only still runs at once. Cost: several commands in one step no
  longer overlap (a long one moves to the background after the shell-job wait, 1.11).
- **Env (default on, all three compose files):** `FILE_TOOL_SHELL_PATHS=0` restores the old resolution and the
  old error words; `COMPUTER_WRITES_IN_ORDER=0` restores the parallel step.
- **Host computer bundle: CHANGED.** `host-computer-runner.ts` adds `workspace` to the `environment` reply and
  bundles `computer-support.ts`. Rebuild the stack's `host-computer` bundle and restart `bee-rakazo-host-computer`
  after the app image. Skew is safe: an old bundle sends no `workspace`, so only the `pwd`-path mapping is missing.
- **Seams:** `computers/screens/computer-support.ts` (resolver, `displayBotWorkspacePath`),
  `runs/tools/run-tools-files.ts` (4 handlers + `readWorkspaceFile`), `tools/workspace-file-tools.ts`
  (`RunWorkspace.realRoot`), `runs/tools/run-tools-{computer,messaging,page-images}.ts` (one argument each),
  `runtime/pi/tools/pi-runtime-tools.ts` (one line), `computers/host/{host-computer-protocol,host-computer-runner}.ts`,
  `adapter-kit/src/interfaces.ts` (`environment` → optional `workspace`).
- **Tests:** `runs/tools/file-tool-paths.fork.test.ts` (real desktop provider and a real `sh`: the shell writes
  `../../shared/...`, all four tools reach it; `pwd` path; traversal by name incl. another bot's folder; links
  that leave, in the bot folder and in `shared/`; error text; kill switch; fake provider; container path
  equality), `computer-support.test.ts` (resolver table), `computer-write-order.test.ts`,
  `pi-runtime-tool-dispatch.test.ts` (modes), `host-computer.test.ts` (`workspace` equals the command's cwd).
  On the old code 5 of the 8 fork cases fail.
- **Live check:** an agent on a Team Computer: `shell` `printf x > ../../shared/t.md`, then in ONE step `shell`
  `printf y > n.md` + `read_file n.md` → content `y`; `read_file ../../shared/t.md` → `x`; `read_file nope.md` →
  the error names `bots/<id>/nope.md`. `tool_calls` in the audit store: `read_file` errors with
  `computer file not found` drop to real misses.
- **Not covered:** a file a *background* job is still writing; `~` on a host computer means the computer home
  here and the user's home in the shell (outside the workspace, so the file tools cannot serve it; the error
  says where it looked); the 20 unmatched failures.
- **Conflicts:** upstream edits to `resolveBotWorkspacePath`, the `executionMode` list in `toAgentTool`, the
  `fileTools` handlers.

### 1.37 A failed command says why in the audit log (`tool.exit_code`, `nonzero_exit`, `killed`) (2026-11-28 audit, C2)
- **Why:** 59 `shell` lines in 35 h had `tool.outcome=error`, `tool.error_class=unknown` and an empty
  `tool.error_message`. `toolCompletionOutcome` (upstream) counts a command that ran and exited non-zero as
  failed, but such a result has no `error`, only `{stdout, stderr, code}`; `toolErrorFields` classified the empty text.
- **Now (log only, `runs/turn/command-exit-audit.ts`):** `agent.tool.completed` carries `tool.exit_code` for every
  completion whose result has an exit code (0 included). For a non-zero exit with no tool error:
  `tool.error_class` = `timeout` (exit 124 or the provider's "command timed out after N ms"), `killed` (exit above
  128, or "command aborted" / "command terminated by SIG…"), else `nonzero_exit`; `tool.error_message` = the LAST
  200 characters of stderr (stdout when stderr is empty), redacted by `redactErrorTail` (`error-redaction.ts`: the
  same patterns as `redactErrorText`, run before the cut; a word cut at either edge is dropped).
  `run.audit_summary` `audit.errors_by_class` gets the new classes.
- **Outcome stays `error` (decision):** it is upstream's rule and the chat's failed-step mark uses the same
  function; what the model gets and the stored thread event are unchanged. A reader that wants "the tool itself
  failed" should leave out `nonzero_exit` (a `grep` with no match is one).
- **Env:** none (log fields only). **Stack-side:** `AUDIT-LOG-EVENTS.md` wording and the audit store's reader for
  `tool.exit_code` are in the stack repo.
- **Seams:** `runs/turn/tool-completion-audit.ts` (two hooks), `tool-error-class.ts` (two names), `error-redaction.ts`.
- **Tests:** `runs/turn/command-exit-audit.test.ts` (9: plain and wrapped result, stdout fallback, time limit, kill,
  success, running, tool error first, secrets, word cuts, payload unchanged).
- **Live check:** `docker logs --since 1h rakazo-api-1 rakazo-worker-1 2>&1 | grep '"tool":"shell"' | grep '"tool.outcome":"error"'`
  → every line has `tool.exit_code` and a class other than `unknown`.
- **Conflicts:** upstream edits to `toolErrorFields` / `appendToolCompletionAudit`.

### 1.38 An image a provider would refuse never reaches a model request (`MODEL_IMAGE_GUARD`) (2026-11-28 audit, C3)
- **Why:** run `cmwydsgm9000c07ssj6ipthde` failed with Anthropic 400 `image_dimensions_too_large`
  ("At least one of the image dimensions exceed max allowed size: 8000 pixels", path
  `messages.0.content.0.content.1`: an image inside a tool result). The run's 12 tool calls were all connector
  (MCP) calls; the last returned a picture taller than 8000 px. `liftMcpResultImages` (`mcp/mcp-result-images.ts`)
  passes an MCP picture on as the server sent it when it is a still PNG or JPEG: no limit on its sides. Every
  other picture a tool makes is scaled to 1568 px (`encodeForModel`). One such block fails the request, and it
  stays in the conversation, so every later step fails too.
- **Two layers:**
  1. **Where it enters (`fitMcpResultImages`):** an MCP picture with a side over 2000 px or over 5 MiB of base64 is
     scaled down like every other tool picture (`scaleImageForModel`), so the model still sees it.
  2. **Before every provider call (`media/model-image-guard.ts`, hooked in `observedPiStream`,
     `runtime/pi/usage/pi-usage.ts`: the one function every Pi model call goes through, any provider, main
     model, backups, helpers):** each image block of the request (user messages, tool results, replayed history)
     is checked by header and length; a block that is empty, not base64, not a PNG/JPEG/GIF/WebP, a PNG cut off
     before its end, over 5 MiB, or over 8000 px a side (2000 px when the request holds more than 20 images) is
     replaced by a text note (`model-image-guard.prompt.ts`: "[image left out: it was 1200x9000 pixels, over the
     8000 pixel limit per side. To look at it, make a smaller or valid copy and read that.]"). The stored
     conversation is not changed. The ACP runtime (pictures handed to another agent one by one) uses the same
     check (`unusableImageNote` in `acp-turn.ts`, `acp-runtime.ts`).
- **Log:** `model_image.left_out` (warn; `images.left_out`, `images.new`, `images.total`, `images.reasons`
  {reason: count}, run id, provider, model; never the image). Once per picture, not once per step.
- **Env (default on, all three compose files):** `MODEL_IMAGE_GUARD=0` sends requests as they are and stops the
  MCP scaling.
- **Tests run with it off by default:** upstream fixtures use one to three placeholder bytes as "images"
  (10 tests in `pi-runtime-fallback`, `pi-runtime-yield`, `acp-runtime` fail otherwise), so
  `packages/testkit/src/pin-test-env.ts` sets `MODEL_IMAGE_GUARD ??= "0"`; the fork's tests turn it on.
- **Seams:** `runtime/pi/usage/pi-usage.ts` (one call), `runtime/pi/tools/pi-runtime-tools.ts` (one await),
  `mcp/mcp-result-images.ts`, `media/tool-result-image.ts` (`scaleImageForModel`), `runtime/acp/{acp-turn,acp-runtime}.ts`,
  `testkit/src/pin-test-env.ts`.
- **Tests:** `media/model-image-guard.test.ts` (8: each reason with real PNGs, user message + tool result,
  logged once, many-image limit, kill switch, MCP scaling), `runtime/pi/usage/pi-usage-image-guard.fork.test.ts`
  (the request body the real Anthropic, OpenAI-completions and OpenAI-responses adapters send: empty, corrupt
  and 900x8600 images gone, the good one kept; with the switch off the tall one is sent).
- **Live check:** an agent with an MCP browser/design server: ask for a full-page screenshot of a long page →
  the run goes on; `docker logs rakazo-api-1 rakazo-worker-1 2>&1 | grep -c model_image.left_out` (0 when the
  scaling handled it); no `run.failed` with `image_dimensions_too_large`.
- **Not covered:** a JPEG/GIF/WebP whose body is damaged behind a good header (no pixel decode per step);
  other model calls that do not go through `observedPiStream` (memory ledger, curator, voice: text only).
- **Conflicts:** upstream edits to `observedPiStream`'s `prepareContext` line, `liftMcpResultImages` call site.

### 1.18 Merge commits
- `c46498f22` merged upstream `7dbc01748` into `integrate/1124` (the rebuild). Nothing fork-specific in it.
- `42d432574` merged upstream `7dbc01748..dbc0c9d46` (76 commits, v0.16.0+) into `sync/main-1125`; see §4.
- `eccc87ac6` merged upstream `4f4189032..50de80b1f` (67 commits) into `sync/upstream-1126` after `fix/post-live-1126`
  (`979685f61`); see §4 (2026-11-26 b).
- `881e9133b` (`fix/cards-plans-mcp-1126`, 1.21-1.26), `6b69eac81` (`feat/vault-fill-mcp-browser`, 1.16b), `55fe5eeea`
  (`feat/agent-skill-assign-tool`, 1.17a) merged into `integrate/1126` on fork `main` `6ae098ad1`; see §4 (2026-11-26).
- `938172ba2` (`fix/journeys-1126`, 1.3 + gate 4b), `9691dd126` (`fix/reload-askfirst-1126`, 1.27, 1.28) merged into
  `integrate/1126c` on fork `main` `051c16885`; 1.29 committed on top; see §4 (2026-11-26 c).

---

## 2. Stack-side pieces (repo `sasajib/rakazo-bee`, dir `/home/sasajib/the-data/rakazo`)
Not in this fork, but a sync/deploy must keep them working:
- **Compose:** `docker-compose.images.yml` (copied from this fork's `infra/compose/docker-compose.images.yml`; keep the
  fork's `x-app-environment` keys) + `docker-compose.override.yml` (bee-specific mounts, networks, voice env).
- **`.env` keys added for fork features** (names only): `VOICE_AGENT_URL`, `VOICE_AGENT_INTERNAL_TOKEN`,
  `RAKAZO_CSP_CONNECT_SRC`, `STANDING_EMBEDDINGS_URL`, `MEMORY_LEDGER`, `MEMORY_LEDGER_MODEL_URL`, `MEMORY_LEDGER_MODEL`,
  `MEMORY_LEDGER_MODEL_API_KEY`, `MEMORY_EMBEDDINGS_URL`, `MEMORY_EMBEDDINGS_MODEL`, `MEMORY_LEDGER_PACK_BUDGET_MS`,
  `SHELL_BACKGROUND_JOBS`, `SANDBOX_HOST_URL`, `SANDBOX_HOST_TOKEN`, `SANDBOX_HOST_SCREEN`, `RAKAZO_DISABLED_BUILTIN_TOOLS`, `VAULT_FILL_MCP_BROWSERS`, `SKILL_CURATOR`,
  `WEB_AUTO_RELOAD` (web service only, optional; the stack's compose copy needs the line in its `web` service),
  `RAKAZO_IMAGE_TAG`, `RAKAZO_COMPUTER_IMAGE`, `RAKAZO_COMPUTER_IMAGE_TAG`, `POSTGRES_IMAGE` (= `rakazo/postgres-graph:16-pgv-age1.6`).
- **Host units (user systemd):** `bee-rakazo-host-computer` (host computer + screen, 1.15), `bee-rakazo-audit`
  (`sasajib/rakazo-audit`), `bee-rakazo-watch` (`sasajib/rakazo-watch`, Watch MCP + webhooks).
- **Tools:** `host-computer/rakazo-tab-shot` (copy in `~/.local/bin`), user-level `xdotool` in `~/.local/opt/xdotool`.
- **Voice stack:** `/home/sasajib/the-data/rakazo-voice` (LiveKit agent + token server; shared SFU in `/home/sasajib/the-data/livekit`),
  `speech-local/` (Parakeet STT + tiny-voca TTS, container `rakazo-speech-local`), `speech-router.py` (built-in call/dictation).
- **Data-side config (DB, survives image changes, lost on a wipe):** standing orders in `STANDING.md`
  (`r-bee-desktop-browser`, `r-bee-desktop-browser-screen`), Browser MCP entry with secret + allBots, Watch MCP,
  `deployment_settings.computerHost='this-mac'`, bot instructions (records in the stack repo `BOT-INSTRUCTIONS-*.md` and
  `rakazo-watch/docs/bot-instructions.md`).
- **History of deploys + rollbacks:** stack `RAKAZO.md` (one dated section per deploy).

---

## 3. Upstream-sync procedure (mechanical)

### 3.1 Fetch and measure
```bash
cd /home/sasajib/the-data/rakazo-src/rakazo
git status --short                       # must be clean
git fetch origin && git fetch upstream   # separate commands
git rev-list --count upstream/main..origin/main   # fork commits (ledger above)
git rev-list --count origin/main..upstream/main   # behind
git merge-tree --write-tree --name-only origin/main upstream/main | sed 1d   # conflicting files, no checkout touched
```

### 3.2 Merge or rebuild?
- **Merge** (normal): conflicts are few (< ~25 files) and none in files whose fork hunk you cannot re-apply by reading
  the ledger. Most syncs.
- **Rebuild** (rare): hundreds of conflicting files, or upstream rewrote the files carrying several features. Archive
  (`archive/main-pre-<date>` branch + tag, `git format-patch` into `~/the-data/rakazo/fork-archive-<date>/`), branch
  `rebuild/<date>` from `upstream/main`, re-port features one by one **from this ledger** (not blind cherry-pick), ≤ 4
  features per worker, commit + push after each.

### 3.3 Branch and merge
```bash
git branch -f backup/main-pre-sync-$(date +%m%d) main
git switch -c sync/main-$(date +%m%d) main
git merge upstream/main            # never -X ours / -s ours
```
Resolve file by file. For a file upstream reorganised (function moved, file split): take upstream's version
(`git checkout upstream/main -- <f>`), then re-apply the fork delta from `git diff <merge-base> origin/main -- <f>`
using the "Seams" lists above. `pnpm-lock.yaml`: take upstream's side, then `pnpm install` and commit the lock.
CHANGELOG: upstream's released sections verbatim, fork lines under `## [Unreleased]`.
Then:
```bash
pnpm install --frozen-lockfile || pnpm install
pnpm --filter @rakazo/db generate
```
If upstream moved a directory that holds fork files (e.g. `packages/core/src` subfolders), move the fork files beside
their siblings and fix `index.ts` exports.

### 3.4 Gates (all must pass before `main` moves)
1. **Type-check per package, unfiltered counts** (baseline on upstream `dbc0c9d46` too: only the 2 `stripe-invoice-refund.ts`
   errors, which show in adapters/api/worker/testkit; apps/mobile 0):
   `for p in packages/contracts packages/core packages/db packages/adapters apps/api apps/web apps/worker packages/testkit apps/mobile; do (cd $p && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"); done`
   (`npx turbo check` gets OOM-killed on bee under load.)
2. **Biome on the fork's changed files only, never piped:** `npx biome check $(git diff --name-only upstream/main...HEAD -- '*.ts' '*.tsx')`.
3. **Vitest in chunks ≤ 5 min:** at least `packages/adapters/src/{tools,tasks,runs/assembly,runs/tools,runs/lifecycle,memory,memory-ledger,shell-jobs,computers}`,
   `packages/core/src`, `apps/api/src`, `apps/web/src/pages/shell`, `infra/updater/src/compose-env.test.ts`,
   `packages/testkit/src/runtime/executor-turn-checkpoint.test.ts`, mobile call tests. Compare failures against
   `git stash -u` / upstream (`desktop-runtime` (8), `infra/sandboxes/supervisor/src/focus-or-launch.test.ts` (1, since upstream
   `dbc0c9d46`: no xdotool + screen-gateway marker on bee), `mcp-package-installer` fail on bee without the fork too).
   A pure-upstream worktree for comparison: `git worktree add --detach ../upstream-<mmdd> upstream/main`
   + `pnpm install --frozen-lockfile` + `pnpm --filter @rakazo/db generate`.
4. **Postgres tests against pgvector:** start a scratch `rakazo/postgres-graph:16-pgv-age1.6`, then for each of
   `row-security.postgres.test.ts`, `memory-ledger/{ledger,seams}.postgres.test.ts`, `shell-jobs.postgres.test.ts`,
   `chat-wait.postgres.test.ts`, `computer-lifecycle.postgres.test.ts`, `apps/api/src/bots/bot-skills.postgres.test.ts`,
   `skill-curator/curator.postgres.test.ts`, `apps/api/src/bots/skill-learning.postgres.test.ts`,
   `plans/plans.postgres.test.ts`, `messaging/bot-supersede.postgres.test.ts`, `takeover-chat.postgres.test.ts`,
   `wakeup.postgres.test.ts`, `packages/testkit/src/product/authorization.test.ts`,
   `mcp-organization` (1.29: two files) (one fresh database per spec):
   `CI_POSTGRES_URL=postgresql://postgres:pw@127.0.0.1:<port>/rakazo MCP_ALLOW_PRIVATE_ENDPOINT=true pnpm test:integration --spec=<file>`;
   remove the container after. (Plain `postgres:18-alpine` lacks pgvector; the ledger migration fails there.)
   **4b. Journeys are a gate (since 2026-11-26):** `packages/testkit/src/product/journeys.test.ts`, same scratch
   container, one fresh database: `CI_POSTGRES_URL=… MCP_ALLOW_PRIVATE_ENDPOINT=true RAKAZO_BROWSER_BINARY=chromium pnpm test:integration --spec=journeys`
   must be all green (84 of 84 on the fork at `fix/journeys-1126`, 3 runs in a row; pure upstream `50de80b1f` 81 of 81).
   The old "6 of 84 fail" debt had two fork causes, both fixed in the 1.3 continuation rule, and one journey that
   needed the fork's rules spelled out: "a bot_message run cannot rewrite a child's instructions without the owner"
   sets the sender's plan mode to `never` first (`plans/setMode`), because the plan gate (1.22/1.25) refuses
   `message_bot` from an owner-started run without an approved plan. A new upstream journey in which a person's run
   calls `message_bot` needs the same line. To run one case: export the harness env by hand and
   `pnpm exec vitest run packages/testkit/src/product/journeys.test.ts -t '<name>'` against an already migrated
   database (`COPY_TEST_DATABASE=1` copies it per file). Never skip or delete a journey to get green.
5. **Prompt surface:** `npx vitest run packages/adapters/src/runs/assembly/prompt-surface.test.ts`; on failure review
   `git diff __prompt_surface__/` (expect only upstream's edits plus the fork's tool args `lane`, `force`, `review` and
   tools `bot_queue`, `standing_set`), then `-u`. Re-measure the `builtin-tool-bridge.test.ts` byte cap.
6. **Fork markers:** `python3 ops/post-sync-check.py --quick` (source markers + migrations; full run after deploy).
7. **Secret grep:** `git diff upstream/main...HEAD | grep -nE 'oc_sk_|eyJ[A-Za-z0-9_-]{20,}|[0-9a-f]{32,}|(key|secret|token|password)\s*[:=]\s*["'"'"'][^"'"'"' ]{8,}'` → no real values.
8. **Image-vs-git check** before building (a hotfix may exist only in the running image):
   `docker create rakazo/app:<running>` → `docker cp <c>:/app/packages` → `diff -rq` against `git archive <deployed ref>`
   (ignore `apps/desktop`, `apps/mobile`, generated dirs).

9. **Migration order against the live DB:** upstream migrations are dated before the fork's `2027-01-xx` ones. Restore the
   live schema (`pg_dump --schema-only`) + its `_prisma_migrations` rows into a scratch database and run
   `DATABASE_MIGRATION_URL=<scratch> npx prisma migrate deploy` in `packages/db`: it must apply only upstream's new
   migrations, cleanly (Prisma `migrate deploy` applies any unapplied migration, even one dated before applied ones).
10. **Host-computer bundle:** build `host-computer/build.mjs` into a scratch copy (`node build.mjs <fork>`) and diff it with the
   deployed `dist/host-computer.mjs` ignoring path comments; if code differs, rebuild in place and restart the unit at deploy.

### 3.5 Land on main
```bash
git switch main && git merge --ff-only sync/main-<mmdd> && git push origin main
```
Pushing `main` runs upstream's CI on the fork (emails on failure); the gates above are meant to keep it green.

### 3.6 Build and deploy (bee)
```bash
# 1. no live call (read the timestamps before going on)
docker logs --since 20m -t rakazo-voice-agent-1 2>&1 | grep -E 'user said|received job|participant disconnect'
# 2. backups
cd /home/sasajib/the-data/rakazo && TS=$(date +%Y%m%d-%H%M) && mkdir -p backups/deploy-$TS
docker exec rakazo-postgres-1 pg_dump -U rakazo -d rakazo -Fc > backups/deploy-$TS/rakazo.dump && cp .env backups/deploy-$TS/env.bak
# 3. image (tag main-<mmdd><letter>, never reuse a tag)
cd /home/sasajib/the-data/rakazo-src/rakazo && docker build -f infra/compose/Dockerfile -t rakazo/app:<tag> .
# 4. switch + recreate (include migrate); run in the background (compose up looks long-lived)
cd /home/sasajib/the-data/rakazo && sed -i 's/^RAKAZO_IMAGE_TAG=.*/RAKAZO_IMAGE_TAG=<tag>/' .env
docker compose --env-file .env -f docker-compose.images.yml -f docker-compose.override.yml up -d --no-build --force-recreate migrate api worker web supervisor
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3311/health    # 200
```
Computer image changes (rare): build `infra/sandboxes/computer`, set `RAKAZO_COMPUTER_IMAGE_TAG`, stop the team computer
through the supervisor first. Host bundle changes (`host-display.ts` etc.): `cd host-computer && node build.mjs`, restart
`bee-rakazo-host-computer` only with no run active.

### 3.7 Verify (after every deploy)
1. `python3 ops/post-sync-check.py` (full; creates and archives 2 bots) → ALL PASS.
2. `docker exec rakazo-api-1 grep -c <new rpc symbol> /app/packages/contracts/src/skills/skills-rpc.ts` (or the feature's file).
3. A real run from a throwaway bot (`ops/rakazo_rpc.py` or his Neo tab, own tab only): reply arrives; `run.prompt_manifest` logged.
4. Feature live checks from the ledger rows touched by the sync (calls: `scenario_assert.py`; host screen; lanes; skills).
5. Retract throwaway bots' `memory_facts`, archive the bots, clear the `"rateLimit"` sign-in row if a script signed in.
6. Add a dated section to stack `RAKAZO.md` (image, fork SHA, `.env` changes, rollback) and commit/push the stack repo.
Tell him: stale web tabs keep the old bundle until reloaded.

### 3.8 Rollback
- App: `.env` `RAKAZO_IMAGE_TAG=<previous tag>` → `up -d --no-build --force-recreate api worker web supervisor`.
  Fork migrations are additive, so the previous image runs on the newer schema.
- Data: `pg_restore` from `backups/deploy-<ts>/rakazo.dump` (stop app services first) only if a migration damaged data.
- Code: `git branch -f main backup/main-pre-sync-<mmdd>` + force-push only with the owner's word.

---

## 4. Sync log

### 2026-11-26 (c) — two fix branches + organization MCP server patch (no upstream change) → `integrate/1126c`, image `main-1126c`
- **Base:** fork `main` `051c16885` (image `main-1126b`, live). Merged `fix/journeys-1126` (`938172ba2`) and
  `fix/reload-askfirst-1126` (`9691dd126`) with real merge commits. One conflict, `ops/post-sync-check.py` (both
  sides appended markers to the end of `MARKERS`: both kept); `docs/FORK.md` merged by itself.
- **Defect fixed on top (1.29):** organization-level MCP server creation answered 500 and broke `mcp/servers/list`.
  Reproduced on pure upstream `50de80b1f` with the same spec, so it is upstream's; carried as a local patch.
- **Not deployed by this entry.** Deploy needs the `WEB_AUTO_RELOAD: ${WEB_AUTO_RELOAD:-}` line in the stack's
  `web` service (1.27); rollback is `ops/rollback.sh main-1126b`. Gate numbers: stack `INTEGRATE-1126c.md`.

### 2026-11-26 (b) — post-live fixes + upstream `4f4189032..50de80b1f` (67 commits) → `sync/upstream-1126`, image `main-1126b`
- **Base:** fork `main` `49d2743ed` (tag `pre-sync-1126`, image `main-1126a`, live-verified). First `fix/post-live-1126`
  (`979685f61`: vault_fill script tool by availability 1.16b, `ops/rakazo_rpc.py` large results 1.9, memory/curator model
  budget 1.10/1.19), then `git merge upstream/main` = `eccc87ac6`. **Decision: merge** (12 content conflicts, all in
  ledger seams; 67 upstream commits, no upstream release tag in the range).
- **Conflicts and resolutions** (ours kept, upstream's change ported onto it):
  - `apps/api/src/app.ts`: fork voice-agent routes + upstream `mountBotAccess`; `mountVoiceHttpRoutes(…, env)` (upstream
    #6804 cross-site cookie guard) stays mounted before the fork routes, so it covers them (1.1).
  - `computers/computer-lifecycle.ts`: imports of both sides; upstream #6817 made slot-aware (1.2). **Ours wins** on
    "other lanes keep running": with several slots, background work yields only the slots the waiting people need.
  - `runs/assembly/run-instructions.prompt.ts` + `runs/executor/executor.test.ts`: `secretGuidance(disabled,
    vaultFillOffered)` (1.16b) + upstream's `ask_user` sentence (#6814) and scratchpad wording (#6745).
  - `runs/executor/executor.ts`: `run.audit_summary` (1.8) + upstream's prompt-task callback (#6707).
  - `runs/lifecycle/run-complete.ts`: `keptTurnTranscript` (#6747) + `notifyOpenOwnerCards` (1.21).
  - `runs/tools/run-tool-selection.ts`, `runs/wakeups/background-job-handlers.ts`: imports of both sides
    (`VAULT_FILL_TOOL`, `runMayStartShellJobs`, `agentConnectionTools`; `pollShellJob`, `deliverTaskCallback`).
  - `runs/tools/run-tools-memory.ts`: upstream `remember {shared}` (#6740) + fork `memory.save` log (1.8) + the
    STANDING.md guard (1.5). **Ours wins:** standing orders stay the binding rule store.
  - `runtime/pi/tools/pi-runtime-tools.ts`: fork labels kept; `save_shared_memory` label dropped with upstream.
  - `tools/builtin.tool-definition.ts`: `sharedMemorySaveError` / `MAX_SHARED_MEMORY_CHARS` removed with upstream (the
    guard moved to `remember`).
  - `tools/builtin-tool-bridge.test.ts`: upstream's comment + fork notes; cap re-measured 49_820 → `49_880`.
- **Not a textual conflict, but broken by the merge and fixed:** `vault_fill` (upstream #6818 labels MCP sources by display
  name; see 1.16b); `executor.test.ts` prompt expectation. Nothing else failed after the merge.
- **Upstream changes checked against fork features:** #6814 "option cards" is prompt wording for the existing `ask`
  block: **no new message block kind** in this range, so `NEEDS_PERSON_BY_KIND`, plan-card history text, message-quote
  and the mobile presentation switches needed nothing (tsc on core/web/mobile confirms). #6768 (unavailable built-ins in
  `find_tool`) merged untouched. #6747 (stored turn transcripts): the ledger block, standing orders and notices live in
  the instructions, not in the turn, so they are not replayed; a turn whose card or mid-turn message sits between prompt
  and reply falls back to the old replay (plan cards keep their status text); a tool-free talk run replays stored turns
  with tool calls the old way. #6717 (text before an approval card) and #6796 (signed webhook deliveries) are additive.
  #6707 (bot API / MCP server / CLI): requests go through `threads/send` as the key's owner, so lanes, plan gate and
  admission apply; such a run counts as owner-started. #6827 (organization MCP servers): `availableInSpace` still
  filters by owner, so 1.23 reuse never picks an organization server; upstream's "your organization already added this
  server" check runs after the reuse check.
- **Prompt surface:** 4 tool snapshots regenerated; diff = upstream's own edits (`ask_user`, `remember` + `shared`,
  `create_child_routine`/`schedule_*` `endAt`, `save_page`, `delete_shared_memory` wording; `save_shared_memory` removed:
  owner chat 69 → 68 tools, 85,381 → 86,283 bytes). `prompts.md`, `vault-fill.md` unchanged. Fork tools and arguments intact.
- **Migrations (7 upstream, none of ours):** `20270101000100_page_images`, `…000200_notification_sounds`,
  `…000200_page_reader_states`, `…000300_access_grant_codes`, `…000400_free_byok_tiers`, `20270101100000_bot_access`,
  `20270102120000_organization_mcp_servers`. They sort between the fork's `20261231235500_memory_ledger` and
  `20270105090000_agent_concurrency`. On a copy of the live schema + `_prisma_migrations` (345 rows) `migrate deploy`
  applied exactly these seven, no error (352 rows after).
- **New upstream env keys:** `PARALLEL_API_KEY`, `PLUGIN_GITHUB_TOKEN` (app anchor), `CREDIT_CODES` (api). Fork:
  `MEMORY_LEDGER_MODEL_MAX_TOKENS`. All optional; the stack compose file needs the lines only to pass a value.
- **Gates:** `npx turbo check` 25/25 tasks, 0 `error TS` (upstream worktree: 25/25, 0). Biome on the 341 `.ts/.tsx` files
  changed vs upstream: exit 0 (6 warnings). Vitest non-postgres, fork vs pure upstream `50de80b1f`, same FAIL list:
  `desktop-runtime` 8, `mcp-package-installer` 1, `focus-or-launch` 1. Mobile `apps/mobile` 380 files / 4,629 tests pass.
  Postgres specs on `rakazo/postgres-graph`, one fresh database each: numbers in stack `SYNC-1126.md`. 102 of 102
  `post-sync-check.py` markers.
- **Journeys (extra, not a gate):** fork 78 passed / 6 failed of 84; pure upstream 81/81; pre-sync fork `main` in the
  same container: see stack `SYNC-1126.md`. The six are the fork's old failures (see 3.4), none new.
  **Fixed after this sync on `fix/journeys-1126` (84 of 84, see 3.4 step 4b and stack `FIX-1126-journeys.md`).**
- **Dropped / changed in behaviour:** the `save_shared_memory` tool is gone (upstream removed it; `remember {shared:
  true}` replaces it, minus STANDING.md). Background work now yields a bot's free computer slot(s) to a waiting
  person's run (upstream #6817, slot-aware here). Nothing of the fork was dropped.
- **Deploy record, image id, host-bundle diff, rollback:** stack repo `SYNC-1126.md`. Rollback = image `main-1126a` + tag
  `pre-sync-1126`.

### 2026-11-26 — three fork branches integrated (no upstream change) → `integrate/1126`, image `main-1126a`
- **Merged, in order, with merge commits:** `fix/cards-plans-mcp-1126` (`014ae8b5f`, 1.21-1.26) = `881e9133b`;
  `feat/vault-fill-mcp-browser` (`376b6d03f`, 1.16b) = `6b69eac81`; `feat/agent-skill-assign-tool` (`a33e79bc1`, 1.17a) =
  `55fe5eeea`. Tag `pre-sync-1126` marks the integrated commit (the base of the next upstream sync).
- **Conflicts:** only the four `__prompt_surface__/tools.*.md` snapshots, in the third merge (cards changed `message_bot`
  and `plan_propose`; skills added `bot_skills` and changed `spawn_bot`, `update_bot`). Taken from the skills side and
  regenerated with `-u`; the diff against `6ae098ad1` is exactly those five tools (+1 tool, +1_169 bytes per surface) plus
  the new `vault-fill.md`; `prompts.md` unchanged. Everything else merged without conflict and was checked by hand:
  ledger rows (1.16b, 1.17a, 1.21-1.26, no number clash), all 95 `post-sync-check.py` markers (61 + 23 + 5 + 6),
  `CORE_BUILTIN_TOOL_NAMES` (`vault_fill`, `bot_skills`, `plan_propose`), the approval-exempt list (both) and the
  own-state list (`bot_skills`), `BUILTIN_TOOL_NAMES`, the five new keys in all three compose anchors
  (`PLAN_DEFAULT_MODE`, `MCP_REUSE_APPROVED_SERVERS`, `MCP_OWNER_REQUEST_AUTO_APPROVE`, `VAULT_FILL_MCP_BROWSERS`,
  `VAULT_FILL_MCP_BROWSER_SHAPES`), `child-bots.ts` + `run-tools-fleet.ts` (`seed` of 1.17a beside `inheritMcpServers` of 1.23).
- **Pinned-tool cap:** re-measured 49_081 (bot_skills +874, message_bot +55, plan_propose -21), cap `49_140`.
  `vault_fill` is pinned but not offered in that test's owner chat (no MCP browser configured).
- **Migrations:** `20270126090000_plan_coverage`, `20270127090000_plan_notify`; on a copy of the live schema +
  `_prisma_migrations` (343 rows) `migrate deploy` applied exactly these two.
- **Host-computer bundle:** differs from the deployed one (1.24 export skip, contracts enums); rebuild + restart the unit at deploy.
- **Gates and deploy record:** stack repo `INTEGRATE-1126.md`.

### 2026-11-25 — upstream `7dbc01748..dbc0c9d46` (76 commits, incl. Release v0.16.0) → `main` `42d432574`, image `main-1125a`
- **Decision: merge, not rebuild.** 46 fork commits vs 76 upstream; `git merge-tree` touched 91 files but only **11 had content
  conflicts**, all in seams the ledger names (well under the ~25-file merge threshold). Backup: branch + tag
  `backup/main-pre-sync-1125` (= `7453a0fc2`), pushed.
- **Conflicts and resolutions** (ours kept, upstream's fix ported onto it):
  - `tools/builtin-computer.tool-definition.ts`: upstream turned the shell description into `shellDescription(screenTool)`
    (adds "open the bot's screen" when a graphical program finds no display). Took upstream's function; its base text
    `SHELL_DESCRIPTION` is the fork's background-job wording (1.11). **Ours wins** on the base text.
  - `runs/tools/run-tool-selection.ts`: upstream's `withShellScreenTool` applied AFTER the fork's job-tool filter (1.11).
  - `runs/tools/run-tools-computer.ts`: the shell result carries both the fork's job limit `note` and upstream's
    no-display `notice`; `postBytesToChat` import (1.12) and upstream's `screenOpeningTool` import both kept.
  - `infra/sandboxes/supervisor/src/routes.ts` (exec): fork's team-shared screen key (`screenIdentity(...).screenKey`, 1.14)
    kept; upstream #6658 rule "no screen for this key = no DISPLAY" applied to that key (before: fork fell back to index 0).
  - `runs/assembly/run-assembly-context.ts`: plan imports (1.20) + upstream `routineEnded`.
  - mobile `lib/calls/incoming-calls.ts` + test, `lib/thread/thread-voice.ts`: upstream added automatic spoken language
    (`loadCallAutoLanguage`, transcriber check before answering, Space-scoped request context). Fork LiveKit transport (1.1)
    kept: the transport is resolved before the automatic-language check, and on LiveKit no voice provider/transcriber is
    asked for (**ours wins**: upstream would refuse an automatic-language call without a transcriber; the voice agent
    transcribes). Upstream's `captureApiRequestContext(spaceId)` + `stillHere()` now also guard the fork's LiveKit start.
  - `apps/web/src/pages/shell/chat/chat-column.tsx`: fork lesson bar (1.19) + upstream `FileDropZoneContext`.
  - `tools/builtin-tool-bridge.test.ts`: upstream's comment + fork note; cap re-measured 48_173 → `48_230` (upstream 37_791).
  - `CHANGELOG.md`: fork lines under Unreleased, upstream 0.16.0 verbatim.
- **Auto-merged fork seams re-checked:** all 57 `post-sync-check.py` markers present; prompt-surface snapshots changed only by
  upstream's `schedule_create`/`schedule_update` `endAt` wording (fork tools/args unchanged).
- **New upstream migration** `20261231230000_routine_ends_at` (dated before the fork's 2027-01 migrations): applies cleanly on
  an empty DB and on a copy of the live schema + `_prisma_migrations` (only it is pending there).
- **Gates:** tsc per package = upstream baseline (2 stripe errors in adapters/api/worker/testkit; others 0; mobile 0).
  Biome on 302 fork-touched files: exit 0 after `--write` (organize-imports in 2 files). Vitest 11 chunks: only
  `desktop-runtime` (8) + `focus-or-launch` (1) fail, identical on pure upstream `dbc0c9d46`. Mobile `apps/mobile/lib`
  3910/3910. 14 postgres specs (incl. authorization inventory, row-security) PASS on `rakazo/postgres-graph`. compose-env PASS.
  Secret grep: fixtures only. Image-vs-git (`main-1124s` vs `f05e734f0`): no image-only edits.
- **Not re-ported / dropped:** nothing. Upstream fixes kept: all 76.
- **Deploy (bee, 2026-11-24 23:32 UTC):** no live call (voice agent log empty for 20 min) and no running runs; backups
  `backups/deploy-20261124-2331/{rakazo.dump,env.bak}`; image `rakazo/app:main-1125a` (`--build-arg GIT_SHA=42d432574…`);
  recreated `migrate api worker web supervisor` (migrate applied `routine_ends_at`); `/health` 200; stack compose gained
  upstream's `SANDBOX_COMPUTER_GPU` key. Host-computer bundle differed (upstream code pulled in transitively), so
  `host-computer/build.mjs` was re-run and `bee-rakazo-host-computer` restarted (listening 172.17.0.1:7093/7094). Voice agent
  unchanged (deployed copy == example), not rebuilt. Computer image not rebuilt (upstream GPU change is not used by host mode).
- **Live checks (throwaway bots, archived; no ledger facts written):** `post-sync-check.py` full ALL PASS (repeat refused
  4→3, same lane serial, other lane parallel). Probe bots: `/api/voice/agent` → `{mode: livekit}` (1.1); talk run 18 s into a
  40 s host shell, answered in 3 s (1.3); shell on the desktop host (1.15, rebuilt bundle) 40 s, output returned;
  `computer_observe share:true` posted an image message (1.12/1.15); `computer/screenUrl` → `/novnc/session/view/…` (1.15);
  delegation request → `plan_propose` card pending → `plans/decide approve` → `message_bot` → B's `bot_message` run
  completed (1.20); `agentSkills/forBot`, `skillLearning/settings`, `plans/settings` answer (1.17/1.19/1.20);
  `run.prompt_manifest` logged; `tools.exposed` 78 on an owner run.
- **Not verified live this sync:** a spoken call (`scenario_assert.py`: the voice-agent account's space has no bots/model);
  mobile LiveKit + automatic language (APK not built; unit tests only); background shell jobs (desktop host skips them by
  design; unit + postgres tests only); Team-Computer shared screen exec path (not used on bee; unit tests only); skill
  curator card flow (unchanged seams; tests only).
- **New baseline failure:** `focus-or-launch.test.ts` (1, upstream test, same on pure upstream).
- **Rollback:** `.env` `RAKAZO_IMAGE_TAG=main-1124s` → recreate `api worker web supervisor` (the new `routines.endsAt` column
  is additive; the old image ignores it); host bundle backup `backups/deploy-20261124-2331/host-computer.mjs` (copy over
  `host-computer/dist/host-computer.mjs`, restart the unit; or rebuild from `backup/main-pre-sync-1125` with `node build.mjs`).
