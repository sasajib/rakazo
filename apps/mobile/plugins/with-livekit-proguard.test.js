import { expect, it } from "vitest";
import { livekitProguardRules } from "./with-livekit-proguard.js";

it("tells R8 the jni_zero glue LiveKit's WebRTC references is expected to be missing", () => {
  const rules = livekitProguardRules("# existing\n");
  expect(rules).toMatch(/^# existing\n/);
  expect(rules).toContain("-dontwarn livekit.org.jni_zero.**");
});

it("appends the rule once, so a second prebuild leaves the file alone", () => {
  const once = livekitProguardRules("");
  expect(livekitProguardRules(once)).toBe(once);
});
