/**
 * Text checks the server applies to every proposed fact, whatever proposed it.
 *
 * The quote fold and the card-number/key/login-link secret filter adapt Nod's
 * `src/server/memory-tree.ts` (Copyright 2026 n8n GmbH, Apache License 2.0); see NOTICE.
 */
import type { OwnerMessage } from "./types.js";

/** Case, accent and whitespace folded, so a quote matches however the model re-spaced it. */
export function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** fold, with curly quotes and apostrophes made straight. */
export function foldQuote(value: string): string {
  return fold(value.replace(/[“”«»„‟]/g, '"').replace(/[‘’‚‛‹›]/g, "'"));
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/** Word tokens (letters or digits), folded. */
export function tokens(value: string): string[] {
  return [...segmenter.segment(fold(value))]
    .filter((part) => part.isWordLike)
    .map((part) => part.segment);
}

const STOP_WORDS = new Set(
  "a an and are as at be but by for from has have he her his i in is it its me my of on or our she so that the their them they this to was we were with you your".split(
    " ",
  ),
);

/** Content words: tokens without the commonest English function words. */
export function contentWords(value: string): string[] {
  return tokens(value).filter((word) => !STOP_WORDS.has(word));
}

/** A crude English stem, enough to match "lives" with "live" and "moved" with "move". */
export function stem(word: string): string {
  let w = word;
  if (w.length <= 3) return w;
  if (/(?:ss|x|z|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (/ies$/.test(w)) w = `${w.slice(0, -3)}y`;
  else if (/ing$/.test(w) && w.length > 5) w = w.slice(0, -3);
  else if (/ed$/.test(w) && w.length > 4) w = w.slice(0, -2);
  else if (/s$/.test(w) && !/ss$/.test(w)) w = w.slice(0, -1);
  return w.length > 3 ? w.replace(/e$/, "") : w;
}

/** The same words in the same order. */
export function sameText(a: string, b: string): boolean {
  const left = tokens(a).join(" ");
  return Boolean(left) && left === tokens(b).join(" ");
}

/** Jaccard overlap of the two texts' content words, 0-1. */
export function overlap(a: string, b: string): number {
  const left = new Set(contentWords(a));
  const right = new Set(contentWords(b));
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/**
 * The quote gate. Returns the owner messages whose text contains the quote (after folding),
 * the cited one first. A quote that is empty, or found in no owner message, returns none: the
 * proposed fact is then rejected, so web pages, emails, tool output and bot replies can never
 * become facts — they never reach this list.
 */
export function quoteSources(
  quote: string,
  messages: readonly OwnerMessage[],
  cited?: number,
): OwnerMessage[] {
  const needle = foldQuote(quote);
  // Two words at least: a one-word "quote" ("yes") proves nothing about the fact.
  if (!needle || tokens(needle).length < 2) return [];
  const found = messages.filter((message) => foldQuote(message.text).includes(needle));
  const citedMessage = cited === undefined ? undefined : messages[cited - 1];
  return citedMessage && found.includes(citedMessage)
    ? [citedMessage, ...found.filter((message) => message !== citedMessage)]
    : found;
}

// --- Secret filter -------------------------------------------------------------------------

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function holdsCardNumber(text: string): boolean {
  for (const [run] of text.matchAll(/\d[\d\s-]{11,30}\d/g)) {
    const groups = run.split(/[\s-]+/);
    for (let start = 0; start < groups.length; start += 1) {
      let digits = "";
      for (let end = start; end < groups.length; end += 1) {
        digits += groups[end];
        if (digits.length > 19) break;
        if (digits.length >= 13 && /^[2-6]/.test(digits) && luhn(digits)) return true;
      }
    }
  }
  return false;
}

const SECRET_SHAPES: readonly RegExp[] = [
  // URL with a user:password part.
  /https?:\/\/[^\s/@]+:[^\s/@]+@/i,
  // Login, reset and magic links that carry a token.
  /https?:\/\/\S*[?&#](?:token|code|key|sig|signature|auth|access_token|otp|magic|reset)=[^\s&]{6,}/i,
  // Common API key shapes.
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // "password is hunter2", "pin: 1234", "OTP 482913".
  /\b(?:password|passcode|passwd|pwd|pin|otp|one[- ]time code|verification code|api key|secret key|cvv|cvc)\b\s*(?:is|was|=|:)\s*\S{3,}/i,
  /\b(?:otp|pin|cvv|cvc|verification code|one[- ]time code|login code|security code)\b\D{0,12}\b\d{4,8}\b/i,
];

/** A card number, key, login link, password or code: never saved as a fact. */
export function holdsSecret(...texts: ReadonlyArray<string | undefined>): boolean {
  return texts.some(
    (text) =>
      Boolean(text) &&
      (SECRET_SHAPES.some((shape) => shape.test(text!)) ||
        holdsCardNumber(text!) ||
        holdsCardNumber(text!.replace(/\s+/g, ""))),
  );
}

// --- Cues ----------------------------------------------------------------------------------

/** "remember that …", "keep in mind …": the owner asked for this to be kept. */
export const EXPLICIT_CUE =
  /\b(?:please\s+)?(?:remember|keep in mind|note that|make a note|don'?t forget|for future reference|from now on)\b/i;

/** Words that mark a statement as changing an earlier one. */
export const CORRECTION_CUE =
  /\b(?:actually|correction|not anymore|no longer|i was wrong|changed|moved|instead|now (?:i|my|we)|switched|anymore|replaces?|replaced|rather than)\b/i;

/** Words that make a statement hypothetical or unsure. */
const HEDGE_CUE =
  /\b(?:maybe|might|perhaps|probably|thinking (?:about|of)|not sure|i guess|if i|what if|considering|someday)\b/i;

export function isExplicitAsk(text: string): boolean {
  return EXPLICIT_CUE.test(text);
}

export function isCorrection(text: string): boolean {
  return CORRECTION_CUE.test(text);
}

export function isHedged(text: string): boolean {
  return HEDGE_CUE.test(text);
}

/** The sentence of `text` that contains `quote`, or the whole text. */
export function sentenceAround(text: string, quote: string): string {
  const needle = foldQuote(quote);
  const sentences = text.split(/(?<=[.!?\n])\s+/);
  return sentences.find((sentence) => foldQuote(sentence).includes(needle)) ?? text;
}

/** Shared stemmed content words over the smaller side: "you prefer meetings after 3pm" vs
 * "Owner prefers meetings after 3pm" is 1. */
export function stemCover(a: string, b: string): number {
  const left = new Set(
    contentWords(a)
      .map(stem)
      .filter((w) => w !== "owner"),
  );
  const right = new Set(
    contentWords(b)
      .map(stem)
      .filter((w) => w !== "owner"),
  );
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.min(left.size, right.size);
}
