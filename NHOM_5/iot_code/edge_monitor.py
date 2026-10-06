"""Watch actual ESP32 forecasts, join later telemetry and save auditable logs.

Only paho-mqtt is required; training/TensorFlow is NOT needed on the demo PC.
Default: accept physical esp32 messages only. --allow-pc-reference is for tests.
"""
import argparse
from collections import OrderedDict
import csv
from datetime import datetime, timezone, timedelta
import json
import math
from pathlib import Path
import queue
import sys
import uuid
import paho.mqtt.client as mqtt
from ai_model.features import HOUSE, STEP, parse_time, validate_reading

PRED_FIELDS = ["received_at", "schema_version", "household_id", "run_id", "input_event_id", "input_timestamp", "target_timestamp", "interval_seconds", "model_version", "device_kind", "device_id", "predicted_solar_kw", "predicted_load_kw", "predicted_net_kw", "predicted_surplus_kwh", "inference_us", "arena_used_bytes", "free_heap_bytes", "clipped_features", "model_bytes", "late"]
SCORE_FIELDS = PRED_FIELDS + ["actual_event_id", "actual_solar_kw", "actual_load_kw", "solar_error_kw", "load_error_kw", "persistence_solar_error_kw", "persistence_load_error_kw"]


def validate_prediction(p):
    if not isinstance(p, dict) or p.get("schema_version") != 1 or p.get("household_id") != HOUSE or p.get("interval_seconds") != STEP:
        raise ValueError("Unsupported prediction")
    if p.get("device_kind") not in ("esp32", "pc_reference"):
        raise ValueError("Missing device kind")
    for name in ("device_id", "model_version", "run_id", "input_event_id"):
        if not isinstance(p.get(name), str) or not 1 <= len(p[name]) <= 120:
            raise ValueError(f"Invalid {name}")
    if len(p["run_id"]) != 32 or any(c not in "0123456789abcdef" for c in p["run_id"]):
        raise ValueError("Invalid run ID")
    prefix = f'{p["run_id"]}:{HOUSE}:'
    if not p["input_event_id"].startswith(prefix) or not p["input_event_id"][len(prefix):].isdigit():
        raise ValueError("Invalid input event")
    if parse_time(p["target_timestamp"]) - parse_time(p["input_timestamp"]) != timedelta(seconds=STEP):
        raise ValueError("Target must be exactly 5 simulated minutes after input")
    for name in ("predicted_solar_kw", "predicted_load_kw", "predicted_net_kw", "predicted_surplus_kwh", "inference_us"):
        value = p.get(name)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(f"Invalid {name}")
        if name != "predicted_net_kw" and value < 0:
            raise ValueError(f"Negative {name}")
    net = p["predicted_solar_kw"] - p["predicted_load_kw"]
    if abs(net - p["predicted_net_kw"]) > .00001 or abs(max(0, net) / 12 - p["predicted_surplus_kwh"]) > .00001:
        raise ValueError("Inconsistent power/energy")


class Scoreboard:
    def __init__(self, directory, allow_pc=False):
        self.allow_pc = allow_pc
        directory.mkdir(parents=True, exist_ok=False) # New folder; never overwrite old data.
        self.directory = directory
        self.actual = OrderedDict()
        self.pending = OrderedDict()
        self.seen = set()
        self.latest_prediction = None
        self.latest_score = None
        self.stats = {}
        self.accepted = self.late = self.expired = 0
        self.streams = []
        for filename, fields in (("predictions.csv", PRED_FIELDS), ("scores.csv", SCORE_FIELDS)):
            stream = (directory / filename).open("x", encoding="utf-8", newline="")
            self.streams.append(stream)
            writer = csv.DictWriter(stream, fieldnames=fields, extrasaction="ignore")
            writer.writeheader(); stream.flush()
            setattr(self, filename.split(".")[0], writer)

    def receive(self, topic, payload):
        if topic == "solar/home_01/telemetry":
            validate_reading(payload)
            key = (payload["run_id"], payload["timestamp"])
            if key in self.actual:
                return
            self.actual[key] = payload
            while len(self.actual) > 2000:
                self.actual.popitem(last=False)
            for identity, (prediction, last) in list(self.pending.items()):
                if (prediction["run_id"], prediction["target_timestamp"]) == key:
                    self._score(prediction, payload, last)
                    del self.pending[identity]
        elif topic == "solar/home_01/prediction":
            validate_prediction(payload)
            if payload["device_kind"] == "pc_reference" and not self.allow_pc:
                return
            identity = tuple(payload[k] for k in ("run_id", "target_timestamp", "model_version", "device_id"))
            if identity in self.seen:
                return
            self.seen.add(identity)
            key = (payload["run_id"], payload["target_timestamp"])
            p = {**payload, "received_at": datetime.now(timezone.utc).isoformat(), "late": key in self.actual}
            self.predictions.writerow(p); self.streams[0].flush()
            self.accepted += 1
            self.latest_prediction = p
            last = self.actual.get((p["run_id"], p["input_timestamp"]))
            if last and last["event_id"] != p["input_event_id"]:
                last = None
            if p["late"]:
                self.late += 1
                self._score(p, self.actual[key], last)
            else:
                self.pending[identity] = (p, last)
                while len(self.pending) > 2000:
                    self.pending.popitem(last=False); self.expired += 1

    def _score(self, p, actual, last):
        row = {**p, "actual_event_id": actual["event_id"]}
        group = f'{p["device_kind"]}/{p["device_id"]}/{p["model_version"]}'
        for name in ("solar", "load"):
            truth = float(actual[f"{name}_power_kw"])
            error = p[f"predicted_{name}_kw"] - truth
            row[f"actual_{name}_kw"] = truth
            row[f"{name}_error_kw"] = error
            baseline = float(last[f"{name}_power_kw"]) - truth if last else None
            row[f"persistence_{name}_error_kw"] = baseline
            if not p["late"]:
                for method, value in (("ai", error), ("persistence", baseline)):
                    if value is not None:
                        key = f"{group}/{method}/{name}"
                        s = self.stats.setdefault(key, {"count": 0, "abs_sum": 0., "squared_sum": 0.})
                        s["count"] += 1; s["abs_sum"] += abs(value); s["squared_sum"] += value * value
        self.scores.writerow(row); self.streams[1].flush()
        self.latest_score = row
        print(f'SCORED {p["device_kind"]} target={p["target_timestamp"]} solar_error={row["solar_error_kw"]:+.4f} load_error={row["load_error_kw"]:+.4f} late={p["late"]}', flush=True)

    def summary(self):
        return {"accepted_predictions": self.accepted, "late_excluded": self.late,
                "pending_without_actual": len(self.pending), "pending_evicted": self.expired,
                "metrics": {k: {"count": v["count"], "mae_kw": v["abs_sum"] / v["count"], "rmse_kw": math.sqrt(v["squared_sum"] / v["count"])} for k, v in self.stats.items()}}

    def close(self):
        for stream in self.streams:
            stream.close()
        (self.directory / "summary.json").write_text(json.dumps(self.summary(), indent=2), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description="ESP32: du bao 5 phut va doi chieu so do thuc te")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=1884)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--allow-pc-reference", action="store_true")
    args = parser.parse_args()
    directory = args.output_dir or Path("data") / ("edge_" + datetime.now().strftime("%Y%m%d_%H%M%S_") + uuid.uuid4().hex[:6])
    try:
        board = Scoreboard(directory, args.allow_pc_reference)
    except OSError as error:
        parser.error(f"Can thu muc moi: {error}")
    messages = queue.Queue(maxsize=4000)
    fatal = []
    status = ["Đang kết nối MQTT..."]
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="edge-monitor-" + uuid.uuid4().hex[:8])
    client.reconnect_delay_set(1, 5)

    def on_connect(client, userdata, flags, reason, properties):
        if reason != 0:
            fatal.append(f"MQTT rejected: {reason}"); return
        client.subscribe([("solar/home_01/telemetry", 1), ("solar/home_01/prediction", 1)])

    def on_subscribe(client, userdata, mid, reasons, properties):
        if any(code.is_failure for code in reasons):
            fatal.append("Subscription rejected")
        else:
            status[0] = "MQTT đã kết nối • ESP32 cần 12 số đo liên tục trước dự báo đầu tiên."
            print(f"READY edge_monitor -> {directory}", flush=True)

    def on_disconnect(client, userdata, flags, reason, properties):
        status[0] = "MQTT mất kết nối — đang thử kết nối lại."

    def on_message(client, userdata, message):
        if message.retain or len(message.payload) > 4096:
            return
        try:
            messages.put_nowait((message.topic, json.loads(message.payload)))
        except ValueError:
            print("SKIP invalid JSON", flush=True)
        except queue.Full:
            fatal.append("Monitor queue full; slow the simulator")

    def drain():
        for _ in range(500):
            try:
                topic, payload = messages.get_nowait()
            except queue.Empty:
                break
            try:
                board.receive(topic, payload)
            except (ValueError, TypeError, KeyError, OverflowError) as error:
                print(f"SKIP {error}", flush=True)

    client.on_connect, client.on_subscribe = on_connect, on_subscribe
    client.on_message, client.on_disconnect = on_message, on_disconnect
    root = None
    try:
        client.connect(args.host, args.port)
        client.loop_start()
        if args.headless:
            import time
            while not fatal:
                drain(); time.sleep(.02)
        else:
            import tkinter as tk
            from tkinter import ttk
            root = tk.Tk(); root.title("SOLAR LAB — ESP32 Edge AI | Nhà 1")
            root.geometry("960x530"); root.minsize(820, 500)
            frame = ttk.Frame(root, padding=22); frame.pack(fill="both", expand=True)
            ttk.Label(frame, text="ESP32 • DỰ BÁO 5 PHÚT TIẾP THEO", font=("Segoe UI", 18, "bold")).pack(anchor="w", pady=8)
            connection_label = ttk.Label(frame, text=status[0]); connection_label.pack(anchor="w", pady=8)
            prediction_label = ttk.Label(frame, text="Chưa có dự báo. Khởi động ESP32 rồi chạy simulator.", font=("Segoe UI", 12), justify="left")
            prediction_label.pack(anchor="w", pady=14)
            actual_label = ttk.Label(frame, text="Chờ số đo của khoảng dự báo để tính sai số.", font=("Segoe UI", 12), justify="left")
            actual_label.pack(anchor="w", pady=14)
            summary_label = ttk.Label(frame, text=""); summary_label.pack(anchor="w", pady=8)
            ttk.Label(frame, text=f"Nhật ký: {directory}\nDự báo đến sau số đo đích được đánh dấu late và loại khỏi thống kê.\nSai số so với số đo mô phỏng; chưa phải đo từ tấm pin/cảm biến thật.", justify="left", wraplength=880).pack(anchor="w", pady=12)

            def refresh():
                drain()
                connection_label.configure(text=("LỖI: " + fatal[-1]) if fatal else status[0])
                p, s = board.latest_prediction, board.latest_score
                if p:
                    prediction_label.configure(text=f'Nguồn: {p["device_kind"]} • {p["device_id"]}\nKhoảng dự báo: {p["target_timestamp"]}\nPhát {p["predicted_solar_kw"]:.3f} kW    Tải {p["predicted_load_kw"]:.3f} kW    Dư/thiếu {p["predicted_net_kw"]:+.3f} kW\nSuy luận {p["inference_us"]:.0f} µs • Tensor arena {p.get("arena_used_bytes")} byte • Feature bị chặn: {p.get("clipped_features", 0)}')
                if s:
                    actual_label.configure(text=f'Đối chiếu khoảng: {s["target_timestamp"]}\nThực tế mô phỏng: phát {s["actual_solar_kw"]:.3f} kW / tải {s["actual_load_kw"]:.3f} kW\nSai số dự báo − số đo: phát {s["solar_error_kw"]:+.3f} kW / tải {s["load_error_kw"]:+.3f} kW')
                summary_label.configure(text=f'Đã nhận {board.accepted} dự báo • Đến trễ {board.late} • Chờ đối chiếu {len(board.pending)}')
                if fatal:
                    return
                root.after(100, refresh)
            refresh(); root.mainloop()
    except KeyboardInterrupt:
        pass
    except (OSError, RuntimeError) as error:
        fatal.append(str(error))
    finally:
        client.disconnect(); client.loop_stop()
        drain(); board.close()
    if fatal:
        print(f"ERROR: {fatal[-1]}", file=sys.stderr); return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
