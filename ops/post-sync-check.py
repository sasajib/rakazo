#!/usr/bin/env python3
"""Post-sync / post-deploy check for Rakazo. Run after every upstream sync or image change:
    python3 ops/post-sync-check.py            # everything, ~4 min (creates 2 throwaway bots, archives them)
    python3 ops/post-sync-check.py --quick    # skips the live queue test
Exit 0 = all PASS. Any FAIL = do not trust the deploy; roll back RAKAZO_IMAGE_TAG."""
import json, os, subprocess, sys, time, urllib.request

ROOT = "/home/sasajib/the-data/rakazo"
SRC = "/home/sasajib/the-data/rakazo-src/rakazo"
COMPOSE = ["docker", "compose", "--env-file", ".env", "-f", "docker-compose.images.yml", "-f", "docker-compose.override.yml"]
# Features we built that an upstream merge must never silently drop: (marker, minimum files containing it)
MARKERS = [("admissionHold", 1), ("bot_queue", 4), ("standing_set", 6), ("normalizeLane", 2),
           ("findQueuedDuplicate", 2), ("historyThisChatOnly", 2), ("notice-ledger", 1)]
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


def migrations():
    mdir = SRC + "/packages/db/prisma/migrations"
    # upstream marks drop-after-release migrations "-- deferred": applied by a later step, not by migrate deploy
    on_disk = {d for d in os.listdir(mdir) if d[:2] == "20" and not open(f"{mdir}/{d}/migration.sql").read().lstrip().startswith("-- deferred")}
    applied = set(psql("select migration_name from _prisma_migrations where finished_at is not null and rolled_back_at is null").splitlines())
    check("all repo migrations applied", not (on_disk - applied), sorted(on_disk - applied)[:3] or f"{len(applied)} applied")
    check("runs.lane column exists", psql("select 1 from information_schema.columns where table_name='runs' and column_name='lane'") == "1")


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
    stack(); code_markers(); migrations()
    if "--quick" not in sys.argv:
        live_queue_test()
    print("\nRESULT:", "ALL PASS" if all(results) else f"{results.count(False)} FAILED")
    sys.exit(0 if all(results) else 1)
