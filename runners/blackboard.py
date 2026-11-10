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
  source TEXT, code TEXT, expires TEXT, supersedes INTEGER, reason TEXT
);
CREATE INDEX IF NOT EXISTS notes_topic ON notes(topic, id DESC);
CREATE INDEX IF NOT EXISTS notes_at ON notes(at);
CREATE INDEX IF NOT EXISTS notes_supersedes ON notes(supersedes);
"""


def _out(r: sqlite3.Row | None) -> dict | None:
    if r is None:
        return None
    d = dict(r)
    if d.get("value") is not None:
        try:
            d["value"] = json.loads(d["value"])
        except (ValueError, TypeError):
            pass
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
            self.db.commit()

    def post(self, topic: str, author: str, value, as_of: str | None = None,
             confidence: float | None = None, source: str | None = None,
             code: str | None = None, expires: str | None = None,
             supersedes: int | None = None) -> dict:
        """Write what you learned. Raises on a malformed note: that's a bug, not a condition."""
        if not topic or not TOPIC_RE.match(topic):
            raise ValueError(f"blackboard: topic must be dotted lowercase, got {topic!r}")
        if not author:
            raise ValueError("blackboard: every note needs an author")
        if confidence is not None and not 0 <= confidence <= 1:
            raise ValueError("blackboard: confidence must be between 0 and 1")
        if supersedes is not None and not self.db.execute(
                "SELECT 1 FROM notes WHERE id = ?", (supersedes,)).fetchone():
            raise ValueError(f"blackboard: cannot supersede note {supersedes}, it does not exist")
        at = now_iso()
        cur = self.db.execute(
            "INSERT INTO notes (topic, author, kind, value, as_of, at, confidence, source, code,"
            " expires, supersedes, reason) VALUES (?,?,'note',?,?,?,?,?,?,?,?,NULL)",
            (topic, author, json.dumps(value), as_of, at, confidence, source, code, expires, supersedes))
        self.db.commit()
        return {"id": cur.lastrowid, "at": at}

    def read(self, topic: str, now: str | None = None) -> dict | None:
        """What do we currently believe about this topic? Latest live, unexpired note, or None."""
        return _out(self.db.execute(
            f"SELECT * FROM notes WHERE topic = ? AND kind = 'note' AND {LIVE}"
            " AND (expires IS NULL OR expires > ?) ORDER BY id DESC LIMIT 1",
            (topic, now or now_iso())).fetchone())

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
