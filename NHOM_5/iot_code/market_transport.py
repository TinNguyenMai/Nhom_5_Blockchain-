"""Paho MQTT bridge over JSON lines for Node, with application validation/history."""
import argparse
import json
import queue
import sys
import threading
import time
import paho.mqtt.client as mqtt
from backend.market_storage import MarketStore
from backend.market_validation import market_message


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--run", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--db")
    parser.add_argument("--client-id", required=True)
    args = parser.parse_args()
    with open(args.manifest, encoding="utf-8") as f:
        manifest = json.load(f)
    lock = threading.Lock()
    ready = threading.Event()
    inbox = queue.Queue()
    store = MarketStore(args.db) if args.db else None
    def emit(value):
        with lock:
            # IPC is ASCII-safe on Windows pipes; JSON decoding restores Vietnamese labels.
            print(json.dumps(value, ensure_ascii=True), flush=True)
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=args.client_id,
                         protocol=mqtt.MQTTv311, clean_session=False)
    client.reconnect_delay_set(1, 3)
    def connect(c, u, flags, rc, properties):
        if rc.is_failure:
            emit({"type": "error", "error": str(rc)})
        else:
            c.subscribe("solar/#", qos=1)
    def subscribe(c, u, mid, codes, properties):
        if codes and all(not x.is_failure for x in codes):
            ready.set()
            emit({"type": "ready"})
    def receive(c, u, msg):
        inbox.put((msg.topic, msg.payload, msg.retain))
    client.on_connect = connect
    client.on_subscribe = subscribe
    client.on_message = receive
    def disconnect(c, u, flags, rc, properties):
        ready.clear()
        emit({"type": "disconnected"})
    client.on_disconnect = disconnect
    requests = queue.Queue()
    def stdin():
        for line in sys.stdin:
            try:
                requests.put(json.loads(line))
            except ValueError:
                emit({"type": "error", "error": "Invalid IPC JSON"})
        requests.put({"op": "stop"})
    threading.Thread(target=stdin, daemon=True).start()
    client.connect_async(args.host, args.port, keepalive=15)
    client.loop_start()
    try:
        running = True
        while running:
            try:
                request = requests.get(timeout=.02)
                if request.get("op") == "stop":
                    running = False
                elif request.get("op") == "publish":
                    if not ready.wait(15):
                        raise TimeoutError("MQTT not connected")
                    info = client.publish(request["topic"], json.dumps(request["payload"], ensure_ascii=False), qos=1, retain=False)
                    info.wait_for_publish(timeout=15)
                    if not info.is_published():
                        raise TimeoutError("MQTT PUBACK timed out")
                    emit({"type": "published", "id": request["id"]})
            except queue.Empty:
                pass
            except Exception as e:
                emit({"type": "publish_error", "id": request.get("id"), "error": str(e)})
            for _ in range(200):
                try:
                    topic, raw, retained = inbox.get_nowait()
                except queue.Empty:
                    break
                if retained:
                    continue
                try:
                    p = market_message(topic, raw, args.run, manifest["deployment_id"], manifest["households"])
                    result = store.store(topic, p) if store else "received"
                    emit({"type": "message", "topic": topic, "payload": p, "storage": result})
                except (ValueError, TypeError, KeyError) as e:
                    if store:
                        store.reject(topic, str(e))
                    emit({"type": "rejected", "topic": topic, "error": str(e)})
    finally:
        client.disconnect()
        client.loop_stop()
        if store:
            store.close()


if __name__ == "__main__":
    main()
