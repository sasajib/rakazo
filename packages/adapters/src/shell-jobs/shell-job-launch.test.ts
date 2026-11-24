import { describe, expect, it } from "vitest";
import { linuxJobComputer } from "./shell-job-launch.js";

type Ctx = Parameters<typeof linuxJobComputer>[0];

function ctx(withCancel: boolean): Ctx {
  const sandbox = withCancel ? { cancelRunWork: async () => {} } : {};
  return { computer: { hostEnvironment: undefined }, deps: { sandbox } } as unknown as Ctx;
}

describe("linuxJobComputer", () => {
  it("allows a docker computer behind the routing sandbox, which always exposes cancelRunWork", () => {
    expect(linuxJobComputer(ctx(true), { kind: "docker" })).toBe(true);
    expect(linuxJobComputer(ctx(false), { kind: "docker" })).toBe(true);
  });

  it("refuses providers that cancel run work their own way, and non-Linux computers", () => {
    expect(linuxJobComputer(ctx(true), { kind: "wuying" })).toBe(false);
    expect(linuxJobComputer(ctx(true), { kind: "desktop" })).toBe(false);
    expect(linuxJobComputer(ctx(true), { kind: "none" })).toBe(false);
    expect(linuxJobComputer(ctx(true), { kind: "fake" })).toBe(false);
    expect(linuxJobComputer(ctx(true), { kind: "fake" }, { allowFake: true })).toBe(true);
  });
});
