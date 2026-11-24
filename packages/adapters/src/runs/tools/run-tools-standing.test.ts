import { describe, expect, it, vi } from "vitest";

const suggestRelated = vi.hoisted(() =>
  vi.fn(async () => [] as { key: string; similarity: number }[]),
);
vi.mock("../../memory/standing-embeddings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../memory/standing-embeddings.js")>()),
  suggestRelated,
}));

import { memoryTools } from "./run-tools-memory.js";

const doc = (content: string) => ({ documents: [{ revision: 3, content }] });
const LINE_R5 =
  "- [rule r5-logins-captcha] 2026-11-17: Click the checkbox, wait 20 s. On Upwork/Fiverr a block needs Shakil: report it.";

const harness = (content: string) => {
  suggestRelated.mockClear();
  const commit = vi.fn(async () => ({}));
  const ctx = {
    runId: "run-1",
    thread: { id: "t1" },
    context: {},
    run: { userId: "u1", spaceId: "space-1", createdAt: new Date("2026-11-17T10:00:00Z") },
    source: { myChatsAllowed: true },
    trust: { receivedOutsideMessage: async () => false },
    deps: {
      prisma: { user: { findUnique: async () => ({ timezone: "Asia/Dhaka" }) } },
      memory: { read: vi.fn(async () => doc(content)), commit },
    },
  };
  const finish = vi.fn((result: unknown) => result);
  return { ctx, commit, finish };
};

describe("standing_set curator", () => {
  it("review:true lists hidden exceptions and changes nothing", async () => {
    const h = harness(`# Standing orders\n\n${LINE_R5}\n`);
    const out = (await memoryTools.standing_set!(
      h.ctx as never,
      {
        args: { review: true },
        finish: h.finish,
      } as never,
    )) as { findings: { kind: string; keys: string[] }[]; entries: number };
    expect(out.entries).toBe(1);
    expect(out.findings.map((f) => f.kind)).toContain("exception");
    expect(h.commit).not.toHaveBeenCalled();
  });

  it("review works in a run that may not change orders", async () => {
    const h = harness(`# Standing orders\n\n${LINE_R5}\n`);
    h.ctx.source.myChatsAllowed = false;
    const out = (await memoryTools.standing_set!(
      h.ctx as never,
      {
        args: { review: true },
        finish: h.finish,
      } as never,
    )) as { ok?: boolean };
    expect(out.ok).toBe(true);
  });

  it("a save that adds an exception returns the review point for that key", async () => {
    const h = harness("# Standing orders\n");
    const out = (await memoryTools.standing_set!(
      h.ctx as never,
      {
        args: {
          kind: "rule",
          key: "r7-sites",
          text: "Use the procedure on every site unless the site is Fiverr.",
        },
        finish: h.finish,
      } as never,
    )) as { action: string; review?: string[] };
    expect(out.action).toBe("added");
    expect(out.review?.[0]).toContain("r7-sites carries an exception");
    expect(h.commit).toHaveBeenCalledTimes(1);
  });

  it("a clean save returns no review", async () => {
    const h = harness("# Standing orders\n");
    const out = (await memoryTools.standing_set!(
      h.ctx as never,
      {
        args: { kind: "rule", key: "r8-tone", text: "Be brief." },
        finish: h.finish,
      } as never,
    )) as { review?: string[] };
    expect(out.review).toBeUndefined();
  });

  it("echoes the saved line with its tier and links", async () => {
    const h = harness("# Standing orders\n");
    const out = (await memoryTools.standing_set!(
      h.ctx as never,
      {
        args: { kind: "rule", key: "r5b", text: "One slow click.", tier: 1, links: "^r5 @upwork" },
        finish: h.finish,
      } as never,
    )) as { now?: string };
    expect(out.now).toBe("[rule r5b p1 ^r5 @upwork] 2026-11-17: One slow click.");
  });

  it("passes related-by-meaning suggestions on to the bot", async () => {
    suggestRelated.mockResolvedValueOnce([{ key: "r5", similarity: 0.74 }]);
    const h = harness("# Standing orders\n\n- [rule r5] 2026-11-17: Solve the check.\n");
    const out = (await memoryTools.standing_set!(
      h.ctx as never,
      {
        args: { kind: "rule", key: "r5b", text: "On Upwork click once." },
        finish: h.finish,
      } as never,
    )) as { similarNotLinked?: { key: string }[] };
    expect(out.similarNotLinked).toEqual([{ key: "r5", similarity: 0.74 }]);
    expect(suggestRelated).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ spaceId: "space-1", key: "r5b" }),
    );
  });
});
