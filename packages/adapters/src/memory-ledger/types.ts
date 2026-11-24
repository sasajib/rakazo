/**
 * The shared fact ledger: one row per fact the owner told any bot in a Space. Facts belong to the
 * Space (a bot is only credited as the one whose run learned it), so deleting a bot leaves the
 * owner's facts and nothing of the bot's own.
 */
export const FACT_AREAS = ["about", "preferences", "people", "work", "lessons"] as const;
export type FactArea = (typeof FACT_AREAS)[number];

export const FACT_STATUSES = [
  "tentative",
  "confirmed",
  "disputed",
  "superseded",
  "retracted",
] as const;
export type FactStatus = (typeof FACT_STATUSES)[number];

/** Statuses a bot is shown and a new fact is compared against. */
export const LIVE_FACT_STATUSES: readonly FactStatus[] = ["tentative", "confirmed", "disputed"];

export type FactOrigin = "stated" | "inferred";

export const LINK_KINDS = ["related", "supersedes", "contradicts", "about_person"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export const FACT_TEXT_MAX_CHARS = 400;
export const FACT_QUOTE_MAX_CHARS = 400;

export interface Fact {
  id: string;
  spaceId: string;
  area: FactArea;
  /** Stable slug for what the fact is about ("owner.home-city"), used to find contradictions. */
  subject: string | null;
  text: string;
  /** Verbatim words from one of the owner's messages; the server checked them. */
  quote: string;
  origin: FactOrigin;
  status: FactStatus;
  confidence: number;
  /** Distinct owner messages that said it. */
  mentions: number;
  sourceMessageIds: string[];
  entities: string[];
  sourceThreadId: string | null;
  sourceRunId: string | null;
  /** Attribution only: the bot whose run learned it. */
  writtenByBotId: string | null;
  writtenByBotName: string | null;
  userId: string | null;
  validFrom: Date;
  validTo: Date | null;
  supersedesId: string | null;
  /** When the owner was asked about this fact (low confidence); asked once. */
  askedAt: Date | null;
  askedThreadId: string | null;
  /** The card message that asked. */
  askedMessageId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FactLink {
  id: string;
  spaceId: string;
  fromId: string;
  toId: string;
  kind: LinkKind;
  score: number | null;
  /** On a `contradicts` link: when the owner was asked which one holds (asked once per pair). */
  askedAt: Date | null;
  askedThreadId: string | null;
  askedMessageId: string | null;
  resolvedAt: Date | null;
  resolution: "use_new" | "keep_old" | null;
  createdAt: Date;
}

/** One of the owner's own messages, in the order they were sent. */
export interface OwnerMessage {
  id: string;
  text: string;
  at: Date;
  /** Sent during the run being learned from (the rest are context). */
  current: boolean;
}

/** What the memory model (or the rule-based cue reader) proposes. Nothing here is trusted. */
export interface FactCandidate {
  area: FactArea;
  subject?: string | undefined;
  text: string;
  quote: string;
  /** 1-based index into the owner messages the proposer was shown. */
  message?: number | undefined;
  origin: FactOrigin;
  /** The proposer's own confidence, 0-1. */
  confidence: number;
  entities: string[];
  /** Ids of existing facts this one changes or corrects. */
  replaces?: string[] | undefined;
  /** The owner explicitly corrected an earlier statement. */
  correction?: boolean | undefined;
  /** Ids of existing facts this one is related to. */
  related?: string[] | undefined;
}

export type NewFact = Omit<
  Fact,
  "id" | "createdAt" | "updatedAt" | "askedAt" | "askedThreadId" | "askedMessageId"
>;
