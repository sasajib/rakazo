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

/** Priority tier: 0 safety and approvals, 1 the user's explicit commands, 2 procedures (default), 3 preferences. Lower wins. */
export type StandingTier = 0 | 1 | 2 | 3;
export const DEFAULT_TIER: StandingTier = 2;

/** Typed links to other keys. They are what make a rule's neighbours (its exceptions, what it beats, what it needs) findable. */
export type StandingLinks = {
  /** `>key`: this entry wins over key when both apply. */
  overrides: string[];
  /** `^key`: this entry is a declared exception to key. */
  exceptionOf: string[];
  /** `+key`: this entry only makes sense together with key. */
  dependsOn: string[];
  /** `@tag`: where it applies (a site or run type), for selection. */
  tags: string[];
};

export type StandingEntry = {
  kind: StandingKind;
  key: string;
  /** YYYY-MM-DD, the day the user's word was recorded. */
  date: string;
  text: string;
  /** Absent = DEFAULT_TIER. */
  tier?: StandingTier;
  links?: StandingLinks;
};

export const emptyLinks = (): StandingLinks => ({
  overrides: [],
  exceptionOf: [],
  dependsOn: [],
  tags: [],
});
export const tierOf = (e: Pick<StandingEntry, "tier">): StandingTier => e.tier ?? DEFAULT_TIER;

const HEADER = "# Standing orders";
// [kind key] or [kind key p1 >other ^rule +needs @site]: tokens after the key are the tier and the typed links.
const LINE = /^- \[(rule|decision) ([^\]\s]+)((?: [^\]\s]+)*)\] (\d{4}-\d{2}-\d{2}): (.*)$/;
const TAG_MAX_CHARS = 30;

export function normalizeStandingKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, KEY_MAX_CHARS);
}

/** Tokens such as `p1 >r3 ^r5 +r19 @upwork` into a tier and links; an error names the bad token. */
export function parseStandingTokens(
  raw: string,
): { tier?: StandingTier; links: StandingLinks } | { error: string } {
  const links = emptyLinks();
  let tier: StandingTier | undefined;
  for (const token of raw.split(/[\s,]+/).filter(Boolean)) {
    const head = token[0]!;
    const rest = token.slice(1);
    if (/^p[0-3]$/.test(token)) {
      tier = Number(token[1]) as StandingTier;
      continue;
    }
    const target =
      head === "@"
        ? rest
            .toLowerCase()
            .replace(/[^a-z0-9._-]+/g, "-")
            .slice(0, TAG_MAX_CHARS)
        : normalizeStandingKey(rest);
    if (!target) return { error: `bad link token \`${token}\`: nothing after ${head}.` };
    const list = {
      ">": links.overrides,
      "^": links.exceptionOf,
      "+": links.dependsOn,
      "@": links.tags,
    }[head];
    if (!list) {
      return {
        error: `bad token \`${token}\`: use p0-p3, >key (wins over), ^key (exception of), +key (needs), @tag (applies to).`,
      };
    }
    if (!list.includes(target)) list.push(target);
  }
  return { ...(tier === undefined ? {} : { tier }), links };
}

function renderTokens(e: StandingEntry): string {
  const l = e.links;
  const parts = [
    ...(e.tier !== undefined && e.tier !== DEFAULT_TIER ? [`p${e.tier}`] : []),
    ...(l?.overrides ?? []).map((k) => `>${k}`),
    ...(l?.exceptionOf ?? []).map((k) => `^${k}`),
    ...(l?.dependsOn ?? []).map((k) => `+${k}`),
    ...(l?.tags ?? []).map((k) => `@${k}`),
  ];
  return parts.length ? ` ${parts.join(" ")}` : "";
}

export function parseStandingOrders(content: string): StandingEntry[] {
  const entries: StandingEntry[] = [];
  for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
    const match = LINE.exec(line.trim());
    if (!match) continue;
    const tokens = match[3]?.trim() ? parseStandingTokens(match[3]) : { links: emptyLinks() };
    const parsed = "error" in tokens ? { links: emptyLinks() } : tokens;
    const hasLinks = Object.values(parsed.links).some((v) => v.length > 0);
    entries.push({
      kind: match[1] as StandingKind,
      key: match[2]!,
      date: match[4]!,
      text: match[5]!,
      ...(parsed.tier === undefined ? {} : { tier: parsed.tier }),
      ...(hasLinks ? { links: parsed.links } : {}),
    });
  }
  return entries;
}

export function renderStandingOrders(entries: readonly StandingEntry[]): string {
  const lines = entries.map((e) => `- ${renderEntry(e)}`);
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
  input: {
    kind: StandingKind;
    key: string;
    /** Omitted on an existing entry keeps its text (change only tier or links); "" removes the entry. */
    text?: string;
    /** 0-3; omitted keeps the entry's current tier (default 2). */
    tier?: number;
    /** Tokens like `>r3 ^r5 +r19 @upwork`; omitted keeps the current links, "" clears them. */
    links?: string;
  },
  today: string,
  maxBytes = STANDING_ORDERS_MAX_BYTES,
): StandingEdit {
  const key = normalizeStandingKey(input.key);
  if (!key)
    return { error: "key is required (a short topic name such as `salary` or `R3-calls`)." };
  if (input.kind !== "rule" && input.kind !== "decision") {
    return { error: "kind must be `rule` or `decision`." };
  }
  const current = parseStandingOrders(existing).find((e) => e.key === key);
  if (input.text === undefined && !current) {
    return { error: "text is required for a new entry." };
  }
  const text = (input.text ?? current?.text ?? "").replace(/\s+/g, " ").trim();
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
  const old = at === -1 ? undefined : entries[at]!;
  let tier: StandingTier | undefined = old?.tier;
  let links: StandingLinks | undefined = old?.links;
  if (input.tier !== undefined && input.tier !== null) {
    if (![0, 1, 2, 3].includes(Number(input.tier)))
      return { error: "tier must be 0, 1, 2 or 3 (lower wins)." };
    tier = Number(input.tier) as StandingTier;
  }
  if (input.links !== undefined) {
    const parsed = parseStandingTokens(String(input.links));
    if ("error" in parsed) return { error: parsed.error };
    if (parsed.tier !== undefined) tier = parsed.tier;
    links = Object.values(parsed.links).some((v) => v.length > 0) ? parsed.links : undefined;
    if (links && [...links.overrides, ...links.exceptionOf, ...links.dependsOn].includes(key)) {
      return { error: "an entry cannot link to itself." };
    }
  }
  const next: StandingEntry = {
    kind: input.kind,
    key,
    date: today,
    text,
    ...(tier === undefined || tier === DEFAULT_TIER ? {} : { tier }),
    ...(links ? { links } : {}),
  };
  if (!old) {
    entries.push(next);
  } else {
    if (
      old.kind === next.kind &&
      old.text === next.text &&
      renderTokens(old) === renderTokens(next)
    ) {
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
  return `[${e.kind} ${e.key}${renderTokens(e)}] ${e.date}: ${e.text}`;
}

const PREAMBLE =
  "These are the user's standing orders for every bot in this space. They are instructions, not background data. " +
  "Where they conflict with durable memory, your own instructions or earlier chat messages, the standing order wins; " +
  "the user's newest message wins over both. [decision ...] lines are SETTLED: use them exactly as written, never ask the user about them again, " +
  "never re-show an older draft or figure for that topic. Before you ask the user anything, check this list. " +
  "When the user states a new rule or settles something, record it at once with standing_set; when he changes one, set the SAME key again (it replaces the old line). " +
  "Never keep a second line for the same topic. " +
  "Order and links: entries are listed by priority tier p0 (safety, approvals) then p1 (the user's explicit commands), p2 (procedures, the default, not shown), p3 (preferences); a lower tier wins when two entries conflict. " +
  "`>key` = this entry wins over key; `^key` = this entry is a declared exception to key (apply the exception only where it says so, otherwise key stands); " +
  "`+key` = read together with key; `@tag` = where it applies. When you act under an entry, also read the entries it links to.";

/** The prompt block, or undefined when nothing is set. */
export function renderStandingOrdersBlock(content: string | undefined): string | undefined {
  const entries = parseStandingOrders(content ?? "");
  if (entries.length === 0) return undefined;
  // Highest priority first (stable within a tier), so the most binding rules are read first and never trimmed.
  const ordered = entries
    .map((e, index) => ({ e, index }))
    .sort((a, b) => tierOf(a.e) - tierOf(b.e) || a.index - b.index)
    .map(({ e }) => e);
  const body = ordered.map(renderEntry).join("\n");
  return `${PREAMBLE}\n\n<standing_orders>\n${body}\n</standing_orders>`;
}
