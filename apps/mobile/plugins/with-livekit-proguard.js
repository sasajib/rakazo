// LiveKit's WebRTC build (@livekit/react-native-webrtc) ships keep rules for livekit.org.jni_zero,
// but the packaged aar has no livekit.org.jni_zero.JniZeroJni: its JniZero.setJniClassLoader
// references a class that only exists in Chromium's full jni_zero build. R8 treats a missing
// referenced class as an error and fails `assembleRelease`, so tell it the gap is expected. The
// class is never reached on Android (the native library sets up JNI itself).
const { withDangerousMod } = require("expo/config-plugins");
const { appendFileSync, existsSync, readFileSync } = require("node:fs");
const path = require("node:path");

const RULES = `
# @livekit/react-native-webrtc: JniZeroJni is referenced but not shipped (see plugins/with-livekit-proguard.js).
-dontwarn livekit.org.jni_zero.**
`;

/** The rules file after this plugin: appended once, so re-running prebuild stays idempotent. */
function livekitProguardRules(existing) {
  return existing.includes("-dontwarn livekit.org.jni_zero.**") ? existing : existing + RULES;
}

function withLivekitProguard(config) {
  return withDangerousMod(config, [
    "android",
    (cfg) => {
      const rules = path.join(cfg.modRequest.platformProjectRoot, "app", "proguard-rules.pro");
      const existing = existsSync(rules) ? readFileSync(rules, "utf8") : "";
      const next = livekitProguardRules(existing);
      if (next !== existing) appendFileSync(rules, next.slice(existing.length));
      return cfg;
    },
  ]);
}

module.exports = withLivekitProguard;
module.exports.livekitProguardRules = livekitProguardRules;
