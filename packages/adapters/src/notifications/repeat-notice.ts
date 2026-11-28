import { getLogger } from "@rakazo/logging";

/**
 * Fork (1.41): an unattended run that says the same thing again is not news.
 *
 * A routine, a webhook, another agent's request or a continuation can post the same report over
 * and over ("Status 22:30: nothing has changed since 22:00", "Reminder: the designs are still
 * waiting on your pick"). Each one went out as a new push, which on the phone reads as the same old
 * notification arriving again and again. The message still lands in the chat (and marks it unread);
 * only the push and the open-app alert are skipped when the last notice of the same kind, to the
 * same person, for the same chat said the same thing within the window. Times and dates are not
 * part of "the same thing", so a status that only moved its clock is a repeat; any other change
 * (a number, a word, a name) is news.
 *
 * Runs a person started (a message, a call, a reaction, a quick answer) are never held back: the
 * person is waiting for that reply even when it reads "Done." again. On unless NOTIFY_REPEAT_GUARD
 * is "0" (also "false" / "off").
 */
export const REPEAT_NOTICE_WINDOW_MS = 12 * 60 * 60 * 1000;
const MAX_REMEMBERED = 5_000;

/** Runs a person started: their replies always notify. */
const PERSON_STARTED_TRIGGERS = new Set([
  "user",
  "follow_up",
  "call_end",
  "talk",
  "reaction",
  "resume",
  "created",
]);

export function repeatNoticeGuardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env.NOTIFY_REPEAT_GUARD ?? "").trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "off");
}

/** Only notices of runs nobody is waiting on can be held back as a repeat. */
export function repeatGuardApplies(trigger: string | undefined): boolean {
  return Boolean(trigger) && !PERSON_STARTED_TRIGGERS.has(trigger as string);
}

const CLOCK_TIME = /\b\d{1,2}[:.]\d{2}(?:[:.]\d{2})?(?:\s?[ap]\.?m\.?)?\b/gi;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}(?:t[\d:.]+z?)?\b/gi;
const MONTHS =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const DAY_MONTH = new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})\\b`, "gi");
const MONTH_DAY = new RegExp(`\\b(?:${MONTHS})\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, "gi");
const WEEKDAY = /\b(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?\b/gi;
const RELATIVE_DAY = /\b(?:today|tonight|yesterday|tomorrow)\b/gi;

/** What a notice says, with its clock taken out: times, dates and day names do not make it new. */
export function noticeFingerprint(title: string, body: string): string {
  return `${title}\n${body}`
    .toLowerCase()
    .replace(ISO_DATE, "<date>")
    .replace(CLOCK_TIME, "<time>")
    .replace(DAY_MONTH, "<date>")
    .replace(MONTH_DAY, "<date>")
    .replace(WEEKDAY, "<day>")
    .replace(RELATIVE_DAY, "<day>")
    .replace(/\s+/g, " ")
    .trim();
}

type Remembered = { fingerprint: string; at: number };

/**
 * The last notice per person, chat and kind, in this process. Bounded; a restart forgets it, so the
 * worst case after a deploy is one more repeat, never a lost notice.
 */
export class RepeatNoticeLedger {
  private readonly last = new Map<string, Remembered>();

  constructor(private readonly windowMs = REPEAT_NOTICE_WINDOW_MS) {}

  /** True when this notice repeats the last one for the key; otherwise remembers it. */
  isRepeat(key: string, fingerprint: string, now = Date.now()): boolean {
    const previous = this.last.get(key);
    if (previous && previous.fingerprint === fingerprint && now - previous.at < this.windowMs) {
      return true;
    }
    this.last.delete(key);
    this.last.set(key, { fingerprint, at: now });
    while (this.last.size > MAX_REMEMBERED) {
      const oldest = this.last.keys().next().value;
      if (oldest === undefined) break;
      this.last.delete(oldest);
    }
    return false;
  }

  /** Forgets a notice that could not be delivered, so the next one is not held back for it. */
  forget(key: string, fingerprint: string): void {
    if (this.last.get(key)?.fingerprint === fingerprint) this.last.delete(key);
  }

  clear(): void {
    this.last.clear();
  }
}

export const repeatNotices = new RepeatNoticeLedger();

export function repeatNoticeKey(input: { userId: string; threadId: string; kind: string }): string {
  return `${input.userId}\n${input.threadId}\n${input.kind}`;
}

/**
 * The recipients a notice still goes to: everyone, unless the guard is on, the run is unattended
 * and the person's last notice for this chat said the same thing. Logs each one held back.
 */
export function recipientsAfterRepeatGuard(
  input: {
    recipients: string[];
    message: {
      kind: string;
      title: string;
      body: string;
      threadId: string;
      botId: string;
      runId?: string;
    };
    trigger?: string;
  },
  ledger: RepeatNoticeLedger = repeatNotices,
  now = Date.now(),
): string[] {
  if (!repeatNoticeGuardEnabled() || !repeatGuardApplies(input.trigger)) return input.recipients;
  const fingerprint = noticeFingerprint(input.message.title, input.message.body);
  return input.recipients.filter((userId) => {
    const key = repeatNoticeKey({
      userId,
      threadId: input.message.threadId,
      kind: input.message.kind,
    });
    if (!ledger.isRepeat(key, fingerprint, now)) return true;
    getLogger().info("notification.suppressed", {
      "notification.reason": "repeat",
      "notification.kind": input.message.kind,
      "run.id": input.message.runId,
      "run.trigger": input.trigger,
      "bot.id": input.message.botId,
      "thread.id": input.message.threadId,
      "user.id": userId,
    });
    return false;
  });
}
