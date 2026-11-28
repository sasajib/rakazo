import type { NotificationMessage } from "@rakazo/adapter-kit";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "../runs/executor/executor-deps.js";
import { notifyRun } from "../runs/lifecycle/run-notifications.js";
import {
  noticeFingerprint,
  REPEAT_NOTICE_WINDOW_MS,
  RepeatNoticeLedger,
  repeatGuardApplies,
  repeatNoticeGuardEnabled,
  repeatNotices,
} from "./repeat-notice.js";

vi.mock("./notification-identity.js", () => ({ notificationIdentity: async () => undefined }));
vi.mock("@rakazo/db", () => ({
  countUnreadInboxChats: async () => 1,
  membersSnoozing: async () => new Set<string>(),
}));

/** Fork (1.41): an unattended run that says the same thing again is not pushed again. */

// The live case, 27 Nov: a status routine every 30 minutes.
const STATUS_2200 =
  "Status, 22:00 (Dhaka), 2026-11-27: - Penpot: https://penpot.example returns HTTP 200. - Web Designer: waiting";
const STATUS_2230 =
  "Status, 22:30 (Dhaka), 2026-11-27: - Nothing has changed since 22:00. - Penpot: https://penpot.example returns HTTP 200.";
const STATUS_2300 =
  "Status, 23:00 (Dhaka), 2026-11-27: - Nothing has changed since 22:30. - Penpot: https://penpot.example returns HTTP 200.";

describe("notice fingerprint", () => {
  it("ignores times, dates and day names, nothing else", () => {
    expect(noticeFingerprint("Umar finished", STATUS_2230)).toBe(
      noticeFingerprint("Umar finished", STATUS_2300),
    );
    expect(noticeFingerprint("Umar finished", STATUS_2200)).not.toBe(
      noticeFingerprint("Umar finished", STATUS_2230),
    );
    expect(noticeFingerprint("a", "Reminder for Fri 28 Nov at 9:30 am")).toBe(
      noticeFingerprint("a", "Reminder for Saturday 29 Nov at 10:15 pm"),
    );
    // A number that is not a clock is news: progress, prices, counts.
    expect(noticeFingerprint("a", "Downloaded 3 of 10")).not.toBe(
      noticeFingerprint("a", "Downloaded 7 of 10"),
    );
    expect(noticeFingerprint("a", "Fajr jamat is at 05:45")).not.toBe(
      noticeFingerprint("a", "Dhuhr jamat is at 13:20"),
    );
  });
});

describe("repeat ledger", () => {
  it("holds back the same notice within the window and lets a change or the window through", () => {
    const ledger = new RepeatNoticeLedger();
    expect(ledger.isRepeat("k", "a", 0)).toBe(false);
    expect(ledger.isRepeat("k", "a", 1_000)).toBe(true);
    expect(ledger.isRepeat("k", "b", 2_000)).toBe(false);
    expect(ledger.isRepeat("k", "a", 3_000)).toBe(false);
    expect(ledger.isRepeat("k", "a", 3_000 + REPEAT_NOTICE_WINDOW_MS)).toBe(false);
    expect(ledger.isRepeat("other", "a", 3_000 + REPEAT_NOTICE_WINDOW_MS)).toBe(false);
    ledger.forget("k", "a");
    expect(ledger.isRepeat("k", "a", 4_000 + REPEAT_NOTICE_WINDOW_MS)).toBe(false);
  });

  it("applies only to runs nobody is waiting on", () => {
    for (const trigger of ["routine", "webhook", "bot_message", "helper_result", "job_result"])
      expect(repeatGuardApplies(trigger)).toBe(true);
    for (const trigger of ["user", "follow_up", "call_end", "talk", "reaction", undefined])
      expect(repeatGuardApplies(trigger)).toBe(false);
  });

  it("is on unless switched off", () => {
    expect(repeatNoticeGuardEnabled({})).toBe(true);
    for (const off of ["0", "false", "off", " OFF "])
      expect(repeatNoticeGuardEnabled({ NOTIFY_REPEAT_GUARD: off })).toBe(false);
  });
});

function deps() {
  const send = vi.fn(async (_message: NotificationMessage, _context: unknown) => undefined);
  const publish = vi.fn(async () => undefined);
  const bot = { id: "bot-1", name: "Umar", color: "#000000", avatarSet: "", notifyOnFinish: true };
  const value = {
    prisma: {
      spaceMember: { findMany: async () => [{ userId: "user-1" }] },
      routine: { findUnique: async () => null },
      run: { findFirst: async () => ({ bot, thread: { groupId: null } }) },
      message: { findFirst: async () => null },
    },
    events: { publishChatAlert: publish },
    notifications: { send },
  } as unknown as ExecutorDeps;
  return { value, send, publish };
}

const run = (trigger: string) => ({
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  threadId: "thread-1",
  trigger,
});

const notice = (body: string, runId: string): NotificationMessage => ({
  kind: "completion",
  title: "Umar finished",
  body,
  botId: "bot-1",
  threadId: "thread-1",
  runId,
});

describe("notifyRun repeat guard", () => {
  const previous = process.env.NOTIFY_REPEAT_GUARD;
  beforeEach(() => repeatNotices.clear());
  afterEach(() => {
    if (previous === undefined) delete process.env.NOTIFY_REPEAT_GUARD;
    else process.env.NOTIFY_REPEAT_GUARD = previous;
    installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
  });

  it("pushes a routine's status once while it only repeats itself, and logs each held one", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    const { value, send, publish } = deps();
    await notifyRun(value, run("routine"), notice(STATUS_2200, "r1"));
    await notifyRun(value, run("routine"), notice(STATUS_2230, "r2"));
    await notifyRun(value, run("routine"), notice(STATUS_2300, "r3"));
    await notifyRun(
      value,
      run("routine"),
      notice(STATUS_2300.replace("HTTP 200", "HTTP 502"), "r4"),
    );
    expect(send.mock.calls.map(([message]) => message.runId)).toEqual(["r1", "r2", "r4"]);
    expect(publish).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[0]![0]).toMatchObject({ trigger: "routine" });
    const held = sink.events.filter((event) => event.message === "notification.suppressed");
    expect(held).toEqual([
      expect.objectContaining({
        "notification.reason": "repeat",
        "run.id": "r3",
        "run.trigger": "routine",
        "thread.id": "thread-1",
      }),
    ]);
    expect(JSON.stringify(held)).not.toContain("Nothing has changed");
  });

  it("always pushes the reply to something the person asked", async () => {
    const { value, send } = deps();
    await notifyRun(value, run("user"), notice("Done.", "u1"));
    await notifyRun(value, run("user"), notice("Done.", "u2"));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("pushes every repeat when switched off", async () => {
    process.env.NOTIFY_REPEAT_GUARD = "0";
    const { value, send } = deps();
    await notifyRun(value, run("routine"), notice(STATUS_2230, "r1"));
    await notifyRun(value, run("routine"), notice(STATUS_2300, "r2"));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not hold back the next notice for one that failed to go out", async () => {
    const { value, send } = deps();
    send.mockRejectedValueOnce(new Error("expo down"));
    await notifyRun(value, run("routine"), notice(STATUS_2230, "r1"));
    await notifyRun(value, run("routine"), notice(STATUS_2300, "r2"));
    expect(send).toHaveBeenCalledTimes(2);
  });
});
