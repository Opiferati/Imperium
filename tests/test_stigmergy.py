"""Stigmergy lessons, Python side. Theraulaz & Bonabeau, Artificial Life 5(2), 1999.

Both adapters must agree on fading and on taint, or a station and a ministry would disagree about
whether a trace is still worth believing.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(HERE, "runners"))

from blackboard import board  # noqa: E402


def plus(days: float) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=days)).isoformat(timespec="seconds").replace("+00:00", "Z")


class Fading(unittest.TestCase):
    def setUp(self):
        self.bb = board(os.path.join(tempfile.mkdtemp(), "blackboard.db"))

    def tearDown(self):
        self.bb.close()

    def test_freshness_halves_every_half_life(self):
        self.bb.post(topic="skald.stock_mood", author="skald", value=60, half_life_days=1)
        self.assertEqual(self.bb.read("skald.stock_mood")["freshness"], 1.0)
        self.assertAlmostEqual(self.bb.read("skald.stock_mood", now=plus(1))["freshness"], 0.5, places=2)
        self.assertAlmostEqual(self.bb.read("skald.stock_mood", now=plus(2))["freshness"], 0.25, places=2)

    def test_the_reader_sets_the_bar(self):
        self.bb.post(topic="t.mood", author="a", value=1, half_life_days=1)
        self.assertIsNone(self.bb.read("t.mood", now=plus(2), min_freshness=0.5))
        self.assertIsNotNone(self.bb.read("t.mood", now=plus(2), min_freshness=0.1))
        self.assertIsNotNone(self.bb.read("t.mood", now=plus(2)))      # no bar asked, no bar applied

    def test_no_half_life_never_fades_but_age_is_still_visible(self):
        self.bb.post(topic="vix.close", author="c", value=19.92, as_of="2026-11-09")
        n = self.bb.read("vix.close", now=plus(400), min_freshness=0.99)
        self.assertEqual(n["freshness"], 1.0)
        self.assertGreater(n["age_hours"], 9000)


class Taint(unittest.TestCase):
    def setUp(self):
        self.bb = board(os.path.join(tempfile.mkdtemp(), "blackboard.db"))

    def tearDown(self):
        self.bb.close()

    def test_suspect_walks_the_citation_chain(self):
        bad = self.bb.post(topic="skald.stock_mood", author="skald", value=5)
        good = self.bb.post(topic="vix.close", author="c", value=19.9)
        mid = self.bb.post(topic="c2.alarming", author="c2", value=2, based_on=[bad["id"], good["id"]])
        far = self.bb.post(topic="c2.exposure", author="c2", value=0.5, based_on=[mid["id"]])
        clean = self.bb.post(topic="ravens.league", author="r", value="fine", based_on=[good["id"]])
        self.bb.retract(bad["id"], author="opie", reason="misread a satire site")
        ids = [n["id"] for n in self.bb.suspect(bad["id"])]
        self.assertEqual(ids, [mid["id"], far["id"]])
        self.assertNotIn(clean["id"], ids)

    def test_a_citation_must_exist(self):
        with self.assertRaises(ValueError):
            self.bb.post(topic="a.b", author="x", value=1, based_on=[999])


class BothAdaptersAgree(unittest.TestCase):
    """A station and a ministry must not disagree about whether a trace is still worth believing."""

    def setUp(self):
        self.db = os.path.join(tempfile.mkdtemp(), "blackboard.db")

    def node(self, code: str) -> str:
        js = (f"const {{board}}=require({json.dumps(os.path.join(HERE, 'runners', 'blackboard.js'))});"
              f"const bb=board(null,{json.dumps(self.db)});{code}")
        out = subprocess.run(["node", "-e", js], capture_output=True, text=True, timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr)
        return out.stdout.strip()

    def test_freshness_matches_across_adapters(self):
        bb = board(self.db)
        bb.post(topic="skald.stock_mood", author="skald", value=60, half_life_days=1)
        when = plus(1)
        mine = bb.read("skald.stock_mood", now=when)["freshness"]
        bb.close()
        theirs = float(self.node(
            f"console.log(bb.read('skald.stock_mood',{{now:{json.dumps(when)}}}).freshness)"))
        self.assertAlmostEqual(mine, theirs, places=3)
        self.assertAlmostEqual(mine, 0.5, places=2)

    def test_taint_matches_across_adapters(self):
        self.node("const a=bb.post({topic:'s.mood',author:'s',value:5});"
                  "bb.post({topic:'c.exp',author:'c',value:1,based_on:[a.id]});")
        bb = board(self.db)
        bad = bb.history("s.mood")[0]["id"]
        self.assertEqual([n["topic"] for n in bb.suspect(bad)], ["c.exp"])
        bb.close()
        self.assertEqual(self.node(f"console.log(bb.suspect({bad}).map(n=>n.topic).join(','))"), "c.exp")


if __name__ == "__main__":
    unittest.main()
