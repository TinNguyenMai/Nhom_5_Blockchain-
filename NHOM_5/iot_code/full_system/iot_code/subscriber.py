"""Receive telemetry, validate it, and append unique readings to CSV."""

import argparse
import csv
import json
from pathlib import Path
import sys
import uuid

import paho.mqtt.client as mqtt

from .model import FIELDS, validate_reading
from .config import DEFAULT_CONFIG, load_config, homes_dict


def main():
    parser = argparse.ArgumentParser(description="Nhan MQTT va ghi CSV.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=1884)
    parser.add_argument("--output", type=Path, default=Path("data/telemetry.csv"))
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    seen = set()
    try:
        home_ids = homes_dict(load_config(args.config))
        if args.output.exists() and args.output.stat().st_size:
            with args.output.open(encoding="utf-8", newline="") as existing:
                rows = csv.DictReader(existing)
                if rows.fieldnames != FIELDS:
                    raise ValueError("CSV co schema khac. Dung --output voi ten tep moi.")
                seen.update(row["event_id"] for row in rows)
    except (OSError, ValueError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1

    client = mqtt.Client(callback_api_version=mqtt.CallbackAPIVersion.VERSION2, client_id=f"collector-{uuid.uuid4().hex[:12]}", protocol=mqtt.MQTTv311)
    client.reconnect_delay_set(min_delay=1, max_delay=5)
    fatal = []
    count = 0

    with args.output.open("a", encoding="utf-8", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=FIELDS, extrasaction="ignore")
        if output.tell() == 0:
            writer.writeheader()
            output.flush()

        def on_connect(client, userdata, flags, reason_code, properties):
            if reason_code != 0:
                fatal.append(f"Ket noi bi tu choi: {reason_code}")
                client.disconnect()
                return
            result, _ = client.subscribe("solar/+/telemetry", qos=1)
            if result != mqtt.MQTT_ERR_SUCCESS:
                fatal.append(f"Subscribe loi: {mqtt.error_string(result)}")
                client.disconnect()

        def on_subscribe(client, userdata, mid, reason_codes, properties):
            if not reason_codes or any(code.is_failure for code in reason_codes):
                fatal.append("Broker tu choi subscription.")
                client.disconnect()
                return
            print(f"READY solar/+/telemetry -> {args.output.resolve()} | existing={len(seen)}", flush=True)

        def on_disconnect(client, userdata, flags, reason_code, properties):
            if reason_code != 0:
                print(f"DISCONNECTED: {reason_code}; dang thu ket noi lai...", flush=True)

        def on_message(client, userdata, message):
            nonlocal count
            try:
                reading = json.loads(message.payload.decode("utf-8"))
                validate_reading(reading, message.topic, home_ids)
            except (ValueError, TypeError, KeyError) as error:
                print(f"SKIP invalid: {error}", flush=True)
                return
            if reading["event_id"] in seen:
                print(f"SKIP duplicate: {reading['event_id']}", flush=True)
                return
            try:
                writer.writerow(reading)
                output.flush()
            except OSError as error:
                fatal.append(f"Khong ghi duoc CSV: {error}")
                client.disconnect()
                return
            seen.add(reading["event_id"])
            count += 1
            print(f"RECV #{count} {reading['timestamp']} {reading['household_id']} solar={reading['solar_power_kw']:.3f}kW load={reading['load_power_kw']:.3f}kW net={reading['net_power_kw']:+.3f}kW", flush=True)

        client.on_connect = on_connect
        client.on_subscribe = on_subscribe
        client.on_message = on_message
        client.on_disconnect = on_disconnect
        try:
            client.connect(args.host, args.port, keepalive=30)
            client.loop_forever()
        except KeyboardInterrupt:
            print(f"\nDa dung subscriber. Them {count} dong vao {args.output}.")
        except (OSError, RuntimeError) as error:
            fatal.append(str(error))
        finally:
            client.disconnect()
    if fatal:
        print(f"ERROR: {fatal[-1]}\nKiem tra broker va duong dan CSV.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
