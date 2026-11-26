"""Tiny client for Rakazo's web RPC through the signed-in BrowserOS Neo tab (127.0.0.1:9210)."""
import json, urllib.request

URL = "http://127.0.0.1:9210/mcp"
HDR = {"content-type": "application/json", "accept": "application/json, text/event-stream"}


def has_result(sc):
    """True when a run's structuredContent carries a result, inline or written to a file."""
    return "value" in sc or bool(sc.get("writtenToFile") and sc.get("path"))


def read_result(sc):
    """The value a `run` returned, from its structuredContent. Two shapes:
    inline       {"ok": true, "value": "<what the code returned>", "logs": []}
    over ~20 KB  {"ok": true, "writtenToFile": true, "path": "<file>", "contentLength": n, "logs": []}
                 where the file holds "ok\nreturn: <the value as JSON>" (logs, if any, before it)."""
    if "value" in sc:
        v = sc["value"]
    else:
        with open(sc["path"]) as f:
            raw = f.read()
        at = 0 if raw.startswith("return: ") else raw.find("\nreturn: ") + 1
        if at == 0 and not raw.startswith("return: "):
            raise RuntimeError("neo run result file has no return value: %s" % sc["path"])
        v, _ = json.JSONDecoder().raw_decode(raw[at + len("return: "):].lstrip())
    if isinstance(v, str):
        try:
            v = json.loads(v)
        except ValueError:
            return v
    return v.get("value", v) if isinstance(v, dict) else v


class Rpc:
    retry_pause = 2

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

    def _run_once(self, code, rid):
        _, txt = self._post({"jsonrpc": "2.0", "id": rid, "method": "tools/call",
                             "params": {"name": "run", "arguments": {"code": code}}})
        line = [l for l in txt.split("\n") if l.startswith("data: {")][0][6:]
        return json.loads(line)["result"]["structuredContent"]

    def _run(self, code):
        self.n += 1
        sc = self._run_once(code, self.n)
        if not has_result(sc):
            # e.g. the fresh tab is still redirecting /app -> /app/<bot>; one retry after a pause
            import time
            time.sleep(self.retry_pause)
            sc = self._run_once(code, self.n + 1000)
            if not has_result(sc):
                raise RuntimeError("neo run failed: %s" % str(sc.get("error"))[:300])
        return read_result(sc)

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
                    href = self._run("const p = browser.page(%d); return JSON.stringify(await p.evaluateInPage(() => location.href));"
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
        code = ("const p = browser.page(%d);\nconst out = await p.evaluateInPage(async (a) => { const r = await fetch('/rpc/'+a.path, "
                "{method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body: JSON.stringify({json:a.j, meta: []})}); "
                "return {status:r.status, text:(await r.text()).slice(0,400000)}; }, {path:%s, j:%s});\nreturn JSON.stringify(out);"
                % (self.page, json.dumps(path), json.dumps(payload)))
        out = None
        for attempt in range(6):
            try:
                out = self._run(code)
                break
            except RuntimeError as error:
                # Our tab is between pages (about:blank while the app redirects): try again shortly.
                if "Failed to parse URL" not in str(error) or attempt == 5:
                    raise
                import time
                time.sleep(2)
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
