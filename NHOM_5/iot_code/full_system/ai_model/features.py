"""Feature contract v1, mirrored by iot_code/firmware/esp32_edge/main/solar_features.h.

Only completed measurements enter the history. The target timestamp is the
start of the next 300-second simulated interval, in the dataset's +07 timezone.
"""
from collections import deque
from datetime import datetime, timedelta
import math

WINDOW = 12
STEP = 300
FIELDS = ("solar_power_kw", "load_power_kw", "irradiance_w_m2", "cloud_cover")
SCALES = (4.0, 2.0, 1000.0, 1.0)  # Fixed physical units, no fit on held-out data.
N_FEATURES = WINDOW * len(FIELDS) + 5
HOUSE = "home_01"


def parse_time(value):
    stamp = datetime.fromisoformat(value)
    if stamp.utcoffset() != timedelta(hours=7) or stamp.microsecond:
        raise ValueError("Edge v1 requires second-resolution timestamps in +07:00")
    return stamp


def validate_reading(row):
    if not isinstance(row, dict):
        raise ValueError("Telemetry must be an object")
    if row.get("household_id") != HOUSE or int(row["interval_seconds"]) != STEP:
        raise ValueError("Edge v1 requires home_01 and 300-second intervals")
    if int(row["schema_version"]) != 1:
        raise ValueError("Unsupported telemetry schema")
    stamp = parse_time(row["timestamp"])
    run = row["run_id"]
    if len(run) != 32 or any(c not in "0123456789abcdef" for c in run):
        raise ValueError("Invalid run_id")
    prefix = f"{run}:{HOUSE}:"
    event = row["event_id"]
    if not event.startswith(prefix) or not event[len(prefix):].isdigit():
        raise ValueError("Invalid event_id")
    for key, maximum in zip(FIELDS, (100, 100, 1500, 1)):
        value = float(row[key])
        if not math.isfinite(value) or not 0 <= value <= maximum:
            raise ValueError(f"Invalid {key}")
    return stamp


def feature_vector(rows):
    if len(rows) != WINDOW:
        raise ValueError(f"Need exactly {WINDOW} readings")
    result = [float(row[key]) / scale for row in rows for key, scale in zip(FIELDS, SCALES)]
    target = parse_time(rows[-1]["timestamp"]) + timedelta(seconds=STEP)
    # Midpoint matches the simulator's average-power approximation.
    midpoint = target + timedelta(seconds=STEP / 2)
    angle = 2 * math.pi * (midpoint.hour * 3600 + midpoint.minute * 60 + midpoint.second) / 86400
    result.extend((math.sin(angle), math.cos(angle), math.sin(2 * angle), math.cos(2 * angle), float(midpoint.weekday() >= 5)))
    return result


class History:
    """Deduplicate QoS1, discard old samples, and reset on run changes/gaps."""
    def __init__(self):
        self.rows = deque(maxlen=WINDOW)
        self.retired_runs = set()

    def add(self, row):
        now = validate_reading(row)
        if row["run_id"] in self.retired_runs:
            return None
        if self.rows:
            last = self.rows[-1]
            if row["run_id"] != last["run_id"]:
                self.retired_runs.add(last["run_id"])
                self.rows.clear()
            else:
                previous = parse_time(last["timestamp"])
                sequence = int(row["event_id"].rsplit(":", 1)[1])
                last_sequence = int(last["event_id"].rsplit(":", 1)[1])
                if now <= previous or sequence <= last_sequence:
                    return None
                if (now - previous).total_seconds() != STEP or sequence != last_sequence + 1:
                    self.rows.clear()
        self.rows.append(row)
        return feature_vector(list(self.rows)) if len(self.rows) == WINDOW else None


def quantize(values, scale, zero):
    """Nearest integer, ties away from zero, same as C++ std::round."""
    import numpy as np
    value = np.asarray(values, dtype=np.float32) / np.float32(scale)
    rounded = np.sign(value) * np.floor(np.abs(value) + np.float32(.5))
    return np.clip(rounded + zero, -128, 127).astype(np.int8)


def postprocess(residual, last, output_scale):
    return [max(0.0, float(last[key]) + float(delta) * float(scale))
            for key, delta, scale in zip(FIELDS[:2], residual, output_scale)]
