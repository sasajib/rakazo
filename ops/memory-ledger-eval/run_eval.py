#!/usr/bin/env python3
"""Memory-ledger eval: fixed scripted conversations against a LIVE Rakazo instance.

What it proves (each scenario prints PASS/FAIL with evidence from the database, never from what
a bot says): facts are saved silently, repeats confirm, corrections supersede, a contradiction of
a confirmed fact posts ONE memory-check card and the owner's "new" settles it, and questions,
secrets, one-off tasks, pasted third-party text and web content are NOT saved.

Run it only against a throwaway bot (create one, run, archive it). Every scenario uses invented
names tagged with a run nonce, so it never collides with the owner's real facts, and it only
reads/writes rows it caused. Nothing is deleted.

Transport (pick one):
  --neo                      drive the RPC through the signed-in BrowserOS Neo tab (127.0.0.1:9210),
                             the same way ops/rakazo_rpc.py does
  --base-url URL --cookie-file FILE
                             POST {base}/rpc/<path> with a session cookie read from FILE
Database checks: `docker exec <pg-container> psql` (default rakazo-postgres-1, user/db rakazo).

  python3 ops/memory-ledger-eval/run_eval.py --neo --bot-id <id> [--only fact-stated,...]
  python3 ops/memory-ledger-eval/run_eval.py --list
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCENARIOS = json.loads((HERE / "scenarios.json").read_text())


# --- transports ------------------------------------------------------------------------------

class NeoRpc:
    """Rakazo RPC through the signed-in Neo tab (see ops/rakazo_rpc.py in the fork)."""

    URL = "http://127.0.0.1:9210/mcp"
    HDR = {"content-type": "application/json", "accept": "application/json, text/event-stream"}

    def __init__(self, host_pattern: str):
        self.n = 10
        self.sid = None
        self.sid, _ = self._post({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "ledger-eval", "version": "1"}}})
        self._post({"jsonrpc": "2.0", "method": "notifications/initialized"})
        _, txt = self._post({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                             "params": {"name": "tabs", "arguments": {"action": "list"}}})
        m = re.search(r"\[(\d+)\]\s+https://" + re.escape(host_pattern), txt)
        if not m:
            raise SystemExit(f"no Neo tab open on {host_pattern}")
        self.page = int(m.group(1))

    def _post(self, body):
        h = dict(self.HDR)
        if self.sid:
            h["mcp-session-id"] = self.sid
        r = urllib.request.urlopen(urllib.request.Request(self.URL, json.dumps(body).encode(), h), timeout=120)
        return r.headers.get("mcp-session-id") or self.sid, r.read().decode()

    def call(self, path: str, payload: dict) -> dict:
        self.n += 1
        code = ("const p = browser.page(%d);\nconst out = await p.evaluate(async (a) => { const r = await fetch('/rpc/'+a.path, "
                "{method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body: JSON.stringify({json:a.j, meta: []})}); "
                "return {status:r.status, text:(await r.text()).slice(0,200000)}; }, {path:%s, j:%s});\nreturn JSON.stringify(out);"
                % (self.page, json.dumps(path), json.dumps(payload)))
        _, txt = self._post({"jsonrpc": "2.0", "id": self.n, "method": "tools/call",
                             "params": {"name": "run", "arguments": {"code": code}}})
        line = [l for l in txt.split("\n") if l.startswith("data: {")][0][6:]
        value = json.loads(json.loads(line)["result"]["structuredContent"]["value"])
        out = value.get("value", value)
        if isinstance(out, str):
            out = json.loads(out)
        return {"status": out["status"], "json": json.loads(out["text"]).get("json") if out["text"].startswith("{") else None}


class CookieRpc:
    def __init__(self, base_url: str, cookie: str):
        self.base = base_url.rstrip("/")
        self.cookie = cookie

    def call(self, path: str, payload: dict) -> dict:
        req = urllib.request.Request(f"{self.base}/rpc/{path}", json.dumps({"json": payload, "meta": []}).encode(),
                                     {"content-type": "application/json", "cookie": self.cookie})
        try:
            r = urllib.request.urlopen(req, timeout=120)
            return {"status": r.status, "json": json.loads(r.read().decode()).get("json")}
        except urllib.error.HTTPError as error:
            return {"status": error.code, "json": None}


# --- database --------------------------------------------------------------------------------

class Db:
    def __init__(self, container: str, user: str, db: str):
        self.cmd = ["docker", "exec", "-i", container, "psql", "-U", user, "-d", db, "-At", "-F", "\t", "-v", "ON_ERROR_STOP=1"]

    def rows(self, sql: str) -> list[list[str]]:
        out = subprocess.run(self.cmd, input=sql, capture_output=True, text=True, timeout=60)
        if out.returncode:
            raise RuntimeError(out.stderr.strip())
        return [line.split("\t") for line in out.stdout.splitlines() if line]

    @staticmethod
    def q(value: str) -> str:
        return "'" + value.replace("'", "''") + "'"


# --- running ---------------------------------------------------------------------------------

TERMINAL = ("completed", "failed", "cancelled", "waiting_input")


def wait_for_learning(db: Db, bot_id: str, since: str, timeout_s: int) -> list[str]:
    """Waits until the bot's runs since `since` are finished and their ledger jobs are done."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        runs = db.rows(f"""select id, status from runs where "botId" = {db.q(bot_id)}
                           and "createdAt" >= {db.q(since)}::timestamp order by "createdAt" """)
        if runs and all(status in TERMINAL for _, status in runs):
            ids = [run_id for run_id, _ in runs]
            jobs = db.rows(f"""select "runId", status from memory_ledger_jobs
                               where "runId" in ({",".join(db.q(i) for i in ids)})""")
            # Runs that are not owner chat runs have no job; the rest must be done or failed.
            if all(status in ("done", "failed") for _, status in jobs) and len(jobs) >= 1:
                return ids
        time.sleep(3)
    raise TimeoutError("runs or ledger jobs did not finish")


def facts_like(db: Db, space_id: str, needle: str) -> list[dict]:
    rows = db.rows(f"""select id, status, mentions, text, quote from memory_facts
                       where "spaceId" = {db.q(space_id)} and (text ilike {db.q('%' + needle + '%')}
                       or quote ilike {db.q('%' + needle + '%')}) order by "createdAt" """)
    return [dict(zip(["id", "status", "mentions", "text", "quote"], row)) for row in rows]


def card_in_thread(db: Db, thread_id: str, since: str) -> int:
    rows = db.rows(f"""select count(*) from messages where "threadId" = {db.q(thread_id)} and role = 'bot'
                       and "clientNonce" like 'memory-ledger:%' and "createdAt" >= {db.q(since)}::timestamp""")
    return int(rows[0][0]) if rows else 0


def check(expect: dict, db: Db, space_id: str, thread_id: str, since: str, tag: str) -> list[str]:
    problems = []
    for item in expect.get("saved", []):
        needle = item["contains"].replace("{N}", tag)
        found = [f for f in facts_like(db, space_id, needle) if f["status"] in item.get("status", ["tentative", "confirmed", "disputed"])]
        if not found:
            problems.append(f"expected a fact containing {needle!r} with status {item.get('status')}")
        elif "min_mentions" in item and max(int(f["mentions"]) for f in found) < item["min_mentions"]:
            problems.append(f"{needle!r}: mentions below {item['min_mentions']}")
    for item in expect.get("not_saved", []):
        needle = item.replace("{N}", tag)
        live = [f for f in facts_like(db, space_id, needle) if f["status"] in ("tentative", "confirmed", "disputed")]
        if live:
            problems.append(f"must not be saved but found: {live[0]['text']!r}")
    if "cards" in expect:
        cards = card_in_thread(db, thread_id, since)
        if cards != expect["cards"]:
            problems.append(f"expected {expect['cards']} memory-check card(s), found {cards}")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--neo", action="store_true")
    parser.add_argument("--neo-host", default="agents.mindshare.website/")
    parser.add_argument("--base-url")
    parser.add_argument("--cookie-file")
    parser.add_argument("--bot-id")
    parser.add_argument("--only", default="")
    parser.add_argument("--pg-container", default="rakazo-postgres-1")
    parser.add_argument("--pg-user", default="rakazo")
    parser.add_argument("--pg-db", default="rakazo")
    parser.add_argument("--turn-timeout", type=int, default=240)
    parser.add_argument("--report", default="")
    args = parser.parse_args()
    if args.list:
        for s in SCENARIOS:
            print(f"{s['id']:28} {s['about']}")
        return 0
    if not args.bot_id:
        parser.error("--bot-id is required (use a throwaway bot)")
    rpc = NeoRpc(args.neo_host) if args.neo else CookieRpc(args.base_url, Path(args.cookie_file).read_text().strip())
    db = Db(args.pg_container, args.pg_user, args.pg_db)
    bot = db.rows(f"""select b."spaceId", t.id from bots b join threads t on t."botId" = b.id
                      where b.id = {db.q(args.bot_id)} order by t."createdAt" limit 1""")
    if not bot:
        raise SystemExit("bot or its thread not found")
    space_id, thread_id = bot[0]
    if not db.rows("select 1 from information_schema.tables where table_name = 'memory_facts'"):
        raise SystemExit("memory_facts table missing: the ledger migration is not applied")
    tag = uuid.uuid4().hex[:6]
    only = {x for x in args.only.split(",") if x}
    results = []
    for scenario in SCENARIOS:
        if only and scenario["id"] not in only:
            continue
        since = db.rows("select (now() at time zone 'UTC')::text")[0][0]
        problems: list[str] = []
        try:
            for turn in scenario["turns"]:
                text = turn.replace("{N}", tag)
                sent = rpc.call("threads/send", {"botId": args.bot_id, "text": text, "clientNonce": f"ledger-eval-{uuid.uuid4().hex}"})
                if sent["status"] != 200:
                    raise RuntimeError(f"threads/send returned {sent['status']}")
                wait_for_learning(db, args.bot_id, since, args.turn_timeout)
            problems = check(scenario["expect"], db, space_id, thread_id, since, tag)
        except Exception as error:  # noqa: BLE001 - reported per scenario
            problems = [f"error: {error}"]
        verdict = "PASS" if not problems else "FAIL"
        results.append({"id": scenario["id"], "verdict": verdict, "problems": problems})
        print(f"{verdict} {scenario['id']}" + "".join(f"\n     - {p}" for p in problems), flush=True)
    passed = sum(r["verdict"] == "PASS" for r in results)
    print(f"\n{passed}/{len(results)} passed (tag {tag})")
    if args.report:
        Path(args.report).write_text(json.dumps({"tag": tag, "results": results}, indent=2))
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
