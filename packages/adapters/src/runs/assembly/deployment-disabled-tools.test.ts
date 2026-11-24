import { describe, expect, it } from "vitest";
import { deploymentDisabledBuiltinTools } from "./run-assembly-capabilities.js";

describe("deployment-wide disabled built-in tools", () => {
  it("reads the comma list, so bots created later get the same tools off", () => {
    expect(
      deploymentDisabledBuiltinTools({
        RAKAZO_DISABLED_BUILTIN_TOOLS: " browser_navigate,browser_act , launch_app,,",
      }),
    ).toEqual(["browser_navigate", "browser_act", "launch_app"]);
    expect(deploymentDisabledBuiltinTools({})).toEqual([]);
  });
});
