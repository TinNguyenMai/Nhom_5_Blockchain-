"""Synthetic demo model. All power values represent approximate interval means."""

import math
import random
import copy
from datetime import datetime, timedelta, timezone

VIETNAM_TZ = timezone(timedelta(hours=7))
HOMES = {
    "home_01": {"pv_kw": 4.0, "base_load_kw": 0.65},
    "home_02": {"pv_kw": 2.5, "base_load_kw": 1.10},
    "home_03": {"pv_kw": 0.0, "base_load_kw": 1.00},
}
FIELDS = [
    "schema_version", "event_id", "run_id", "household_id", "timestamp",
    "published_at", "interval_seconds", "irradiance_w_m2", "temperature_c",
    "cloud_cover", "solar_power_kw", "load_power_kw", "net_power_kw",
    "solar_energy_kwh", "load_energy_kwh", "surplus_energy_kwh",
    "deficit_energy_kwh",
]


def parse_start(value):
    timestamp = datetime.fromisoformat(value)
    if timestamp.tzinfo is None or timestamp.utcoffset() is None:
        raise ValueError("Thoi gian phai co mui gio, vi du +07:00.")
    return timestamp.astimezone(VIETNAM_TZ)


class SolarModel:
    def __init__(self, seed=42, homes=None, weather="auto"):
        self.rng = random.Random(seed)
        self.cloud_cover = 0.25
        self.homes = copy.deepcopy(HOMES if homes is None else homes)
        self.weather = weather

    def generate(self, timestamp, step_seconds, run_id, sequence):
        """One shared weather sample and one reading per home per interval."""
        # Midpoint approximation of average power for this simulated interval.
        middle = (timestamp + timedelta(seconds=step_seconds / 2)).astimezone(VIETNAM_TZ)
        hour = middle.hour + middle.minute / 60 + middle.second / 3600
        daylight = max(0.0, math.sin(math.pi * (hour - 6) / 12)) if 6 < hour < 18 else 0.0
        self.cloud_cover = min(1.0, max(0.0, 0.95 * self.cloud_cover + 0.05 * self.rng.random() + self.rng.gauss(0, 0.04)))
        if self.weather != "auto":
            self.cloud_cover = {"sunny": 0.05, "cloudy": 0.65, "rainy": 0.95}[self.weather]
        irradiance = round(1000 * daylight * (1 - 0.75 * self.cloud_cover), 2)
        temperature = round(28 + 5 * math.sin(2 * math.pi * (hour - 8) / 24) + self.rng.gauss(0, 0.3), 2)
        morning_peak = math.exp(-((hour - 7) / 1.5) ** 2)
        evening_peak = math.exp(-((hour - 19) / 2.0) ** 2)
        weekend = 1.1 if middle.weekday() >= 5 else 1.0

        for home_id, settings in self.homes.items():
            solar_kw = round(settings["pv_kw"] * irradiance / 1000 * 0.85, 4) if settings.get("pv_enabled", True) else 0.0
            load_kw = round(max(0.0001, settings["base_load_kw"] * (1 + 0.9 * morning_peak + 1.6 * evening_peak) * weekend * self.rng.uniform(0.92, 1.08) * settings.get("load_multiplier", 1.0)), 4)
            solar_kwh = round(solar_kw * step_seconds / 3600, 6)
            load_kwh = round(load_kw * step_seconds / 3600, 6)
            yield {
                "schema_version": 1,
                "event_id": f"{run_id}:{home_id}:{sequence}",
                "run_id": run_id,
                "household_id": home_id,
                "timestamp": timestamp.astimezone(VIETNAM_TZ).isoformat(),
                "published_at": datetime.now(timezone.utc).isoformat(),
                "interval_seconds": step_seconds,
                "irradiance_w_m2": irradiance,
                "temperature_c": temperature,
                "cloud_cover": round(self.cloud_cover, 4),
                "solar_power_kw": solar_kw,
                "load_power_kw": load_kw,
                "net_power_kw": round(solar_kw - load_kw, 4),
                "solar_energy_kwh": solar_kwh,
                "load_energy_kwh": load_kwh,
                "surplus_energy_kwh": round(max(solar_kwh - load_kwh, 0), 6),
                "deficit_energy_kwh": round(max(load_kwh - solar_kwh, 0), 6),
            }


def validate_reading(data, topic, home_ids=None):
    if not isinstance(data, dict) or any(field not in data for field in FIELDS):
        raise ValueError("Thieu truong du lieu hoac JSON khong phai object.")
    if type(data["schema_version"]) is not int or data["schema_version"] != 1:
        raise ValueError("Sai schema_version.")
    for field in ("event_id", "run_id", "household_id"):
        if not isinstance(data[field], str) or not data[field]:
            raise ValueError(f"{field} phai la chuoi khong rong.")
    if data["household_id"] not in (HOMES if home_ids is None else home_ids):
        raise ValueError("household_id khong nam trong cau hinh demo.")
    if topic != f"solar/{data['household_id']}/telemetry":
        raise ValueError("household_id khong khop topic.")
    prefix = f"{data['run_id']}:{data['household_id']}:"
    if not data["event_id"].startswith(prefix) or not data["event_id"][len(prefix):].isdigit():
        raise ValueError("event_id khong hop le.")
    for field in ("timestamp", "published_at"):
        if not isinstance(data[field], str):
            raise ValueError(f"{field} phai la ISO 8601 string.")
        parse_start(data[field])
    for field in FIELDS[6:]:
        value = data[field]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(f"{field} phai la so huu han.")
    if not 0 < data["interval_seconds"] <= 300:
        raise ValueError("interval_seconds phai trong (0, 300].")
    if not 0 <= data["cloud_cover"] <= 1 or data["irradiance_w_m2"] < 0:
        raise ValueError("Du lieu thoi tiet ngoai pham vi.")
    for field in ("solar_power_kw", "load_power_kw", "solar_energy_kwh", "load_energy_kwh", "surplus_energy_kwh", "deficit_energy_kwh"):
        if data[field] < 0:
            raise ValueError(f"{field} khong duoc am.")
    expected = {
        "net_power_kw": data["solar_power_kw"] - data["load_power_kw"],
        "solar_energy_kwh": data["solar_power_kw"] * data["interval_seconds"] / 3600,
        "load_energy_kwh": data["load_power_kw"] * data["interval_seconds"] / 3600,
        "surplus_energy_kwh": max(data["solar_energy_kwh"] - data["load_energy_kwh"], 0),
        "deficit_energy_kwh": max(data["load_energy_kwh"] - data["solar_energy_kwh"], 0),
    }
    for field, value in expected.items():
        if not math.isclose(data[field], value, rel_tol=0, abs_tol=0.000002):
            raise ValueError(f"{field} khong khop cong thuc.")
