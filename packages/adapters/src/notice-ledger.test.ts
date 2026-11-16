import { describe, expect, it } from "vitest";
import type { Notice } from "./notice-ledger.js";
import { findDuplicateNotice, renderNoticeLedger, textSimilarity } from "./notice-ledger.js";

const at = new Date("2026-11-16T01:42:00Z");
const n = (id: string, text: string, ticked = false): Notice => ({ id, at, text, ticked });

describe("notice ledger", () => {
  it("lists open and ticked notices", () => {
    const out =
      renderNoticeLedger([
        n("1", "Hafsa called. Do you want to call her back?"),
        n("2", "Lemon mail", true),
      ]) ?? "";
    expect(out).toContain("[open] 11-16 01:42 UTC: Hafsa called");
    expect(out).toContain("[done] 11-16 01:42 UTC: Lemon mail");
    expect(renderNoticeLedger([])).toBeUndefined();
  });

  it("flags the same report posted again, even with a new header", () => {
    const old = n(
      "1",
      "Summary for 2026-11-16 08:00. Closed (Barakah's report): Gun.io, Lemon.io, Braintrust, Contra, LinkedIn, Wellfound, Jobicy. Everything below is Barakah's 00:10 report and I have not verified it.",
    );
    const again =
      "Summary for 2026-11-16 15:00. Closed (Barakah's report): Gun.io, Lemon.io, Braintrust, Contra, LinkedIn, Wellfound, Jobicy. Everything below is Barakah's 00:10 report and I have not verified it.";
    expect(findDuplicateNotice(again, [old])?.id).toBe("1");
  });

  it("does not flag a genuinely new message or a short different one", () => {
    const old = n("1", "WhatsApp at 7:41 am: Kamrun Naher, Missed video call. I did not reply.");
    expect(
      findDuplicateNotice("New Gmail from Suno: welcome mail, no action needed, opened no link.", [
        old,
      ]),
    ).toBeUndefined();
    expect(findDuplicateNotice("Ok.", [n("2", "Done.")])).toBeUndefined();
    expect(textSimilarity("a b c", "")).toBe(0);
  });
});
