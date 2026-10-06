"""MQTT pipeline testing on PC. Output is explicitly labelled pc_reference."""
import argparse
import json
import queue
import sys
import uuid
import paho.mqtt.client as mqtt
from .features import History
from .predictor import Predictor


def main():
    parser = argparse.ArgumentParser(description="PC reference, not proof of ESP32 inference")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=1884)
    args = parser.parse_args()
    predictor = Predictor()
    messages = queue.Queue(maxsize=1000)
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="reference-" + uuid.uuid4().hex[:8])
    fatal = []

    def on_connect(client, userdata, flags, reason, properties):
        if reason != 0:
            fatal.append(f"MQTT rejected {reason}"); return
        messages.put_nowait(None)
        client.subscribe("solar/home_01/telemetry", qos=1)

    def on_subscribe(client, userdata, mid, reasons, properties):
        if any(code.is_failure for code in reasons):
            fatal.append("Subscription rejected")
        else:
            print("READY pc_reference (CPU, not ESP32)", flush=True)

    def on_message(client, userdata, message):
        if message.retain or len(message.payload) > 2048:
            return
        try:
            messages.put_nowait(json.loads(message.payload))
        except (ValueError, queue.Full):
            fatal.append("Invalid message or queue full; slow the simulator")

    client.on_connect, client.on_subscribe, client.on_message = on_connect, on_subscribe, on_message
    try:
        client.connect(args.host, args.port)
        client.loop_start()
        while not fatal:
            try:
                row = messages.get(timeout=.2)
            except queue.Empty:
                continue
            if row is None:
                predictor.history = History()
                continue
            try:
                prediction = predictor.add(row)
            except (ValueError, KeyError, TypeError) as error:
                print(f"SKIP {error}", flush=True); continue
            if prediction:
                info = client.publish("solar/home_01/prediction", json.dumps(prediction, allow_nan=False), qos=1, retain=False)
                info.wait_for_publish(timeout=5)
                if not info.is_published():
                    raise TimeoutError("MQTT publish not acknowledged")
    except KeyboardInterrupt:
        pass
    except (OSError, RuntimeError) as error:
        fatal.append(str(error))
    finally:
        client.disconnect(); client.loop_stop()
    if fatal:
        print(f"ERROR: {fatal[-1]}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
