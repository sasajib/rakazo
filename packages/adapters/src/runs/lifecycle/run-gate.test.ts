import { describe, expect, it } from "vitest";
import type { GateRun } from "./run-gate.js";
import { admissionBlock, laneKey, normalizeLane } from "./run-gate.js";

const t = (n: number) => new Date(2026, 10, 17, 5, 0, n);
const run = (id: string, o: Partial<GateRun> = {}): GateRun => ({
  id,
  botId: "barakah",
  threadId: "th1",
  trigger: "bot_message",
  lane: null,
  createdAt: t(0),
  ...o,
});

describe("run admission gate", () => {
  it("one unattended run at a time on a one-slot bot (what 12 overlapping runs lacked)", () => {
    expect(admissionBlock(run("b"), 1, [run("a")], [run("b")])).toBe("no free slot");
    expect(admissionBlock(run("b"), 1, [], [run("b")])).toBeUndefined();
  });

  it("different lanes run side by side; the same lane waits", () => {
    const indeed = run("a", { lane: "indeed" });
    expect(admissionBlock(run("b", { lane: "himalayas" }), 4, [indeed], [])).toBeUndefined();
    expect(admissionBlock(run("c", { lane: "indeed" }), 4, [indeed], [])).toBe("lane busy");
  });

  it("no lane means the conversation is the lane", () => {
    expect(laneKey(run("x"))).toBe("thread:th1");
    expect(admissionBlock(run("b"), 4, [run("a")], [])).toBe("lane busy");
  });

  it("oldest request in a lane starts first", () => {
    const older = run("a", { lane: "indeed", createdAt: t(1) });
    const newer = run("b", { lane: "indeed", createdAt: t(5) });
    expect(admissionBlock(newer, 4, [], [older, newer])).toBe("older request first");
    expect(admissionBlock(older, 4, [], [older, newer])).toBeUndefined();
  });

  it("unattended work leaves one slot for a person when concurrency >= 2", () => {
    const a = run("a", { lane: "x" });
    const b = run("b", { lane: "y" });
    expect(admissionBlock(b, 2, [a], [])).toBe("no free slot");
    expect(admissionBlock(b, 3, [a], [])).toBeUndefined();
  });

  it("never holds people, talk, helper or call-end runs", () => {
    const busy = [run("a"), run("z", { lane: "q" })];
    for (const trigger of ["user", "follow_up", "talk", "helper", "call_end", "reaction"]) {
      expect(admissionBlock(run("p", { trigger }), 1, busy, [])).toBeUndefined();
    }
  });

  it("talk and helper runs do not take a slot", () => {
    expect(admissionBlock(run("b"), 1, [run("t", { trigger: "talk" })], [])).toBeUndefined();
  });

  it("webhook runs are slot-limited but have no lane", () => {
    const hook = (id: string) => run(id, { trigger: "webhook" });
    expect(admissionBlock(hook("b"), 2, [hook("a")], [])).toBe("no free slot");
    expect(admissionBlock(hook("b"), 4, [hook("a")], [])).toBeUndefined();
  });

  it("normalises lanes", () => {
    expect(normalizeLane(" Indeed.com / Jobs ")).toBe("indeed.com-jobs");
    expect(normalizeLane("")).toBeNull();
  });
});
