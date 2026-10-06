"""Commands are applied only between complete household batches."""
from collections import OrderedDict
import copy
from datetime import datetime, timezone
import time

from .config import WEATHER, number


class Runtime:
    def __init__(self, model, run_id, interval, paused=False, dataset=False):
        self.model, self.run_id, self.interval = model, run_id, interval
        self.paused, self.dataset = paused, dataset
        self.stopped = False
        self.completed_steps = 0
        self.sent_messages = 0
        self.last_timestamp = None
        self.next_timestamp = None
        self.handled = OrderedDict()

    def snapshot(self, status=None):
        return {
            "run_id": self.run_id,
            "status": status or ("stopped" if self.stopped else "paused" if self.paused else "running"),
            "sent_at": datetime.now(timezone.utc).isoformat(),
            "controls_enabled": not self.dataset,
            "publish_interval_seconds": self.interval,
            "weather": self.model.weather,
            "completed_steps": self.completed_steps,
            "sent_messages": self.sent_messages,
            "last_timestamp": self.last_timestamp,
            "next_timestamp": self.next_timestamp,
            "homes": copy.deepcopy(self.model.homes),
        }

    def apply(self, command):
        if not isinstance(command, dict):
            return {"request_id": None, "ok": False, "error": "Command phai la object."}, False
        request_id = command.get("request_id")
        if not isinstance(request_id, str) or not 1 <= len(request_id) <= 64:
            return {"request_id": None, "ok": False, "error": "request_id khong hop le."}, False
        if request_id in self.handled:
            return self.handled[request_id], False
        ack = {"request_id": request_id, "run_id": self.run_id, "ok": False}
        try:
            if command.get("run_id") != self.run_id:
                raise ValueError("Sai run_id.")
            issued_at = number(command.get("issued_at"), "issued_at", 0, 1e12)
            if not -2 <= time.time() - issued_at <= 10:
                raise ValueError("Lenh het han; gui lai lenh moi.")
            if self.dataset:
                raise ValueError("Che do dataset khoa dieu khien de bao toan kich ban.")
            action = command.get("action")
            if action == "pause":
                self.paused = True
            elif action == "resume":
                self.paused = False
            elif action == "stop":
                self.stopped = True
            elif action == "interval":
                self.interval = number(command.get("value"), "interval", 0.1, 60)
            elif action == "weather":
                value = command.get("value")
                if not isinstance(value, str) or value not in WEATHER:
                    raise ValueError("weather phai la auto/sunny/cloudy/rainy.")
                self.model.weather = value
            elif action == "home":
                home_id = command.get("household_id")
                if not isinstance(home_id, str) or home_id not in self.model.homes:
                    raise ValueError("Khong tim thay ho.")
                changes = command.get("changes")
                if not isinstance(changes, dict) or not changes or not set(changes) <= {"pv_enabled", "load_multiplier"}:
                    raise ValueError("Chi doi pv_enabled va load_multiplier.")
                if "pv_enabled" in changes and type(changes["pv_enabled"]) is not bool:
                    raise ValueError("pv_enabled can true/false.")
                if "load_multiplier" in changes:
                    number(changes["load_multiplier"], "load_multiplier", 0.1, 5)
                self.model.homes[home_id].update(changes)
            else:
                raise ValueError("Hanh dong khong hop le.")
            ack["ok"] = True
        except ValueError as error:
            ack["error"] = str(error)
        self.handled[request_id] = ack
        if len(self.handled) > 1000:
            self.handled.popitem(last=False)
        return ack, True
