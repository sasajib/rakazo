import { describe, expect, it } from "vitest";
import type { OpenWorkFacts } from "./open-work.js";
import {
  decideOpenWork,
  declaresFurtherWork,
  openWorkContinuationPrompt,
  promisedWork,
  replyAsksThePerson,
  runIsFollowedForOpenWork,
  stalledNotice,
} from "./open-work.js";
import { CONTINUATION_MARKER } from "./run-supervision.js";

const NO_WAKERS = {
  helpers: 0,
  queuedHelpers: 0,
  runs: 0,
  jobs: 0,
  schedules: 0,
  cards: 0,
  requests: 0,
};

function facts(overrides: Partial<OpenWorkFacts> = {}): OpenWorkFacts {
  return {
    enabled: true,
    status: "completed",
    trigger: "helper_result",
    replyText: "Parts one and two are written.",
    toolCallCount: 3,
    openItems: [],
    itemsTouchedInRun: 0,
    parkedInRun: [],
    promise: "none",
    isContinuation: false,
    continuationsSoFar: 0,
    maxContinuations: 8,
    wakers: NO_WAKERS,
    ...overrides,
  };
}

const ITEMS = [
  { id: "i1", title: "Write part three" },
  { id: "i2", title: "Write part four" },
];

describe("a reply's closing lines: does the agent promise more work of its own", () => {
  it.each([
    "Parts 1 to 5 are saved. I'm continuing with part 6.",
    "Done with the first batch. I am now moving on to the second batch.",
    "The outline is ready. Next I'll write the introduction.",
    "Three files are fixed. Now I will fix the remaining two.",
    "I'll continue with the remaining sections.",
    "Summary so far is above.\n\nContinuing with the next section.",
    "The build is running. I'll report back when it is done.",
    "I\u2019m continuing with the next part.",
    "We are going to start the second pass now.",
    "First half delivered. I will now proceed to the second half.",
  ])("promise: %s", (reply) => {
    expect(declaresFurtherWork(reply)).toBe("promise");
  });

  it.each([
    "All eighteen parts are written and saved in the folder.",
    "Done. The report is attached.",
    "I fixed the two failing tests and pushed the branch.",
    "Here is the summary you asked for.",
    "",
    // Offers and questions hand the next move to the person.
    "Part one is done. If you want, I'll continue with part two.",
    "The draft is ready. Should I start on the second section?",
    "I can continue with the rest once you confirm the title.",
    "Let me know if you'd like me to proceed with the remaining files.",
    "I'll continue when you have sent the logo.",
    "Do you want me to keep going with the next batch?",
    // A promise followed by a question: the last word is still the person's.
    "I'm continuing with part two. Should the index be updated as well?",
  ])("none: %s", (reply) => {
    expect(declaresFurtherWork(reply)).toBe("none");
  });

  it.each([
    "The first part is ready. I'll have the rest in a while.",
    "Still working on it.",
    "Let me check the remaining pages.",
    // A closing these patterns cannot read is left to the judge.
    "প্রথম অংশ শেষ হয়েছে। আমি এখন পরের অংশ লিখছি।",
  ])("unclear, left to the judge: %s", (reply) => {
    expect(declaresFurtherWork(reply)).toBe("unclear");
  });

  it("reads only the closing lines: a plan told early in a long reply is not a promise", () => {
    const reply = `Next I'll write the introduction. ${"The introduction covers the background in detail. ".repeat(40)}Everything is written and saved.`;
    expect(declaresFurtherWork(reply)).toBe("none");
  });

  it("knows a question or an offer at the very end", () => {
    expect(replyAsksThePerson("Part one is done. Shall I go on?")).toBe(true);
    expect(replyAsksThePerson("Part one is done. Let me know if you want changes.")).toBe(true);
    expect(replyAsksThePerson("Is it done? Yes. I'm continuing with part two.")).toBe(false);
  });

  it("quotes the sentence that carries the promise", () => {
    expect(promisedWork("Parts 1 to 5 are saved. I'm continuing with **part 6**.")).toBe(
      "I'm continuing with part 6.",
    );
  });
});

describe("which runs the rule follows", () => {
  it.each([
    "user",
    "follow_up",
    "helper_result",
    "bot_message",
    "routine",
    "webhook",
    "job_result",
  ])("follows %s", (trigger) => expect(runIsFollowedForOpenWork(trigger)).toBe(true));
  it.each(["helper", "talk", "created", "tickets", "call_end", "messaging", "reaction"])(
    "does not follow %s",
    (trigger) => expect(runIsFollowedForOpenWork(trigger)).toBe(false),
  );
});

describe("deciding what happens when a run ends", () => {
  it("continues a run of any followed trigger that leaves items open with nothing to wake it", () => {
    for (const trigger of ["user", "helper_result", "bot_message", "routine", "webhook"])
      expect(decideOpenWork(facts({ trigger, openItems: ITEMS }))).toEqual({
        action: "continue",
        basis: "items",
      });
  });

  it("continues on a promise when no item is kept", () => {
    expect(decideOpenWork(facts({ promise: "promise" }))).toEqual({
      action: "continue",
      basis: "promise",
    });
  });

  it("does nothing when no work is open", () => {
    expect(decideOpenWork(facts())).toEqual({ action: "none", reason: "no_open_work" });
  });

  it.each(Object.keys(NO_WAKERS) as Array<keyof typeof NO_WAKERS>)(
    "does nothing while something else will wake the agent: %s",
    (waker) => {
      // A status report while helpers work must not start a run, whatever it promises.
      const decision = decideOpenWork(
        facts({
          openItems: ITEMS,
          promise: "promise",
          replyText: "Two of four are back. I'm continuing when the others report.",
          wakers: { ...NO_WAKERS, [waker]: 1 },
        }),
      );
      expect(decision).toEqual({ action: "none", reason: `will_wake:${waker}` });
    },
  );

  it("does nothing when the reply hands the next move to the person", () => {
    expect(
      decideOpenWork(facts({ openItems: ITEMS, replyText: "Part two is done. Shall I go on?" })),
    ).toEqual({ action: "none", reason: "asked_person" });
  });

  it.each([
    ["switched off", { enabled: false }, "disabled"],
    ["a run that did not complete", { status: "failed" }, "not_completed"],
    ["a helper's own run", { trigger: "helper" }, "trigger"],
    ["a talk run", { trigger: "talk" }, "trigger"],
  ] as const)("does nothing for %s", (_label, overrides, reason) => {
    expect(decideOpenWork(facts({ openItems: ITEMS, ...overrides }))).toEqual({
      action: "none",
      reason,
    });
  });

  // Fork (L5): the older rule ("announced work and used no tool") is one of this rule's facts,
  // so one function decides and at most one run is started for a finished run.
  describe("a run that only announced its work", () => {
    const announcedRun = {
      trigger: "user",
      announced: true,
      toolCallCount: 0,
      replyText: "Got it. First I",
    };

    it("is continued, on that basis, when nothing else says work is open", () => {
      expect(decideOpenWork(facts(announcedRun))).toEqual({
        action: "continue",
        basis: "announced",
      });
    });

    it("gives one decision when an item or a promise says so too", () => {
      expect(decideOpenWork(facts({ ...announcedRun, openItems: ITEMS }))).toEqual({
        action: "continue",
        basis: "items",
      });
      expect(decideOpenWork(facts({ ...announcedRun, promise: "promise" }))).toEqual({
        action: "continue",
        basis: "promise",
      });
    });

    it.each(Object.keys(NO_WAKERS) as Array<keyof typeof NO_WAKERS>)(
      "starts nothing while something else will wake the agent: %s",
      (waker) => {
        expect(
          decideOpenWork(facts({ ...announcedRun, wakers: { ...NO_WAKERS, [waker]: 1 } })),
        ).toEqual({ action: "none", reason: `will_wake:${waker}` });
      },
    );

    it("starts nothing when the short reply is a question or an offer to the person", () => {
      for (const replyText of ["Which folder should I use?", "I can do that if you want."])
        expect(decideOpenWork(facts({ ...announcedRun, replyText }))).toEqual({
          action: "none",
          reason: "asked_person",
        });
    });

    it("is never the reason to continue a continuation: one such run per task, and no notice", () => {
      const continuation = { ...announcedRun, isContinuation: true, continuationsSoFar: 1 };
      expect(decideOpenWork(facts(continuation))).toEqual({
        action: "none",
        reason: "no_open_work",
      });
      // What a continuation leaves open is judged like any run's.
      expect(decideOpenWork(facts({ ...continuation, promise: "promise" }))).toEqual({
        action: "stalled",
        reason: "no_progress",
        openCount: 1,
      });
    });

    it("stops at the limit without a notice: nothing is known to be open", () => {
      expect(
        decideOpenWork(facts({ ...announcedRun, continuationsSoFar: 8, maxContinuations: 8 })),
      ).toEqual({ action: "none", reason: "limit" });
    });

    it("does nothing when the fact is absent or false, or the rule is off", () => {
      expect(decideOpenWork(facts({ ...announcedRun, announced: false }))).toEqual({
        action: "none",
        reason: "no_open_work",
      });
      expect(decideOpenWork(facts({ ...announcedRun, announced: undefined }))).toEqual({
        action: "none",
        reason: "no_open_work",
      });
      expect(decideOpenWork(facts({ ...announcedRun, enabled: false }))).toEqual({
        action: "none",
        reason: "disabled",
      });
    });
  });

  describe("a continuation must make progress", () => {
    const continuation = { isContinuation: true, continuationsSoFar: 1, openItems: ITEMS };

    it("goes on after one that worked and moved an item", () => {
      expect(
        decideOpenWork(facts({ ...continuation, toolCallCount: 4, itemsTouchedInRun: 1 })),
      ).toEqual({ action: "continue", basis: "items" });
    });

    it("ends the chain after one that did nothing", () => {
      expect(
        decideOpenWork(facts({ ...continuation, toolCallCount: 0, itemsTouchedInRun: 0 })),
      ).toEqual({ action: "stalled", reason: "no_progress", openCount: 2 });
    });

    it("ends the chain after one that moved no item", () => {
      expect(
        decideOpenWork(facts({ ...continuation, toolCallCount: 4, itemsTouchedInRun: 0 })),
      ).toEqual({ action: "stalled", reason: "no_progress", openCount: 2 });
    });

    it("with no item kept, a tool call is the progress", () => {
      const promised = { isContinuation: true, continuationsSoFar: 1, promise: "promise" as const };
      expect(decideOpenWork(facts({ ...promised, toolCallCount: 2 }))).toEqual({
        action: "continue",
        basis: "promise",
      });
      expect(decideOpenWork(facts({ ...promised, toolCallCount: 0 }))).toEqual({
        action: "stalled",
        reason: "no_progress",
        openCount: 1,
      });
    });
  });

  it("ends the chain at the limit for one task", () => {
    expect(
      decideOpenWork(
        facts({
          openItems: ITEMS,
          isContinuation: true,
          toolCallCount: 4,
          itemsTouchedInRun: 1,
          continuationsSoFar: 8,
          maxContinuations: 8,
        }),
      ),
    ).toEqual({ action: "stalled", reason: "limit", openCount: 2 });
  });

  it("reports a continuation that parked its work instead of doing it as blocked", () => {
    const parked = [{ id: "i1", title: "Write part three", notes: "needs the source file" }];
    expect(decideOpenWork(facts({ isContinuation: true, parkedInRun: parked }))).toEqual({
      action: "stalled",
      reason: "blocked",
      openCount: 1,
    });
    // A person's own run that parks something says so in its reply; no platform notice.
    expect(decideOpenWork(facts({ parkedInRun: parked }))).toEqual({
      action: "none",
      reason: "no_open_work",
    });
  });
});

describe("the continuation's brief and the owner's notice", () => {
  it("names the open items, as data, and forbids another promise", () => {
    const prompt = openWorkContinuationPrompt({
      basis: "items",
      items: ITEMS,
      promised: "",
      attempt: 2,
      maxContinuations: 8,
      escape: (text) => text.replace("<", "&lt;"),
    });
    expect(prompt.startsWith(CONTINUATION_MARKER)).toBe(true);
    expect(prompt).toContain("continuation 2 of 8");
    expect(prompt).toContain("- Write part three (id: i1)");
    expect(prompt).toContain("Never end by saying you are continuing");
    expect(prompt).toContain("No person sent this");
  });

  it("quotes the promise when no item is kept", () => {
    const prompt = openWorkContinuationPrompt({
      basis: "promise",
      items: [],
      promised: "I'm continuing with part 6.",
      attempt: 1,
      maxContinuations: 8,
      escape: (text) => text,
    });
    expect(prompt).toContain('"I\'m continuing with part 6."');
  });

  it("tells the owner how much is open and why it stopped", () => {
    expect(
      stalledNotice({ botName: "Writer", reason: "no_progress", items: ITEMS, promised: "" }),
    ).toEqual({
      title: "Writer stalled",
      body: "2 items open: Write part three; Write part four. Nothing is running for this task now, because its last automatic continuation made no progress.",
      chat: "Stalled: 2 items open: Write part three; Write part four. Nothing is running for this task now, because its last automatic continuation made no progress. A message here starts it again.",
    });
    const blocked = stalledNotice({
      botName: "Writer",
      reason: "blocked",
      items: [{ id: "i1", title: "Write part three", notes: "needs the source file" }],
      promised: "",
    });
    expect(blocked.title).toBe("Writer is blocked");
    expect(blocked.body).toContain("1 item parked: Write part three");
    expect(blocked.body).toContain("it cannot go on by itself: needs the source file");
    expect(
      stalledNotice({ botName: "Writer", reason: "limit", items: [], promised: "I'll do part 6." })
        .body,
    ).toContain('promised work not done: "I\'ll do part 6."');
  });
});
