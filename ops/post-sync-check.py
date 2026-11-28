#!/usr/bin/env python3
"""Post-sync / post-deploy check for Rakazo. Run after every upstream sync or image change:
    python3 ops/post-sync-check.py            # everything, ~4 min (creates 2 throwaway bots, archives them)
    python3 ops/post-sync-check.py --quick    # skips the live queue test
Exit 0 = all PASS. Any FAIL = do not trust the deploy; roll back RAKAZO_IMAGE_TAG.

Not run here (needs a scratch Postgres, ~1 min): the end-to-end journeys suite. It is a sync GATE
(docs/FORK.md 3.4 step 4b), 84 of 84 on the fork since 2026-11-26; before `main` moves run
    docker run -d --name scratch-pg-journeys -e POSTGRES_PASSWORD=x -p 127.0.0.1:55466:5432 rakazo/postgres-graph:16-pgv-age1.6
    docker exec scratch-pg-journeys psql -U postgres -c 'create database j1'
    CI_POSTGRES_URL=postgresql://postgres:x@127.0.0.1:55466/j1 MCP_ALLOW_PRIVATE_ENDPOINT=true \
      RAKAZO_BROWSER_BINARY=chromium pnpm test:integration --spec=journeys
in the source worktree (one fresh database per run), then `docker rm -f scratch-pg-journeys`."""
import json, os, subprocess, sys, time, urllib.request

ROOT = "/home/sasajib/the-data/rakazo"
SRC = "/home/sasajib/the-data/rakazo-src/rakazo"
COMPOSE = ["docker", "compose", "--env-file", ".env", "-f", "docker-compose.images.yml", "-f", "docker-compose.override.yml"]
# Features we built that an upstream merge must never silently drop: (marker, minimum files containing it)
# (historyThisChatOnly is gone: upstream now gives the my_chats guidance only when it is allowed.)
MARKERS = [("admissionHold", 1), ("bot_queue", 4), ("standing_set", 6), ("normalizeLane", 2),
           ("findQueuedDuplicate", 2), ("notice-ledger", 1), ("threadHasLiveCall", 1),
           ("CALL_RELAY_GUIDANCE", 1), ("talkLaneDue", 2), ("TALK_RUN_TRIGGER", 4),
           ("planLeaseSlot", 2), ("VOICE_AGENT_URL", 3), ("callNote", 2), ("leaveCards", 2),
           ("scratchpad_list", 2),
           # memory ledger seams (fork): prompt block, run-finished writer, remember/recall, RLS table list,
           # and the deleted-bot path that no longer re-files MEMORY.md while the ledger is on
           ("withLedgerMemory(", 2), ("placeLedgerBlock(", 2), ("learnAfterRun(ctx)", 1),
           ("rememberToolViaLedger(", 2), ("recallToolViaLedger(", 2), ('"memory_facts",', 1),
           ("!deleteMemories && !ledgerEnabled()", 1),
           # host computer serves bee's display :1 (live screen, take over, computer_observe/act)
           ("userMachineServesScreen(", 3), ("displayConnect", 3), ("screenlessUserMachine(", 3),
           # deployment-wide disabled built-in tools: both seams (capabilities + tool selection)
           ("RAKAZO_DISABLED_BUILTIN_TOOLS", 2),
           # saved logins typed through an MCP browser: tool, offering seam, approval seam, guidance seam
           ("VAULT_FILL_TOOL", 5), ("vaultFillBrowserInRun(", 2), ("vaultFillLoginSteps(", 2),
           ("vaultFillOffered", 2), ("withVaultFillWording(", 2),
           # per-agent skills: filter in the catalog + skill_read, the run-records seam, RPC, web section
           ("filterSkillsForBot(", 2), ("loadBotSkillSelection(", 3), ("addSkillToBotSelection(", 2),
           ("botSkillsProcedures", 2), ("createBotSkillsService(", 2), ("BotSkillsSection", 2),
           ('"BotSkillSelection",', 1),
           # new agents start with built-in skills only (RAKAZO_NEW_BOT_SKILLS=builtins)
           ("newBotSkillsBuiltinsOnly(", 2),
           # agents assign skills to other agents: bot_skills tool (contracts name, definition, pin, approval
           # lists, pi arguments, handler), the shared write behind agentSkills/setForBot, spawn_bot's skills seam
           ("botSkillsFromTool(", 2), ("resolveNewBotSkills(", 2), ("writeBotSkillSelection(", 2),
           ("setBotSkills(", 2), ('"bot_skills"', 10), ("seed: input.seed", 1),
           # skills load themselves, Space-pinned skills, standing orders outside the turn data (1.32):
           # the assembly seam + its log line, the pinned read in access/assembly/tool/RPC, the block in
           # the system instructions, the standing-orders split, the tool actions, RLS table, web switch
           ("autoloadSkills(", 2), ("logSkillAutoload(", 2), ("loadPinnedSkillRefs(", 4),
           ("loadBotSkillAccess(", 2), ("renderPinnedSkills(", 3), ("splitStandingOrders(", 2),
           ("standingOrders: turnMemory.standing", 1), ("changePinnedSkills(", 2),
           ('"space_pinned_skills",', 1), ("SkillPinLine", 2), ("SKILL_AUTOLOAD", 2), ('"list_pinned"', 4),
           # skill curator (auto-learned skills, chat teaching): run-finished hook, prompt seam, RPC,
           # card block, web card + Learning section + lesson bar, desktop-host teaching gate
           ("curateAfterRun(ctx)", 1), ("skillLearningPromptState(", 2), ("skillLearningInstruction(", 2),
           ("skillLearningProcedures", 2), ("createSkillLearningService(", 2), ("LearnedSkillBlockSchema", 2),
           ("LearnedSkillCard", 2), ("BotLearningSection", 2), ("TeachingBar", 2), ("teachingRefuses(", 1),
           ('"skill_learning_proposals",', 1),
           # plan confirmation + superseding requests + workflow trust: prompt seam, tool, message_bot gate,
           # supersede in the delivery transaction, RPC, card block, web card + Plans section + Skills line
           ("planPromptState(", 2), ("planInstruction(", 2), ("planGateForMessageBot(", 2), ('"plan_propose"', 4),
           ("findReplaceableRequest(", 2), ("cancelReplacedRequest(", 2), ("planProcedures", 2),
           ("createPlansService(", 2), ("PlanBlockSchema", 2), ("PlanCard", 2), ("BotPlansSection", 2),
           ("SkillTrustLine", 2), ('"agent_plans",', 1),
           # 2026-11-25 sync re-ports: shell's base description keeps the background-job wording under upstream's
           # shellDescription(); job tools filtered before withShellScreenTool; LiveKit calls skip the
           # automatic-language transcriber check on mobile
           ("Fork (1.11 background shell jobs)", 1), ("JOB_TOOL_NAME_SET", 2),
           ('autoLanguage && transport !== "livekit"', 1),
           # 2026-11-26 audit fixes (FORK.md 1.21+): one core rule for cards that wait on the person, used by
           # the server page filter, the live-event filter, the unread default and the owner notice
           ("isNeedsPersonBlock", 3), ("isPeerRunVisibleBlock", 2), ("notifyOpenOwnerCards(", 2),
           # one approval covers the task (1.22): gate by involved agents, recipients recorded, finished replaces
           ("planGateCheck(", 2), ("recordPlanRecipient(", 2), ("planInvolves(", 2),
           ("followsFinishedPreface(", 2),
           # approved MCP server reused instead of a duplicate + card; spawn_bot inherits (1.23)
           ("reuseApprovedMcpServer(", 2), ("copyApprovedMcpAssignments(", 2),
           ("MCP_REUSE_APPROVED_SERVERS", 1), ("inheritMcpServers", 2),
           # host checkpoint skips files over the protocol cap and saves the rest (1.24)
           ("exportWorkspaceSkippingLarge(", 2), ("skipLargeFiles", 3), ("keepSavedVersion(", 2),
           ("computer.checkpoint_skipped_large", 1),
           # proactive agents (1.25+): plan mode notify + deployment default
           ("planDefaultMode(", 2), ("PLAN_DEFAULT_MODE", 1), ("PLAN_NOTICE_FIRST_NOTE", 1), ("spokenNotice(", 1),
           # an MCP server the owner asked for himself is connected without a card to answer (1.26)
           ("ownerRequestVerdict(", 2), ("ownerRequestFacts(", 2), ("MCP_OWNER_REQUEST_AUTO_APPROVE", 1),
           ("mcp.server.auto_approved", 1),
           # 2026-11-26 post-live fixes: vault_fill picks the script tool the server offers; the memory
           # and curator models retry once with twice the budget when thinking used it all
           ("stepTools(", 2), ("chatWithBudget(", 2), ("MEMORY_LEDGER_MODEL_MAX_TOKENS", 1),
           # 2026-11-26b sync re-ports: background work yields a bot's slots to waiting people only as far
           # as they need them; vault_fill reads the server from the tool id (upstream labels sources by
           # display name); remember {shared} cannot write STANDING.md
           ("backgroundYieldsSlot(", 2), ("connectorToolServerKey(", 2), ("catalogSources", 3),
           ("parsed.data.shared &&", 1),
           # journeys fixes (1.3): the continuation rule skips a run that stopped for the person
           ("PAUSED_FOR_PERSON_EVENT_TYPES", 2), ("pausedForPerson", 2),
           # an open tab moves onto a new deploy by itself (1.27): upstream tracker seams, the screen-control
           # hold, the web server's kill switch
           ("forkClientUpdates(", 2), ("installFork", 2), ("forkAllows", 2), ("holdReload(", 2),
           ("autoReloadHeaderMiddleware(", 2), ("WEB_AUTO_RELOAD", 2),
           # Ask first on a saved item holds in Never ask; loosely named logins (1.28)
           ("itemAsksFirst", 4), ("withSavedLoginNames(", 2), ("unknownLoginError(", 2),
           # organization MCP servers (1.29): the reply reads as in the viewer's Space (upstream's fix
           # since sync 1128b, the local patch is gone); one unreadable row never takes
           # mcp/servers/list; inheritance copies own rows only
           ("spaceId: row.spaceId ?? viewer.spaceId", 1), ("readableMcpServers(", 2),
           ("organizationItemIn(scope), allBots: true", 1),
           # memory ledger idempotency (1.10, 2026-11-27): a late job reads its own run's messages, the
           # write stage is one transaction claimed once per job, one live fact per text and meaning
           ("until: job.createdAt", 1), ("claimWrite(", 3), ("writeTransaction(", 3), ("insertFactOnce(", 3),
           ("NEAR_DUPLICATE_SIMILARITY", 2), ("memory_facts_live_text_key", 1),
           # the memory and curator model calls repeat on 429/5xx/timeout inside a time budget
           ("MEMORY_LEDGER_MODEL_RETRIES", 1), ("retryAfterMs(", 2), ("MODEL_CALL_BUDGET_MS", 2),
           # a removed bot is not read again (1.30, upstream bug, local patch): trusted batch on web, the roster drops the bot's cached reads, a read for a missing bot is not a warning
           ("omittedIsGone", 2), ("dropBotQueries(", 1), ("BotNotFoundError", 3), ("markExpectedClientMiss(", 2),
           # a rollback reloads open tabs too (1.27): older build seen stable twice, own loop guard
           ("attemptRollback", 3), ("claimRollbackReload(", 2), ("FORK_STABLE_MS", 1),
           # 2026-11-28 audit, tools (1.36+): file tools take the shell's paths and name the path tried;
           # a command or write runs before the file read written beside it
           ("shellPathsEnabled(", 3), ("filePathFailure(", 2), ("botStoredPath(", 1),
           ("writesComputerFiles(", 3), ("FILE_TOOL_SHELL_PATHS", 2), ("COMPUTER_WRITES_IN_ORDER", 2),
           # a failed command says why in the audit log (1.37)
           ("commandExitErrorFields(", 2), ("redactErrorTail(", 2), ('"tool.exit_code"', 2),
           # an image a provider would refuse never reaches a model request (1.38)
           ("guardModelImages(", 2), ("fitMcpResultImages(", 3), ("unusableImageNote(", 3),
           ("MODEL_IMAGE_GUARD", 3), ("model_image.left_out", 2),
           # a delegated request that was stopped still answers the agent that asked (1.39)
           ("returnStoppedBotMessageOutcomes(", 3), ("botMessageStoppedText(", 3),
           ("BOT_MESSAGE_STOP_NOTICE", 2),
           # long-task continuity (1.33): any run of the agent delegates under a budget, with every helper
           # tied to the first conversation; helpers beyond the cap queue and start by themselves; Stop
           # cancels the queue
           ("delegationOriginId(", 2), ("helperStartBudget(", 1), ("HELPER_DELEGATION_ANY_RUN", 1),
           ("queueHelperInTransaction(", 2), ("startQueuedHelpers(", 3), ("startAllQueuedHelpers(", 2),
           ("cancelQueuedHelpersInTransaction(", 3), ("delegationContinuityClause(", 2), ('"QueuedHelper",', 1),
           # open work (1.33 A3/A4): the rule, its seam after a run completes, the wakers, the item's chat,
           # the stalled notice's state, Stop standing the items down, the prompt clause
           ("decideOpenWork(", 2), ("continueOpenWork(ctx, completion?.heldFinishNotice)", 1),
            ("loadOpenWorkWakers(", 1),
           ("followOpenWork(", 2), ("disarmOpenWorkInTransaction(", 3), ("openWorkClause(", 2),
           ("OPEN_WORK_NONCE_PREFIX", 2), ("threadId: run.threadId,", 1), ('"OpenWorkState",', 1),
            # one finished notification for a continued job (1.33): held for a continuation run, sent
            # when the chain ends, dropped when the job goes on or the stalled notice went out
            ("holdsFinishNotice(", 2), ("settleFinishNotice(", 1), ("holdFinishNotice", 2),
            ("run.finish_notice_held", 1),
            # command slots (1.40): runs of one agent run commands on its computer at the same time;
            # the screen keeps its one-run lease
            ("planRunLeaseSlot(", 3), ("createRunComputerLease", 3), ("releaseCommandSlots(", 3),
            ("renewHeldComputerLease(", 2), ("COMPUTER_COMMAND_SLOTS", 2), ("COMMAND_SLOT_BASE", 5),
            # skill auto-load leftovers (1.32): a short message borrows the earlier request only when it
            # goes on with it
            ("continuesEarlierRequest(", 3), ("SKILL_AUTOLOAD_CONTINUATION_CHECK", 2),
            # a digest of the task is embedded, kept by its hash, and asked for when the task is read
            ("taskDigest(", 3), ("warmTaskVector(", 3), ("helperTaskOf(", 2), ("SKILL_AUTOLOAD_EMBED_CHARS", 2),
            # a stopped helper's card says so itself (1.33): one constant at every writer, one reader
            ("STOPPED_HELPER_CARD", 6), ("helperWasStopped(", 3)]
results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(("PASS " if ok else "FAIL ") + name + (" - " + str(detail) if detail else ""), flush=True)


def sh(cmd, cwd=ROOT):
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=300).stdout.strip()


def psql(sql):
    return sh(["docker", "exec", "rakazo-postgres-1", "psql", "-U", "rakazo", "-d", "rakazo", "-At", "-F", "|", "-c", sql])


def stack():
    tag = [l.split("=", 1)[1] for l in open(ROOT + "/.env") if l.startswith("RAKAZO_IMAGE_TAG=")][0].strip()
    ps = sh(COMPOSE + ["ps", "--format", "{{.Name}} {{.Image}} {{.Status}}"])
    app = [l for l in ps.splitlines() if "rakazo/app" in l]
    check("all app containers run the tag in .env", bool(app) and all(tag in l for l in app), tag)
    check("api, worker, supervisor healthy", sum("(healthy)" in l for l in app) >= 3, "; ".join(l.split()[0] for l in app if "(healthy)" not in l) or "ok")
    code = urllib.request.urlopen("http://127.0.0.1:3311/health", timeout=10).status
    check("api /health 200", code == 200, code)
    head = sh(["git", "rev-parse", "--short", "HEAD"], SRC)
    img = sh(["docker", "inspect", "-f", "{{index .Config.Labels \"org.opencontainers.revision\"}}", "rakazo/app:" + tag])
    print("INFO source HEAD", head, "image revision label", img or "(none)")


def code_markers():
    for marker, need in MARKERS:
        n = len(sh(["git", "grep", "-l", marker, "--", "packages", "apps"], SRC).splitlines())
        check("feature present in source: " + marker, n >= need, f"{n} files (need {need})")


def prompt_surface():
    # the committed prompt/tool snapshots must match the code: a merge that changed a prompt or tool fails here
    r = subprocess.run(["npx", "vitest", "run", "packages/adapters/src/runs/assembly/prompt-surface.test.ts"], cwd=SRC, capture_output=True, text=True, timeout=280)
    out = r.stdout + r.stderr
    check("prompt surface matches committed snapshot", r.returncode == 0, "review the diff, then run with -u" if r.returncode else "unchanged")


def migrations():
    mdir = SRC + "/packages/db/prisma/migrations"
    # upstream marks drop-after-release migrations "-- deferred": applied by a later step, not by migrate deploy
    on_disk = {d for d in os.listdir(mdir) if d[:2] == "20" and not open(f"{mdir}/{d}/migration.sql").read().lstrip().startswith("-- deferred")}
    applied = set(psql("select migration_name from _prisma_migrations where finished_at is not null and rolled_back_at is null").splitlines())
    check("all repo migrations applied", not (on_disk - applied), sorted(on_disk - applied)[:3] or f"{len(applied)} applied")
    check("runs.lane column exists", psql("select 1 from information_schema.columns where table_name='runs' and column_name='lane'") == "1")
    check("memory ledger migration on disk", os.path.isdir(mdir + "/20261231235500_memory_ledger"))
    check("memory ledger idempotency migration on disk", os.path.isdir(mdir + "/20270128090000_memory_ledger_idempotency"))
    check("helper queue migration on disk", os.path.isdir(mdir + "/20270129090000_helper_queue"))
    check("queued_helpers table exists with row security", psql("select count(*) from pg_class where relname='queued_helpers' and relrowsecurity") == "1")
    check("open work migration on disk", os.path.isdir(mdir + "/20270130090000_open_work"))
    check("open_work_states table exists with row security", psql("select count(*) from pg_class where relname='open_work_states' and relrowsecurity") == "1")
    check("scratchpad_items.threadId column exists", psql("select 1 from information_schema.columns where table_name='scratchpad_items' and column_name='threadId'") == "1")
    check("memory ledger idempotency columns exist", psql("select count(*) from information_schema.columns where (table_name='memory_facts' and column_name='textKey') or (table_name='memory_ledger_jobs' and column_name='wroteAt')") == "2")
    check("memory ledger tables exist", psql("select count(*) from information_schema.tables where table_name in ('memory_facts','memory_fact_links','memory_ledger_jobs')") == "3")
    check("per-agent skill tables exist with row security", psql("select count(*) from pg_class where relname in ('bot_skill_selections','bot_skills') and relrowsecurity") == "2")
    check("Space-pinned skills table exists with row security (1.32)", psql("select count(*) from pg_class where relname = 'space_pinned_skills' and relrowsecurity") == "1")
    check("skill curator tables exist with row security", psql("select count(*) from pg_class where relname in ('skill_learning_settings','skill_learning_jobs','skill_learning_proposals','learned_skills','skill_teaching_sessions') and relrowsecurity") == "5")
    check("plan confirmation tables exist with row security", psql("select count(*) from pg_class where relname in ('agent_plans','plan_settings','plan_trust') and relrowsecurity") == "3")
    check("agent_plans.recipients column exists (plan coverage)", psql("select 1 from information_schema.columns where table_name='agent_plans' and column_name='recipients'") == "1")
    check("plan mode notify allowed by the database", "notify" in psql("select pg_get_constraintdef(oid) from pg_constraint where conname='plan_settings_mode_check'"))


def live_queue_test():
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from rakazo_rpc import Rpc
    rpc = Rpc()
    ids = []
    try:
        tag = str(int(time.time()))[-6:]
        w = rpc.call("bots/create", {"name": "Chk Worker", "spawnKey": "chk-w-" + tag, "instructions": "Worker test bot. Do exactly what a message asks. Reply in one short sentence.", "description": "post-sync check"})["json"]["id"]
        s = rpc.call("bots/create", {"name": "Chk Sender", "spawnKey": "chk-s-" + tag, "instructions": "Sender test bot. Do exactly what the user says, using message_bot with the exact arguments given. Reply in one short sentence.", "description": "post-sync check"})["json"]["id"]
        ids = [w, s]
        rpc.call("bots/update", {"botId": w, "concurrency": 4})
        # plan confirmation would hold the sender's message_bot calls for a plan card; this test is about lanes
        rpc.call("plans/setMode", {"botId": s, "mode": "never"})
        for b in ids:
            rpc.call("threads/send", {"botId": b, "text": "ok, ready.", "clientNonce": "i-" + b[:6]})
        time.sleep(30)
        job = lambda lane, word: f"lane '{lane}', message 'Check job {word} for the {lane} lane: run the shell command sleep 20 && echo {word}-done, then reply done'"
        msg = (f"Call message_bot four times in this order, each with bot_id {w}. (1) {job('indeed','ONE')}. (2) {job('indeed','TWO')}. "
               f"(3) {job('himalayas','THREE')}. (4) exactly the same arguments as call 1. Then say in one sentence what each call returned.")
        rpc.call("threads/send", {"botId": s, "text": msg, "clientNonce": "chk-" + tag})
        q = lambda: [r.split("|") for r in psql(
            f"select coalesce(lane,'-'), extract(epoch from \"startedAt\"), extract(epoch from \"updatedAt\"), status from runs where \"botId\"='{w}' and trigger='bot_message' order by \"createdAt\"").splitlines()]
        deadline = time.time() + 360
        time.sleep(60)
        rows = q()
        while time.time() < deadline and (len(rows) < 3 or any(r[3] not in ("completed", "failed") for r in rows)):
            time.sleep(15)
            rows = q()
        check("exact repeat refused (4 sends -> 3 runs)", len(rows) == 3, f"{len(rows)} runs")
        ind = [r for r in rows if r[0] == "indeed"]
        him = [r for r in rows if r[0] == "himalayas"]
        if len(ind) == 2 and him:
            check("same lane runs one at a time", float(ind[1][1]) >= float(ind[0][2]) - 1, f"2nd started {float(ind[1][1]) - float(ind[0][2]):+.0f}s vs 1st end")
            check("other lane runs in parallel", float(him[0][1]) < float(ind[0][2]), "himalayas started before indeed #1 finished")
        else:
            check("lane rows present", False, rows)
        check("all test runs completed", all(r[3] == "completed" for r in rows), [r[3] for r in rows])
    finally:
        for b in ids:
            try:
                rpc.call("bots/archive", {"botId": b})
            except Exception as e:
                print("WARN could not archive", b, e)


if __name__ == "__main__":
    stack(); code_markers(); prompt_surface(); migrations()
    if "--quick" not in sys.argv:
        live_queue_test()
    print("\nRESULT:", "ALL PASS" if all(results) else f"{results.count(False)} FAILED")
    sys.exit(0 if all(results) else 1)
