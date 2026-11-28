import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExpoPushProvider, expoPushData, noticeKey } from "./expo-push.js";
import { MemoryPushTokenStore } from "./push-token-store.test-support.js";

/** Fork (1.41): every push carries a stable notice key and leaves one ids-only log line. */

afterEach(() => {
  vi.unstubAllGlobals();
  installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
});

const context = {
  operationId: "notify",
  traceId: "t",
  spaceId: "space-1",
  userId: "user-1",
  signal: new AbortController().signal,
};

const completion = {
  kind: "completion" as const,
  title: "Umar finished",
  body: "Status 22:30: nothing has changed",
  botId: "bot-1",
  threadId: "thread-1",
  runId: "run-1",
  messageId: "message-1",
  trigger: "routine",
};

describe("notice key", () => {
  it("is the same for every send of one notice and differs between notices", () => {
    expect(noticeKey(completion)).toBe("completion:run-1");
    expect(noticeKey({ kind: "completion", messageId: "m-2" })).toBe("completion:message:m-2");
    expect(noticeKey({ kind: "help", runId: "run-1", messageId: "m-3" })).toBe("help:message:m-3");
    expect(noticeKey({ kind: "help", runId: "run-1" })).toBeUndefined();
    const first = expoPushData(completion, "space-1", "delivery-1");
    const retry = expoPushData(completion, "space-1", "delivery-2");
    expect(first.noticeKey).toBe("completion:run-1");
    expect(retry.noticeKey).toBe(first.noticeKey);
    expect(
      expoPushData({ ...completion, runId: undefined, messageId: undefined }, "s", "d"),
    ).not.toHaveProperty("noticeKey");
  });

  it("never sends the trigger to a device", () => {
    expect(expoPushData(completion, "space-1", "d")).not.toHaveProperty("trigger");
  });
});

describe("notification.sent", () => {
  it("logs kind, run, trigger, chat, devices and key, and never the text", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    const tokens = new MemoryPushTokenStore();
    await tokens.save("user-1", "ExponentPushToken[one]", "", "android_sender");
    await tokens.save("user-1", "ExponentPushToken[two]");
    const keys: Array<string | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        keys.push((JSON.parse(init.body) as { data: { noticeKey?: string } }).data.noticeKey);
        return Response.json({ data: { status: "ok", id: "ticket" } });
      }),
    );
    await new ExpoPushProvider(tokens).deliver(completion, context);
    expect(keys).toEqual(["completion:run-1", "completion:run-1"]);
    const sent = sink.events.filter((event) => event.message === "notification.sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      "notification.kind": "completion",
      "notification.key": "completion:run-1",
      "notification.collapse_id": "thread-1",
      "notification.devices": 2,
      "notification.accepted": 2,
      "notification.failed": 0,
      "run.id": "run-1",
      "run.trigger": "routine",
      "bot.id": "bot-1",
      "thread.id": "thread-1",
      "user.id": "user-1",
    });
    expect(JSON.stringify(sent[0])).not.toContain("nothing has changed");
    expect(JSON.stringify(sent[0])).not.toContain("Umar finished");
  });

  it("logs a send that reached no device", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    vi.stubGlobal("fetch", vi.fn());
    await expect(
      new ExpoPushProvider(new MemoryPushTokenStore()).deliver(completion, context),
    ).resolves.toBe("undeliverable");
    expect(sink.events.find((event) => event.message === "notification.sent")).toMatchObject({
      "notification.devices": 0,
      "notification.accepted": 0,
    });
  });
});

describe("notification.receipt", () => {
  it("logs the outcome of every receipt", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: { ticket: { status: "ok" } } })),
    );
    await new ExpoPushProvider(new MemoryPushTokenStore()).checkReceipt({
      userId: "user-1",
      ticketId: "ticket",
      tokenDigest: "digest",
    });
    expect(sink.events.find((event) => event.message === "notification.receipt")).toMatchObject({
      "receipt.status": "ok",
      "device.digest": "digest",
    });
  });
});
