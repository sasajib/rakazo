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
        e("a", "Never open a second browser tab for an Indeed search; keep one tab per site."),
        e("b", "Always use a new browser tab for each Indeed search."),
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
});
