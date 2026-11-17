#!/usr/bin/env python3
"""Weekly Rakazo self-audit. Reads the last N days (default 7) and writes a markdown report to
/home/sasajib/the-data/rakazo-audit/weekly/YYYY-MM-DD.md, printing a short summary.
Looks for: overlapping runs in one lane, starved queued work, repeated bot messages, blocked-site stops
(and whether a matching procedure existed), repeated questions, tool error hot spots."""
import datetime, sqlite3, subprocess, sys, os

DAYS = int(sys.argv[1]) if len(sys.argv) > 1 else 7
OUT = "/home/sasajib/the-data/rakazo-audit/weekly"
AUDIT = "/home/sasajib/the-data/rakazo-audit/audit.sqlite"
UNATT = "('bot_message','webhook','routine','tickets')"
TXT = "(select string_agg(b->>'text',' ') from jsonb_array_elements(m.blocks::jsonb) b where b->>'kind'='text')"


def psql(sql):
    out = subprocess.run(["docker", "exec", "rakazo-postgres-1", "psql", "-U", "rakazo", "-d", "rakazo", "-At", "-F", " | ", "-c", sql],
                         capture_output=True, text=True, timeout=120)
    return [l for l in out.stdout.splitlines() if l.strip()] or ([] if not out.stderr else ["ERROR " + out.stderr[:200]])


findings, lines = [], []


def section(title, rows, flag=None, empty="none"):
    lines.append(f"\n## {title}\n")
    lines.extend(["- " + r for r in rows] if rows else [f"- {empty}"])
    if flag and rows:
        findings.append(f"{title}: {len(rows)}")


W = f"now() - interval '{DAYS} days'"

section("Overlapping runs inside one lane (should be 0 since the queue gate)", psql(f"""
select dy || ' ' || nm || ': ' || n || ' pairs, lane ' || ln from (
 select to_char(r1."createdAt" at time zone 'Asia/Dhaka','MM-DD') AS dy, b.name AS nm, coalesce(r1.lane,'(conversation)') AS ln, count(*) AS n
 from runs r1 join runs r2 on r1."botId"=r2."botId" and r1.id<r2.id and r1."startedAt"<r2."updatedAt" and r2."startedAt"<r1."updatedAt"
  and r1.lane is not distinct from r2.lane and (r1.lane is not null or r1."threadId"=r2."threadId")
 join bots b on b.id=r1."botId"
 where r1."createdAt">{W} and r1.trigger='bot_message' and r2.trigger='bot_message' and r1."startedAt" is not null and r2."startedAt" is not null
 group by 1,2,3) x order by dy desc, n desc limit 14"""), flag=True)

section("Slowest waits in the queue (created to started, bot_message runs)", psql(f"""
select b.name || ': max ' || round(max(extract(epoch from r."startedAt"-r."createdAt"))/60) || ' min, avg ' || round(avg(extract(epoch from r."startedAt"-r."createdAt"))/60) || ' min over ' || count(*) || ' runs'
from runs r join bots b on b.id=r."botId" where r."createdAt">{W} and r.trigger='bot_message' and r."startedAt" is not null
group by b.name having max(extract(epoch from r."startedAt"-r."createdAt"))>600 order by 1"""), flag=True, empty="no run waited more than 10 min")

section("Same message sent 3+ times by a bot (repeats)", psql(f"""
select b.name || ' x' || count(*) || ': ' || left(regexp_replace(t,E'\\\\s+',' ','g'),110)
from (select t2."botId" bid, {TXT} t from messages m join threads t2 on t2.id=m."threadId" where m.role='bot' and m."createdAt">{W}) s
join bots b on b.id=s.bid where t is not null and length(t)>40
group by b.name, left(regexp_replace(t,E'\\\\s+',' ','g'),110) having count(*)>=3 order by count(*) desc limit 10"""), flag=True)

section("Blocked-site stops (captcha / Cloudflare / blocked / login wall) per bot per day", psql(f"""
select dy || ' ' || nm || ': ' || n || ' messages' from (
 select to_char(m."createdAt" at time zone 'Asia/Dhaka','MM-DD') AS dy, b.name AS nm, count(*) AS n
 from messages m join threads t on t.id=m."threadId" join bots b on b.id=t."botId"
 where m.role='bot' and m."createdAt">{W} and ({TXT}) ~* '(cloudflare|captcha|press (&|and) hold|turnstile|login wall|blocked)'
 group by 1,2) x order by dy desc, n desc limit 14"""),
    empty="no blocked-site messages")
lines.append("\nCheck each: did a standing order already cover it (r5, r20)? If yes and the bot only reported, the rule wording needs fixing.")

lines.append("\n## Questions to the user (ask_user) per bot\n")
try:
    c = sqlite3.connect(AUDIT)
    since = (datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None) - datetime.timedelta(days=DAYS)).strftime("%Y-%m-%dT%H:%M:%S")
    names = dict(l.split(" | ") for l in psql("select id || ' | ' || name from bots") if " | " in l)
    asks = c.execute("select coalesce(bot_id,'?'), count(*), count(distinct args_hash), sum(args_hash is null) from tool_calls where tool='ask_user' and ts>? group by 1 order by 2 desc", (since,)).fetchall()
    lines.append("")
    for bid, n, distinct, nohash in asks:
        rep = (nohash == 0 and n > distinct)
        lines.append(f"- {names.get(bid, bid[:8])}: {n} ask_user calls" + ("  <- same question repeated" if rep else ""))
        if rep:
            findings.append(f"repeated ask_user ({names.get(bid, bid[:8])})")
    errs = c.execute("select tool, count(*), sum(outcome='error') from tool_calls where ts>? group by 1 having sum(outcome='error')>=5 order by 3 desc limit 8", (since,)).fetchall()
    section("Tool error hot spots (5+ errors)", [f"{e[0]}: {e[2]} errors of {e[1]} calls" for e in errs], flag=True)
except Exception as e:
    lines.append(f"- audit db unreadable: {e}")

section("Bots with long unattended runs (> 20 min)", psql(f"""
select b.name || ': ' || count(*) || ' runs, longest ' || round(max(extract(epoch from r."updatedAt"-r."startedAt"))/60) || ' min'
from runs r join bots b on b.id=r."botId" where r."createdAt">{W} and r.trigger in {UNATT} and r."startedAt" is not null and r.status='completed'
 and r."updatedAt"-r."startedAt" > interval '20 minutes' group by b.name order by 1"""), empty="none")

today = datetime.date.today().isoformat()
os.makedirs(OUT, exist_ok=True)
path = f"{OUT}/{today}.md"
open(path, "w").write(f"# Rakazo weekly self-audit {today} (last {DAYS} days)\n" + "\n".join(lines) + "\n")
print(f"Report: {path}")
print("FINDINGS: " + ("; ".join(findings) if findings else "none flagged"))
