# Concurrency: how many runs a bot may execute at once

A bot executes **one run at a time** by default. That is the product rule: a bot answers the way a
person does, one piece of work in front of them, and a message sent while it works is read at its
next turn boundary rather than starting a second copy of the bot.

A Space can raise that per bot, up to 8 slots, when the bot's work is long and lives in *separate
threads* — a research bot running three threads, a bot whose routine and whose chat have nothing to
do with each other. Concurrency buys parallel **threads**. It never buys two writers in one
conversation.

## What a slot is

```
bots.concurrency            = 3        (default 1, max 8)
computer_execution_leases   UNIQUE (computerId, botId, slot)
```

A run must hold a lease on a slot before it may use the computer. With concurrency 3 the bot may
hold three leases (slots 0, 1, 2) and therefore run three runs at once; a fourth waits in the queue
and is retried with the usual backoff. An expired row is kept as a tombstone and is *reclaimed*, not
deleted, so the screen fence still rises and a stale screen session cannot be mistaken for the new
run's.

Dedicated computers are exempt: a dedicated computer is one bot's own machine, and its screen,
browser profile and desktop are single resources, so it stays one run at a time whatever the bot's
concurrency says.

## One writer per conversation

Independently of concurrency, a run checks that no other run of the same bot is active in the same
thread. Two runs may work on different threads; two runs never edit one conversation, its history or
its pi session. This is enforced inside the same transaction that grants the slot, so the check and
the grant cannot be split by a race.

Without that rule, concurrent runs of one bot could interleave replies in one chat, write memory from
two places, and drift the model's context.

## Queue order

Runs are ordered by what waiting is worth, not by arrival alone:

| Weight | Triggers | Why |
|---|---|---|
| 50 | `user`, `call_end` | The person is on the other end. |
| 45 | `follow_up`, `resume` | The person's previous message, answered late. |
| 40 | `helper_result`, `cloud_agent` | Work a run asked for and is waiting on. |
| 35 | `spawn` | A child bot the parent started. |
| 30 | `helper` | A background helper's own turn. |
| 25 | `messaging` | An app talking to the bot. |
| 20 | `bot_message` | Another bot's report. |
| 15 | `webhook`, `tickets`, `skill` | External triggers and board work. |
| 10 | `purchase`, `media`, `created` | Follow-ups on something the bot started. |
| 5 | `routine`, `reaction` | The bot's own schedule. |

Waiting earns a point a minute, capped at 25 — two classes. A background run that has waited long
enough overtakes the classes above it, but never the person: the lowest person weight (50) is still
above the highest a boosted background run can reach (5 + 25).

Within a class the queue is FIFO, and the id breaks ties, so a paginated scan cannot start one run
twice or skip another.

## Setting it

`bots/update` accepts `concurrency` (integer, 1–8). The value is stored on the bot and read by the
executor on every run; lowering it does not cancel a run that already holds a slot, it only stops
that run from taking a *second* one.

## What this does not fix

A long run in the bot's **only** chat thread still blocks a typed or spoken message that lands in the
same thread — the single-writer rule queues it. Answering during a long task needs the conversation
lane described in `CHIEF-RESPONSIVENESS-RCA.md` (a lease-free, read-only lane with its own session
id), which is a larger change than slot accounting.
