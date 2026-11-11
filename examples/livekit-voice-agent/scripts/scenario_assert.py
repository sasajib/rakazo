#!/usr/bin/env python3
"""End-to-end gate for how a call FEELS, not just whether a task completes.

Runs the whole scenario against the live stack with a synthetic caller (`scenario_caller.py`):

  1. caller asks (by voice) for a new voice agent to be created;
  2. the bot must CONFIRM it out loud, before the result exists;
  3. while it works, the caller asks an unrelated question — it must be answered first;
  4. the bot then reports on the task, naming it;
  5. the caller cuts the report off with another question — answered, then the bot says which
     report it is returning to and continues from where it stopped (not from the top);
  6. every spoken line must also be written in the chat;
  7. the agent must really exist in the database afterwards.

Usage:  python3 scenario_assert.py [--name "Scenario Check"]
Prints the timeline, then PASS/FAIL per check. Exit code 1 on any failure.
Test runs create a real bot in the space; the report says which and archives nothing itself.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent))
from call_assert import APP, BOT, SPACE, bots_snapshot, pcm_for  # noqa: E402

sys.path.insert(0, "/home/sasajib/.hermes/cache/scratch")
from rakazo_rpc import Client  # noqa: E402


def norm(text: str) -> list[str]:
    return re.sub(r"[^a-z0-9 ]", " ", text.lower()).split()


def sentences(text: str) -> list[str]:
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+|\n+", text) if len(norm(s)) >= 3]


def parse_iso(stamp: str) -> float:
    return datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="", help="agent name; default is unique per run so it is never 'already there'")
    ap.add_argument("--task", default="Please run the shell command sleep forty on your computer, and after that create one new voice testing agent called {name}, then tell me its id.")
    ap.add_argument("--question", default="Quick question, what is the capital of India?")
    ap.add_argument("--interrupt", default="Wait, quick question. What is two plus two?")
    ap.add_argument("--max-seconds", type=float, default=240)
    args = ap.parse_args()
    if not args.name:
        import random
        import string

        args.name = "Probe " + "".join(random.choices(string.ascii_uppercase, k=4))

    client = Client()
    client.sign_in()
    client.use_first_space()
    work = Path(tempfile.mkdtemp())
    (work / "bearer").write_text(client.token)
    pcms = {
        "task": pcm_for(args.task.format(name=args.name), work, 0),
        "question": pcm_for(args.question, work, 1),
        "interrupt": pcm_for(args.interrupt, work, 2),
    }

    before = bots_snapshot()
    started = datetime.now(timezone.utc).timestamp()
    result = subprocess.run(
        [
            "docker", "run", "--rm", "--network", "host",
            "-v", f"{APP}:/app", "-v", f"{work}:/pcm:ro", "-w", "/app", "rakazo-voice-agent",
            "python", "scripts/scenario_caller.py",
            "--token-url", "http://127.0.0.1:3320", "--bearer-file", "/pcm/bearer",
            "--bot-id", BOT, "--space-id", SPACE,
            "--task-pcm", f"/pcm/{pcms['task'].name}",
            "--question-pcm", f"/pcm/{pcms['question'].name}",
            "--interrupt-pcm", f"/pcm/{pcms['interrupt'].name}",
            "--max-seconds", str(args.max_seconds),
        ],
        capture_output=True, text=True, timeout=args.max_seconds + 120,
    )
    events = []
    for line in result.stdout.splitlines():
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    if not events:
        print("FAIL: the caller produced no events\n", result.stdout[-800:], result.stderr[-800:])
        return 1
    after = bots_snapshot()

    # ---- what was said, in order of speech --------------------------------------------------
    user_say = {e["name"]: e for e in events if e["e"] == "utterance_start"}
    ends = {e["name"]: e for e in events if e["e"] == "utterance_end"}
    captions = [e for e in events if e["e"] == "caption" and e["who"] == "agent"]
    print("\n=== timeline ===")
    for e in events:
        if e["e"] == "caption":
            print(f"{e['t']:6.1f}s  {e['who']:<5} {e['text'][:150]}")
        elif e["e"] in ("utterance_start", "barge_in", "timeout", "ack_started"):
            print(f"{e['t']:6.1f}s  -- {e['e']} {json.dumps({k: v for k, v in e.items() if k not in ('t', 'e')})}")
        elif e["e"] in ("agent_speaking_start", "agent_speaking_end"):
            print(f"{e['t']:6.1f}s     {e['e']}")

    failures: list[str] = []
    print("\n=== chat (bot messages written during the call) ===")
    _thread = client.rpc("threads/get", {"botId": BOT})
    for m in _thread["messages"]:
        if parse_iso(m["createdAt"]) >= started - 2:
            body = " / ".join(b.get("text", b.get("kind", "")) for b in m["blocks"])[:170]
            print(f"  {m['createdAt'][11:19]} {m['role']:<4} run={str(m.get('runId'))[:6]} call={'y' if m.get('callId') else 'n'} {body}")

    def check(name: str, ok: bool, detail: str = "") -> None:
        print(f"{'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f"  — {detail}"))
        if not ok:
            failures.append(name)

    print("\n=== checks ===")
    task_end = ends.get("task", {}).get("t", 0)
    ack = next((e for e in events if e["e"] == "agent_speaking_start" and e["t"] > task_end), None)

    # the chat, as it stands now
    thread = client.rpc("threads/get", {"botId": BOT})
    chat = [m for m in thread["messages"] if parse_iso(m["createdAt"]) >= started - 2]
    bot_texts = [
        (parse_iso(m["createdAt"]), m.get("runId"), "\n".join(b.get("text", "") for b in m["blocks"] if b.get("kind") == "text"))
        for m in chat
        if m["role"] == "bot"
    ]
    bot_texts = [t for t in bot_texts if t[2].strip()]
    chat_words = norm(" ".join(t[2] for t in bot_texts))
    chat_blob = " " + " ".join(chat_words) + " "

    # 1. confirmed out loud, early, and before the result existed
    check("the task was confirmed out loud", ack is not None and ack["t"] - task_end < 25,
          f"first agent speech {None if ack is None else round(ack['t'] - task_end, 1)}s after the request")
    final_result_at = None
    for at, run_id, text in bot_texts:
        if re.search(r"\b(created|is live|checked in the fleet|verified)\b", text, re.I) and run_id:
            final_result_at = at
    run_started = started + (task_end if task_end else 0)
    if ack is not None and final_result_at is not None:
        # caller timeline is relative to the caller's start; align via the first user message in chat
        first_user = next((parse_iso(m["createdAt"]) for m in chat if m["role"] == "user"), None)
        if first_user is not None:
            ack_abs = first_user + (ack["t"] - task_end)
            check("the confirmation was HEARD before the result existed", ack_abs < final_result_at,
                  f"heard at +{ack_abs - first_user:.1f}s, result written at +{final_result_at - first_user:.1f}s")
    agent_after_task = [c for c in captions if c["t"] >= task_end]
    first_line = agent_after_task[0]["text"] if agent_after_task else ""
    check("the confirmation says what it will do", bool(re.search(r"\b(on it|i'?ll|i will|creating|checking|loading|first|let me|going to|set up|setting up|create|you want)\b", first_line, re.I)), first_line[:100])

    # 2. answered the question first
    answer = next((c for c in captions if c["t"] > ends.get("question", {}).get("t", 1e9) and re.search(r"delhi", c["text"], re.I)), None)
    check("the second question was answered", answer is not None, "no caption mentions Delhi")
    report = next((c for c in captions if re.search(r"(about|update on) your request to", c["text"], re.I)), None)
    check("the task was reported by name", report is not None, "no 'About your request to …' / 'update on your request to …'")
    if answer and report:
        check("the new question was answered BEFORE the report on the old task", answer["t"] <= report["t"], "")

    # 3. what the report says: the result, named
    all_text = " ".join(c["text"] for c in captions)
    check("the report says what was done and names it",
          bool(re.search(r"\b(created|built|made|exists|ready|set up)\b", all_text, re.I)) and args.name.lower().split()[-1] in all_text.lower(),
          "result or name missing from everything said")

    # 4. interruption
    barge = next((e for e in events if e["e"] == "barge_in"), {})
    check("the report had started when it was interrupted", bool(barge.get("report_started")), "never reached the report")
    interrupt_start = user_say.get("interrupt", {})
    check("the interruption landed while the bot was speaking", bool(interrupt_start.get("during_agent_speech")), "bot was silent")
    four = next((c for c in captions if c["t"] > ends.get("interrupt", {}).get("t", 1e9) and re.search(r"\b(four|4)\b", c["text"], re.I)), None)
    check("the interrupting question was answered", four is not None, "no caption with 'four'")
    # the return that matters follows the interruption (an earlier one may follow the first question)
    after_cut = ends.get("interrupt", {}).get("t", 0)
    resume = next((c for c in captions if c["t"] > after_cut and "let me continue" in c["text"].lower()), None)
    check("it returned to the report and named it", resume is not None and re.search(r"update on your request to", resume["text"], re.I) is not None,
          "no 'I was giving you an update on …. Let me continue.'")
    if four and resume:
        check("the answer came before the return", four["t"] <= resume["t"], "")
        # The continuation is its own spoken segment, so it is the rest of that caption plus
        # whatever the agent said after it.
        later = [c["text"] for c in captions if c["t"] > resume["t"]]
        tail = " ".join([resume["text"].lower().split("let me continue", 1)[1], *later])
        check("the report carried on after the return", len(norm(tail)) >= 8, tail[:80])
        # ...and from where it stopped, not from the top: what was heard before the cut must not
        # be read again after the return.
        heard_before = " ".join(norm(" ".join(c["text"] for c in captions if c["t"] < resume["t"])))
        first_words = " ".join(norm(tail)[:6])
        check("it resumed where it stopped, not from the beginning", first_words not in heard_before or len(first_words) < 12,
              f"after the return it said {first_words!r}, which it had already said")

    # 5. nothing said twice within a minute (a bot's stock disclaimer in two answers minutes apart is
    #    the model's habit, not the call repeating itself)
    last_seen: dict[str, float] = {}
    repeats = []
    for c in captions:
        for sentence in sentences(c["text"]):
            key = " ".join(norm(sentence))
            if len(key) > 25 and key in last_seen and c["t"] - last_seen[key] < 60:
                repeats.append(sentence)
            last_seen[key] = c["t"]
    check("no sentence was spoken twice", not repeats, "; ".join(r[:60] for r in repeats[:3]))

    # 6. voice and chat are the same conversation. Compared as letters only: captions split words
    #    where the model's chunks did ("Bo"+"th"), which is the transport, not the text.
    def letters(text: str) -> str:
        return re.sub(r"[^a-z0-9]", "", text.lower())

    from conversation import speakable  # ids are spoken by their ending; the chat keeps them whole

    chat_letters = letters(" ".join(t[2] for t in bot_texts)) + letters(" ".join(speakable(t[2]) for t in bot_texts))
    unmatched = []
    for c in captions:
        for s in re.split(r"(?<=[.!?])\s*|\n+", c["text"]):
            key = letters(s)
            if len(key) < 25:
                continue
            if key in chat_letters:
                continue
            # an interrupted sentence is cut mid-word: the chat holds the whole of it
            if key[: max(20, len(key) - 14)] in chat_letters:
                continue
            unmatched.append(s.strip())
    check("everything spoken is also in the chat", not unmatched, "not in chat: " + " | ".join(u[:70] for u in unmatched[:4]))

    # 7. the work is real
    created = {n: i for n, i in after.items() if n not in before}
    check("the agent really exists in the database", bool(created), "no new bot row")
    if created:
        print("created:", ", ".join(f"{n} ({i[:10]}…)" for n, i in created.items()))

    print()
    print("VERDICT:", "FAIL" if failures else "PASS", f"({len(failures)} failed)" if failures else "")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
