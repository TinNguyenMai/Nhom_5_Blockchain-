"""Validate the Phase 1 wire contract; no TensorFlow dependency."""
from datetime import datetime, timedelta
import json
import math
import re

from iot_code.config import no_duplicate_keys, reject_constant
from iot_code.model import FIELDS, validate_reading
from iot_code.edge_monitor import PRED_FIELDS, validate_prediction

RUN = re.compile(r"[0-9a-f]{32}\Z")
DEVICE = re.compile(r"esp32-[0-9a-f]{12}\Z")


def decode(raw: bytes):
    if len(raw) > 16384:
        raise ValueError("Payload larger than 16 KiB")
    value = json.loads(raw.decode("utf-8"), object_pairs_hook=no_duplicate_keys,
                       parse_constant=reject_constant)
    if not isinstance(value, dict):
        raise ValueError("Expected JSON object")
    return value


def run_id(value):
    if not isinstance(value, str) or not RUN.fullmatch(value):
        raise ValueError("run_id must be 32 lower-case hexadecimal characters")
    return value


def stamp(value):
    if not isinstance(value, str):
        raise ValueError("Timestamp must be a string")
    dt = datetime.fromisoformat(value)
    if dt.utcoffset() != timedelta(hours=7) or dt.microsecond or dt.second or dt.minute % 5:
        raise ValueError("Simulation timestamp must align to 5-minute boundaries in +07:00")
    return dt.isoformat()


def identity(p, event_key):
    run_id(p["run_id"])
    event = p[event_key]
    prefix = f'{p["run_id"]}:{p["household_id"]}:'
    if not isinstance(event, str) or not event.startswith(prefix):
        raise ValueError("Event identity does not match run/house")
    tail = event[len(prefix):]
    if not tail.isascii() or not tail.isdigit() or len(tail) > 10 or str(int(tail)) != tail:
        raise ValueError("Invalid event sequence")
    return int(tail)


def telemetry(p, topic, homes):
    validate_reading(p, topic, homes)
    identity(p, "event_id")
    if type(p["interval_seconds"]) is not int or p["interval_seconds"] != 300:
        raise ValueError("Phase 2 currently requires 300-second intervals")
    for key in ("solar_power_kw", "load_power_kw"):
        if p[key] > 1000:
            raise ValueError("Power outside demo bounds")
    result = {key: p[key] for key in FIELDS}
    result["timestamp"] = stamp(p["timestamp"])
    if 'time_mode' in p or 'sampling_seconds' in p:
        # Accelerated time carries either generated samples or 5-second INA219 averages.
        if p.get('data_mode') not in ('simulation', 'real') or p.get('time_mode') != 'accelerated' or type(p.get('sampling_seconds')) is not int or p['sampling_seconds'] != 5:
            raise ValueError('Invalid accelerated telemetry timing')
        result.update(time_mode='accelerated', sampling_seconds=5)
    if "data_mode" in p:
        if p["data_mode"] not in ("real", "simulation"):
            raise ValueError("data_mode must be real or simulation")
        scenario = p.get("demo_scenario")
        allowed = ("sell", "buy", "hold") if p["data_mode"] == "simulation" else ("none",)
        if scenario not in allowed:
            raise ValueError("demo_scenario does not match data_mode")
        electrical = ("solar_voltage_v", "solar_current_a", "load_voltage_v", "load_current_a")
        if any(key not in p for key in electrical):
            raise ValueError("Voltage/current fields must be provided together")
        for key in electrical:
            value = p[key]
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
                raise ValueError(f"Invalid {key}")
        if max(p["solar_voltage_v"], p["load_voltage_v"]) > 1000 or max(p["solar_current_a"], p["load_current_a"]) > 10000:
            raise ValueError("Voltage/current outside demo bounds")
        result.update({"data_mode": p["data_mode"], "demo_scenario": scenario,
                       **{key: p[key] for key in electrical}})
    if "temperature_source" in p or "temperature_valid" in p:
        source = p.get("temperature_source")
        # Earlier Edge firmware labelled its numeric placeholder unavailable
        # before adding the explicit validity flag. Keep accepting that format.
        valid = p.get("temperature_valid", False if source == "unavailable" else None)
        if source not in ("ds18b20", "simulation", "unavailable") or type(valid) is not bool:
            raise ValueError("Invalid temperature provenance")
        if valid != (source != "unavailable"):
            raise ValueError("Temperature validity/source mismatch")
        if source == "simulation" and p.get("data_mode") != "simulation":
            raise ValueError("Simulated temperature must use simulation mode")
        if source == "ds18b20" and (p.get("data_mode") != "real" or not -55 <= p["temperature_c"] <= 125):
            raise ValueError("Invalid DS18B20 measurement/mode")
        if not valid and p["temperature_c"] != 0:
            raise ValueError("Unavailable temperature must use the schema-v1 placeholder")
        result.update(temperature_source=source, temperature_valid=valid)
        if "temperature_samples" in p:
            count = p["temperature_samples"]
            if type(count) is not int or count < 0 or valid != (count > 0):
                raise ValueError("Invalid temperature sample count")
            result["temperature_samples"] = count
    return result


def prediction(p, device_id=None):
    validate_prediction(p)
    identity(p, "input_event_id")
    if type(p["schema_version"]) is not int or type(p["interval_seconds"]) is not int:
        raise ValueError("Schema and interval must be integers")
    if p["device_kind"] != "esp32":
        raise ValueError("Phase 2 only accepts esp32 prediction messages")
    if not DEVICE.fullmatch(p["device_id"]) or (device_id and p["device_id"] != device_id):
        raise ValueError("Unexpected device_id")
    for key in ("arena_used_bytes", "free_heap_bytes", "clipped_features", "model_bytes"):
        if type(p.get(key)) is not int or not 0 <= p[key] <= 2**32:
            raise ValueError(f"Invalid {key}")
    if max(p["predicted_solar_kw"], p["predicted_load_kw"]) > 1000:
        raise ValueError("Forecast outside demo bounds")
    fields = [key for key in PRED_FIELDS if key not in ("received_at", "late")]
    result = {key: p[key] for key in fields}
    result["input_timestamp"] = stamp(p["input_timestamp"])
    result["target_timestamp"] = stamp(p["target_timestamp"])
    if "data_mode" in p:
        if p["data_mode"] not in ("real", "simulation"):
            raise ValueError("Invalid prediction data_mode")
        if type(p.get("history_samples")) is not int or p["history_samples"] != 12:
            raise ValueError("Edge prediction requires 12 history samples")
        result.update(data_mode=p["data_mode"], history_samples=p["history_samples"])
    if 'time_mode' in p or 'sampling_seconds' in p:
        allowed = [('accelerated', 5)] if p.get('data_mode') == 'simulation' else [('realtime', 300), ('accelerated', 5)]
        if (p.get('time_mode'), p.get('sampling_seconds')) not in allowed or type(p.get('sampling_seconds')) is not int:
            raise ValueError('Invalid Edge AI prediction timing')
        result.update(time_mode=p['time_mode'], sampling_seconds=p['sampling_seconds'])
    return result


def simulator_state(p):
    run_id(p.get("run_id"))
    if p.get("status") not in ("running", "paused", "stopped", "offline", "error"):
        raise ValueError("Unknown simulator status")
    return {"run_id": p["run_id"], "status": p["status"]}


def actuator_ack(p):
    required = ("schema_version", "household_id", "run_id", "round_id", "action",
                "relay1_on", "relay2_on", "state")
    if not isinstance(p, dict) or any(key not in p for key in required):
        raise ValueError("Invalid actuator acknowledgement")
    if p["schema_version"] != 1 or p["household_id"] != "home_01":
        raise ValueError("Unsupported actuator acknowledgement")
    run_id(p["run_id"])
    if type(p["round_id"]) is not int or p["round_id"] < 1:
        raise ValueError("Invalid actuator round")
    if p["action"] not in ("sell", "buy", "off") or p["state"] not in ("applied", "timeout"):
        raise ValueError("Invalid actuator state")
    if type(p["relay1_on"]) is not bool or type(p["relay2_on"]) is not bool:
        raise ValueError("Invalid relay state")
    return {key: p[key] for key in required}
