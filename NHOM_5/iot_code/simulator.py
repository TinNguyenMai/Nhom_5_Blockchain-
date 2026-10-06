"""Configurable MQTT simulator; control commands apply at interval boundaries."""
import argparse
import json
from pathlib import Path
import queue
import sys
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone

import paho.mqtt.client as mqtt

from .config import DEFAULT_CONFIG, load_config, validate_config, homes_dict, reject_constant
from .model import SolarModel, parse_start
from .runtime import Runtime

STATE_TOPIC = "solar/simulator/state"


def main():
    parser = argparse.ArgumentParser(description="Phase 1B: simulator co cau hinh va dieu khien.")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=1884)
    parser.add_argument("--interval", type=float, default=None)
    parser.add_argument("--step-seconds", type=int, default=None)
    parser.add_argument("--start", default=None)
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument("--steps", type=int, default=0)
    parser.add_argument("--paused", action="store_true")
    parser.add_argument("--dataset", action="store_true", help="Khoa lenh dieu khien; can --steps > 0.")
    parser.add_argument("--quiet", action="store_true", help="An tung dong SENT khi tao dataset.")
    parser.add_argument("--run-dir", type=Path, default=Path("data/runs"))
    args = parser.parse_args()
    try:
        cfg = load_config(args.config)
        for argument, key in [(args.interval, "publish_interval_seconds"), (args.step_seconds, "step_seconds"), (args.start, "start"), (args.seed, "seed")]:
            if argument is not None:
                cfg["simulation"][key] = argument
        cfg = validate_config(cfg)
        if args.steps < 0 or (args.dataset and (args.steps == 0 or args.paused)):
            raise ValueError("steps >= 0; --dataset can --steps > 0 va khong dung --paused.")
    except (OSError, ValueError) as error:
        parser.error(str(error))

    sim = cfg["simulation"]
    timestamp = parse_start(sim["start"])
    run_id = uuid.uuid4().hex
    model = SolarModel(sim["seed"], homes_dict(cfg), sim["weather"])
    runtime = Runtime(model, run_id, sim["publish_interval_seconds"], args.paused, args.dataset)
    connected = threading.Event()
    commands = queue.Queue(maxsize=100)
    command_topic = f"solar/simulator/{run_id}/command"
    ack_topic = f"solar/simulator/{run_id}/ack"
    client = mqtt.Client(callback_api_version=mqtt.CallbackAPIVersion.VERSION2, client_id=f"sim-{run_id[:16]}", protocol=mqtt.MQTTv311)
    client.will_set(STATE_TOPIC, json.dumps({"run_id": run_id, "status": "offline"}), qos=1, retain=False)
    client.reconnect_delay_set(min_delay=1, max_delay=5)

    def on_connect(client, userdata, flags, reason_code, properties):
        if reason_code == 0:
            client.subscribe(command_topic, qos=1)
        else:
            print(f"CONNECT REJECTED: {reason_code}", flush=True)

    def on_subscribe(client, userdata, mid, reason_codes, properties):
        if reason_codes and all(not code.is_failure for code in reason_codes):
            connected.set()
            print(f"CONNECTED {args.host}:{args.port} | run_id={run_id}", flush=True)

    def on_disconnect(client, userdata, flags, reason_code, properties):
        connected.clear()
        if reason_code != 0:
            print(f"DISCONNECTED: {reason_code}", flush=True)

    def on_message(client, userdata, message):
        if message.retain or len(message.payload) > 16384:
            return
        try:
            commands.put_nowait(json.loads(message.payload.decode("utf-8"), parse_constant=reject_constant))
        except (ValueError, queue.Full):
            print("SKIP invalid/full command queue.", flush=True)

    client.on_connect = on_connect
    client.on_subscribe = on_subscribe
    client.on_disconnect = on_disconnect
    client.on_message = on_message

    def publish(topic, value, timeout=10):
        info = client.publish(topic, json.dumps(value, allow_nan=False), qos=1, retain=False)
        if info.rc != mqtt.MQTT_ERR_SUCCESS:
            raise RuntimeError(f"Publish: {mqtt.error_string(info.rc)}")
        info.wait_for_publish(timeout=timeout)
        if not info.is_published():
            raise TimeoutError("Broker chua ACK. Kiem tra ket noi.")

    status = "stopped"
    exit_code = 0
    command_log = None
    try:
        args.run_dir.mkdir(parents=True, exist_ok=True)
        metadata = {
            "run_id": run_id, "software_phase": "1B", "config": cfg,
            "mode": "dataset" if args.dataset else "interactive",
            "planned_steps": args.steps,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        with (args.run_dir / f"{run_id}.json").open("x", encoding="utf-8") as file:
            json.dump(metadata, file, ensure_ascii=False, indent=2)
        command_log = (args.run_dir / f"{run_id}.commands.jsonl").open("x", encoding="utf-8")
        client.connect(args.host, args.port, keepalive=15)
        client.loop_start()
        next_due = next_status = time.monotonic()
        while not runtime.stopped:
            if not connected.wait(timeout=15):
                raise TimeoutError("Khong ket noi duoc broker trong 15 giay.")
            runtime.next_timestamp = timestamp.isoformat()
            for _ in range(100):
                try:
                    command = commands.get_nowait()
                except queue.Empty:
                    break
                ack, first = runtime.apply(command)
                if first:
                    command_log.write(json.dumps({
                        "effective_from_sequence": runtime.completed_steps,
                        "received_at": datetime.now(timezone.utc).isoformat(),
                        "command": command, "ack": ack,
                    }, ensure_ascii=False, allow_nan=False) + "\n")
                    command_log.flush()
                publish(ack_topic, ack)
                next_status = 0
                if ack["ok"] and command.get("action") in ("resume", "interval"):
                    next_due = time.monotonic()
            now = time.monotonic()
            if now >= next_status:
                publish(STATE_TOPIC, runtime.snapshot())
                next_status = time.monotonic() + 1
            if runtime.stopped:
                break
            if runtime.paused or now < next_due:
                time.sleep(0.05)
                continue
            sequence = runtime.completed_steps
            for reading in model.generate(timestamp, sim["step_seconds"], run_id, sequence):
                publish(f"solar/{reading['household_id']}/telemetry", reading)
                runtime.sent_messages += 1
                if not args.quiet:
                    print(f"SENT {reading['timestamp']} {reading['household_id']} solar={reading['solar_power_kw']:.3f}kW load={reading['load_power_kw']:.3f}kW net={reading['net_power_kw']:+.3f}kW", flush=True)
            runtime.last_timestamp = timestamp.isoformat()
            runtime.completed_steps += 1
            timestamp += timedelta(seconds=sim["step_seconds"])
            runtime.next_timestamp = timestamp.isoformat()
            if args.steps and runtime.completed_steps >= args.steps:
                break
            next_due = time.monotonic() + runtime.interval
        print(f"DONE: {runtime.completed_steps} khoang do, {runtime.sent_messages} ban tin.", flush=True)
    except KeyboardInterrupt:
        print("\nDa dung simulator.", flush=True)
    except (OSError, RuntimeError, ValueError) as error:
        status, exit_code = "error", 1
        print(f"ERROR: {error}", file=sys.stderr, flush=True)
    finally:
        runtime.stopped = True
        if client.is_connected():
            try:
                publish(STATE_TOPIC, runtime.snapshot(status), timeout=2)
            except (OSError, RuntimeError, ValueError):
                pass
        client.disconnect()
        client.loop_stop()
        if command_log is not None:
            command_log.close()
        try:
            with (args.run_dir / f"{run_id}.summary.json").open("w", encoding="utf-8") as file:
                json.dump(runtime.snapshot(status), file, ensure_ascii=False, indent=2)
        except OSError as error:
            print(f"WARNING: Khong ghi duoc summary: {error}", file=sys.stderr)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
