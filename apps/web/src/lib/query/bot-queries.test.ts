import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

vi.mock("./rpc", () => {
  // Any procedure path, as the real client exposes; these tests never call one.
  const client = (): unknown => new Proxy(() => undefined, { get: () => client() });
  return {
    rpc: client(),
    createSpaceRpc: client,
    rpcForSpace: client,
    selectedSpaceId: () => null,
  };
});

import { botsThatLeft, dropBotQueries } from "./bot-queries";
import { spaceQueries } from "./query";
import { spaceChanged } from "./space-changes";

const queries = spaceQueries("user-a", "space-a");
const routinesOf = (botId: string) => queries.routines.list.queryKey({ input: { botId } });
const skillsOf = (botId: string) => queries.skills.list.queryKey({ input: { botId } });

describe("a bot that left the roster", () => {
  it("takes its cached reads with it and leaves every other bot's alone", () => {
    const client = new QueryClient();
    for (const botId of ["kept", "gone", "also-gone"]) {
      client.setQueryData(routinesOf(botId), []);
      client.setQueryData(skillsOf(botId), []);
    }
    client.setQueryData(queries.connections.list.queryKey(), []);

    expect(dropBotQueries(["gone", "also-gone"], client)).toBe(4);

    expect(client.getQueryData(routinesOf("gone"))).toBeUndefined();
    expect(client.getQueryData(skillsOf("also-gone"))).toBeUndefined();
    expect(client.getQueryData(routinesOf("kept"))).toEqual([]);
    expect(client.getQueryData(skillsOf("kept"))).toEqual([]);
    expect(client.getQueryData(queries.connections.list.queryKey())).toEqual([]);
    expect(dropBotQueries([], client)).toBe(0);
  });

  it("has its read in flight cancelled, and is not read again when routines change", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const reads: string[] = [];
    const aborted: string[] = [];
    const watch = (botId: string) =>
      new QueryObserver(client, {
        queryKey: routinesOf(botId),
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          new Promise<never[]>((resolve) => {
            reads.push(botId);
            signal.addEventListener("abort", () => aborted.push(botId));
            if (botId === "kept") resolve([]);
          }),
      }).subscribe(() => undefined);
    watch("kept");
    watch("gone");
    await vi.waitFor(() => expect(reads).toEqual(["kept", "gone"]));

    dropBotQueries(["gone"], client);
    await vi.waitFor(() => expect(aborted).toEqual(["gone"]));
    expect(client.getQueryCache().find({ queryKey: routinesOf("gone") })).toBeUndefined();

    // The server's "routines changed" signal that follows a removal finds nothing of the bot's.
    await spaceChanged("routines", client);
    expect(client.getQueryCache().find({ queryKey: routinesOf("gone") })).toBeUndefined();
    expect(reads.filter((botId) => botId === "gone")).toHaveLength(1);
    // The bot that stayed is read again, as the signal asks.
    expect(reads.filter((botId) => botId === "kept")).toHaveLength(2);
  });

  it("is told apart from the bots that stayed", () => {
    expect(botsThatLeft(["a", "b", "c"], ["c", "a", "d"])).toEqual(["b"]);
    expect(botsThatLeft([], ["a"])).toEqual([]);
  });
});
