"""Durable run journal; an interrupted process never silently restarts movement."""
from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

TERMINAL_SQL = "'COMPLETED','CANCELLED','EXPIRED','FAILED','INTERRUPTED'"


class BusyError(RuntimeError): pass


class Store:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,target TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL,created REAL NOT NULL,updated REAL NOT NULL,detail TEXT NOT NULL)")
            db.execute(f"CREATE UNIQUE INDEX IF NOT EXISTS active_device ON runs(target) WHERE state NOT IN ({TERMINAL_SQL})")
        path.chmod(0o600)

    def connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        return db

    def interrupt_old_runs(self):
        with self.connect() as db:
            db.execute(f"UPDATE runs SET state='INTERRUPTED',updated=?,detail=? WHERE state NOT IN ({TERMINAL_SQL})",
                       (time.time(),json.dumps({"error":"controller restarted; phone lease expires automatically"})))

    def reserve(self, run_id, target, digest, capacity) -> bool:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute("SELECT target,digest FROM runs WHERE id=?",(run_id,)).fetchone()
            if existing:
                if existing["target"] != target or existing["digest"] != digest: raise ValueError("run ID already belongs to a different request")
                return False
            count = db.execute(f"SELECT count(*) FROM runs WHERE state NOT IN ({TERMINAL_SQL})").fetchone()[0]
            if count >= capacity: raise BusyError("drive capacity reached")
            now = time.time()
            try: db.execute("INSERT INTO runs VALUES(?,?,?,?,?,?,?)",(run_id,target,digest,"QUEUED",now,now,"{}"))
            except sqlite3.IntegrityError: raise BusyError("device already has an active drive") from None
        return True

    def update(self, run_id, state, detail):
        with self.connect() as db:
            db.execute("UPDATE runs SET state=?,updated=?,detail=? WHERE id=?",(state,time.time(),json.dumps(detail,allow_nan=False),run_id))

    def get(self, run_id):
        with self.connect() as db: row = db.execute("SELECT * FROM runs WHERE id=?",(run_id,)).fetchone()
        if row is None: return None
        result = dict(row)
        result["detail"] = json.loads(result["detail"])
        return result
