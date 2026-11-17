import { describe, expect, it } from "vitest";
import { curateStanding, findingsFor } from "./standing-curator.js";
import type { StandingEntry } from "./standing-orders.js";

const e = (
  key: string,
  text: string,
  date = "2026-11-17",
  kind: "rule" | "decision" = "rule",
): StandingEntry => ({
  kind,
  key,
  date,
  text,
});

describe("standing curator", () => {
  it("surfaces the hidden exception that stopped Upwork (the real failure)", () => {
    const found = curateStanding(
      [
        e(
          "r5-logins-captcha",
          "Turnstile: click the checkbox, wait 20 s. One pass per page. On Upwork/Fiverr a block needs Shakil: report it.",
        ),
        e("r1-tools", "Retry a failed tool three times."),
      ],
      "2026-11-17",
    );
    const ex = found.filter((f) => f.kind === "exception");
    expect(ex).toHaveLength(1);
    expect(ex[0]!.keys).toEqual(["r5-logins-captcha"]);
    expect(ex[0]!.message).toContain("needs Shakil");
  });

  it("flags two keys that say nearly the same thing", () => {
    const text = "Send one summary at 08:00 15:00 and 00:00 and only when something is new.";
    const found = curateStanding([e("r3", text), e("r15", `${text} Thanks.`)], "2026-11-17");
    expect(found.some((f) => f.kind === "overlap" && f.keys.join() === "r3,r15")).toBe(true);
  });

  it("flags a possible conflict when one rule forbids what another asks on the same subject", () => {
    const found = curateStanding(
      [
        e("a", "Never open a second browser tab for Indeed search results; keep one tab per site."),
        e("b", "Always use a new browser tab for Indeed search results."),
      ],
      "2026-11-17",
    );
    expect(found.some((f) => f.kind === "conflict")).toBe(true);
  });

  it("asks to re-confirm old decisions but not old rules", () => {
    const found = curateStanding(
      [
        e("salary", "50K USD per year.", "2026-09-01", "decision"),
        e("tone", "Be brief.", "2026-09-01", "rule"),
      ],
      "2026-11-17",
    );
    expect(found.filter((f) => f.kind === "stale").map((f) => f.keys[0])).toEqual(["salary"]);
  });

  it("flags entries close to the length limit", () => {
    expect(
      curateStanding([e("big", "x ".repeat(320).trim())], "2026-11-17").some(
        (f) => f.kind === "oversize",
      ),
    ).toBe(true);
  });

  it("does not call ordinary conditions exceptions, nor shared names a conflict", () => {
    const found = curateStanding(
      [
        e(
          "r1",
          "Retry a failed tool only if a retry may help, then report the exact error to Shakil.",
        ),
        e(
          "r2",
          "Never send a message to Shakil twice; use one message per sender and report to Shakil first.",
        ),
        e(
          "r3",
          "Always use a call for urgent results Shakil must act on; message Shakil otherwise.",
        ),
      ],
      "2026-11-17",
    );
    expect(found).toEqual([]);
  });

  it("is quiet on clean, unrelated entries and can filter by key", () => {
    const entries = [
      e("a", "Use Google sign in first."),
      e("b", "Reports go to the chat."),
      e("c", "Rate is fixed."),
    ];
    expect(curateStanding(entries, "2026-11-17")).toEqual([]);
    const withEx = curateStanding([...entries, e("d", "Do X unless it rains.")], "2026-11-17");
    expect(findingsFor(withEx, "d")).toHaveLength(1);
    expect(findingsFor(withEx, "a")).toHaveLength(0);
  });

  describe("links", () => {
    const L = (o: Partial<NonNullable<StandingEntry["links"]>>) => ({
      overrides: [],
      exceptionOf: [],
      dependsOn: [],
      tags: [],
      ...o,
    });
    const le = (
      key: string,
      text: string,
      links: NonNullable<StandingEntry["links"]>,
      tier?: 0 | 1 | 2 | 3,
    ): StandingEntry => ({
      kind: "rule",
      key,
      date: "2026-11-17",
      text,
      links,
      ...(tier === undefined ? {} : { tier }),
    });

    it("a declared exception (^) is not reported as a hidden one", () => {
      const found = curateStanding(
        [
          e("r5", "Solve the check."),
          le("r5b", "Except on Upwork: one click only.", L({ exceptionOf: ["r5"] })),
        ],
        "2026-11-17",
      );
      expect(found.filter((f) => f.kind === "exception")).toEqual([]);
    });

    it("reports links to entries that do not exist", () => {
      const found = curateStanding([le("a", "Do x.", L({ dependsOn: ["ghost"] }))], "2026-11-17");
      expect(found.find((f) => f.kind === "link")?.message).toContain("no entry ghost");
    });

    it("reports an override loop and a weaker tier beating a stronger one", () => {
      const loop = curateStanding(
        [le("a", "A.", L({ overrides: ["b"] })), le("b", "B.", L({ overrides: ["a"] }))],
        "2026-11-17",
      );
      expect(loop.some((f) => f.kind === "link" && f.message.includes("Override loop"))).toBe(true);
      const inv = curateStanding(
        [le("pref", "Short.", L({ overrides: ["safe"] }), 3), le("safe", "Ask first.", L({}), 0)],
        "2026-11-17",
      );
      expect(inv.some((f) => f.message.includes("cannot beat a stronger one"))).toBe(true);
    });

    it("a rule linked to another is not flagged as a possible conflict with it", () => {
      const a = e(
        "a",
        "Never open a second browser tab for Indeed search results; keep one tab per site.",
      );
      const b = le(
        "b",
        "Always use a new browser tab for Indeed search results.",
        L({ overrides: ["a"] }),
        1,
      );
      expect(curateStanding([a, b], "2026-11-17").some((f) => f.kind === "conflict")).toBe(false);
    });
  });
});
