/**
 * Standing orders: the user's rules and settled decisions, one line per key.
 *
 * Why this exists: rules kept as free text in a bot's MEMORY.md get appended to, never replaced, so
 * an old rule survives next to its correction. Here a key holds exactly one line; setting a key
 * again replaces that line in place, so a superseded rule cannot survive.
 */

/** Space memory document that holds the standing orders (read by every bot of the space). */
export const STANDING_ORDERS_PATH = "STANDING.md";
export const STANDING_ORDERS_MAX_BYTES = 24 * 1024;
export const STANDING_ENTRY_MAX_CHARS = 700;
const KEY_MAX_CHARS = 60;

export type StandingKind = "rule" | "decision";

export type StandingEntry = {
  kind: StandingKind;
  key: string;
  /** YYYY-MM-DD, the day the user's word was recorded. */
  date: string;
  text: string;
};

const HEADER = "# Standing orders";
const LINE = /^- \[(rule|decision) ([^\]]+)\] (\d{4}-\d{2}-\d{2}): (.*)$/;

export function normalizeStandingKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, KEY_MAX_CHARS);
}

export function parseStandingOrders(content: string): StandingEntry[] {
  const entries: StandingEntry[] = [];
  for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
    const match = LINE.exec(line.trim());
    if (!match) continue;
    entries.push({
      kind: match[1] as StandingKind,
      key: match[2]!,
      date: match[3]!,
      text: match[4]!,
    });
  }
  return entries;
}

export function renderStandingOrders(entries: readonly StandingEntry[]): string {
  const lines = entries.map((e) => `- [${e.kind} ${e.key}] ${e.date}: ${e.text}`);
  return `${HEADER}\n\n${lines.join("\n")}${lines.length ? "\n" : ""}`;
}

export type StandingEdit =
  | { content: string; action: "added" | "replaced" | "removed" | "unchanged"; previous?: string }
  | { error: string };

/**
 * Sets (or with empty text removes) the entry for `key`. A key is unique across rules and
 * decisions, so one topic can never hold two lines. `today` is YYYY-MM-DD in the user's zone.
 */
export function setStandingOrder(
  existing: string,
  input: { kind: StandingKind; key: string; text: string },
  today: string,
  maxBytes = STANDING_ORDERS_MAX_BYTES,
): StandingEdit {
  const key = normalizeStandingKey(input.key);
  if (!key)
    return { error: "key is required (a short topic name such as `salary` or `R3-calls`)." };
  if (input.kind !== "rule" && input.kind !== "decision") {
    return { error: "kind must be `rule` or `decision`." };
  }
  const text = input.text.replace(/\s+/g, " ").trim();
  if (text.length > STANDING_ENTRY_MAX_CHARS) {
    return {
      error: `text is ${text.length} characters; keep an entry under ${STANDING_ENTRY_MAX_CHARS}. Split it into two keys.`,
    };
  }
  const entries = parseStandingOrders(existing);
  const at = entries.findIndex((e) => e.key === key);
  const previous = at === -1 ? undefined : renderEntry(entries[at]!);
  if (!text) {
    if (at === -1) return { content: existing, action: "unchanged" };
    entries.splice(at, 1);
    return { content: renderStandingOrders(entries), action: "removed", previous };
  }
  const next: StandingEntry = { kind: input.kind, key, date: today, text };
  if (at === -1) {
    entries.push(next);
  } else {
    const old = entries[at]!;
    if (old.kind === next.kind && old.text === next.text) {
      return { content: existing, action: "unchanged", previous };
    }
    entries[at] = next;
  }
  const content = renderStandingOrders(entries);
  if (Buffer.byteLength(content, "utf8") > maxBytes) {
    return {
      error: `Standing orders are full (${maxBytes} bytes). Remove or merge an entry first.`,
    };
  }
  return { content, action: at === -1 ? "added" : "replaced", ...(previous ? { previous } : {}) };
}

function renderEntry(e: StandingEntry): string {
  return `[${e.kind} ${e.key}] ${e.date}: ${e.text}`;
}

const PREAMBLE =
  "These are the user's standing orders for every bot in this space. They are instructions, not background data. " +
  "Where they conflict with durable memory, your own instructions or earlier chat messages, the standing order wins; " +
  "the user's newest message wins over both. [decision ...] lines are SETTLED: use them exactly as written, never ask the user about them again, " +
  "never re-show an older draft or figure for that topic. Before you ask the user anything, check this list. " +
  "When the user states a new rule or settles something, record it at once with standing_set; when he changes one, set the SAME key again (it replaces the old line). " +
  "Never keep a second line for the same topic.";

/** The prompt block, or undefined when nothing is set. */
export function renderStandingOrdersBlock(content: string | undefined): string | undefined {
  const entries = parseStandingOrders(content ?? "");
  if (entries.length === 0) return undefined;
  const body = entries.map(renderEntry).join("\n");
  return `${PREAMBLE}\n\n<standing_orders>\n${body}\n</standing_orders>`;
}
