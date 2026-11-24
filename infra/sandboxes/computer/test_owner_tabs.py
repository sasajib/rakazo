"""Offline tests for the shared team browser's per-bot tabs (fork): each bot works in a tab of its own."""
import importlib.machinery
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
loader = importlib.machinery.SourceFileLoader("page_browser_owner", str(HERE / "rakazo-page-browser"))
spec = importlib.util.spec_from_loader(loader.name, loader)
helper = importlib.util.module_from_spec(spec)
loader.exec_module(helper)


class FakeBrowser:
    def __init__(self, tabs):
        self.tabs = [{"id": tab, "type": "page", "url": f"https://{tab}.test/"} for tab in tabs]
        self.created = []

    def list(self, _port):
        return list(self.tabs)

    def connect(self, _port):
        client = Mock()

        def call(method, params):
            assert method == "Target.createTarget"
            self.created.append(params)
            tab = f"new{len(self.created)}"
            self.tabs.append({"id": tab, "type": "page", "url": "about:blank"})
            return {"targetId": tab}

        client.call.side_effect = call
        return client


class OwnerTabsTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        # The person's own tab is in front; no bot owns it.
        self.browser = FakeBrowser(["person"])
        self.patches = [patch.object(helper, "page_tabs", self.browser.list),
                        patch.object(helper.page_secrets, "connect", self.browser.connect)]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in self.patches:
            item.stop()

    def owner(self, name):
        return helper.OwnerTabs(self.home, 9222, name)

    def test_each_bot_gets_its_own_tab_never_the_tab_in_front(self):
        a, _ = self.owner("botA").tab()
        b, _ = self.owner("botB").tab()
        self.assertNotEqual(a, b)
        self.assertNotIn("person", (a, b))
        # Opened behind: the screen keeps showing what it showed.
        self.assertTrue(all(params.get("background") for params in self.browser.created))
        # The same bot comes back to the same tab.
        self.assertEqual(self.owner("botA").tab()[0], a)
        self.assertEqual(self.owner("botA").others(), {b})

    def test_a_closed_tab_is_replaced_and_another_bots_tab_is_never_adopted(self):
        a, _ = self.owner("botA").tab()
        b, _ = self.owner("botB").tab()
        self.owner("botA").adopt(b)
        self.assertEqual(self.owner("botA").tab()[0], a)
        self.browser.tabs = [tab for tab in self.browser.tabs if tab["id"] != a]
        replaced, url = self.owner("botA").tab()
        self.assertNotIn(replaced, (a, b))
        self.assertEqual(url, "about:blank")

    def test_front_without_a_tab_does_not_open_one(self):
        self.assertFalse(self.owner("botC").front())
        self.assertEqual(self.browser.created, [])

    def test_owner_name_is_validated(self):
        with patch.dict(os.environ, {"RAKAZO_TAB_OWNER": "bot/../x"}):
            self.assertIsNone(helper.tab_owner())
        with patch.dict(os.environ, {"RAKAZO_TAB_OWNER": "cmwuevujdeuie7pw8o6tj0ptt"}):
            self.assertEqual(helper.tab_owner(), "cmwuevujdeuie7pw8o6tj0ptt")

    def test_agent_browser_session_is_per_bot(self):
        with patch.dict(os.environ, {"RAKAZO_TAB_OWNER": "botA"}):
            self.assertEqual(helper.AgentBrowser(9222).session, "display-9222-botA")
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("RAKAZO_TAB_OWNER", None)
            self.assertEqual(helper.AgentBrowser(9222).session, "display-9222")


if __name__ == "__main__":
    unittest.main()
