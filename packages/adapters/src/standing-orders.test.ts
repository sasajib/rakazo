import { describe, expect, it } from "vitest";
import {
  normalizeStandingKey,
  parseStandingOrders,
  renderStandingOrdersBlock,
  setStandingOrder,
} from "./standing-orders.js";

describe("standing orders", () => {
  it("adds, then replaces in place: a changed rule never leaves its old line behind", () => {
    const a = setStandingOrder(
      "",
      { kind: "rule", key: "R3 calls", text: "Wait 2 minutes." },
      "2026-11-10",
    );
    if ("error" in a) throw new Error(a.error);
    expect(a.action).toBe("added");
    const b = setStandingOrder(
      a.content,
      { kind: "decision", key: "salary", text: "50K USD per year." },
      "2026-11-12",
    );
    if ("error" in b) throw new Error(b.error);
    const c = setStandingOrder(
      b.content,
      { kind: "rule", key: "r3-calls", text: "Wait 5 minutes." },
      "2026-11-14",
    );
    if ("error" in c) throw new Error(c.error);
    expect(c.action).toBe("replaced");
    expect(c.previous).toContain("Wait 2 minutes.");
    const entries = parseStandingOrders(c.content);
    expect(entries.map((e) => e.key)).toEqual(["r3-calls", "salary"]);
    expect(entries[0]).toMatchObject({ date: "2026-11-14", text: "Wait 5 minutes." });
    expect(c.content).not.toContain("2 minutes");
  });

  it("a key is unique across rules and decisions", () => {
    const a = setStandingOrder(
      "",
      { kind: "rule", key: "upwork-rate", text: "Keep 55." },
      "2026-11-13",
    );
    if ("error" in a) throw new Error(a.error);
    const b = setStandingOrder(
      a.content,
      { kind: "decision", key: "Upwork rate", text: "Keep 55 USD." },
      "2026-11-15",
    );
    if ("error" in b) throw new Error(b.error);
    expect(parseStandingOrders(b.content)).toHaveLength(1);
    expect(parseStandingOrders(b.content)[0]?.kind).toBe("decision");
  });

  it("empty text removes; an identical set changes nothing", () => {
    const a = setStandingOrder("", { kind: "rule", key: "x", text: "One." }, "2026-11-10");
    if ("error" in a) throw new Error(a.error);
    const same = setStandingOrder(
      a.content,
      { kind: "rule", key: "x", text: "One." },
      "2026-11-11",
    );
    expect(same).toMatchObject({ action: "unchanged" });
    const gone = setStandingOrder(a.content, { kind: "rule", key: "x", text: "" }, "2026-11-11");
    if ("error" in gone) throw new Error(gone.error);
    expect(gone.action).toBe("removed");
    expect(parseStandingOrders(gone.content)).toHaveLength(0);
  });

  it("refuses an oversized entry and a missing key", () => {
    expect(
      setStandingOrder("", { kind: "rule", key: "k", text: "x".repeat(800) }, "2026-11-10"),
    ).toHaveProperty("error");
    expect(
      setStandingOrder("", { kind: "rule", key: "  ", text: "x" }, "2026-11-10"),
    ).toHaveProperty("error");
  });

  it("normalises keys and flattens newlines", () => {
    expect(normalizeStandingKey(" R3: Calling Shakil! ")).toBe("r3-calling-shakil");
    const a = setStandingOrder("", { kind: "rule", key: "k", text: "a\n\nb" }, "2026-11-10");
    if ("error" in a) throw new Error(a.error);
    expect(parseStandingOrders(a.content)[0]?.text).toBe("a b");
  });

  it("renders a binding block, and nothing when empty", () => {
    expect(renderStandingOrdersBlock("# Standing orders\n")).toBeUndefined();
    const a = setStandingOrder(
      "",
      { kind: "decision", key: "salary", text: "50K USD." },
      "2026-11-12",
    );
    if ("error" in a) throw new Error(a.error);
    const block = renderStandingOrdersBlock(a.content) ?? "";
    expect(block).toContain("instructions, not background data");
    expect(block).toContain("<standing_orders>");
    expect(block).toContain("[decision salary] 2026-11-12: 50K USD.");
  });
});
