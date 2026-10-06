"""One MQTT connection per virtual household; it has no private key or RPC access."""
import json
import threading
import paho.mqtt.client as mqtt
from backend.validation import decode


class HouseholdAgent:
    def __init__(self, home, run_id, deployment_id, port, inbox):
        self.home = home
        self.run_id = run_id
        self.deployment_id = deployment_id
        self.ready = threading.Event()
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2,
            client_id=f"home-sim-{run_id[:12]}-{home['id']}", protocol=mqtt.MQTTv311, clean_session=False)
        self.client.reconnect_delay_set(1, 3)
        def connect(c, u, flags, rc, props):
            if not rc.is_failure:
                c.subscribe(f"solar/{home['id']}/simulation/request", qos=1)
        def subscribed(c, u, mid, codes, props):
            if codes and all(not x.is_failure for x in codes):
                self.ready.set()
        def message(c, u, msg):
            if msg.retain or len(msg.payload) > 16384:
                return
            try:
                p = decode(msg.payload)
                if p.get("run_id") == run_id and p.get("deployment_id") == deployment_id and p.get("household_id") == home["id"]:
                    inbox.put((home["id"], p))
            except (ValueError, TypeError):
                pass
        self.client.on_connect = connect
        self.client.on_subscribe = subscribed
        self.client.on_message = message
        self.client.on_disconnect = lambda *a: self.ready.clear()
        self.client.connect_async("127.0.0.1", port, keepalive=15)
        self.client.loop_start()

    def publish(self, topic, p):
        if not self.ready.wait(15):
            raise TimeoutError(f"Household {self.home['id']} MQTT unavailable")
        info = self.client.publish(topic, json.dumps(p, ensure_ascii=False, allow_nan=False), qos=1, retain=False)
        info.wait_for_publish(timeout=15)
        if not info.is_published():
            raise TimeoutError("Household publish not acknowledged")

    def close(self):
        self.client.disconnect()
        self.client.loop_stop()
