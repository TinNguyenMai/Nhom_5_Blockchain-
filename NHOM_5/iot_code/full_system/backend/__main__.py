import argparse
import logging
from pathlib import Path

import uvicorn

from .api import create_app
from .settings import ROOT, Settings


def main():
    parser = argparse.ArgumentParser(description="Phase 2: MQTT -> SQLite -> FastAPI (localhost)")
    parser.add_argument("--mqtt-host", default="127.0.0.1")
    parser.add_argument("--mqtt-port", type=int, default=1884)
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--db", type=Path, default=ROOT / "data" / "phase2.sqlite3")
    parser.add_argument("--config", type=Path, default=ROOT / "config" / "edge_demo.json")
    parser.add_argument("--device-id", help="Optional exact ESP32 device ID filter (not cryptographic identity)")
    parser.add_argument("--sell-reserve", type=float, default=0.2)
    parser.add_argument("--minimum-kwh", type=float, default=0.01)
    parser.add_argument("--stale-seconds", type=int, default=60)
    parser.add_argument("--no-mqtt", action="store_true", help="Read saved history without connecting MQTT")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("HTTP port must be 1..65535")
    try:
        settings = Settings(db_path=args.db, homes_config=args.config, mqtt_host=args.mqtt_host,
                            mqtt_port=args.mqtt_port, mqtt_enabled=not args.no_mqtt,
                            device_id=args.device_id, sell_reserve=args.sell_reserve,
                            minimum_kwh=args.minimum_kwh, stale_seconds=args.stale_seconds)
    except ValueError as error:
        parser.error(str(error))
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    print(f"Database: {settings.db_path.resolve()}", flush=True)
    print(f"Dashboard: http://127.0.0.1:{args.port} | API docs: /docs", flush=True)
    # One process owns the MQTT subscriber; do not use multiple workers/reload.
    uvicorn.run(create_app(settings), host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    main()
