"""Durable MQTT history for simulation runs; never changes the Phase 2 database."""
import json
import sqlite3
from datetime import datetime, timezone, timedelta
from pathlib import Path


class MarketStore:
    def __init__(self, file):
        Path(file).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(file, check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript("""
          CREATE TABLE IF NOT EXISTS messages (
            message_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, topic TEXT NOT NULL,
            household_id TEXT, received_at TEXT NOT NULL, payload TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS idx_market_topic ON messages(topic, household_id);
          CREATE TABLE IF NOT EXISTS rejected (received_at TEXT, topic TEXT, reason TEXT);
        """)
        self.db.commit()

    def store(self, topic, payload):
        raw = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        old = self.db.execute("SELECT topic,payload FROM messages WHERE message_id=?", (payload["message_id"],)).fetchone()
        if old:
            if old != (topic, raw):
                raise ValueError("Conflicting message identity")
            return "duplicate"
        if topic.endswith("/prediction"):
            source = self.db.execute("SELECT topic,payload FROM messages WHERE message_id=?", (payload.get("input_message_id"),)).fetchone()
            if not source or source[0] != f"solar/{payload['household_id']}/telemetry":
                raise ValueError("Prediction input telemetry is absent")
            reading = json.loads(source[1])
            difference = round((reading["solar_energy_kwh"] - reading["load_energy_kwh"]) * 1000)
            action = "sell" if difference > 0 else "buy" if difference < 0 else "hold"
            if payload.get("input_event_id") != reading["event_id"] or payload["action"] != action or int(payload["quantity_wh"]) != abs(difference) or \
                    payload.get("target_timestamp") != (datetime.fromisoformat(reading["timestamp"]) + timedelta(seconds=300)).isoformat():
                raise ValueError("Prediction does not match its simulated input")
        self.db.execute("INSERT INTO messages VALUES(?,?,?,?,?,?)", (payload["message_id"], payload["run_id"], topic,
            payload.get("household_id"), datetime.now(timezone.utc).isoformat(), raw))
        self.db.commit()
        return "stored"

    def reject(self, topic, reason):
        self.db.execute("INSERT INTO rejected VALUES(?,?,?)", (datetime.now(timezone.utc).isoformat(), topic, reason))
        self.db.commit()

    def close(self):
        self.db.close()
