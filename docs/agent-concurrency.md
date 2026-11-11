# Concurrency: how many runs a bot may execute at once

A bot executes **one run at a time** by default. That is the product rule: a bot answers the way a
person does, one piece of work in front of them, and a message sent while it works is read at its
next turn boundary rather than starting a second copy of the bot.

A Space can raise that per bot, up to 8 slots, when the bot's work is long and lives in _separate
threads_ — a research bot running three threads, a bot whose routine and whose chat have nothing to
do with each other. Concurrency buys parallel **threads**. It never buys two writers in one
conversation.

## What a slot is

```
bots.concurrency            = 3        (default 1, max 8)
computer_execution_leases   UNIQUE (computerId, botId, slot)
```

A run must hold a lease on a slot before it may use the computer. With concurrency 3 the bot may
hold three leases (slots 0, 1, 2) and therefore run three runs at once; a fourth waits in the queue
and is retried with the usual backoff. An expired row is kept as a tombstone and is _reclaimed_, not
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

| Weight | Triggers                       | Why                                           |
| ------ | ------------------------------ | --------------------------------------------- |
| 50     | `user`, `call_end`             | The person is on the other end.               |
| 45     | `follow_up`, `resume`          | The person's previous message, answered late. |
| 40     | `helper_result`, `cloud_agent` | Work a run asked for and is waiting on.       |
| 35     | `spawn`                        | A child bot the parent started.               |
| 30     | `helper`                       | A background helper's own turn.               |
| 25     | `messaging`                    | An app talking to the bot.                    |
| 20     | `bot_message`                  | Another bot's report.                         |
| 15     | `webhook`, `tickets`, `skill`  | External triggers and board work.             |
| 10     | `purchase`, `media`, `created` | Follow-ups on something the bot started.      |
| 5      | `routine`, `reaction`          | The bot's own schedule.                       |

Waiting earns a point a minute, capped at 25 — two classes. A background run that has waited long
enough overtakes the classes above it, but never the person: the lowest person weight (50) is still
above the highest a boosted background run can reach (5 + 25).

Within a class the queue is FIFO, and the id breaks ties, so a paginated scan cannot start one run
twice or skip another.

## Setting it

`bots/update` accepts `concurrency` (integer, 1–8). The value is stored on the bot and read by the
executor on every run; lowering it does not cancel a run that already holds a slot, it only stops
that run from taking a _second_ one.

## What this does not fix

A long run in the bot's **only** chat thread still blocks a typed or spoken message that lands in the
same thread — the single-writer rule queues it. Answering during a long task needs the conversation
lane described in `CHIEF-RESPONSIVENESS-RCA.md` (a lease-free, read-only lane with its own session
id), which is a larger change than slot accounting.

## Answering beside a long run (the talk lane)

Concurrency gives a bot more slots; it does not let two runs write one conversation. So a message
that lands in the bot's own chat thread while a run is working still cannot start a second run
there — the single-writer rule refuses it.

The **talk lane** is the exception that makes that feel right. When a message arrives while the
bot's run has been working for at least `TALK_LANE_MIN_BUSY_MS` (8 s), the API also creates a
`talk` run for the same thread:

- it holds **no computer lease**, so it never waits for the working run (and the working run never
  waits for it);
- it holds **no tools** — it cannot start work, touch the computer or write memory, so the working
  run stays the only writer of the bot's state;
- it runs in its **own pi session** (`threadId:botId:talk`), so it never loads or rewrites the
  working run's session;
- it is told to answer in one to three sentences, and never to claim the work is finished;
- the message is still written as **steering**, so the working run takes it up at its next step and
  can change course. The person gets an answer now; the run keeps going.

It is skipped for call turns (the voice agent speaks exactly one run's output), for another
person's run, while a stop is being handled, and when a talk run is already live for that bot.
Below the 8 s threshold the working run reads the steering within a second or two, so a second run
would only duplicate the reply.

### Measured on the live instance (2026-11-11)

Chief was given a run that holds the computer for 30-45 s (`shell: sleep`). A second message sent
while that run was working created a talk run **12 ms** after the send (`run.queue_wait_ms: 27`), and
the two ran at once:

|          | start    | end      | spoke                                                                                                                         |
| -------- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| work run | 02:04:47 | 02:05:26 | "Tokyo — answering mid-task; … READY follows."                                                                                |
| talk run | 02:04:59 | 02:05:44 | "Tokyo — that one's instant, no tools needed. The sleep is still running in the background, so READY comes once it finishes." |

So the person is answered while the work continues, and the talk run says plainly that the work is
still going instead of claiming it is done.

Two honest limits:

- **Both may answer.** The message is also steering, so the work run replies to it when it reaches
  its next step. When the work finishes before the talk run's model call returns (this instance's
  model took 45 s for that answer), the person sees two replies to one message.
- **The talk answer is as fast as the model.** Here it took 45 s because the provider returned
  `429 inference service is overloaded` and the runtime retried; a healthy model answers in a few
  seconds. The lane removes the _queue_, not the model.

## Voice: who answers, and what happens to an interrupted report

A call is a conversation with a run in the background, so a spoken turn has to be routed on what the
caller is doing, not only on whether the bot is busy. The agent tags each turn (`answerNow`) from its
own conversation state; the server honours the tag (and reads the text when an older client sends
none).

| The caller | What happens |
|---|---|
| Asks something ("what is the capital…?", "how long will it take") | The turn gets its **own run** (talk lane), the busy run keeps working. The caller hears the answer to the question. |
| Says "hmm", "okay", "go on" **while a question is still being answered** | Still tagged: the caller is waiting on that answer, so it keeps its own run. |
| Says "hmm", "okay" **with no question open** (just listening to a task report) | Not tagged: no second run starts, and the busy run keeps reporting what it is doing. |
| **Interrupts a report** to ask a question | The report stops, the question is answered, then one short line offers the rest: "…still has the rest of that update — say go on and I'll finish it." Offered once per interruption. |
| Says "go on" / "continue" / "the rest" after that | The interrupted report is spoken from what the call captured, with **no model call**. |
| Asks another question while a report is paused | The new question is answered; the paused report stays available and is not offered twice. |
| Starts a clearly new subject | The paused report is still theirs to ask for; it is not thrown away and not re-offered. |
| Interrupts an *answer* with another question | The newest question wins (per-turn identity); the superseded answer stops at its next chunk. |
| Says "stop" | The server treats it as Stop; the call ends or the run stops. |

The report offered back is the text this call heard or was given, so a run that finished while the
caller was talking still leaves a coherent report to replay.

## A task is acknowledged before it starts

A run used to begin in silence: the model's first turn goes straight into a tool call, and that call
can take minutes, so the person saw nothing until the work was done. Now, when a person's run starts
(`user` / `follow_up`), the executor posts one interim line first, derived from their own words:

> On it — "create a voice testing agent". Working through it now; I'll tell you when it's finished.

It is deterministic, so it cannot be skipped by a slow model, and it is budgeted as an interim
message, so it counts against the same allowance as the run's other progress notes. Runs that are not
a person's turn (routine, bot message, helper, talk) stay quiet.

Measured: **1.1 s** from send to acknowledgement, with the task still starting immediately.

## A question does not wait for the busy threshold

The talk lane's 8 s threshold exists so a quick "go on" does not spawn a duplicate answer. It applied
to questions too, which meant asking something one second into a task got no answer until the task
finished. A turn that asks something (`asksForAnswer`, or the voice agent's `answerNow` tag) now
bypasses the threshold and is answered beside the run however recently it started.

## Confirming a task, and what a cut-off answer does

The confirmation is written by the **model**, from the full request, as its first sentence — not by a
template. A template tried to restate a dictation and produced lines like "Got it — create a voice as
an agent at voice testing agent again we can test few things with him", and on a call the agent's own
template landed on top of the run's, so the caller heard two stutters.

How it works now:

- a person's run is instructed to open with one short sentence saying what it understood and what it
  will do first, before any tool call (`PLAN_FIRST_INSTRUCTION`);
- the platform publishes that first sentence **at once** rather than after the long-turn delay, so it
  arrives while the work runs (measured 4.3 s), and it is the same message a caller hears;
- nothing else writes an acknowledgement. There is one confirmation, in the bot's words, per task.

Example, verbatim from the live instance:

> You want a voice testing agent for test calls — I'll check the fleet first, since a "Voice Test" bot
> should already exist, and only create one if it's genuinely gone.

Any speech the caller cuts short is held for "go on": an interrupted report, an interrupted answer, a
long explanation. If it was cut before anything was sent, nothing is held — the caller simply started
again. The next completed answer offers it once: "…still has the rest of that update — say go on and
I'll finish it."
