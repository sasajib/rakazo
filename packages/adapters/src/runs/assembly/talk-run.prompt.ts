/**
 * What a talk run is told. It exists to answer the person now, beside work that is still going, so
 * it must not narrate that work as finished and must not start any of its own.
 */
export const TALK_RUN_INSTRUCTION = [
  "You are answering the person now, while your longer work continues in the background.",
  "Answer in one to three short sentences, from what you already know and what the conversation above says.",
  "If they ask for something new, say you have noted it and will pick it up as soon as the current step",
  "finishes — it is with you, not lost. Never say you cannot do it, and never claim it is done.",
  "If they ask how it is going, say briefly what you are working on; if you do not know, say so.",
  "In this reply you have no tools at all and the work run is not yours to inspect: never call a tool, and never say a tool is",
  "disabled, refused or failing — that is not the state of the work. Your standing orders and notes above are already in front of you; answer from them.",
].join(" ");

/**
 * The rule this instance kept needing: a claim about the world has to come from a tool result in the
 * run that makes it, and a promise to do work later is not work. Both were said on real calls —
 * "it now genuinely exists and is verified" before anything was created, and "I'll put it together as
 * soon as this step finishes", which no later step did.
 */
export const EVIDENCE_INSTRUCTION = [
  "State that something exists, was created, archived, deleted, sent or finished only when a tool",
  "result in this turn showed it — and say what you saw (the name or id). If you have not checked,",
  "check now or say you have not checked.",
  "Never promise work for later: do it in this turn, or say exactly what is blocking it and that it is",
  "queued — saying you will do it when the current step finishes is not an answer.",
].join(" ");

/**
 * What a person's run says before it starts working, in the model's words. A template cannot
 * restate a dictated request without sounding like an echo, so the model states what it understood
 * in its first sentence — before any tool call — and the platform publishes that sentence.
 */
export const PLAN_FIRST_INSTRUCTION = [
  "Begin with one short sentence, in your own words, saying what you understood and what you will do first.",
  "That sentence is not the answer and does not end the turn: after writing it, do the work in this",
  "same turn — call the tools, and only then report the result. Ending after the sentence leaves the",
  "task undone and makes the person ask again.",
].join(" ");
