"""SQLite storage for tonight's records. Uses only the standard library."""

import json
import sqlite3
from contextlib import closing

from .seed import demo_entities

SCHEMA = """
CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,             -- donor | request | runner
    data TEXT NOT NULL,             -- JSON
    added_at REAL NOT NULL,         -- minutes after 20:00
    cancelled_at REAL               -- NULL while active
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    t REAL NOT NULL,
    kind TEXT NOT NULL,             -- logged | cancelled | rejected | accepted
    entity TEXT,
    note TEXT
);
CREATE TABLE IF NOT EXISTS checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id TEXT NOT NULL,
    decision TEXT NOT NULL,         -- accepted | rejected
    items TEXT NOT NULL,            -- JSON of the pickup checklist
    t REAL NOT NULL
);
"""


class Store:
    def __init__(self, path):
        self.path = path
        with closing(self._db()) as db:
            db.executescript(SCHEMA)
            if not db.execute("SELECT 1 FROM entities LIMIT 1").fetchone():
                self._seed(db)
            db.commit()

    def _db(self):
        db = sqlite3.connect(self.path)
        db.row_factory = sqlite3.Row
        return db

    def _seed(self, db):
        for e in demo_entities():
            db.execute("INSERT INTO entities (id, kind, data, added_at) VALUES (?, ?, ?, ?)",
                       (e["id"], e["kind"], json.dumps(e["data"]), e["added_at"]))

    def reset(self):
        with closing(self._db()) as db:
            db.executescript("DELETE FROM entities; DELETE FROM events; DELETE FROM checks;")
            self._seed(db)
            db.commit()

    # ---------------------------------------------------------------- reads

    def entities(self):
        with closing(self._db()) as db:
            rows = db.execute("SELECT * FROM entities ORDER BY rowid").fetchall()
        return [{"id": r["id"], "kind": r["kind"], "data": json.loads(r["data"]),
                 "added_at": r["added_at"], "cancelled_at": r["cancelled_at"]} for r in rows]

    def events(self):
        with closing(self._db()) as db:
            return [dict(r) for r in db.execute("SELECT * FROM events ORDER BY t, id")]

    def checks(self):
        with closing(self._db()) as db:
            rows = db.execute("SELECT * FROM checks ORDER BY id").fetchall()
        return [{"trip_id": r["trip_id"], "decision": r["decision"],
                 "items": json.loads(r["items"]), "t": r["t"]} for r in rows]

    def get(self, entity_id):
        return next((e for e in self.entities() if e["id"] == entity_id), None)

    # ---------------------------------------------------------------- writes

    def add(self, kind, entity_id, data, t, note):
        with closing(self._db()) as db:
            db.execute("INSERT INTO entities (id, kind, data, added_at) VALUES (?, ?, ?, ?)",
                       (entity_id, kind, json.dumps(data), t))
            db.execute("INSERT INTO events (t, kind, entity, note) VALUES (?, 'logged', ?, ?)",
                       (t, entity_id, note))
            db.commit()

    def cancel(self, entity_id, t, kind, note):
        with closing(self._db()) as db:
            db.execute("UPDATE entities SET cancelled_at = ? WHERE id = ? AND cancelled_at IS NULL",
                       (t, entity_id))
            db.execute("INSERT INTO events (t, kind, entity, note) VALUES (?, ?, ?, ?)",
                       (t, kind, entity_id, note))
            db.commit()

    def record_check(self, trip_id, decision, items, t, note):
        with closing(self._db()) as db:
            db.execute("INSERT INTO checks (trip_id, decision, items, t) VALUES (?, ?, ?, ?)",
                       (trip_id, decision, json.dumps(items), t))
            if decision == "accepted":
                db.execute("INSERT INTO events (t, kind, entity, note) VALUES (?, 'accepted', ?, ?)",
                           (t, trip_id, note))
            db.commit()
