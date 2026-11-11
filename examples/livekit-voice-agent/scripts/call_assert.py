#!/usr/bin/env python3
"""Drive a real LiveKit call and assert what the caller hears.

This is the test that replaces "you test, I guess". It synthesises speech for each utterance, runs
the synthetic caller against the live stack, parses the caller's event log, and checks the things
that kept breaking:

  1. a task is confirmed before the work finishes (a plan sentence appears first);
  2. the confirmation is not repeated afterwards;
  3. a question asked mid-task is answered with the right answer;
  4. no line is spoken twice in a row.

Usage:
    python call_assert.py --task "create a voice test agent for testing" \
                          --question "what is the capital of India?" --expect Delhi
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

APP = Path("/home/sasajib/the-data/rakazo-voice/app")
SPEECH = "http://127.0.0.1:3312/v1/audio/speech"
BOT = "cmwb03kunchgjyukvkalfsty0"
SPACE = "8ac0cc331ddc82ec18d718b350083a9e"

LINE = re.compile(r'\[\s*([0-9.]+)s\]\s+(\w+)\s+(\{.*\})')


def pcm_for(text: str, workdir: Path, index: int) -> Path:
    """48k mono s16le, because the caller feeds that straight into its track."""
    out = workdir / f"u{index}.pcm"
    mp3 = out.with_suffix(".mp3")
    subprocess.run(
        [
            "curl", "-s", "-m", "60", "-X", "POST", SPEECH,
            "-H", "Content-Type: application/json",
            "-d", json.dumps({"model": "tts-1", "voice": "alloy", "input": text, "response_format": "mp3"}),
            "-o", str(mp3),
        ],
        check=True,
    )
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(mp3), "-ac", "1", "-ar", "48000", "-f", "s16le", str(out)],
        check=True,
    )
    return out


def bots_snapshot() -> dict[str, str]:
    """Name -> id for every live bot, straight from the database."""
    sql = 'select name || \'|\' || id from bots where "archivedAt" is null order by name;'
    out = subprocess.run(
        ["docker", "exec", "-i", "rakazo-postgres-1", "sh", "-lc",
         'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At'],
        input=sql, capture_output=True, text=True, check=True,
    ).stdout
    pairs = (line.split("|", 1) for line in out.splitlines() if "|" in line)
    return {name: bot_id for name, bot_id in pairs}


def call(utterances: list[str], tail: float) -> list[tuple[float, str, str]]:
    """Run the call, return (seconds, who, text) for every transcript the caller heard or said."""
    bearer = subprocess.run(
        ["python3", "-c",
         "import sys;sys.path.insert(0,'/home/sasajib/.hermes/cache/scratch');"
         "from rakazo_rpc import Client;c=Client();c.sign_in();c.use_first_space();"
         "print(c.token)"],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    workdir = Path(tempfile.mkdtemp())
    bearer_file = workdir / "bearer"
    bearer_file.write_text(bearer)
    pcm_args: list[str] = []
    for index, said in enumerate(utterances):
        pcm_args += ["--pcm", f"/pcm/{pcm_for(said, workdir, index).name}"]

    result = subprocess.run(
        [
            "docker", "run", "--rm", "--network", "host",
            "-v", f"{APP}:/app", "-v", f"{workdir}:/pcm:ro",
            "-w", "/app", "rakazo-voice-agent",
            "python", "scripts/synthetic_caller.py", *pcm_args,
            "--token-url", "http://127.0.0.1:3320",
            "--bearer-file", f"/pcm/{bearer_file.name}",
            "--bot-id", BOT, "--space-id", SPACE,
            "--tail", str(tail),
        ],
        capture_output=True, text=True, timeout=tail + 120,
    )
    # Speech start is when the caller *hears* it; a transcript's timestamp is when Deepgram
    # finalised the caption, which lags by tens of seconds on a long line.
    events: list[tuple[float, str, str]] = []
    pending_start: float | None = None
    for line in result.stdout.splitlines():
        match = LINE.search(line)
        if not match:
            continue
        at, kind, payload = match.groups()
        if kind == "agent_speaking_start":
            pending_start = float(at)
            continue
        if kind != "transcript":
            continue
        data = json.loads(payload)
        who = "agent" if data["who"].startswith("agent") else "user"
        heard_at = pending_start if who == "agent" and pending_start is not None else float(at)
        if who == "agent":
            pending_start = None
        events.append((heard_at, who, data["text"]))
    return events


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--task", required=True)
    parser.add_argument("--question", required=True)
    parser.add_argument("--expect", required=True, help="a word the answer must contain")
    parser.add_argument("--tail", type=float, default=75)
    parser.add_argument("--expect-created", action="store_true",
                        help="require a new bot row afterwards (proves it did the work, not just said so)")
    args = parser.parse_args()

    before = bots_snapshot() if args.expect_created else {}
    events = call([args.task, args.question], args.tail)
    after = bots_snapshot() if args.expect_created else {}
    if not events:
        print("FAIL: the call produced no transcript at all")
        return 1
    for at, who, text in events:
        print(f"{at:6.1f}s {who:<5} {text[:110]}")

    failures: list[str] = []
    # Skip the opening greeting ("Connected. Go ahead."): the confirmation is the first line the
    # bot says after the caller's first utterance.
    said_at = next((at for at, who, _ in events if who == "user"), -1.0)
    agent_lines = [(at, text) for at, who, text in events if who == "agent" and at > said_at]

    # 1. a confirmation before the work: the first agent line after the task says what it will do.
    if len(agent_lines) < 2 or not re.search(
        r"\b(on it|i'?ll|i will|first|let me|checking|looking|creating|going to)\b", agent_lines[0][1], re.I
    ):
        failures.append("no plan sentence before the work")
    task_lines = [text for at, text in agent_lines if at < next((t2 for t2, w, _ in events if w == "user" and t2 > said_at), float("inf"))]
    if task_lines and not any(
        re.search(r"\b(created?|already|done|ready|built|is live|exists|checked)\b", text, re.I)
        for text in task_lines
    ):
        failures.append("no result line after the work")

    # 1b. the result says what was done, and names it — "done" alone is not a clarification.
    result_text = "\n".join(task_lines)
    if not re.search(r"\b(created|built|made|exists?|already|is live|ready|set up)\b", result_text, re.I):
        failures.append("the result does not say what was done")
    named = re.search(r"(?:voice test|voice testing|cm[a-z0-9]{20,}|\b[a-z][a-z0-9 ]{3,30}\b(?: bot| agent))", result_text, re.I)
    if not named:
        failures.append("the result does not name what it created")
    if len(result_text.strip()) < 40:
        failures.append("the result is too terse to clarify anything")

    # 2. the confirmation is not said again later.
    if len(agent_lines) > 1 and agent_lines[0][1].strip() == agent_lines[1][1].strip():
        failures.append("the confirmation was repeated")

    # 3. the question is answered with the right answer.
    if not any(args.expect.lower() in text.lower() for _, text in agent_lines):
        failures.append(f"the question was not answered with {args.expect!r}")

    # 4. nothing is spoken twice in a row.
    for (_, first), (_, second) in zip(agent_lines, agent_lines[1:]):
        if first.strip() == second.strip():
            failures.append("a line was spoken twice in a row")
            break

    # 5. did it actually create one? the words are not evidence, the table is.
    if args.expect_created:
        new = {name: bot_id for name, bot_id in after.items() if name not in before}
        if not new:
            failures.append("no bot was created, whatever the reply said")
        else:
            print()
            print("created in the database:", ", ".join(f"{n} ({i[:10]}…)" for n, i in new.items()))

    print()
    if failures:
        for failure in failures:
            print(f"FAIL: {failure}")
        return 1
    print("PASS: confirmed first, answered the question, nothing repeated")
    return 0


if __name__ == "__main__":
    sys.exit(main())
