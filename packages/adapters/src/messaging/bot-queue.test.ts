import { describe, expect, it } from "vitest";
import type { QueueItem } from "./bot-queue.js";
import { describeQueueItem, findQueuedDuplicate } from "./bot-queue.js";

const item = (o: Partial<QueueItem>): QueueItem => ({
  id: "r1",
  status: "queued",
  trigger: "bot_message",
  lane: "indeed",
  ageSeconds: 300,
  from: "Umar",
  summary: "",
  text: "Check the Indeed salary field and report the saved value in USD per year for the profile.",
  ...o,
});

describe("bot queue", () => {
  it("finds a request that repeats one already open", () => {
    const again =
      "Check the Indeed salary field and report the saved value in USD per year for the profile please.";
    expect(findQueuedDuplicate(again, [item({})], "indeed")?.id).toBe("r1");
    expect(findQueuedDuplicate(item({}).text, [item({})])?.id).toBe("r1");
  });

  it("never calls a one-word variation a duplicate, in any lane", () => {
    const a = item({
      text: "Q-A: run the shell command sleep 25 && echo A-done, then reply done",
      lane: "indeed",
    });
    const b = "Q-B: run the shell command sleep 25 && echo B-done, then reply done";
    expect(findQueuedDuplicate(b, [a], "himalayas")).toBeUndefined();
    expect(findQueuedDuplicate(b, [a], "indeed")).toBeUndefined();
    expect(findQueuedDuplicate(b, [a])).toBeUndefined();
  });

  it("does not call different work a duplicate, or match people's runs", () => {
    expect(
      findQueuedDuplicate("Upload the CV to Himalayas and confirm the tech stack list.", [
        item({}),
      ]),
    ).toBeUndefined();
    expect(findQueuedDuplicate(item({}).text, [item({ trigger: "user" })])).toBeUndefined();
  });

  it("describes an item for the sender", () => {
    expect(describeQueueItem(item({}))).toBe("waiting 5 min, lane indeed, from Umar");
    expect(describeQueueItem(item({ status: "running", lane: null }))).toBe(
      "working 5 min, from Umar",
    );
  });
});
