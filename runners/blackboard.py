"""THE BLACKBOARD, Python side (2026-11-09) — the same five-method contract as runners/blackboard.js.

The ministries are Node, the stations are Python, and both must be able to read the same floor. One
SQLite file, two thin adapters, identical contract. Swap either adapter without touching the other.

    from blackboard import board
    bb = board()                                  # C:\\Imperium\\data\\blackboard.db by default
    bb.post(topic="cavalier.exposure", author="cavalier", value=0.75, as_of="2026-11-09")
    bb.read("skald.stock_mood")                    # what we currently believe
    bb.query(prefix="cavalier")                    # a whole branch
    bb.history("cavalier.exposure")                # everything ever said, oldest first
    bb.retract(12, author="opie", reason="wrong source")

Append-only: nothing is ever UPDATEd. A correction supersedes; a withdrawal retracts. `at` is when the
note was written, `as_of` is the moment the fact is about — never collapse those two.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
from datetime import datetime, timezone

TOPIC_RE = re.compile(r"^[a-z0-9]+([._-][a-z0-9]+)*$")
BUSY_MS = 5000
LIVE = "id NOT IN (SELECT supersedes FROM notes WHERE supersedes IS NOT NULL)"


def _wsl(p: str) -> str:
    if len(p) > 2 and p[1] == ":" and p[0].isalpha():
        return "/mnt/" + p[0].lower() + "/" + p[3:].replace("\\", "/")
    return p


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


DEFAULT_DB = os.path.join(_wsl(os.environ.get("IMPERIUM_DIR", r"C:\Imperium")), "data", "blackboard.db")


SCHEMA = """
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL, author TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'note',
  value TEXT, as_of TEXT, at TEXT NOT NULL, confidence REAL,
  source TEXT, code TEXT, expires TEXT, supersedes INTEGER, reason TEXT,
  half_life_days REAL, based_on TEXT
);
CREATE INDEX IF NOT EXISTS notes_topic ON notes(topic, id DESC);
CREATE INDEX IF NOT EXISTS notes_at ON notes(at);
CREATE INDEX IF NOT EXISTS notes_supersedes ON notes(supersedes);
"""


def _out(r: sqlite3.Row | None, now: datetime | None = None) -> dict | None:
    """Decorates with age and freshness. QUANTITATIVE STIGMERGY (Theraulaz & Bonabeau 1999): a trail that
    never fades is not a trail, it's a monument. freshness is 1.0 when written and halves every
    half_life_days; a note with no half-life never fades, which is right for a fact about a fixed day and
    wrong for a belief about the present."""
    if r is None:
        return None
    d = dict(r)
    for k in ("value", "based_on"):
        if d.get(k) is not None:
            try:
                d[k] = json.loads(d[k])
            except (ValueError, TypeError):
                pass
    age_h = ((now or datetime.now(timezone.utc)) - datetime.fromisoformat(d["at"].replace("Z", "+00:00"))
             ).total_seconds() / 3600
    d["age_hours"] = round(max(0.0, age_h), 2)
    hl = d.get("half_life_days")
    d["freshness"] = round(0.5 ** ((age_h / 24) / hl), 4) if hl else 1.0
    return d


class Board:
    """The five-method contract. Anything with these methods is a drop-in replacement."""

    def __init__(self, path: str | None = None, read_only: bool = False):
        self.path = path or DEFAULT_DB
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        self.db = sqlite3.connect(self.path, timeout=BUSY_MS / 1000)
        self.db.row_factory = sqlite3.Row
        try:
            self.db.execute("PRAGMA journal_mode = WAL")
        except sqlite3.DatabaseError:
            pass                                       # a Windows mount may refuse WAL; the default is fine
        if not read_only:
            self.db.executescript(SCHEMA)
            # Columns added 2026-11-10; old boards migrate in place and simply have no half-life or citations.
            for col in ("half_life_days REAL", "based_on TEXT"):
                try:
                    self.db.execute(f"ALTER TABLE notes ADD COLUMN {col}")
                except sqlite3.OperationalError:
                    pass
            self.db.commit()

    def post(self, topic: str, author: str, value, as_of: str | None = None,
             confidence: float | None = None, source: str | None = None,
             code: str | None = None, expires: str | None = None,
             supersedes: int | None = None, if_changed: bool = False,
             half_life_days: float | None = None, based_on: list[int] | None = None) -> dict:
        """Write what you learned. Raises on a malformed note: that's a bug, not a condition.
        if_changed=True skips writing a note identical to the current one for the same topic and as_of —
        not an update (nothing is ever rewritten), just a way to keep the history meaningful."""
        if not topic or not TOPIC_RE.match(topic):
            raise ValueError(f"blackboard: topic must be dotted lowercase, got {topic!r}")
        if not author:
            raise ValueError("blackboard: every note needs an author")
        if confidence is not None and not 0 <= confidence <= 1:
            raise ValueError("blackboard: confidence must be between 0 and 1")
        if supersedes is not None and not self.db.execute(
                "SELECT 1 FROM notes WHERE id = ?", (supersedes,)).fetchone():
            raise ValueError(f"blackboard: cannot supersede note {supersedes}, it does not exist")
        payload = json.dumps(value)
        # "Identical" means the value AND how to read it: a producer that changes its half-life or its
        # confidence has said something new, even about the same number.
        if if_changed:
            now = self.db.execute(
                f"SELECT * FROM notes WHERE topic = ? AND kind = 'note' AND {LIVE}"
                " AND (expires IS NULL OR expires > ?) ORDER BY id DESC LIMIT 1",
                (topic, now_iso())).fetchone()
            if (now and now["value"] == payload and now["as_of"] == as_of
                    and now["half_life_days"] == half_life_days and now["confidence"] == confidence):
                return {"id": now["id"], "at": now["at"], "unchanged": True}
        for b in based_on or []:
            if not self.db.execute("SELECT 1 FROM notes WHERE id = ?", (b,)).fetchone():
                raise ValueError(f"blackboard: cannot cite note {b}, it does not exist")
        at = now_iso()
        cur = self.db.execute(
            "INSERT INTO notes (topic, author, kind, value, as_of, at, confidence, source, code,"
            " expires, supersedes, reason, half_life_days, based_on)"
            " VALUES (?,?,'note',?,?,?,?,?,?,?,?,NULL,?,?)",
            (topic, author, payload, as_of, at, confidence, source, code, expires, supersedes,
             half_life_days, json.dumps(based_on) if based_on else None))
        self.db.commit()
        return {"id": cur.lastrowid, "at": at}

    def read(self, topic: str, now: str | None = None, min_freshness: float | None = None) -> dict | None:
        """What we currently believe about this topic, or None. min_freshness refuses a faded trace —
        the reader decides how stale is too stale."""
        when = now or now_iso()
        n = _out(self.db.execute(
            f"SELECT * FROM notes WHERE topic = ? AND kind = 'note' AND {LIVE}"
            " AND (expires IS NULL OR expires > ?) ORDER BY id DESC LIMIT 1",
            (topic, when)).fetchone(), datetime.fromisoformat(when.replace("Z", "+00:00")))
        if n and min_freshness is not None and n["freshness"] < min_freshness:
            return None
        return n

    def value(self, topic: str, fallback=None):
        n = self.read(topic)
        return n["value"] if n else fallback

    def query(self, topic: str | None = None, prefix: str | None = None, author: str | None = None,
              since: str | None = None, until: str | None = None, as_of: str | None = None,
              include_expired: bool = False, include_superseded: bool = False,
              include_retractions: bool = False, limit: int = 200, now: str | None = None) -> list[dict]:
        """Browse the floor. All filters optional; `prefix` matches a whole branch, e.g. 'cavalier'."""
        where, args = [], []
        if topic:
            where.append("topic = ?"); args.append(topic)
        if prefix:
            where.append("(topic = ? OR topic LIKE ?)"); args += [prefix, prefix + ".%"]
        if author:
            where.append("author = ?"); args.append(author)
        if since:
            where.append("at >= ?"); args.append(since)
        if until:
            where.append("at <= ?"); args.append(until)
        if as_of:
            where.append("as_of = ?"); args.append(as_of)
        if not include_retractions:
            where.append("kind = 'note'")
        if not include_superseded:
            where.append(LIVE)
        if not include_expired:
            where.append("(expires IS NULL OR expires > ?)"); args.append(now or now_iso())
        sql = "SELECT * FROM notes" + (" WHERE " + " AND ".join(where) if where else "")
        rows = self.db.execute(sql + " ORDER BY id DESC LIMIT ?", (*args, limit)).fetchall()
        return [_out(r) for r in rows]

    def history(self, topic: str, limit: int = 500) -> list[dict]:
        """Everything ever said about a topic, oldest first — superseded and retracted notes included."""
        return [_out(r) for r in self.db.execute(
            "SELECT * FROM notes WHERE topic = ? ORDER BY id ASC LIMIT ?", (topic, limit)).fetchall()]

    def suspect(self, note_id: int, limit: int = 500) -> list[dict]:
        """THE PARALASTOR LESSON (Theraulaz & Bonabeau 1999): one stray stimulus made a wasp build an entire
        redundant funnel — confident, competent, wasted work, because the trace it answered was wrong.
        Retracting a bad note does not un-build the funnel, so the board must at least name what is now
        suspect. Walks `based_on` citations forward, transitively."""
        rows = [_out(r) for r in self.db.execute(
            "SELECT * FROM notes WHERE based_on IS NOT NULL LIMIT ?", (limit,)).fetchall()]
        tainted, grew = {int(note_id)}, True
        while grew:
            grew = False
            for n in rows:
                if n["id"] not in tainted and any(int(b) in tainted for b in (n["based_on"] or [])):
                    tainted.add(n["id"])
                    grew = True
        tainted.discard(int(note_id))
        return sorted((n for n in rows if n["id"] in tainted), key=lambda n: n["id"])

    def retract(self, note_id: int, author: str, reason: str | None = None) -> dict:
        """Withdraw a note. Append-only: writes a retraction that supersedes it, and deletes nothing."""
        t = self.db.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
        if not t:
            raise ValueError(f"blackboard: no note {note_id} to retract")
        if not author:
            raise ValueError("blackboard: a retraction needs an author")
        at = now_iso()
        cur = self.db.execute(
            "INSERT INTO notes (topic, author, kind, value, as_of, at, supersedes, reason)"
            " VALUES (?,?,'retraction',NULL,?,?,?,?)", (t["topic"], author, t["as_of"], at, note_id, reason))
        self.db.commit()
        return {"id": cur.lastrowid, "at": at}

    def topics(self, prefix: str | None = None) -> list[dict]:
        return [dict(r) for r in self.db.execute(
            "SELECT topic, COUNT(*) n, MAX(at) latest FROM notes WHERE topic LIKE ?"
            " GROUP BY topic ORDER BY topic", ((prefix or "") + "%",)).fetchall()]

    def close(self):
        self.db.close()


def board(path: str | None = None, read_only: bool = False) -> Board:
    return Board(path, read_only)
