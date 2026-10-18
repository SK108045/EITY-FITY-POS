"""Companion-owned durable jobs and mappings. Never writes the eTIMS database."""
import json
from pathlib import Path
import sqlite3
from datetime import datetime, timezone
from contracts import canonical, digest, job_id
from contextlib import contextmanager

def now():
    return datetime.now(timezone.utc).isoformat()

class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript('''CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY, digest TEXT NOT NULL, payload TEXT NOT NULL,
                state TEXT NOT NULL, details TEXT NOT NULL, result TEXT,
                error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS mappings (
                id TEXT PRIMARY KEY, code TEXT NOT NULL, metadata TEXT NOT NULL,
                updated_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY, job TEXT NOT NULL, stage TEXT NOT NULL,
                at TEXT NOT NULL);''')
    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        try:
            db.execute('PRAGMA journal_mode=WAL')
            with db:yield db
        finally:db.close()
    @staticmethod
    def decode(row):
        if not row:
            return None
        value = dict(row)
        for field in ('payload', 'details', 'result'):
            if value.get(field):
                value[field] = json.loads(value[field])
        return value
    def get(self, key):
        with self.connect() as db:
            return self.decode(db.execute('SELECT * FROM jobs WHERE id=?', (key,)).fetchone())
    def create(self, payload, details=None):
        key, fingerprint = job_id(payload), digest(payload)
        with self.connect() as db:
            db.execute('INSERT OR IGNORE INTO jobs VALUES (?,?,?,?,?,?,?,?,?)',
                       (key, fingerprint, canonical(payload), 'queued', canonical(details or {}), None, None, now(), now()))
            row = self.decode(db.execute('SELECT * FROM jobs WHERE id=?', (key,)).fetchone())
            if row['digest'] != fingerprint:
                raise ValueError('This POS sale identity is already bound to different sale details')
        return row
    def update(self, key, state, *, result=None, error=None, details=None):
        with self.connect() as db:
            db.execute('UPDATE jobs SET state=?,result=coalesce(?,result),error=?,details=coalesce(?,details),updated_at=? WHERE id=?',
                       (state, canonical(result) if result is not None else None, error,
                        canonical(details) if details is not None else None, now(), key))
            db.execute('INSERT INTO events(job,stage,at) VALUES(?,?,?)', (key, state, now()))
        return self.get(key)
    def mapping(self, key):
        with self.connect() as db:
            row = db.execute('SELECT * FROM mappings WHERE id=?', (key,)).fetchone()
            return {**dict(row), 'metadata': json.loads(row['metadata'])} if row else None
    def map(self, key, code, metadata):
        with self.connect() as db:
            db.execute('''INSERT INTO mappings VALUES(?,?,?,?)
                          ON CONFLICT(id) DO UPDATE SET code=excluded.code, metadata=excluded.metadata, updated_at=excluded.updated_at''',
                       (key, code, canonical(metadata), now()))
    def interrupted(self):
        with self.connect() as db:
            return [self.decode(r) for r in db.execute("SELECT * FROM jobs WHERE state NOT IN ('complete','needs_details','review_required','failed')")]
    def completed_invoice(self,invoice):
        with self.connect() as db:
            for row in db.execute("SELECT result FROM jobs WHERE state='complete' AND result IS NOT NULL"):
                result=json.loads(row['result'])
                if result.get('local_invoice_id')==invoice:return result
        return None
