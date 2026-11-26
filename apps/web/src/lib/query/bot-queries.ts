import type { Query, QueryClient } from "@tanstack/react-query";
import { queryClient } from "./query";

/** The bot a per-bot read is for: its input's `botId`, wherever the key carries the input. */
function botOf(query: Pick<Query, "queryKey">): string | undefined {
  for (const part of query.queryKey) {
    if (!part || typeof part !== "object" || Array.isArray(part)) continue;
    const input = (part as { input?: unknown }).input;
    const botId = input && typeof input === "object" ? (input as { botId?: unknown }).botId : null;
    if (typeof botId === "string") return botId;
  }
  return undefined;
}

/**
 * Fork: forgets every per-bot read of bots that left the roster (removed or archived, here or
 * from another client). Their reads in flight are cancelled and their cached data dropped, so
 * a later "routines changed" or "runs changed" signal has nothing of theirs to read again: each
 * such read was a 404 on the server. Returns how many reads were dropped.
 */
export function dropBotQueries(
  botIds: Iterable<string>,
  client: QueryClient = queryClient,
): number {
  const gone = new Set(botIds);
  if (gone.size === 0) return 0;
  const predicate = (query: Pick<Query, "queryKey">) => {
    const botId = botOf(query);
    return botId !== undefined && gone.has(botId);
  };
  const dropped = client.getQueryCache().findAll({ predicate }).length;
  void client.cancelQueries({ predicate });
  client.removeQueries({ predicate });
  return dropped;
}

/** The ids in `previous` that `next` no longer has. */
export function botsThatLeft(previous: Iterable<string>, next: Iterable<string>): string[] {
  const now = new Set(next);
  return [...previous].filter((id) => !now.has(id));
}
