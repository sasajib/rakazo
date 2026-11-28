// @vitest-environment jsdom

import { flush } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ pinned: vi.fn(), pin: vi.fn() }));
vi.mock("../../lib/query/rpc", () => {
  const client = { agentSkills: api };
  return {
    rpc: client,
    rpcForSpace: () => client,
    createSpaceRpc: () => client,
    selectedSpaceId: () => null,
  };
});
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values);
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

import { SkillPinLine } from "./skill-agents-line";

const state = (skillIds: string[], extra: Record<string, unknown> = {}) => ({
  skillIds,
  bytes: 10,
  budgetBytes: 16384,
  overBudget: [],
  enabled: true,
  ...extra,
});

async function mount(node: ReactNode) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>),
  );
  await act(flush);
  return {
    host,
    toggle: () => host.querySelector<HTMLInputElement>('[data-testid="skill-pin-toggle"]')!,
    close: () => act(() => root.unmount()),
  };
}

afterEach(() => {
  api.pinned.mockReset();
  api.pin.mockReset();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

// Fork (1.32): the Skills window's switch that pins a skill for every agent of the space.
it("shows whether the skill is pinned and pins it for every agent on a click", async () => {
  api.pinned.mockResolvedValueOnce(state([])).mockResolvedValue(state(["skill-1"]));
  api.pin.mockResolvedValue(state(["skill-1"]));
  const view = await mount(<SkillPinLine skillId="skill-1" skillName="House Rules" />);
  expect(view.toggle().checked).toBe(false);
  expect(view.host.textContent).toContain("Every agent always follows this skill");

  await act(async () => view.toggle().click());
  await act(flush);
  expect(api.pin).toHaveBeenCalledTimes(1);
  expect(api.pin.mock.calls[0]![0]).toEqual({ skillId: "skill-1", pinned: true });
  expect(view.toggle().checked).toBe(true);
  await view.close();
});

it("unpins, and says when the pinned skills no longer fit or are switched off", async () => {
  api.pinned.mockResolvedValue(state(["skill-1"], { overBudget: ["House Rules"], enabled: false }));
  api.pin.mockResolvedValue(state([]));
  const view = await mount(<SkillPinLine skillId="skill-1" skillName="House Rules" />);
  expect(view.toggle().checked).toBe(true);
  expect(view.host.querySelector('[data-testid="skill-pin-cut"]')).not.toBeNull();
  expect(view.host.querySelector('[data-testid="skill-pin-off"]')).not.toBeNull();

  await act(async () => view.toggle().click());
  await act(flush);
  expect(api.pin.mock.calls[0]![0]).toEqual({ skillId: "skill-1", pinned: false });
  await view.close();
});

it("shows the server's reason when a pin is refused, and nothing without the procedure", async () => {
  api.pinned.mockResolvedValue(state([]));
  api.pin.mockRejectedValue(new Error("At most 20 skills can be pinned for every agent."));
  const view = await mount(<SkillPinLine skillId="skill-1" skillName="House Rules" />);
  await act(async () => view.toggle().click());
  await act(flush);
  expect(view.host.querySelector('[data-testid="skill-pin-error"]')?.textContent).toBe(
    "At most 20 skills can be pinned for every agent.",
  );
  expect(view.toggle().checked).toBe(false);
  await view.close();

  api.pinned.mockRejectedValue(new Error("not found"));
  const absent = await mount(<SkillPinLine skillId="skill-1" skillName="House Rules" />);
  expect(absent.host.querySelector('[data-testid="skill-pin"]')).toBeNull();
  await absent.close();
});
