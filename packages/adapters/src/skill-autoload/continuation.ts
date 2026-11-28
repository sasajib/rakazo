/**
 * Fork (FORK.md 1.32, L1): does a short message go on with the request before it?
 *
 * A message with too few content words to match a skill by itself ("ok, go") is matched together
 * with the person's previous request. That is right only when the short message continues that
 * request: a go-ahead, an approval, a correction, a reference to it. A greeting, thanks, or a new
 * short question after a finished task is not: it borrowed the old request, loaded that task's
 * skill again, and the agent obeyed the skill in its answer to "hello".
 *
 * Decided here from the words alone, in order, with no model call:
 *   1. it tells the agent to act, agrees, or corrects        -> continues
 *   2. it greets, thanks, says goodbye or makes small talk   -> does not
 *   3. it is only an acknowledgement ("ok", "sounds good")   -> continues
 *   4. it points back at the earlier request ("the second one", "why did it fail?") -> continues
 *   5. anything else is a request of its own                 -> does not
 * A wrong "does not" costs nothing but the automatic load: the catalog and skill_read are there.
 */

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .match(/[\p{L}\p{M}\p{N}']+/gu) ?? [];

const phrase = (alternatives: string) => new RegExp(`(?:^| )(?:${alternatives})(?= |$)`);

/** Agreeing to what the agent proposed, telling it to act on it, or correcting it. */
const ACTS = phrase(
  [
    "go ahead",
    "go on",
    "go for it",
    "do it",
    "do that",
    "do so",
    "do this",
    "do both",
    "please do",
    "carry on",
    "keep going",
    "run it",
    "send it",
    "ship it",
    "finish it",
    "fix it",
    "fix that",
    "change it",
    "change that",
    "undo it",
    "undo that",
    "yes",
    "yep",
    "yeah",
    "yup",
    "sure",
    "absolutely",
    "definitely",
    "agreed",
    "approve",
    "approved",
    "confirm",
    "confirmed",
    "correct",
    "exactly",
    "lgtm",
    "that works",
    "works for me",
    "instead",
    "actually",
    "rather",
    "wrong",
    "not that",
    "not this",
    "hold on",
    // The same in Bangla, written both ways.
    "haan",
    "thik ache",
    "koro",
    "kore dao",
    "chaliye jao",
    "হ্যাঁ",
    "ঠিক আছে",
    "করো",
    "করে দাও",
    "চালিয়ে যাও",
  ].join("|"),
);

/**
 * Verbs that go on with the task when they stand alone ("continue", "start now", "stop") and open
 * a request of their own when they take an object ("start a budget", "stop the music").
 */
const BARE_VERBS = new Set(
  "go proceed continue resume start begin finish retry redo fix change undo revert wait stop cancel try run send".split(
    " ",
  ),
);
const BESIDE_A_BARE_VERB = new Set("ahead on now please it that this them then and".split(" "));

/** Greetings, thanks, goodbyes and small talk: the person is not asking for the task again. */
const CLOSES = phrase(
  [
    "hi",
    "hello",
    "hey",
    "hiya",
    "howdy",
    "greetings",
    "good morning",
    "good afternoon",
    "good evening",
    "good night",
    "good day",
    "morning",
    "evening",
    "thanks",
    "thank",
    "thx",
    "ty",
    "cheers",
    "appreciated",
    "appreciate",
    "well done",
    "good job",
    "great job",
    "nice job",
    "nice work",
    "good work",
    "great work",
    "bye",
    "goodbye",
    "see you",
    "see ya",
    "later",
    "take care",
    "how are you",
    "how're you",
    "how are things",
    "how is it going",
    "how's it going",
    "hows it going",
    "how do you do",
    "what's up",
    "whats up",
    "sup",
    "who are you",
    "what are you",
    "what can you do",
    "nice to meet you",
    "what time is it",
    "what day is it",
    "what date is it",
    "never mind",
    "nevermind",
    "no need",
    "nothing",
    "that's all",
    "that is all",
    "that's it",
    "all good",
    "assalamu alaikum",
    "salam",
    "dhonnobad",
    "kemon acho",
    "ধন্যবাদ",
    "কেমন আছো",
    "কেমন আছেন",
  ].join("|"),
);

/** Words that only acknowledge. A message made of nothing else is a nod to go on. */
const ACKNOWLEDGES = new Set(
  (
    "ok okay k kk alright right fine good great nice cool perfect excellent awesome fair noted understood " +
    "got gotcha sounds looks seems"
  ).split(" "),
);
const FILLERS = new Set(
  "it that this then so well now just too very all is to me oh ah hmm um uh no please and but let's lets".split(
    " ",
  ),
);

/** Pointing back at the earlier request or at what the agent said about it. */
const REFERS = phrase(
  [
    "it",
    "it's",
    "its",
    "that",
    "that's",
    "this",
    "these",
    "those",
    "them",
    "same",
    "the first",
    "the second",
    "the third",
    "the last",
    "the other",
    "the others",
    "the rest",
    "the former",
    "the latter",
    "first one",
    "second one",
    "third one",
    "last one",
    "other one",
    "both",
    "either",
    "neither",
    "option",
    "what about",
    "how about",
    "abar",
    "আবার",
    "too",
    "as well",
    "again",
    "once more",
    "one more",
    "another one",
  ].join("|"),
);
/** A conjunction that opens the message joins it to the request before. */
const OPENS_JOINED = /^(?:and|also|but|plus|then|or) /;

/** True when a short message goes on with the person's previous request. */
export function continuesEarlierRequest(message: string): boolean {
  const tokens = words(message);
  if (tokens.length === 0) return false;
  const text = tokens.join(" ");
  const only = (...sets: ReadonlySet<string>[]) =>
    tokens.every((token) => sets.some((set) => set.has(token)));
  if (ACTS.test(text)) return true;
  if (
    tokens.some((token) => BARE_VERBS.has(token)) &&
    only(BARE_VERBS, BESIDE_A_BARE_VERB, ACKNOWLEDGES, FILLERS)
  )
    return true;
  if (CLOSES.test(text)) return false;
  if (tokens.some((token) => ACKNOWLEDGES.has(token)) && only(ACKNOWLEDGES, FILLERS)) return true;
  return REFERS.test(text) || OPENS_JOINED.test(text);
}
