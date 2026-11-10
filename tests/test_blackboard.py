"""The Blackboard, Python side — same contract, and the two adapters must see the same floor."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(HERE, "runners"))

from blackboard import board  # noqa: E402


class PythonSide(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.bb = board(os.path.join(self.dir, "blackboard.db"))

    def tearDown(self):
        self.bb.close()

    def test_round_trip_and_value(self):
        self.bb.post(topic="skald.stock_mood", author="skald", value=32, as_of="2026-11-09")
        n = self.bb.read("skald.stock_mood")
        self.assertEqual((n["value"], n["as_of"], n["author"]), (32, "2026-11-09", "skald"))
        self.assertEqual(self.bb.value("skald.stock_mood"), 32)
        self.assertEqual(self.bb.value("nobody.home", "fallback"), "fallback")

    def test_structured_value(self):
        v = {"exposure": 0.75, "th": {"wiki": True, "vix": None}, "changes": [1, 2]}
        self.bb.post(topic="cavalier.state", author="cavalier", value=v)
        self.assertEqual(self.bb.read("cavalier.state")["value"], v)

    def test_supersede_keeps_history(self):
        first = self.bb.post(topic="market.spy.close", author="treasury", value=752.0, as_of="2026-11-09")
        self.bb.post(topic="market.spy.close", author="treasury", value=752.69,
                     as_of="2026-11-09", supersedes=first["id"])
        self.assertEqual(self.bb.read("market.spy.close")["value"], 752.69)
        h = self.bb.history("market.spy.close")
        self.assertEqual([len(h), h[0]["value"]], [2, 752.0])

    def test_retract_hides_but_keeps(self):
        r = self.bb.post(topic="ravens.rumour", author="ravens", value="sky falling")
        self.bb.retract(r["id"], author="opie", reason="bad source")
        self.assertIsNone(self.bb.read("ravens.rumour"))
        h = self.bb.history("ravens.rumour")
        self.assertEqual([len(h), h[1]["kind"], h[1]["reason"]], [2, "retraction", "bad source"])

    def test_expiry_and_prefix(self):
        self.bb.post(topic="weather.today", author="w", value="rain", expires="2026-11-09T00:00:00Z")
        self.assertEqual(self.bb.read("weather.today", now="2026-11-08T00:00:00Z")["value"], "rain")
        self.assertIsNone(self.bb.read("weather.today", now="2026-11-10T00:00:00Z"))
        self.bb.post(topic="cavalier", author="a", value=1)
        self.bb.post(topic="cavalier.exposure", author="a", value=2)
        self.bb.post(topic="cavalierish.other", author="b", value=4)
        self.assertEqual(sorted(n["value"] for n in self.bb.query(prefix="cavalier")), [1, 2])

    def test_malformed_refused(self):
        for kw in ({"topic": "Bad Topic", "author": "a", "value": 1},
                   {"topic": "ok.topic", "author": "", "value": 1},
                   {"topic": "ok.topic", "author": "a", "value": 1, "confidence": 2},
                   {"topic": "ok.topic", "author": "a", "value": 1, "supersedes": 999}):
            with self.assertRaises(ValueError):
                self.bb.post(**kw)
        self.bb.post(topic="ok.topic", author="a", value=None)   # null means "looked, knew nothing"
        self.assertIsNone(self.bb.read("ok.topic")["value"])


class OneFloorTwoAdapters(unittest.TestCase):
    """The whole point: a station writes in Python, a ministry reads in Node, and vice versa."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.db = os.path.join(self.dir, "blackboard.db")

    def node(self, code: str) -> str:
        js = (f"const {{board}}=require({json.dumps(os.path.join(HERE, 'runners', 'blackboard.js'))});"
              f"const bb=board(null,{json.dumps(self.db)});{code}")
        out = subprocess.run(["node", "-e", js], capture_output=True, text=True, timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr)
        return out.stdout.strip()

    def test_python_writes_node_reads(self):
        bb = board(self.db)
        bb.post(topic="cavalier.exposure", author="cavalier", value=0.75, as_of="2026-11-09")
        bb.close()
        seen = json.loads(self.node("console.log(JSON.stringify(bb.read('cavalier.exposure')))"))
        self.assertEqual((seen["value"], seen["as_of"], seen["author"]), (0.75, "2026-11-09", "cavalier"))

    def test_node_writes_python_reads(self):
        self.node("bb.post({topic:'skald.stock_mood',author:'skald',value:60,as_of:'2026-11-09'});")
        bb = board(self.db)
        n = bb.read("skald.stock_mood")
        self.assertEqual((n["value"], n["as_of"], n["author"]), (60, "2026-11-09", "skald"))
        bb.close()

    def test_supersede_across_the_two(self):
        self.node("bb.post({topic:'market.spy.close',author:'treasury',value:752.0,as_of:'2026-11-09'});")
        bb = board(self.db)
        first = bb.read("market.spy.close")
        bb.post(topic="market.spy.close", author="cavalier", value=752.69,
                as_of="2026-11-09", supersedes=first["id"])
        bb.close()
        self.assertEqual(json.loads(self.node("console.log(JSON.stringify(bb.read('market.spy.close')))"))["value"],
                         752.69)


if __name__ == "__main__":
    unittest.main()


class IfChanged(unittest.TestCase):
    def setUp(self):
        self.bb = board(os.path.join(tempfile.mkdtemp(), "blackboard.db"))

    def tearDown(self):
        self.bb.close()

    def test_identical_note_is_not_rewritten(self):
        a = self.bb.post(topic="cavalier2.exposure", author="c2", value=0.75, as_of="2026-11-09", if_changed=True)
        b = self.bb.post(topic="cavalier2.exposure", author="c2", value=0.75, as_of="2026-11-09", if_changed=True)
        self.assertEqual((b["id"], b.get("unchanged")), (a["id"], True))
        self.assertEqual(len(self.bb.history("cavalier2.exposure")), 1)

    def test_a_real_change_and_a_new_day_both_write(self):
        self.bb.post(topic="t.x", author="a", value=1, as_of="2026-11-09", if_changed=True)
        self.bb.post(topic="t.x", author="a", value=2, as_of="2026-11-09", if_changed=True)
        self.bb.post(topic="t.x", author="a", value=2, as_of="2026-11-10", if_changed=True)
        self.assertEqual([(n["value"], n["as_of"]) for n in self.bb.history("t.x")],
                         [(1, "2026-11-09"), (2, "2026-11-09"), (2, "2026-11-10")])

    def test_default_stays_dumb_and_honest(self):
        self.bb.post(topic="plain.topic", author="x", value=1)
        self.bb.post(topic="plain.topic", author="x", value=1)
        self.assertEqual(len(self.bb.history("plain.topic")), 2)
