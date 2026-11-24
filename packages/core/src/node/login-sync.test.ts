import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LOGIN_SYNC_PROGRAM_BASE64, startLoginSyncCommand } from "./login-sync.js";

describe("team computer login sync", () => {
  it("ships exactly the reviewed program next to it", () => {
    const source = readFileSync(new URL("./login-sync.py", import.meta.url), "utf8");
    expect(Buffer.from(LOGIN_SYNC_PROGRAM_BASE64, "base64").toString("utf8")).toBe(source);
  });

  it("installs once per version and starts one copy", () => {
    const lines = startLoginSyncCommand().join("\n");
    expect(lines).toContain("base64 -d >/tmp/rakazo/login-sync.py.next");
    expect(lines).toContain("grep -qs login-sync");
    expect(lines).toContain("setsid nohup python3 /tmp/rakazo/login-sync.py");
  });

  it("copies a login made in one bot's browser to the others, and a sign-out too", () => {
    const program = fileURLToPath(new URL("./login-sync.py", import.meta.url));
    // Three fake browsers; Umar's has signed in. The program's DevTools calls are replaced.
    const script = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("ls", ${JSON.stringify(program)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
def c(name, value, domain=".youtube.com"):
    return {"name": name, "value": value, "domain": domain, "path": "/", "expires": 2e9, "session": False}
browsers = {9222: {}, 9223: {}, 9224: {}}
m.browser_ports = lambda: set(browsers)
m.read_cookies = lambda port: {m.key_of(x): dict(x) for x in browsers[port].values()}
def write(port, push, drop):
    for x in push: browsers[port][m.key_of(x)] = dict(x)
    for x in drop: browsers[port].pop(m.key_of(x), None)
m.write_cookies = write
jar, seen = {}, {}
m.sync_once(jar, seen)
browsers[9223][m.key_of(c("SID", "umar"))] = c("SID", "umar")
m.sync_once(jar, seen)
after_login = sorted(p for p, b in browsers.items() if any(x["value"] == "umar" for x in b.values()))
del browsers[9224][m.key_of(c("SID", "umar"))]
m.sync_once(jar, seen)
after_logout = sorted(p for p, b in browsers.items() if b)
print(json.dumps({"login": after_login, "logout": after_logout, "jar": len(jar)}))
`;
    const out = JSON.parse(execFileSync("python3", ["-c", script], { encoding: "utf8" }));
    expect(out).toEqual({ login: [9222, 9223, 9224], logout: [], jar: 0 });
  });
});
