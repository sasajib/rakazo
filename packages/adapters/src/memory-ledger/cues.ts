/**
 * Rule-based proposals for when no memory model is reachable: only sentences in which the owner
 * explicitly asks for something to be kept ("remember that …"), and a bot's remember text when
 * it repeats the owner's own words. Everything still goes through decide().
 */
import { EXPLICIT_CUE, foldQuote, tokens } from "./text.js";
import type { FactArea, FactCandidate, OwnerMessage } from "./types.js";

const CUE_PREFIX = new RegExp(
  `^.*?${EXPLICIT_CUE.source}\\s*(?:[:,-]\\s*)?(?:that\\s+|this\\s*:\\s*)?`,
  "i",
);

export function guessArea(text: string): FactArea {
  if (
    /\b(?:prefer|like|love|hate|want|always|never|please (?:use|send|write)|don'?t like|format|style)\b/i.test(
      text,
    )
  )
    return "preferences";
  if (
    /\b(?:my (?:wife|husband|son|daughter|mother|mom|father|dad|brother|sister|friend|boss|client|colleague|manager|accountant|partner|assistant))\b|\b[A-Z][\p{L}]+ is my\b/u.test(
      text,
    )
  )
    return "people";
  if (
    /\b(?:client|project|job|work|company|invoice|contract|upwork|fiverr|deadline|business|account)\b/i.test(
      text,
    )
  )
    return "work";
  if (/\b(?:avoid|mistake|lesson|don'?t ever|never again)\b/i.test(text)) return "lessons";
  return "about";
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?\n])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

const capitalized = (text: string) =>
  [...text.matchAll(/\b\p{Lu}[\p{L}\p{M}'-]+(?:\s+\p{Lu}[\p{L}\p{M}'-]+)*/gu)]
    .map((match) => match[0])
    .filter((name) => !/^(?:I|Remember|Please|Note|Keep|From|For|My|The|This|That)$/.test(name));

/** "remember that my accountant is Rahim" → "my accountant is Rahim", quoted verbatim. */
export function cueCandidates(messages: readonly OwnerMessage[]): FactCandidate[] {
  const proposals: FactCandidate[] = [];
  messages.forEach((message, index) => {
    if (!message.current) return;
    for (const sentence of sentences(message.text)) {
      if (!EXPLICIT_CUE.test(sentence) || /\?\s*$/.test(sentence)) continue;
      const clause = sentence
        .replace(CUE_PREFIX, "")
        .replace(/[.!\s]+$/, "")
        .trim();
      if (tokens(clause).length < 3) continue;
      proposals.push({
        area: guessArea(clause),
        text: `${clause[0]!.toUpperCase()}${clause.slice(1)}.`.slice(0, 400),
        quote: clause.slice(0, 400),
        message: index + 1,
        origin: "stated",
        confidence: 0.7,
        entities: capitalized(clause).slice(0, 8),
      });
    }
  });
  return proposals;
}

/**
 * A bot's remember text, kept only where it repeats the owner's words: each sentence of it that
 * appears verbatim in one of the owner's messages becomes a stated proposal.
 */
export function hintCandidates(hint: string, messages: readonly OwnerMessage[]): FactCandidate[] {
  const proposals: FactCandidate[] = [];
  for (const sentence of sentences(hint)) {
    const clause = sentence
      .replace(CUE_PREFIX, "")
      .replace(/[.!\s]+$/, "")
      .trim();
    if (tokens(clause).length < 3) continue;
    const index = messages.findIndex((message) =>
      foldQuote(message.text).includes(foldQuote(clause)),
    );
    if (index < 0) continue;
    proposals.push({
      area: guessArea(clause),
      text: `${clause[0]!.toUpperCase()}${clause.slice(1)}.`.slice(0, 400),
      quote: clause.slice(0, 400),
      message: index + 1,
      origin: "stated",
      confidence: 0.75,
      entities: capitalized(clause).slice(0, 8),
    });
  }
  return proposals;
}
