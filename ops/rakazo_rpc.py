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
        v = json.loads(json.loads(line)["result"]["structuredContent"]["value"])
        return v.get("value", v)

    def _find_page(self):
        # the open tab on agents.mindshare.website (signed in as Shakil)
        _, txt = self._post({"jsonrpc": "2.0", "id": 99, "method": "tools/call",
                             "params": {"name": "tabs", "arguments": {"action": "list"}}})
        import re
        m = re.search(r"\[(\d+)\]\s+https://agents\.mindshare\.website/", txt)
        if m:
            return int(m.group(1))
        raise RuntimeError("no agents.mindshare.website tab open in Neo")

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
