import type { StandingEntry } from "./standing-orders.js";
import { tierOf } from "./standing-orders.js";

/**
 * The standing orders as a graph: entries are nodes, `>` `^` `+` links are edges.
 * Used to keep the binding core intact when the prompt block has to shrink, and to find an entry's neighbours.
 */

/** Above this the prompt block is trimmed to its binding core plus what fits; below it nothing is left out. */
export const STANDING_PROMPT_SOFT_BYTES = 16 * 1024;

const linkKeys = (e: StandingEntry): string[] => [
  ...(e.links?.overrides ?? []),
  ...(e.links?.exceptionOf ?? []),
  ...(e.links?.dependsOn ?? []),
];

/** Keys linked to `key` in either direction, across all link types. */
export function neighbors(entries: readonly StandingEntry[], key: string): string[] {
  const out = new Set<string>();
  const own = entries.find((e) => e.key === key);
  for (const k of own ? linkKeys(own) : []) out.add(k);
  for (const e of entries) if (e.key !== key && linkKeys(e).includes(key)) out.add(e.key);
  out.delete(key);
  return [...out];
}

/** `seeds` plus everything within `hops` links of them. */
export function closure(
  entries: readonly StandingEntry[],
  seeds: readonly string[],
  hops = 1,
): Set<string> {
  const known = new Set(entries.map((e) => e.key));
  const seen = new Set(seeds.filter((k) => known.has(k)));
  let frontier = [...seen];
  for (let i = 0; i < hops; i += 1) {
    const next: string[] = [];
    for (const key of frontier) {
      for (const n of neighbors(entries, key)) {
        if (known.has(n) && !seen.has(n)) {
          seen.add(n);
          next.push(n);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

/**
 * Picks the entries that go into the prompt within `maxBytes` (as rendered by `size`). Everything fits: all of
 * them, in the given order. Otherwise the core is never dropped: tiers 0 and 1 plus their direct neighbours;
 * the rest join by tier, newest first, while they fit. Returns kept entries in the original order.
 */
export function selectForPrompt(
  entries: readonly StandingEntry[],
  maxBytes: number,
  size: (e: StandingEntry) => number,
): { kept: StandingEntry[]; omitted: string[] } {
  const total = entries.reduce((n, e) => n + size(e) + 1, 0);
  if (total <= maxBytes) return { kept: [...entries], omitted: [] };
  const core = closure(
    entries,
    entries.filter((e) => tierOf(e) <= 1).map((e) => e.key),
    1,
  );
  const chosen = new Set(core);
  let used = entries.filter((e) => chosen.has(e.key)).reduce((n, e) => n + size(e) + 1, 0);
  const rest = entries
    .filter((e) => !chosen.has(e.key))
    .sort((a, b) => tierOf(a) - tierOf(b) || b.date.localeCompare(a.date));
  for (const e of rest) {
    const cost = size(e) + 1;
    if (used + cost > maxBytes) continue;
    chosen.add(e.key);
    used += cost;
  }
  return {
    kept: entries.filter((e) => chosen.has(e.key)),
    omitted: entries.filter((e) => !chosen.has(e.key)).map((e) => e.key),
  };
}
