"""Tiny client for Rakazo's web RPC through the signed-in BrowserOS Neo tab (127.0.0.1:9210)."""
import json, urllib.request

URL = "http://127.0.0.1:9210/mcp"
HDR = {"content-type": "application/json", "accept": "application/json, text/event-stream"}


class Rpc:
    def __init__(self, page=None):
        self.n = 10
        self.sid, _ = self._post({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "ops", "version": "1"}}})
        self._post({"jsonrpc": "2.0", "method": "notifications/initialized"})
        self.page = page or self._find_page()
        import atexit
        atexit.register(self.close)

    def _post(self, body):
        h = dict(HDR)
        if getattr(self, "sid", None):
            h["mcp-session-id"] = self.sid
        r = urllib.request.urlopen(urllib.request.Request(URL, json.dumps(body).encode(), h), timeout=120)
        return r.headers.get("mcp-session-id"), r.read().decode()

    def _run(self, code):
        self.n += 1
        _, txt = self._post({"jsonrpc": "2.0", "id": self.n, "method": "tools/call",
                             "params": {"name": "run", "arguments": {"code": code}}})
        line = [l for l in txt.split("\n") if l.startswith("data: {")][0][6:]
        sc = json.loads(line)["result"]["structuredContent"]
        if "value" not in sc:
            # e.g. the fresh tab is still redirecting /app -> /app/<bot>; one retry after a pause
            import time
            time.sleep(2)
            _, txt = self._post({"jsonrpc": "2.0", "id": self.n + 1000, "method": "tools/call",
                                 "params": {"name": "run", "arguments": {"code": code}}})
            line = [l for l in txt.split("\n") if l.startswith("data: {")][0][6:]
            sc = json.loads(line)["result"]["structuredContent"]
            if "value" not in sc:
                raise RuntimeError("neo run failed: %s" % str(sc.get("error"))[:300])
        v = json.loads(sc["value"])
        return v.get("value", v)

    def _find_page(self):
        # Open OUR OWN tab on the app (his Neo profile is signed in, so the cookie applies).
        # Never drive his open agents.mindshare.website tab: his tabs are off limits to agents.
        _, txt = self._post({"jsonrpc": "2.0", "id": 99, "method": "tools/call",
                             "params": {"name": "tabs", "arguments": {
                                 "action": "new", "url": "https://agents.mindshare.website/app"}}})
        import re
        m = re.search(r"opened page (\d+)", txt)
        if m:
            self.own_page = int(m.group(1))
            # A fresh tab can still be about:blank, where a relative fetch('/rpc/...') fails to parse: wait for the app.
            import time
            for _ in range(20):
                try:
                    href = self._run("const p = browser.page(%d); return JSON.stringify(await p.evaluate(() => location.href));"
                                     % self.own_page)
                except Exception:
                    href = ""
                if str(href).startswith("https://"):
                    break
                time.sleep(1)
            return self.own_page
        raise RuntimeError("could not open an own agents.mindshare.website tab in Neo")

    def close(self):
        """Close the tab this client opened (call when done)."""
        if getattr(self, "own_page", None) is not None:
            self._post({"jsonrpc": "2.0", "id": 98, "method": "tools/call",
                        "params": {"name": "tabs", "arguments": {"action": "close", "page": self.own_page}}})
            self.own_page = None

    def call(self, path, payload):
        code = ("const p = browser.page(%d);\nconst out = await p.evaluate(async (a) => { const r = await fetch('/rpc/'+a.path, "
                "{method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body: JSON.stringify({json:a.j, meta: []})}); "
                "return {status:r.status, text:(await r.text()).slice(0,400000)}; }, {path:%s, j:%s});\nreturn JSON.stringify(out);"
                % (self.page, json.dumps(path), json.dumps(payload)))
        out = self._run(code)
        if isinstance(out, dict) and out.get("writtenToFile"):
            # Neo saves a large result to a file instead of returning it
            raw = open(out["path"]).read()
            try:
                out = json.loads(raw)
                if isinstance(out, str):
                    out = json.loads(out)
            except ValueError:
                out = json.loads(raw[raw.index("{"):raw.rindex("}") + 1])
            if "value" in out and "text" not in out:
                out = out["value"] if isinstance(out["value"], dict) else json.loads(out["value"])
        if isinstance(out, str):
            out = json.loads(out)
        out["json"] = json.loads(out["text"]).get("json") if out["text"].startswith("{") else None
        return out
