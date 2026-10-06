"""Synthetic HTTP integration fixture; never connects MQTT or user databases.

Used only by npm run test:integration. These forecasts are TEST INPUTS, not
physical ESP32 inference. The production bridge consumes the user's real API.
"""
import argparse
from datetime import timedelta
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import uvicorn
from backend.api import create_app
from backend.service import Service
from backend.settings import Settings
from iot_code.config import homes_dict, load_config
from iot_code.model import SolarModel, parse_start

parser = argparse.ArgumentParser()
parser.add_argument("--db", required=True)
parser.add_argument("--port", required=True, type=int)
parser.add_argument("--live", action="store_true", help="Mock MQTT readiness inside this test fixture only")
args = parser.parse_args()
settings = Settings(db_path=Path(args.db), mqtt_enabled=False)
service = Service(settings)
model = SolarModel(123, homes_dict(load_config(ROOT / "config" / "edge_demo.json")))
for sequence, (solar, load) in enumerate([(3.0, 1.0), (.2, 1.4), (2.5, 1.0)]):
    timestamp = parse_start("2026-10-01T10:00:00+07:00") + timedelta(minutes=5 * sequence)
    row = next(model.generate(timestamp, 300, "a" * 32, sequence))
    pred = {"schema_version": 1, "household_id": "home_01", "run_id": row["run_id"],
            "input_event_id": row["event_id"], "input_timestamp": row["timestamp"],
            "target_timestamp": (timestamp + timedelta(minutes=5)).isoformat(),
            "interval_seconds": 300, "model_version": "phase3-test-fixture-not-real-inference",
            "device_kind": "esp32", "device_id": "esp32-000000000001",
            "predicted_solar_kw": solar, "predicted_load_kw": load,
            "predicted_net_kw": solar-load, "predicted_surplus_kwh": max(solar-load, 0)/12,
            "inference_us": 0, "arena_used_bytes": 0, "free_heap_bytes": 0,
            "clipped_features": 0, "model_bytes": 5832}
    service.store.write("telemetry", row)
    service.store.write("prediction", pred)
service.store.write("state", {"run_id": "a" * 32, "status": "running" if args.live else "stopped"})
if args.live:
    # The live bridge still runs unchanged. Only the fixture replaces MQTT readiness.
    import backend.api
    class FixtureService(Service):
        def ready(self):
            return True
    backend.api.Service = FixtureService
uvicorn.run(create_app(settings), host="127.0.0.1", port=args.port, log_level="warning")
