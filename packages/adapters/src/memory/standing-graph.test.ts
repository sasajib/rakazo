import { describe, expect, it } from "vitest";
import { closure, neighbors, selectForPrompt } from "./standing-graph.js";
import type { StandingEntry, StandingLinks } from "./standing-orders.js";
import { emptyLinks } from "./standing-orders.js";

type Opts = {
  date?: string;
  text?: string;
  tier?: StandingEntry["tier"];
  links?: Partial<StandingLinks>;
};

const e = (key: string, o: Opts = {}): StandingEntry => ({
  kind: "rule",
  key,
  date: o.date ?? "2026-11-17",
  text: o.text ?? `Rule ${key}.`,
  ...(o.tier === undefined ? {} : { tier: o.tier }),
  ...(o.links ? { links: Object.assign(emptyLinks(), o.links) } : {}),
});

describe("standing graph", () => {
  const entries = [
    e("r5"),
    e("r5b", { links: { exceptionOf: ["r5"] } }),
    e("r19", { links: { dependsOn: ["r5", "r3"] } }),
    e("r3"),
    e("lonely"),
  ];

  it("finds neighbours in both directions", () => {
    expect(neighbors(entries, "r5").sort()).toEqual(["r19", "r5b"]);
    expect(neighbors(entries, "r19").sort()).toEqual(["r3", "r5"]);
    expect(neighbors(entries, "lonely")).toEqual([]);
  });

  it("pulls in the implicit neighbours of a blocked-site situation", () => {
    expect([...closure(entries, ["r19"], 1)].sort()).toEqual(["r19", "r3", "r5"]);
    expect([...closure(entries, ["r19"], 2)].sort()).toEqual(["r19", "r3", "r5", "r5b"]);
  });

  it("keeps everything while it fits", () => {
    const out = selectForPrompt(entries, 10_000, () => 20);
    expect(out.omitted).toEqual([]);
    expect(out.kept).toHaveLength(5);
  });

  it("when it must shrink, never drops tiers 0-1 or their neighbours, and drops preferences first", () => {
    const many = [
      e("safe", { tier: 0 }),
      e("cmd", { tier: 1, links: { dependsOn: ["helper"] } }),
      e("helper", { tier: 3 }),
      e("proc-a"),
      e("proc-b", { date: "2026-11-01" }),
      e("pref-a", { tier: 3 }),
      e("pref-b", { tier: 3 }),
    ];
    const out = selectForPrompt(many, 85, () => 20); // room for 4 entries
    const kept = out.kept.map((x) => x.key);
    expect(kept).toEqual(expect.arrayContaining(["safe", "cmd", "helper"]));
    expect(kept).toHaveLength(4);
    expect(kept).toContain("proc-a"); // tier 2 beats the tier-3 preferences
    expect(out.omitted.sort()).toEqual(["pref-a", "pref-b", "proc-b"]);
  });

  it("keeps the core even when it alone exceeds the budget", () => {
    const out = selectForPrompt(
      [e("safe", { tier: 0 }), e("also", { tier: 1 }), e("x")],
      10,
      () => 50,
    );
    expect(out.kept.map((x) => x.key)).toEqual(["safe", "also"]);
  });
});
