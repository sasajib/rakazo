#!/usr/bin/env python3
"""Retire duplicate live facts in the memory ledger (fork, FORK.md 1.10).

Dry run by default: prints the clusters it found and what it would change, and changes nothing.
With --apply it first writes every affected row to a JSONL backup, then, in ONE transaction,
marks each copy `superseded` with `validTo` = now and adds a `supersedes` link from the fact
that stays to the copy: the same status and link the ledger's own writer uses when a newer fact
retires an older one (packages/adapters/src/memory-ledger/writer.ts `apply`). Running it again
finds nothing left to do.

What counts as a duplicate (the writer's own rules since the idempotency fix):
  * exact  - the same words in the same order (text.ts `sameText`, the `textKey` unique index);
  * near   - embedding cosine >= --threshold (scoring.ts NEAR_DUPLICATE_SIMILARITY, 0.92) AND
             the same numbers/dates in both texts (text.ts `sameNumbers`).
A cluster is one fact that stays plus the facts directly matching IT (no chains: A~B and B~C
does not put C with A). The fact that stays is the oldest confirmed one, else the oldest.

Never touched:
  * disputed facts and any fact on an unanswered `contradicts` link (an open conflict: only the
    owner's answer settles it);
  * tentative facts the owner was asked about on a card (`askedAt` set);
  * a confirmed fact whose words differ from the fact that stays (the owner confirmed it
    differently); an exact confirmed copy is retired like any other copy.

Reads and writes go through psql, so no Python driver is needed:
  python3 ops/memory-ledger-dedupe.py                       # dry run on the live stack
  python3 ops/memory-ledger-dedupe.py --apply               # backup, then retire the copies
  python3 ops/memory-ledger-dedupe.py --psql "docker exec -i scratch-pg psql -U postgres -d copy"

Output names facts by id prefix, subject, status and writer; fact text is printed only with
--show-text. The backup file holds full rows (text included): keep it with the stack backups.
"""

from __future__ import annotations

import argparse
import collections
import datetime
import json
import os
import re
import shlex
import subprocess
import sys
import unicodedata

DEFAULT_PSQL = "docker exec -i rakazo-postgres-1 psql -U rakazo -d rakazo"
LIVE = ("tentative", "confirmed", "disputed")
ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,64}$")


def psql(command: str, sql: str, *, stop_on_error: bool = False) -> str:
    args = shlex.split(command) + ["-At", "-X", "-q"]
    if stop_on_error:
        args += ["-v", "ON_ERROR_STOP=1"]
    else:
        # Every read runs in a read-only session, so a dry run cannot change anything.
        sql = "SET default_transaction_read_only = on;\n" + sql
    done = subprocess.run(args + ["-f", "-"], input=sql, capture_output=True, text=True)
    if done.returncode != 0:
        raise SystemExit(f"psql failed ({done.returncode}): {done.stderr.strip()[:800]}")
    return done.stdout


def fold(value: str) -> str:
    value = unicodedata.normalize("NFD", value)
    value = "".join(ch for ch in value if not 0x300 <= ord(ch) <= 0x36F)
    return re.sub(r"\s+", " ", value).strip().lower()


def tokens(value: str) -> list[str]:
    return re.findall(r"[^\W_]+", fold(value))


def text_key(value: str) -> str:
    return " ".join(tokens(value))


def numbers(value: str) -> str:
    return " ".join(sorted(word for word in tokens(value) if re.search(r"\d", word)))


def load(command: str, space: str | None, threshold: float):
    where_space = ""
    if space:
        if not ID_RE.match(space):
            raise SystemExit("--space: not an id")
        where_space = f""" AND f."spaceId" = '{space}'"""
    statuses = ",".join(f"'{status}'" for status in LIVE)
    facts = json.loads(
        psql(
            command,
            f"""SELECT coalesce(json_agg(t ORDER BY t."createdAt", t.id), '[]') FROM (
                  SELECT f.id, f."spaceId", f.area, f.subject, f.text, f.status, f.mentions,
                         f."sourceRunId", f."writtenByBotName", f."createdAt", f."askedAt",
                         f.embedding IS NOT NULL AS embedded
                  FROM "memory_facts" f WHERE f.status IN ({statuses}){where_space}) t""",
        )
        or "[]"
    )
    open_links = json.loads(
        psql(
            command,
            """SELECT coalesce(json_agg(json_build_array("fromId", "toId")), '[]')
               FROM "memory_fact_links" WHERE kind = 'contradicts' AND "resolvedAt" IS NULL""",
        )
        or "[]"
    )
    similar = {}
    rows = psql(
        command,
        f"""SELECT a.id, b.id, round((1 - (a.embedding <=> b.embedding))::numeric, 4)
            FROM "memory_facts" a JOIN "memory_facts" b
              ON a."spaceId" = b."spaceId" AND a.id < b.id
            WHERE a.status IN ({statuses}) AND b.status IN ({statuses})
              AND a.embedding IS NOT NULL AND b.embedding IS NOT NULL
              AND 1 - (a.embedding <=> b.embedding) >= {threshold:.4f}""",
    )
    for line in rows.splitlines():
        left, right, score = line.split("|")
        similar[(left, right)] = float(score)
    return facts, open_links, similar


def plan(facts, open_links, similar, threshold: float):
    """Clusters as (keeper, [(copy, reason, similarity)]), plus what was left alone and why."""
    in_open_conflict = {fact_id for pair in open_links for fact_id in pair}
    skipped = collections.Counter()
    eligible = []
    for fact in facts:
        if fact["status"] == "disputed" or fact["id"] in in_open_conflict:
            skipped["open conflict (disputed or unanswered contradicts link)"] += 1
        elif fact["status"] == "tentative" and fact["askedAt"]:
            skipped["owner was asked about it on a card"] += 1
        else:
            eligible.append(fact)

    def score(a, b) -> float:
        return similar.get((min(a["id"], b["id"]), max(a["id"], b["id"])), 0.0)

    # Confirmed first, then oldest: the order in which facts get to be the one that stays.
    order = sorted(eligible, key=lambda f: (f["status"] != "confirmed", f["createdAt"], f["id"]))
    taken: set[str] = set()
    clusters = []
    confirmed_differently = []
    reported: set[tuple[str, str]] = set()
    for keeper in order:
        if keeper["id"] in taken:
            continue
        copies = []
        for other in order:
            if other["id"] == keeper["id"] or other["id"] in taken:
                continue
            if other["spaceId"] != keeper["spaceId"]:
                continue
            exact = text_key(other["text"]) == text_key(keeper["text"]) != ""
            near = score(keeper, other)
            if exact:
                copies.append((other, "exact", near or 1.0))
            elif near >= threshold and numbers(other["text"]) == numbers(keeper["text"]):
                if other["status"] == "confirmed":
                    # The owner confirmed this wording too: both stay.
                    pair = (min(keeper["id"], other["id"]), max(keeper["id"], other["id"]))
                    if pair not in reported:
                        reported.add(pair)
                        confirmed_differently.append((keeper, other, near))
                    continue
                copies.append((other, "near", near))
        if copies:
            taken.add(keeper["id"])
            taken.update(copy["id"] for copy, _, _ in copies)
            clusters.append((keeper, copies))
    return clusters, skipped, confirmed_differently


def short(fact) -> str:
    return f'{fact["id"][:8]} {fact["status"][:4]} {fact["createdAt"][:16]} [{fact["writtenByBotName"] or "-"}] {fact["subject"] or "-"}'


def report(facts, clusters, skipped, confirmed_differently, show_text: bool) -> int:
    copies = [(keeper, copy, reason, sim) for keeper, group in clusters for copy, reason, sim in group]
    print(f"live facts: {len(facts)}")
    for reason, count in sorted(skipped.items()):
        print(f"  left alone, {reason}: {count}")
    exact = sum(1 for _, _, reason, _ in copies if reason == "exact")
    print(f"clusters: {len(clusters)}  (facts that stay: {len(clusters)}, copies to retire: {len(copies)}; exact {exact}, near {len(copies) - exact})")
    print(f"live facts after: {len(facts) - len(copies)}")
    if confirmed_differently:
        print(f"near pairs left alone because both are confirmed with different words: {len(confirmed_differently)}")
        for keeper, other, sim in confirmed_differently:
            print(f"    {short(keeper)}  ~{sim:.3f}~  {short(other)}")
    by_writer = collections.Counter(
        (copy["writtenByBotName"] or "-", copy["createdAt"][:10]) for _, copy, _, _ in copies
    )
    live_by_writer = collections.Counter(
        (fact["writtenByBotName"] or "-", fact["createdAt"][:10]) for fact in facts
    )
    print("copies to retire per writer and day (of live facts written that day):")
    for (writer, day), count in sorted(by_writer.items(), key=lambda item: (item[0][1], item[0][0])):
        print(f"    {day}  {writer}: {count} of {live_by_writer[(writer, day)]}")
    print("clusters (first line stays):")
    for keeper, group in clusters:
        print(f"  KEEP   {short(keeper)}" + (f'  "{keeper["text"]}"' if show_text else ""))
        for copy, reason, sim in group:
            print(
                f"    retire {short(copy)}  {reason} sim={sim:.3f}"
                + (f'  "{copy["text"]}"' if show_text else "")
            )
    return len(copies)


def backup_rows(command: str, ids: list[str], path: str) -> int:
    quoted = ",".join(f"'{fact_id}'" for fact_id in ids)
    rows = psql(
        command,
        f"""SELECT (to_jsonb(f) - 'embedding' - 'fts')::text FROM "memory_facts" f WHERE f.id IN ({quoted}) ORDER BY f.id""",
    ).splitlines()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as handle:
        for row in rows:
            handle.write(row + "\n")
    return len(rows)


def apply(command: str, clusters) -> str:
    statuses = ",".join(f"'{status}'" for status in LIVE)
    statements = ["BEGIN;"]
    for keeper, group in clusters:
        for copy, _reason, sim in group:
            for fact_id in (keeper["id"], copy["id"], keeper["spaceId"]):
                if not ID_RE.match(fact_id):
                    raise SystemExit(f"refusing an id that is not an id: {fact_id!r}")
            # Only while both are still live: a fact the ledger changed since the plan is skipped.
            statements.append(
                f"""WITH retired AS (
                      UPDATE "memory_facts" SET "status" = 'superseded',
                             "validTo" = (now() AT TIME ZONE 'utc'), "updatedAt" = (now() AT TIME ZONE 'utc')
                      WHERE "id" = '{copy["id"]}' AND "status" IN ({statuses}) AND "status" <> 'disputed'
                        AND EXISTS (SELECT 1 FROM "memory_facts" k WHERE k."id" = '{keeper["id"]}' AND k."status" IN ({statuses}))
                      RETURNING "id", "spaceId")
                    INSERT INTO "memory_fact_links" ("id", "spaceId", "fromId", "toId", "kind", "score")
                    SELECT gen_random_uuid()::text, "spaceId", '{keeper["id"]}', "id", 'supersedes', {sim:.2f} FROM retired
                    ON CONFLICT ("fromId", "toId", "kind") DO NOTHING;"""
            )
    statements.append(
        """SELECT 'superseded now: ' || count(*) FROM "memory_facts" WHERE "status" = 'superseded' AND "validTo" > (now() AT TIME ZONE 'utc') - interval '1 minute';"""
    )
    statements.append("COMMIT;")
    return psql(command, "\n".join(statements), stop_on_error=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    parser.add_argument("--psql", default=DEFAULT_PSQL, help=f"psql command (default: {DEFAULT_PSQL})")
    parser.add_argument("--apply", action="store_true", help="change the database (default: dry run)")
    parser.add_argument("--threshold", type=float, default=0.92, help="cosine similarity of a near duplicate")
    parser.add_argument("--space", help="only this space id")
    parser.add_argument("--backup", help="backup file for --apply (default: ./memory-ledger-dedupe-<utc>.jsonl)")
    parser.add_argument("--show-text", action="store_true", help="print fact text (private) beside each id")
    args = parser.parse_args()
    if not 0.5 <= args.threshold <= 1:
        raise SystemExit("--threshold must be between 0.5 and 1")

    facts, open_links, similar = load(args.psql, args.space, args.threshold)
    clusters, skipped, confirmed_differently = plan(facts, open_links, similar, args.threshold)
    print(f"mode: {'APPLY' if args.apply else 'dry run (nothing is changed)'}; near threshold {args.threshold}")
    to_retire = report(facts, clusters, skipped, confirmed_differently, args.show_text)
    if not args.apply:
        print(f"dry run: would mark {to_retire} fact(s) superseded and add {to_retire} supersedes link(s); re-run with --apply to do it")
        return 0
    if not to_retire:
        print("nothing to do")
        return 0
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d-%H%M%S")
    path = args.backup or f"memory-ledger-dedupe-{stamp}.jsonl"
    ids = sorted({keeper["id"] for keeper, _ in clusters} | {copy["id"] for _, group in clusters for copy, _, _ in group})
    saved = backup_rows(args.psql, ids, path)
    if saved != len(ids):
        raise SystemExit(f"backup holds {saved} rows, expected {len(ids)}; nothing was changed")
    print(f"backup: {saved} rows (facts that stay and copies) -> {path}")
    print(apply(args.psql, clusters).strip())
    after, _, _ = load(args.psql, args.space, args.threshold)
    print(f"applied: live facts now {len(after)} (was {len(facts)})")
    print(
        "undo: for each backed-up row whose status changed, "
        'UPDATE "memory_facts" SET "status" = <old>, "validTo" = <old> WHERE "id" = <id>; '
        "and delete the supersedes links created at that minute"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
