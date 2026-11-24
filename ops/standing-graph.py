#!/usr/bin/env python3
"""The standing orders as a graph. Everything here is DERIVED from STANDING.md (read through the web RPC):
an AGE graph in Rakazo's Postgres can always be rebuilt, because AGE graphs do not survive pg_dump/restore.

    python3 ops/standing-graph.py show                 rules by tier with their links (text)
    python3 ops/standing-graph.py sync                 rebuild the AGE graph 'standing' from STANDING.md
    python3 ops/standing-graph.py impact <key> [hops]  rules within N links of <key> (needs sync; default 2 hops)
    python3 ops/standing-graph.py pairs [out.json]     rule pairs worth judging for contradictions (linked, same tag,
                                                       similar wording, or close in meaning) with both texts

Nodes carry only key, kind, tier; rule text never goes into the graph.
"""
import itertools
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rakazo_rpc import Rpc  # noqa: E402

LINE = re.compile(r"^- \[(rule|decision) ([^\]\s]+)((?: [^\]\s]+)*)\] (\d{4}-\d{2}-\d{2}): (.*)$")
GRAPH = "standing"


def load_entries():
    docs = Rpc().call("memory/list", {"scope": "user"})["json"]
    content = next(d["content"] for d in docs if d["path"] == "STANDING.md")
    entries = []
    for line in content.splitlines():
        m = LINE.match(line.strip())
        if not m:
            continue
        e = {"kind": m[1], "key": m[2], "date": m[4], "text": m[5], "tier": 2,
             "overrides": [], "exception_of": [], "depends_on": [], "tags": []}
        for tok in m[3].split():
            if re.fullmatch(r"p[0-3]", tok):
                e["tier"] = int(tok[1])
            elif tok[0] == ">":
                e["overrides"].append(tok[1:])
            elif tok[0] == "^":
                e["exception_of"].append(tok[1:])
            elif tok[0] == "+":
                e["depends_on"].append(tok[1:])
            elif tok[0] == "@":
                e["tags"].append(tok[1:])
        entries.append(e)
    return entries


def psql(sql, db="rakazo"):
    r = subprocess.run(["docker", "exec", "-i", "rakazo-postgres-1", "psql", "-U", "rakazo", "-d", db, "-At", "-v", "ON_ERROR_STOP=1"],
                       input=sql, capture_output=True, text=True, timeout=120)
    if r.returncode:
        raise RuntimeError(r.stderr.strip()[:400])
    return r.stdout


def edges(entries):
    out = []
    for e in entries:
        out += [(e["key"], "OVERRIDES", k) for k in e["overrides"]]
        out += [(e["key"], "EXCEPTION_OF", k) for k in e["exception_of"]]
        out += [(e["key"], "DEPENDS_ON", k) for k in e["depends_on"]]
    return out


def cmd_show(entries):
    by = sorted(entries, key=lambda e: (e["tier"], e["key"]))
    names = {0: "p0 safety and approvals", 1: "p1 explicit commands", 2: "p2 procedures", 3: "p3 preferences"}
    for tier in range(4):
        group = [e for e in by if e["tier"] == tier]
        if not group:
            continue
        print(f"\n{names[tier]} ({len(group)})")
        for e in group:
            links = [f"wins over {k}" for k in e["overrides"]] + [f"exception of {k}" for k in e["exception_of"]] + \
                    [f"needs {k}" for k in e["depends_on"]] + [f"@{t}" for t in e["tags"]]
            print(f"  {e['key']}" + (f"  -> {'; '.join(links)}" if links else ""))
    keys = {e["key"] for e in entries}
    dangling = [(a, t, b) for a, t, b in edges(entries) if b not in keys]
    print(f"\n{len(entries)} entries, {len(edges(entries))} links" + (f", DANGLING: {dangling}" if dangling else ""))


def cmd_sync(entries):
    keys = {e["key"] for e in entries}
    cy = lambda q: f"SELECT * FROM cypher('{GRAPH}', $$ {q} $$) AS (x agtype);"
    sql = ["LOAD 'age';", "SET search_path = ag_catalog, public;",
           # a graph restored from a dump is unusable (stale OIDs): remove it by name, then rebuild
           f"DO $$ BEGIN IF EXISTS (SELECT 1 FROM ag_graph WHERE name='{GRAPH}') THEN BEGIN PERFORM drop_graph('{GRAPH}', true); "
           f"EXCEPTION WHEN OTHERS THEN DELETE FROM ag_graph WHERE name='{GRAPH}'; EXECUTE 'DROP SCHEMA IF EXISTS {GRAPH} CASCADE'; END; END IF; END $$;",
           f"SELECT create_graph('{GRAPH}');"]
    for e in entries:
        sql.append(cy(f"CREATE (:Rule {{key:'{e['key']}', kind:'{e['kind']}', tier:{e['tier']}}})"))
    tags = sorted({t for e in entries for t in e["tags"]})
    for t in tags:
        sql.append(cy(f"CREATE (:Tag {{name:'{t}'}})"))
    skipped = []
    for a, typ, b in edges(entries):
        if b not in keys:
            skipped.append((a, typ, b))
            continue
        sql.append(cy(f"MATCH (a:Rule {{key:'{a}'}}), (b:Rule {{key:'{b}'}}) CREATE (a)-[:{typ}]->(b)"))
    for e in entries:
        for t in e["tags"]:
            sql.append(cy(f"MATCH (a:Rule {{key:'{e['key']}'}}), (t:Tag {{name:'{t}'}}) CREATE (a)-[:APPLIES_TO]->(t)"))
    psql("\n".join(sql))
    n = psql(f"LOAD 'age'; SET search_path = ag_catalog, public; SELECT * FROM cypher('{GRAPH}', $$ MATCH (r:Rule) RETURN count(r) $$) AS (n agtype);").strip().splitlines()[-1]
    m = psql(f"LOAD 'age'; SET search_path = ag_catalog, public; SELECT * FROM cypher('{GRAPH}', $$ MATCH ()-[e]->() RETURN count(e) $$) AS (n agtype);").strip().splitlines()[-1]
    print(f"graph '{GRAPH}' rebuilt: {n} rules, {len(tags)} tags, {m} edges" + (f"; skipped dangling {skipped}" if skipped else ""))


def cmd_impact(key, hops=2):
    if not re.fullmatch(r"[a-z0-9._-]+", key):
        sys.exit("bad key")
    out = psql(f"LOAD 'age'; SET search_path = ag_catalog, public; SELECT * FROM cypher('{GRAPH}', $$ MATCH (a:Rule {{key:'{key}'}})-[*1..{int(hops)}]-(b) "
               f"RETURN DISTINCT coalesce(b.key, b.name), b.tier $$) AS (name agtype, tier agtype);")
    rows = [l for l in out.splitlines() if "|" in l]
    print(f"within {hops} links of {key}:")
    for l in sorted(rows):
        name, tier = (x.strip('"') for x in l.split("|"))
        print(f"  {name}" + (f" (p{tier})" if tier not in ("", "null") else " (tag)"))
    if not rows:
        print("  nothing linked")


def words(t):
    return set(w for w in re.sub(r"[^\w\s]", " ", t.lower()).split() if len(w) > 3)


def cmd_pairs(entries, out_path):
    by = {e["key"]: e for e in entries}
    reasons = {}
    def add(a, b, why):
        reasons.setdefault(tuple(sorted((a, b))), set()).add(why)
    for a, typ, b in edges(entries):
        if b in by:
            add(a, b, f"linked ({typ.lower()})")
    for t in {t for e in entries for t in e["tags"]}:
        for a, b in itertools.combinations([e["key"] for e in entries if t in e["tags"]], 2):
            add(a, b, f"same tag @{t}")
    for a, b in itertools.combinations(entries, 2):
        wa, wb = words(a["text"]), words(b["text"])
        if wa and wb and len(wa & wb) / len(wa | wb) >= 0.25:
            add(a["key"], b["key"], "similar wording")
    try:  # close in meaning (pgvector), when the embeddings exist
        rows = psql("""select x."key", y."key", round((1 - (x.embedding <=> y.embedding))::numeric, 2)
                       from standing_embeddings x join standing_embeddings y on y."spaceId"=x."spaceId" and x."key"<y."key"
                       where x.embedding is not null and y.embedding is not null and 1-(x.embedding <=> y.embedding) >= 0.65""")
        for l in rows.splitlines():
            a, b, s = l.split("|")
            if a in by and b in by:
                add(a, b, f"close in meaning ({s})")
    except RuntimeError as ex:
        print("note: no embeddings available:", str(ex)[:80], file=sys.stderr)
    pairs = [{"a": a, "b": b, "why": sorted(w), "a_text": by[a]["text"], "b_text": by[b]["text"],
              "a_tier": by[a]["tier"], "b_tier": by[b]["tier"]} for (a, b), w in sorted(reasons.items()) if a in by and b in by]
    json.dump({"entries": len(entries), "pairs": pairs}, open(out_path, "w"), indent=1, ensure_ascii=False)
    print(f"{len(pairs)} candidate pairs from {len(entries)} entries -> {out_path}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "show"
    entries = load_entries()
    if cmd == "show":
        cmd_show(entries)
    elif cmd == "sync":
        cmd_sync(entries)
    elif cmd == "impact":
        cmd_impact(sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 2)
    elif cmd == "pairs":
        cmd_pairs(entries, sys.argv[2] if len(sys.argv) > 2 else "/home/sasajib/the-data/rakazo-audit/weekly/standing-pairs.json")
    else:
        sys.exit(__doc__)
