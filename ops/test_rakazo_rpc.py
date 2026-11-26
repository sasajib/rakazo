"""rakazo_rpc against recorded answers of neo's `run` tool: no browser needed.
    python3 -m unittest ops/test_rakazo_rpc.py   (or: python3 ops/test_rakazo_rpc.py)"""
import json, os, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import rakazo_rpc  # noqa: E402

SAMPLES = json.load(open(os.path.join(HERE, "testdata", "neo-run-samples.json")))


def recorded(name, tmp):
    """The recorded SSE answer; a written-to-file answer gets its file re-created under tmp."""
    sample = SAMPLES[name]
    sse = sample["sse"]
    if "file" in sample:
        line = [l for l in sse.split("\n") if l.startswith("data: {")][0][6:]
        old = json.loads(line)["result"]["structuredContent"]["path"]
        new = os.path.join(tmp, name + ".txt")
        with open(new, "w") as f:
            f.write(sample["file"])
        sse = sse.replace(json.dumps(old)[1:-1], json.dumps(new)[1:-1])
    return sse


def client(answers):
    """An Rpc that never opens a tab or a socket: _post replays the given SSE answers in order."""
    rpc = rakazo_rpc.Rpc.__new__(rakazo_rpc.Rpc)
    rpc.n, rpc.page, rpc.sid, rpc.retry_pause, rpc.posted = 10, 7, "s", 0, []
    queue = list(answers)

    def post(body):
        rpc.posted.append(body)
        return None, queue.pop(0) if len(queue) > 1 else queue[0]
    rpc._post = post
    return rpc


class RunResultShapes(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="rakazo-rpc-test-")

    def test_inline_result(self):
        rpc = client([recorded("small", self.tmp)])
        self.assertEqual(rpc._run("x"), {"status": 200, "text": '{"json":{"ok":true}}'})
        self.assertEqual(rpc.call("threads/get", {})["json"], {"ok": True})
        self.assertEqual(len(rpc.posted), 2)  # no retry

    def test_result_written_to_a_file(self):
        # the shape that raised "neo run failed: None" (threads/get on a long thread)
        for name, letter in (("large", "x"), ("large_obj", "y")):
            rpc = client([recorded(name, self.tmp)])
            out = rpc._run("x")
            self.assertEqual(out["status"], 200)
            self.assertGreater(len(out["text"]), 30000)
            got = rpc.call("threads/get", {"threadId": "t"})
            self.assertEqual(got["json"], {"big": letter * 30000})
            self.assertEqual(len(rpc.posted), 2, "a file result is a result: no retry")

    def test_file_with_log_lines_before_the_value(self):
        path = os.path.join(self.tmp, "logs.txt")
        with open(path, "w") as f:
            f.write('ok\nlog: return: not this\nreturn: {"status": 200, "text": "{}"}\n')
        self.assertEqual(rakazo_rpc.read_result({"ok": True, "writtenToFile": True, "path": path}),
                         {"status": 200, "text": "{}"})

    def test_failed_run_still_raises_with_the_error(self):
        rpc = client([recorded("error", self.tmp)])
        with self.assertRaises(RuntimeError) as raised:
            rpc._run("x")
        self.assertIn("Failed to parse URL", str(raised.exception))
        self.assertEqual(len(rpc.posted), 2)  # one retry, then the error

    def test_retry_after_a_failed_first_answer(self):
        rpc = client([recorded("error", self.tmp), recorded("large", self.tmp)])
        self.assertEqual(rpc._run("x")["status"], 200)


if __name__ == "__main__":
    unittest.main()
