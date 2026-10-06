import logging
import sqlite3
import threading
import uuid

import paho.mqtt.client as mqtt

from iot_code.config import homes_dict, load_config
from . import validation
from .storage import Store, now_iso

LOG = logging.getLogger("solar.backend")
TOPICS = [("solar/+/telemetry", 1), ("solar/home_01/prediction", 1),
          ("solar/home_01/actuator/status", 1), ("solar/simulator/state", 1)]


class Service:
    def __init__(self, settings):
        self.settings = settings
        self.homes = homes_dict(load_config(settings.homes_config))
        if "home_01" not in self.homes:
            raise ValueError("Phase 2 requires home_01 in the homes config")
        self.store = Store(settings)
        self.lock = threading.Lock()
        self.stats = {"connected": False, "subscribed": False, "stored": 0, "duplicates": 0,
                      "rejected": 0, "retained_ignored": 0, "storage_errors": 0,
                      "last_received_at": None, "last_error": None, "storage_ok": True,
                      "last_actuator_ack": None}
        self.client = None

    def update(self, **values):
        with self.lock:
            self.stats.update(values)

    def status(self):
        with self.lock:
            return {**self.stats, "enabled": self.settings.mqtt_enabled,
                    "host": self.settings.mqtt_host, "port": self.settings.mqtt_port}

    def ready(self):
        s = self.status()
        return s["connected"] and s["subscribed"] and s["storage_ok"]

    def ingest(self, topic, raw, retained=False):
        with self.lock:
            self.stats["last_received_at"] = now_iso()
        if retained:
            with self.lock:
                self.stats["retained_ignored"] += 1
            return "ignored"
        try:
            p = validation.decode(raw)
            if topic == "solar/home_01/prediction":
                kind, p = "prediction", validation.prediction(p, self.settings.device_id)
            elif topic == "solar/home_01/actuator/status":
                p = validation.actuator_ack(p)
                self.update(last_actuator_ack=p)
                return "stored"
            elif topic == "solar/simulator/state":
                kind, p = "state", validation.simulator_state(p)
            elif topic.startswith("solar/") and topic.endswith("/telemetry"):
                kind, p = "telemetry", validation.telemetry(p, topic, self.homes)
            else:
                raise ValueError("Unexpected topic")
            result = self.store.write(kind, p)
            with self.lock:
                self.stats["duplicates" if result == "duplicate" else "stored"] += 1
                self.stats["storage_ok"] = True
            if result == "stored" and kind == "prediction":
                LOG.info("PRED saved run=%s target=%s device=%s", p["run_id"], p["target_timestamp"], p["device_id"])
            return result
        except (ValueError, KeyError, TypeError, OverflowError, RecursionError, sqlite3.IntegrityError) as error:
            with self.lock:
                self.stats["rejected"] += 1
                self.stats["last_error"] = str(error)
            LOG.warning("REJECT %s: %s", topic, error)
            return "rejected"
        except sqlite3.Error as error:
            with self.lock:
                self.stats["storage_errors"] += 1
                self.stats["storage_ok"] = False
                self.stats["last_error"] = "SQLite error: " + str(error)
            LOG.exception("SQLite write failed")
            return "storage_error"

    def publish_demo_actuator(self, action, round_id, duration_seconds):
        if not self.ready() or self.client is None:
            raise RuntimeError("MQTT backend is not ready")
        if action not in ("sell", "buy") or type(round_id) is not int or round_id < 1 or \
                type(duration_seconds) is not int or not 1 <= duration_seconds <= 60:
            raise ValueError("Invalid actuator command")
        command = f"settled:{action}:{round_id}:{duration_seconds}"
        info = self.client.publish("solar/home_01/actuator", command, qos=1, retain=False)
        if info.rc != mqtt.MQTT_ERR_SUCCESS:
            raise RuntimeError("MQTT actuator publish failed")
        info.wait_for_publish(timeout=5)
        if not info.is_published():
            raise RuntimeError("MQTT actuator publish was not acknowledged by broker")
        return {"topic": "solar/home_01/actuator", "command": command, "qos": 1, "retain": False}

    def start(self):
        if not self.settings.mqtt_enabled:
            return
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="phase2-" + uuid.uuid4().hex[:12],
                             protocol=mqtt.MQTTv311, manual_ack=True)
        self.client = client
        client.reconnect_delay_set(min_delay=1, max_delay=10)

        def on_connect(c, userdata, flags, reason, properties):
            self.update(connected=not reason.is_failure, subscribed=False)
            if reason.is_failure:
                self.update(last_error=f"MQTT rejected: {reason}")
            else:
                rc, _ = c.subscribe(TOPICS)
                if rc != mqtt.MQTT_ERR_SUCCESS:
                    self.update(last_error="MQTT subscribe request failed")

        def on_subscribe(c, userdata, mid, reasons, properties):
            ok = bool(reasons) and all(not reason.is_failure for reason in reasons)
            self.update(subscribed=ok)
            if ok:
                LOG.info("READY backend MQTT %s:%s", self.settings.mqtt_host, self.settings.mqtt_port)
            else:
                self.update(last_error="Broker rejected subscription")

        def on_message(c, userdata, msg):
            result = self.ingest(msg.topic, msg.payload, msg.retain)
            # Only acknowledge stored/duplicate/invalid messages. A disk failure
            # remains visible through /ready (503) and is not acknowledged.
            if msg.qos and result != "storage_error":
                c.ack(msg.mid, msg.qos)

        client.on_connect = on_connect
        client.on_subscribe = on_subscribe
        client.on_message = on_message
        client.on_disconnect = lambda c, u, f, r, p: self.update(connected=False, subscribed=False)
        client.on_connect_fail = lambda c, u: self.update(connected=False, subscribed=False, last_error="Broker unavailable; retrying")
        client.connect_async(self.settings.mqtt_host, self.settings.mqtt_port, keepalive=30)
        client.loop_start()

    def stop(self):
        if self.client:
            self.client.disconnect()
            self.client.loop_stop()
        self.update(connected=False, subscribed=False)
        self.store.checkpoint()
