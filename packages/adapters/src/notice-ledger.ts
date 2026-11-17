import type { PrismaClient } from "@rakazo/db";
import { readMessageBlocks } from "@rakazo/db";

/**
 * What the bot already told the user, and what he ticked (✅ = read/done).
 * Fed back into every run so the same notice or question is not sent again, and used to refuse a
 * near-identical message from an unattended run.
 */
export const NOTICE_TICK = "✅";

/** Runs nobody is watching: a watch event, a routine, another bot, the ticket board. */
const UNATTENDED_TRIGGERS = new Set(["webhook", "routine", "bot_message", "tickets"]);
export function isUnattendedRun(trigger: string | null | undefined): boolean {
  return UNATTENDED_TRIGGERS.has(trigger ?? "");
}
const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_NOTICES = 25;
const SNIPPET_CHARS = 150;
const MAX_LEDGER_BYTES = 3_800;

export type Notice = { id: string; at: Date; text: string; ticked: boolean };

const PREAMBLE =
  "Messages you already sent the user in the last 24 hours. [done] = he ticked it (read/done): it is closed, never mention, re-ask or re-summarise it. [open] = sent, not ticked yet: do not send it again; if there is new information, send only the new part in one short line. Never ask a question that already appears here.\n\n<sent_notices>\n";
const CLOSING = "\n</sent_notices>";

export function renderNoticeLedger(notices: readonly Notice[]): string | undefined {
  if (notices.length === 0) return undefined;
  const lines = notices.map((n) => {
    const stamp = n.at.toISOString().slice(5, 16).replace("T", " ");
    const snippet = n.text.replace(/\s+/g, " ").trim().slice(0, SNIPPET_CHARS);
    return `- [${n.ticked ? "done" : "open"}] ${stamp} UTC: ${snippet}`;
  });
  let body = lines.join("\n");
  while (Buffer.byteLength(body, "utf8") > MAX_LEDGER_BYTES && lines.length > 1) {
    lines.pop();
    body = lines.join("\n");
  }
  return `${PREAMBLE}${body}${CLOSING}`;
}

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 0),
  );
}

/** Word-set overlap (Jaccard) of two messages, 0..1. */
export function textSimilarity(a: string, b: string): number {
  const x = tokens(a);
  const y = tokens(b);
  if (x.size === 0 || y.size === 0) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both += 1;
  return both / (x.size + y.size - both);
}

/** Word overlap above which a message counts as a repeat. Templated messages differing by one word must not. */
export const DUPLICATE_THRESHOLD = 0.9;

/** The earlier notice this text repeats, if any (short texts must match exactly). */
export function findDuplicateNotice(text: string, recent: readonly Notice[]): Notice | undefined {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return recent.find((n) => {
    const prev = n.text.replace(/\s+/g, " ").trim();
    if (prev === t) return true;
    return t.length >= 40 && textSimilarity(t, prev) >= DUPLICATE_THRESHOLD;
  });
}

type Row = {
  id: string;
  role: string;
  blocks: unknown;
  replyToMessageId: string | null;
  createdAt: Date;
};

function textOf(row: Row): string {
  const { blocks } = readMessageBlocks(row as never);
  return (blocks as Array<{ kind: string; text?: string }>)
    .filter((b) => b.kind === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

/** The bot's recent messages in this thread, newest first, each marked ticked or open. */
export async function loadRecentNotices(
  prisma: PrismaClient,
  input: { threadId: string; botId: string; now: Date },
): Promise<Notice[]> {
  const since = new Date(input.now.getTime() - WINDOW_MS);
  const sent = (await prisma.message.findMany({
    where: { threadId: input.threadId, botId: input.botId, role: "bot", createdAt: { gte: since } },
    orderBy: { seq: "desc" },
    take: MAX_NOTICES,
    select: { id: true, role: true, blocks: true, replyToMessageId: true, createdAt: true },
  })) as Row[];
  if (sent.length === 0) return [];
  const replies = (await prisma.message.findMany({
    where: {
      threadId: input.threadId,
      role: "user",
      replyToMessageId: { in: sent.map((m) => m.id) },
      createdAt: { gte: since },
    },
    select: { id: true, role: true, blocks: true, replyToMessageId: true, createdAt: true },
  })) as Row[];
  const ticked = new Set(
    replies.filter((r) => textOf(r).trim() === NOTICE_TICK).map((r) => r.replyToMessageId),
  );
  return sent
    .map((m) => ({ id: m.id, at: m.createdAt, text: textOf(m), ticked: ticked.has(m.id) }))
    .filter((n) => n.at instanceof Date && n.text.trim());
}
