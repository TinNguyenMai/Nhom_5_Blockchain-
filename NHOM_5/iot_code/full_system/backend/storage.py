from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import sqlite3

from .policy import propose


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


class Store:
    def __init__(self, settings):
        self.settings = settings
        self.path = settings.db_path.resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as db:
            db.execute("PRAGMA journal_mode=WAL")
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, 1):
                raise ValueError(f"Unsupported database schema: {version}")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT UNIQUE NOT NULL,
                    first_received_at TEXT NOT NULL, last_received_at TEXT NOT NULL,
                    simulator_status TEXT, state_received_at TEXT
                );
                CREATE TABLE IF NOT EXISTS telemetry (
                    event_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id),
                    household_id TEXT NOT NULL, timestamp TEXT NOT NULL, sequence INTEGER NOT NULL,
                    received_at TEXT NOT NULL, payload TEXT NOT NULL,
                    UNIQUE(run_id, household_id, timestamp), UNIQUE(run_id, household_id, sequence)
                );
                CREATE TABLE IF NOT EXISTS predictions (
                    id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id),
                    household_id TEXT NOT NULL, input_event_id TEXT NOT NULL,
                    input_timestamp TEXT NOT NULL, target_timestamp TEXT NOT NULL,
                    model_version TEXT NOT NULL, device_id TEXT NOT NULL,
                    received_at TEXT NOT NULL, late INTEGER NOT NULL, payload TEXT NOT NULL,
                    UNIQUE(run_id, household_id, target_timestamp, model_version, device_id)
                );
                CREATE TABLE IF NOT EXISTS proposals (
                    prediction_id TEXT PRIMARY KEY REFERENCES predictions(id),
                    payload TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_telemetry_time ON telemetry(run_id, household_id, timestamp);
                CREATE INDEX IF NOT EXISTS idx_prediction_time ON predictions(run_id, target_timestamp);
                PRAGMA user_version=1;
            """)

    @contextmanager
    def connection(self):
        db = sqlite3.connect(str(self.path), timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def _run(db, run_id, now):
        db.execute("INSERT INTO runs(run_id,first_received_at,last_received_at) VALUES(?,?,?) "
                   "ON CONFLICT(run_id) DO UPDATE SET last_received_at=excluded.last_received_at",
                   (run_id, now, now))

    def write(self, kind, payload):
        raw, now = canonical(payload), now_iso()
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            if kind == "telemetry":
                existing = db.execute("SELECT payload FROM telemetry WHERE event_id=? OR "
                                      "(run_id=? AND household_id=? AND timestamp=?)",
                                      (payload["event_id"], payload["run_id"], payload["household_id"], payload["timestamp"])).fetchone()
                if existing:
                    if existing[0] != raw:
                        raise ValueError("Conflicting telemetry identity; original record preserved")
                    return "duplicate"
                self._run(db, payload["run_id"], now)
                db.execute("INSERT INTO telemetry VALUES(?,?,?,?,?,?,?)", (
                    payload["event_id"], payload["run_id"], payload["household_id"], payload["timestamp"],
                    int(payload["event_id"].rsplit(":", 1)[1]), now, raw))
            elif kind == "prediction":
                key = [payload[k] for k in ("run_id", "household_id", "target_timestamp", "model_version", "device_id")]
                pid = hashlib.sha256(canonical(key).encode()).hexdigest()
                existing = db.execute("SELECT payload FROM predictions WHERE id=?", (pid,)).fetchone()
                if existing:
                    if existing[0] != raw:
                        raise ValueError("Conflicting prediction identity; original record preserved")
                    return "duplicate"
                last = db.execute("SELECT MAX(timestamp) FROM telemetry WHERE run_id=? AND household_id=?",
                                  (payload["run_id"], payload["household_id"])).fetchone()[0]
                late = last is not None and last >= payload["target_timestamp"]
                self._run(db, payload["run_id"], now)
                db.execute("INSERT INTO predictions VALUES(?,?,?,?,?,?,?,?,?,?,?)", (
                    pid, payload["run_id"], payload["household_id"], payload["input_event_id"],
                    payload["input_timestamp"], payload["target_timestamp"], payload["model_version"],
                    payload["device_id"], now, int(late), raw))
                policy = propose(payload, self.settings.sell_reserve, self.settings.minimum_kwh)
                # Forecast and policy snapshot are committed together, or neither is written.
                db.execute("INSERT INTO proposals VALUES(?,?)", (pid, canonical(policy)))
            else:
                self._run(db, payload["run_id"], now)
                db.execute("UPDATE runs SET simulator_status=?,state_received_at=? WHERE run_id=?",
                           (payload["status"], now, payload["run_id"]))
        return "stored"

    def counts(self):
        with self.connection() as db:
            return {table: db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                    for table in ("runs", "telemetry", "predictions", "proposals")}

    def runs(self, limit=50):
        with self.connection() as db:
            return [dict(row) for row in db.execute("""
                SELECT r.*, (SELECT COUNT(*) FROM telemetry t WHERE t.run_id=r.run_id) AS telemetry_count,
                (SELECT COUNT(*) FROM predictions p WHERE p.run_id=r.run_id) AS prediction_count
                FROM runs r ORDER BY r.id DESC LIMIT ?
            """, (limit,))]

    @staticmethod
    def filters(run_id, household_id, alias=""):
        clauses, values = [], []
        for name, value in (("run_id", run_id), ("household_id", household_id)):
            if value is not None:
                clauses.append(f"{alias}{name}=?"); values.append(value)
        return (" WHERE " + " AND ".join(clauses) if clauses else ""), values

    def records(self, kind, run_id=None, household_id=None, limit=100, offset=0, *, order_by_received=False):
        if kind not in ("telemetry", "predictions"):
            raise ValueError("Unsupported record type")
        where, values = self.filters(run_id, household_id)
        timestamp = "timestamp" if kind == "telemetry" else "target_timestamp"
        if order_by_received:
            timestamp = "received_at"
        with self.connection() as db:
            total = db.execute(f"SELECT COUNT(*) FROM {kind}{where}", values).fetchone()[0]
            rows = db.execute(f"SELECT * FROM {kind}{where} ORDER BY {timestamp} DESC,rowid DESC LIMIT ? OFFSET ?",
                              [*values, limit, offset])
            items = []
            for row in rows:
                p = json.loads(row["payload"])
                p["received_at"] = row["received_at"]
                if kind == "predictions":
                    p.update(id=row["id"], late=bool(row["late"]))
                items.append(p)
        return {"items": items, "total": total, "limit": limit, "offset": offset}

    def homes(self, home_settings, run_id=None):
        with self.connection() as db:
            if run_id is None:
                row = db.execute("SELECT run_id FROM runs ORDER BY id DESC LIMIT 1").fetchone()
                run_id = row[0] if row else None
            items = []
            for hid, home in home_settings.items():
                row = db.execute("SELECT payload,received_at FROM telemetry WHERE run_id=? AND household_id=? "
                                 "ORDER BY timestamp DESC LIMIT 1", (run_id, hid)).fetchone()
                reading = json.loads(row[0]) if row else None
                age = max(0, (datetime.now(timezone.utc) - datetime.fromisoformat(row[1])).total_seconds()) if row else None
                items.append({"household_id": hid, "name": home["name"], "telemetry": reading,
                              "received_at": row[1] if row else None, "age_seconds": age,
                              "stale": age is None or age > self.settings.stale_seconds,
                              "has_edge_model": hid == "home_01"})
        return {"run_id": run_id, "items": items}

    def proposals(self, mqtt_ready, run_id=None, household_id=None, limit=100, offset=0):
        where, values = self.filters(run_id, household_id, "p.")
        with self.connection() as db:
            latest = db.execute("SELECT run_id FROM runs ORDER BY id DESC LIMIT 1").fetchone()
            latest_run = latest[0] if latest else None
            total = db.execute("SELECT COUNT(*) FROM predictions p" + where, values).fetchone()[0]
            rows = db.execute("""
                SELECT p.*, q.payload AS policy, i.payload AS input_payload, a.payload AS actual_payload,
                    r.simulator_status, r.state_received_at,
                    (SELECT MAX(t.timestamp) FROM telemetry t WHERE t.run_id=p.run_id
                     AND t.household_id=p.household_id) AS high_water
                FROM predictions p JOIN proposals q ON q.prediction_id=p.id
                JOIN runs r ON r.run_id=p.run_id
                LEFT JOIN telemetry i ON i.event_id=p.input_event_id
                LEFT JOIN telemetry a ON a.run_id=p.run_id AND a.household_id=p.household_id
                    AND a.timestamp=p.target_timestamp
            """ + where + " ORDER BY p.target_timestamp DESC,p.rowid DESC LIMIT ? OFFSET ?", [*values, limit, offset])
            items = []
            for row in rows:
                p, policy = json.loads(row["payload"]), json.loads(row["policy"])
                actual = json.loads(row["actual_payload"]) if row["actual_payload"] else None
                inp = json.loads(row["input_payload"]) if row["input_payload"] else None
                age = max(0, (datetime.now(timezone.utc) - datetime.fromisoformat(row["received_at"])).total_seconds())
                state_age = max(0, (datetime.now(timezone.utc) - datetime.fromisoformat(row["state_received_at"])).total_seconds()) if row["state_received_at"] else None
                if row["late"]:
                    status = "late"
                elif not inp:
                    status = "awaiting_input"
                elif inp["timestamp"] != p["input_timestamp"]:
                    status = "invalid_input"
                elif actual:
                    status = "observed"
                elif row["high_water"] and row["high_water"] >= p["target_timestamp"]:
                    status = "expired"
                elif p["run_id"] != latest_run:
                    status = "archived"
                elif row["simulator_status"] in ("stopped", "offline", "error", "paused"):
                    status = row["simulator_status"]
                elif not mqtt_ready:
                    status = "disconnected"
                elif age > self.settings.stale_seconds or (state_age is not None and state_age > self.settings.stale_seconds):
                    status = "stale"
                elif policy["action"] == "hold":
                    status = "below_threshold"
                else:
                    status = "proposed"
                items.append({"id": row["id"], "run_id": p["run_id"], "household_id": p["household_id"],
                              "input_event_id": p["input_event_id"], "target_timestamp": p["target_timestamp"],
                              "device_id": p["device_id"], "model_version": p["model_version"],
                              "created_at": row["received_at"], **policy, "status": status,
                              "eligible_for_review": status == "proposed", "on_chain": False,
                              "actual_net_kwh": (actual["solar_energy_kwh"] - actual["load_energy_kwh"]) if actual else None,
                              "basis": "esp32_forecast", "purpose": "advisory_only"})
        return {"items": items, "total": total, "limit": limit, "offset": offset}

    def checkpoint(self):
        with self.connection() as db:
            db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
