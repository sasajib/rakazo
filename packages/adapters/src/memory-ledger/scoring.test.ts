import { describe, expect, it } from "vitest";
import { ASK_BELOW, decide, decisionKey, scoreCandidate } from "./scoring.js";
import type { Fact, FactCandidate, OwnerMessage } from "./types.js";

const at = new Date("2026-11-24T10:00:00Z");
const message = (id: string, text: string): OwnerMessage => ({ id, text, at, current: true });

function fact(overrides: Partial<Fact>): Fact {
  return {
    id: "old",
    spaceId: "space",
    area: "about",
    subject: "owner.home-city",
    text: "Owner lives in Dhaka",
    quote: "I live in Dhaka",
    origin: "stated",
    status: "tentative",
    confidence: 0.8,
    mentions: 1,
    sourceMessageIds: ["m0"],
    entities: ["Dhaka"],
    sourceThreadId: "thread",
    sourceRunId: null,
    writtenByBotId: null,
    writtenByBotName: null,
    userId: "user",
    validFrom: new Date("2026-11-12T10:00:00Z"),
    validTo: null,
    supersedesId: null,
    askedAt: null,
    askedThreadId: null,
    askedMessageId: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function candidate(overrides: Partial<FactCandidate>): FactCandidate {
  return {
    area: "about",
    subject: "owner.home-city",
    text: "Owner lives in Berlin",
    quote: "I live in Berlin",
    message: 1,
    origin: "stated",
    confidence: 0.8,
    entities: ["Berlin"],
    ...overrides,
  };
}

describe("decide: quote gate and filters", () => {
  it("rejects a fact whose quote is not the owner's words", () => {
    expect(
      decide({
        candidate: candidate({ quote: "the owner lives in Berlin now" }),
        messages: [message("m1", "I live in Berlin")],
        existing: [],
      }),
    ).toEqual({ kind: "reject", reason: "quote" });
  });

  it("rejects secrets even when quoted", () => {
    expect(
      decide({
        candidate: candidate({ text: "Owner's PIN is 4821", quote: "my pin: 4821" }),
        messages: [message("m1", "my pin: 4821")],
        existing: [],
      }),
    ).toEqual({ kind: "reject", reason: "secret" });
  });

  it("drops questions and hedges as low confidence", () => {
    expect(
      decide({
        candidate: candidate({ quote: "I should move to Berlin", confidence: 0.5 }),
        messages: [message("m1", "Maybe I should move to Berlin?")],
        existing: [],
      }),
    ).toEqual({ kind: "reject", reason: "low_confidence" });
  });

  it("rejects oversized text", () => {
    expect(
      decide({
        candidate: candidate({ text: "x".repeat(401) }),
        messages: [message("m1", "I live in Berlin")],
        existing: [],
      }).kind,
    ).toBe("reject");
  });
});

describe("decide: new facts", () => {
  it("saves a plain statement silently as tentative", () => {
    const decision = decide({
      candidate: candidate({}),
      messages: [message("m1", "I live in Berlin")],
      existing: [],
    });
    expect(decision).toMatchObject({ kind: "insert", status: "tentative", askUnsure: false });
  });

  it("confirms an explicit remember at once", () => {
    const decision = decide({
      candidate: candidate({}),
      messages: [message("m1", "Remember: I live in Berlin.")],
      existing: [],
    });
    expect(decision).toMatchObject({ kind: "insert", status: "confirmed", askUnsure: false });
  });

  it("asks once about an unsure extraction instead of guessing", () => {
    const decision = decide({
      candidate: candidate({ confidence: 0.45, origin: "inferred" }),
      messages: [message("m1", "I live in Berlin")],
      existing: [],
    });
    expect(decision.kind).toBe("insert");
    if (decision.kind === "insert") {
      expect(decision.confidence).toBeLessThan(ASK_BELOW);
      expect(decision.askUnsure).toBe(true);
      expect(decision.status).toBe("tentative");
    }
  });

  it("scores down a text the quote does not support", () => {
    const source = message("m1", "I live in Berlin");
    const supported = scoreCandidate(candidate({}), source, false);
    const invented = scoreCandidate(
      candidate({ text: "Owner works as a dentist at Charité hospital" }),
      source,
      false,
    );
    expect(invented).toBeLessThan(supported);
  });
});

describe("decide: repeats", () => {
  it("adds evidence and confirms a fact said again in another message", () => {
    const decision = decide({
      candidate: candidate({ text: "Owner lives in Dhaka", quote: "I live in Dhaka" }),
      messages: [message("m2", "As I said, I live in Dhaka")],
      existing: [fact({})],
    });
    expect(decision).toMatchObject({ kind: "reinforce", newSource: true, confirm: true });
  });

  it("does not count the same message twice", () => {
    const decision = decide({
      candidate: candidate({ text: "Owner lives in Dhaka", quote: "I live in Dhaka" }),
      messages: [message("m0", "I live in Dhaka")],
      existing: [fact({})],
    });
    expect(decision).toMatchObject({ kind: "reinforce", newSource: false, confirm: false });
  });
});

describe("decide: conflicts and supersession", () => {
  const messages = [message("m1", "I live in Berlin")];

  it("newer wins silently over a tentative fact on the same subject", () => {
    const old = fact({ status: "tentative" });
    const decision = decide({ candidate: candidate({}), messages, existing: [old] });
    expect(decision).toMatchObject({ kind: "insert", supersedes: [old], conflicts: [] });
  });

  it("newer wins over a fact the model named as replaced, whatever its subject", () => {
    const old = fact({ subject: "owner.city", status: "tentative" });
    const decision = decide({
      candidate: candidate({ replaces: ["old"] }),
      messages,
      existing: [old],
    });
    expect(decision).toMatchObject({ kind: "insert", supersedes: [old] });
  });

  it("never replaces a confirmed fact on a plain new statement: both disputed, owner asked", () => {
    const old = fact({ status: "confirmed" });
    const decision = decide({ candidate: candidate({}), messages, existing: [old] });
    expect(decision).toMatchObject({
      kind: "insert",
      status: "disputed",
      supersedes: [],
      conflicts: [old],
    });
  });

  it("an explicit, confident correction replaces a confirmed fact without asking", () => {
    const old = fact({ status: "confirmed" });
    const decision = decide({
      candidate: candidate({ quote: "I moved, I live in Berlin now", correction: true }),
      messages: [message("m1", "Actually I moved, I live in Berlin now.")],
      existing: [old],
    });
    expect(decision).toMatchObject({
      kind: "insert",
      status: "confirmed",
      supersedes: [old],
      conflicts: [],
    });
  });

  it("the model's correction flag alone does not replace a confirmed fact: both disputed", () => {
    const old = fact({
      status: "confirmed",
      area: "preferences",
      subject: "pref.meeting-time",
      text: "Owner prefers meetings after 3pm",
      quote: "I prefer meetings after 3pm",
      entities: [],
    });
    const decision = decide({
      candidate: candidate({
        area: "preferences",
        subject: "pref.meeting-time",
        text: "Owner likes meetings before 11am",
        quote: "I like meetings before 11am",
        entities: [],
        confidence: 0.95,
        correction: true,
        replaces: ["old"],
      }),
      messages: [
        message("m1", "Book my calls with the bank in the morning, I like meetings before 11am."),
      ],
      existing: [old],
    });
    expect(decision).toMatchObject({ kind: "insert", status: "disputed", conflicts: [old] });
  });

  it("the owner's latest message correcting it by name replaces a confirmed fact", () => {
    const old = fact({
      status: "confirmed",
      subject: "owner.car",
      text: "Owner's car is a white Honda Civic",
      quote: "my car is a white Honda Civic",
      entities: ["Honda Civic"],
    });
    const decision = decide({
      candidate: candidate({
        subject: "owner.car",
        text: "Owner's car is a blue Toyota Corolla",
        quote: "my blue Toyota Corolla",
        message: 1,
        entities: ["Toyota Corolla"],
        confidence: 0.9,
      }),
      messages: [
        {
          id: "m1",
          text: "Get my blue Toyota Corolla washed this weekend, it is my car.",
          at,
          current: false,
        },
        { id: "m2", text: "Corolla replaces the Civic", at, current: true },
      ],
      existing: [old],
    });
    expect(decision).toMatchObject({ kind: "insert", status: "confirmed", supersedes: [old] });
  });

  it("an unsure correction of a confirmed fact still asks", () => {
    const old = fact({ status: "confirmed" });
    const decision = decide({
      candidate: candidate({ confidence: 0.4, correction: true, origin: "inferred" }),
      messages,
      existing: [old],
    });
    expect(decision).toMatchObject({ kind: "insert", status: "disputed", conflicts: [old] });
  });

  it("does not ask again about a statement the owner already turned down", () => {
    const old = fact({ status: "confirmed" });
    const decision = decide({
      candidate: candidate({}),
      messages,
      existing: [old],
      decidedAgainst: new Set([decisionKey("old", "Owner lives in Berlin")]),
    });
    expect(decision).toEqual({ kind: "reject", reason: "already_decided" });
  });

  it("leaves facts on other subjects alone", () => {
    const other = fact({ id: "job", subject: "owner.employer", text: "Owner works at Acme" });
    const decision = decide({ candidate: candidate({}), messages, existing: [other] });
    expect(decision).toMatchObject({ kind: "insert", supersedes: [], conflicts: [] });
  });
});
