/**
 * Fork: how an owner's reply to a pending plan reads. Pure, so the server (typed or spoken
 * message) and the tests agree on one rule; the voice agent carries a copy of the same words.
 *
 * approve  "yes", "go ahead", "do it", "approved", "sounds good" with nothing that changes the plan
 * change   names a change: "change step 2 to ...", "instead ...", "no, first ...", "add a step ..."
 * reject   "no", "cancel it", "don't do that", "forget it" with nothing else
 * other    anything else (a question, an unrelated request): the plan keeps waiting
 */
export type PlanReplyIntent = "approve" | "change" | "reject" | "other";

const APPROVE =
  /^(?:(?:yes|yeah|yep|yup|ok(?:ay)?|sure|alright|right|fine|great|perfect|good|correct|exactly)\b[\s,.!]*)*(?:yes|yeah|yep|yup|ok(?:ay)?|sure|alright|fine|great|perfect|go(?: ahead)?|go for it|do it|approved?|proceed|confirm(?:ed)?|sounds good|looks good|that'?s (?:right|correct|fine|good)|carry on|start|let'?s go|send it|please do|please go ahead)\b/i;
const APPROVE_ANYWHERE =
  /\b(?:go ahead|do it|approved?|proceed|sounds good|looks good|go for it|send it|carry it out)\b/i;
const CHANGE =
  /\b(?:change|instead|rather|replace|swap|edit|modify|update the plan|add (?:a )?step|remove (?:the )?step|drop (?:the )?step|step (?:\d+|one|two|three|four|five|six)|first (?:go|open|check|find)|before that|after that|but\b|except|actually|not that|wrong|should (?:go|open|use|be)|you should|tell (?:him|her|them) to)\b/i;
const REJECT =
  /^(?:no|nope|nah|cancel(?: it| that)?|stop|don'?t(?: do (?:it|that))?|forget it|never ?mind|reject(?:ed)?|not now|scrap (?:it|that))\b[\s,.!]*$/i;
const NOISE = /^(?:(?:uh+|um+|er+|erm|hmm+|so|well|oh)\b[\s,.]*)+/i;

export function planReplyIntent(text: string): PlanReplyIntent {
  const said = String(text ?? "")
    .trim()
    .replace(NOISE, "")
    .trim();
  if (!said) return "other";
  if (REJECT.test(said)) return "reject";
  const words = said.split(/\s+/).length;
  if (CHANGE.test(said) && words >= 3) return "change";
  if (/^(?:no|nope|nah)\b/i.test(said) && words >= 3) return "change";
  if (APPROVE.test(said) && words <= 12 && !/\?\s*$/.test(said)) return "approve";
  if (APPROVE_ANYWHERE.test(said) && words <= 12 && !/\?\s*$/.test(said)) return "approve";
  return "other";
}
