import { describe, expect, it } from "vitest";
import { cueCandidates, hintCandidates } from "./cues.js";
import { foldQuote, holdsSecret, overlap, quoteSources, sameText } from "./text.js";
import type { OwnerMessage } from "./types.js";

const message = (id: string, text: string, current = true): OwnerMessage => ({
  id,
  text,
  at: new Date("2026-11-24T10:00:00Z"),
  current,
});

describe("quote gate", () => {
  const messages = [
    message("m1", "Hi! I moved to Berlin last month, so use CET from now on.", false),
    message("m2", "My accountant is “Rahim Uddin”, he files my taxes."),
  ];

  it("accepts a verbatim quote, ignoring case, spacing and curly quotes", () => {
    expect(quoteSources("i  moved to BERLIN", messages).map((m) => m.id)).toEqual(["m1"]);
    expect(quoteSources('accountant is "Rahim Uddin"', messages).map((m) => m.id)).toEqual(["m2"]);
  });

  it("puts the cited message first", () => {
    const twice = [message("a", "I live in Dhaka"), message("b", "Yes, I live in Dhaka.")];
    expect(quoteSources("I live in Dhaka", twice, 2).map((m) => m.id)).toEqual(["b", "a"]);
  });

  it("rejects words that are not in any owner message", () => {
    expect(quoteSources("I moved to Paris", messages)).toEqual([]);
    // A paraphrase is not a quote.
    expect(quoteSources("the owner relocated to Berlin", messages)).toEqual([]);
  });

  it("rejects empty and one-word quotes", () => {
    expect(quoteSources("", messages)).toEqual([]);
    expect(quoteSources("Berlin", messages)).toEqual([]);
  });

  it("folds accents", () => {
    expect(foldQuote("Café  Déjà")).toBe("cafe deja");
  });
});

describe("secret filter", () => {
  it.each([
    "my card is 4111 1111 1111 1111",
    "password: hunter22",
    "the OTP is 482913",
    // Built at runtime so no key-shaped literal sits in the repository.
    `key ${["sk", "abcdefghijklmnopqrstuvwx"].join("-")}`,
    `token ${["ghp", "abcdefghijklmnopqrstuvwxyz0123"].join("_")}`,
    "login https://example.com/magic?token=abcdef123456",
    "https://user:pa55@example.com/",
  ])("finds %s", (text) => {
    expect(holdsSecret(text)).toBe(true);
  });

  it.each([
    "I live at house 12, road 4, Dhanmondi",
    "my phone ends in 1207",
    "I hate password managers",
    "the postal code is 1207",
    "invoice 2026-11-24 for 1500 USD",
  ])("leaves %s alone", (text) => {
    expect(holdsSecret(text)).toBe(false);
  });
});

describe("text comparison", () => {
  it("treats the same words as the same text", () => {
    expect(sameText("Owner lives in Dhaka.", "owner lives in dhaka")).toBe(true);
    expect(sameText("Owner lives in Dhaka", "Owner lives in Berlin")).toBe(false);
  });

  it("measures content-word overlap", () => {
    expect(overlap("Owner prefers PDF reports", "Owner prefers reports as PDF")).toBeGreaterThan(
      0.7,
    );
    expect(overlap("Owner lives in Dhaka", "Rahim is the accountant")).toBe(0);
  });
});

describe("rule-based cues (no memory model)", () => {
  it("takes the clause after an explicit remember", () => {
    const [candidate] = cueCandidates([
      message("m1", "Thanks. Remember that my accountant is Rahim Uddin."),
    ]);
    expect(candidate).toMatchObject({
      quote: "my accountant is Rahim Uddin",
      area: "people",
      origin: "stated",
      message: 1,
    });
    expect(candidate?.entities).toContain("Rahim Uddin");
  });

  it("ignores questions, context messages and messages without a cue", () => {
    expect(
      cueCandidates([
        message("m1", "Do you remember what my accountant is called?"),
        message("m2", "Remember that I like tea", false),
        message("m3", "I like coffee"),
      ]),
    ).toEqual([]);
  });

  it("keeps a bot's remember text only where it repeats the owner", () => {
    const owner = [message("m1", "Send invoices to billing@acme.test from now on")];
    expect(hintCandidates("Send invoices to billing@acme.test", owner)).toHaveLength(1);
    expect(hintCandidates("The owner seems to like short emails", owner)).toEqual([]);
  });
});
