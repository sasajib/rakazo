"""Share browser logins between the bots of one team computer.

Every bot on a team computer has its own Chromium profile and display (upstream isolation), so a
login made in one bot's browser was invisible to the others. This loop keeps their cookie jars in
step through each browser's DevTools port:

- a cookie added or changed in any browser since the last look is copied to every other browser;
- a cookie removed from a browser (a sign-out) is removed from the others;
- a browser seen for the first time gets the shared jar, then its own extra cookies join the jar.

The jar persists in ~/.browser-profiles/.shared-logins.json (mode 600), so a browser started
later, or after a restart, still gets every login. Only the stdlib; one instance per computer.
"""

import base64
import glob
import json
import os
import re
import socket
import struct
import sys
import time
import urllib.request

HOME = os.environ.get("HOME") or "/home/rakazo"
ROOT = os.path.join(HOME, ".browser-profiles")
JAR_PATH = os.path.join(ROOT, ".shared-logins.json")
PID_PATH = "/tmp/rakazo/login-sync.pid"
INTERVAL_S = float(os.environ.get("RAKAZO_LOGIN_SYNC_INTERVAL_S", "3"))
PARAM_FIELDS = (
    "name", "value", "domain", "path", "secure", "httpOnly", "sameSite", "priority",
    "sourceScheme", "sourcePort", "partitionKey",
)


class DevTools:
    """A minimal client for one browser's DevTools websocket (text frames only)."""

    def __init__(self, port):
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=2) as r:
            endpoint = json.load(r)["webSocketDebuggerUrl"]
        path = "/" + endpoint.split("/", 3)[3]
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=5)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall(
            (
                f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\n"
                f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
            ).encode()
        )
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise OSError("devtools closed during handshake")
            head += chunk
        if b" 101 " not in head.split(b"\r\n")[0]:
            raise OSError("devtools refused the websocket")
        self.buffer = head.split(b"\r\n\r\n", 1)[1]
        self.next_id = 0

    def _read(self, n):
        while len(self.buffer) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise OSError("devtools closed")
            self.buffer += chunk
        out, self.buffer = self.buffer[:n], self.buffer[n:]
        return out

    def _frame(self):
        b0, b1 = self._read(2)
        length = b1 & 0x7F
        if length == 126:
            length = struct.unpack(">H", self._read(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", self._read(8))[0]
        return b0 & 0x80, b0 & 0x0F, self._read(length)

    def call(self, method, params=None):
        self.next_id += 1
        payload = json.dumps({"id": self.next_id, "method": method, "params": params or {}}).encode()
        mask = os.urandom(4)
        n = len(payload)
        header = bytes([0x81])
        if n < 126:
            header += bytes([0x80 | n])
        elif n < 65536:
            header += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            header += bytes([0x80 | 127]) + struct.pack(">Q", n)
        self.sock.sendall(header + mask + bytes(v ^ mask[i % 4] for i, v in enumerate(payload)))
        while True:
            message = b""
            while True:
                fin, opcode, data = self._frame()
                if opcode == 0x9:  # ping
                    continue
                message += data
                if fin:
                    break
            reply = json.loads(message)
            if reply.get("id") == self.next_id:
                if "error" in reply:
                    raise OSError(reply["error"].get("message", "devtools error"))
                return reply.get("result", {})

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def key_of(cookie):
    partition = cookie.get("partitionKey")
    if isinstance(partition, dict):
        partition = partition.get("topLevelSite", "")
    return f'{cookie.get("name")}\t{cookie.get("domain")}\t{cookie.get("path")}\t{partition or ""}'


def signature(cookie):
    return f'{cookie.get("value")}\t{cookie.get("expires")}\t{cookie.get("session")}'


def as_param(cookie, expire=False):
    param = {k: cookie[k] for k in PARAM_FIELDS if k in cookie and cookie[k] is not None}
    if expire:
        param["expires"] = 1
    elif not cookie.get("session") and cookie.get("expires", -1) > 0:
        param["expires"] = cookie["expires"]
    return param


def browser_ports():
    """DevTools ports of the bots' running browsers (main processes on a managed profile).

    Chromium rewrites its argv into one space-joined line (setproctitle), so the flags are found
    in the joined text rather than as separate arguments.
    """
    ports = set()
    for cmdline in glob.glob("/proc/[0-9]*/cmdline"):
        try:
            text = open(cmdline, "rb").read().replace(b"\0", b" ").decode(errors="ignore")
        except OSError:
            continue
        if " --type=" in f" {text}" or f"--user-data-dir={ROOT}/chromium-bot-" not in text:
            continue
        found = re.search(r"--remote-debugging-port=(\d+)", text)
        if found:
            ports.add(int(found.group(1)))
    return ports


def read_cookies(port):
    tools = DevTools(port)
    try:
        return {key_of(c): c for c in tools.call("Storage.getCookies").get("cookies", [])}
    finally:
        tools.close()


def write_cookies(port, cookies, expire=()):
    params = [as_param(c) for c in cookies] + [as_param(c, expire=True) for c in expire]
    if not params:
        return
    tools = DevTools(port)
    try:
        for start in range(0, len(params), 200):
            tools.call("Storage.setCookies", {"cookies": params[start : start + 200]})
    finally:
        tools.close()


def load_jar():
    try:
        return json.load(open(JAR_PATH))
    except (OSError, ValueError):
        return {}


def save_jar(jar):
    tmp = JAR_PATH + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(jar, f)
    os.replace(tmp, JAR_PATH)


def sync_once(jar, seen):
    """One pass. `seen` maps port -> {key: signature} as of the last pass. Returns jar changed."""
    changed = False
    ports = browser_ports()
    for gone in set(seen) - ports:
        del seen[gone]
    current = {}
    for port in sorted(ports):
        try:
            current[port] = read_cookies(port)
        except OSError:
            continue
    # What each browser did since the last look: its own adds/changes and removals.
    updates, removals = {}, {}
    for port, cookies in current.items():
        if port not in seen:
            continue
        before = seen[port]
        for k, c in cookies.items():
            if before.get(k) != signature(c):
                updates[k] = c
        for k in before:
            if k not in cookies:
                removals[k] = True
    for k in removals:
        if k in jar and k not in updates:
            removals[k] = jar.pop(k)
            changed = True
        else:
            removals[k] = None
    for k, c in updates.items():
        if jar.get(k) is None or signature(jar[k]) != signature(c):
            jar[k] = c
            changed = True
    # A browser seen for the first time: its own extra cookies join the jar, then it gets the jar.
    for port, cookies in current.items():
        if port in seen:
            continue
        for k, c in cookies.items():
            if k not in jar:
                jar[k] = c
                changed = True
    for port, cookies in current.items():
        push = [c for k, c in jar.items() if k not in cookies or signature(cookies[k]) != signature(c)]
        drop = [cookies[k] for k, c in removals.items() if c is not None and k in cookies]
        try:
            write_cookies(port, push, drop)
            seen[port] = {k: signature(c) for k, c in read_cookies(port).items()}
        except OSError:
            seen.pop(port, None)
    return changed


def main():
    os.makedirs(os.path.dirname(PID_PATH), exist_ok=True)
    try:
        other = int(open(PID_PATH).read().strip())
        if other != os.getpid() and os.path.exists(f"/proc/{other}") and b"login-sync" in open(
            f"/proc/{other}/cmdline", "rb"
        ).read():
            return 0
    except (OSError, ValueError):
        pass
    with open(PID_PATH, "w") as f:
        f.write(str(os.getpid()))
    jar, seen = load_jar(), {}
    once = "--once" in sys.argv
    while True:
        try:
            if sync_once(jar, seen):
                save_jar(jar)
        except Exception as error:  # never die on one bad pass
            print(f"login-sync: {error}", file=sys.stderr)
        if once:
            return 0
        time.sleep(INTERVAL_S)


if __name__ == "__main__":
    sys.exit(main())
