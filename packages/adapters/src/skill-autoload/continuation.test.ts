import { describe, expect, it } from "vitest";
import { continuesEarlierRequest } from "./continuation.js";
import { contentWords, matchText, SHORT_TASK_WORDS } from "./match.js";

const EARLIER = ["file the supplier invoice for March in the quarterly ledger"];

/** Short messages that go on with the request before them, in several wordings each. */
const CONTINUES: Record<string, string[]> = {
  "go-ahead": [
    "ok, go",
    "go",
    "go ahead",
    "Go ahead please.",
    "yes",
    "Yes, do it",
    "yep",
    "sure",
    "sure, go on",
    "do it",
    "please do",
    "proceed",
    "continue",
    "carry on",
    "keep going",
    "start",
    "start now",
    "let's go",
    "ok start",
    "run it",
    "send it",
  ],
  approval: [
    "ok",
    "OK.",
    "okay",
    "alright",
    "sounds good",
    "looks good",
    "that works",
    "works for me",
    "approved",
    "confirmed",
    "agreed",
    "perfect, go ahead",
    "great, do that",
    "thanks, go ahead",
    "hi, yes please",
    "lgtm",
    "fine",
  ],
  correction: [
    "no, the other one",
    "not that, the second one",
    "actually use April",
    "use April instead",
    "wrong month",
    "fix it",
    "change it to April",
    "again",
    "try again",
    "retry",
    "redo it",
    "once more",
    "stop",
    "wait",
    "cancel it",
    "undo that",
  ],
  reference: [
    "the second one",
    "the first option",
    "both",
    "same for April",
    "and April too",
    "also the receipts",
    "what about April?",
    "how about the receipts?",
    "why did it fail?",
    "is that done?",
    "did it finish?",
    "show me those",
    "but in euros",
    "then email it",
    "option 2",
  ],
  "another language": ["হ্যাঁ", "ঠিক আছে", "করো", "haan, koro", "thik ache", "আবার"],
};

/** Short messages that are their own turn: the earlier request is over for them. */
const DOES_NOT: Record<string, string[]> = {
  greeting: [
    "hello, how are you today?",
    "hello",
    "hi",
    "Hi there!",
    "hey",
    "good morning",
    "Good evening!",
    "how are you?",
    "how's it going?",
    "what's up",
    "hello again",
    "hey, you there?",
    "assalamu alaikum",
    "কেমন আছো?",
  ],
  thanks: [
    "thanks",
    "thanks!",
    "thank you",
    "Thank you so much",
    "ok thanks",
    "ok, thank you",
    "great, thanks",
    "thanks, that looks good",
    "perfect, thank you",
    "cheers",
    "well done",
    "good job",
    "nice work, thanks",
    "ধন্যবাদ",
  ],
  goodbye: ["bye", "good night", "see you tomorrow", "that's all for now", "never mind", "nothing"],
  "a new short question or request": [
    "what time is it?",
    "what day is it today?",
    "who won the match?",
    "what's the weather?",
    "great, how's the weather?",
    "ok, what's the weather?",
    "check my email",
    "tell me a joke",
    "who are you?",
    "what can you do?",
    "start a budget",
    "stop the music",
    "fix the printer",
    "change my password",
    "cancel my subscription",
    "Dhaka weather tomorrow",
    "",
    "?",
  ],
};

describe("continuesEarlierRequest", () => {
  for (const [kind, messages] of Object.entries(CONTINUES)) {
    it.each(messages)(`${kind}: "%s" goes on with the earlier request`, (message) => {
      expect(continuesEarlierRequest(message)).toBe(true);
    });
  }
  for (const [kind, messages] of Object.entries(DOES_NOT)) {
    it.each(messages)(`${kind}: "%s" does not`, (message) => {
      expect(continuesEarlierRequest(message)).toBe(false);
    });
  }

  it("every table entry is a short message, so the rule is what decides it", () => {
    for (const message of [...Object.values(CONTINUES), ...Object.values(DOES_NOT)].flat())
      expect(contentWords(message).length, message).toBeLessThan(SHORT_TASK_WORDS);
  });
});

describe("matchText with an earlier request in the chat", () => {
  it.each(Object.values(CONTINUES).flat())('"%s" is matched with it', (message) => {
    expect(matchText(message, EARLIER)).toEqual({
      text: `${message}\n${EARLIER[0]}`,
      usedEarlier: true,
    });
  });

  it.each(Object.values(DOES_NOT).flat())('"%s" is matched alone', (message) => {
    expect(matchText(message, EARLIER)).toEqual({ text: message, usedEarlier: false });
  });

  it("borrows for any short message when the check is switched off", () => {
    expect(matchText("hello, how are you today?", EARLIER, { continuationOnly: false })).toEqual({
      text: `hello, how are you today?\n${EARLIER[0]}`,
      usedEarlier: true,
    });
  });

  it("never borrows for a message that says enough itself", () => {
    const own = "yes, and build a slide deck from the meeting outline";
    expect(matchText(own, EARLIER)).toEqual({ text: own, usedEarlier: false });
  });
});
