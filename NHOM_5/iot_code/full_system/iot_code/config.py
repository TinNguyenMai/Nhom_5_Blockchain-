"""Validated, shared configuration for simulator and collector."""
import copy
import json
import math
from pathlib import Path
import re

DEFAULT_CONFIG = Path(__file__).resolve().parent.parent / "config" / "homes.json"
HOME_ID = re.compile(r"[A-Za-z][A-Za-z0-9_-]{0,31}\Z")
WEATHER = {"auto", "sunny", "cloudy", "rainy"}


def number(value, name, minimum, maximum):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not minimum <= value <= maximum:
        raise ValueError(f"{name}: can so trong [{minimum}, {maximum}].")
    return value


def no_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Trung khoa JSON: {key}")
        result[key] = value
    return result


def reject_constant(value):
    raise ValueError(f"JSON khong cho phep {value}.")


def validate_config(raw):
    from .model import parse_start
    cfg = copy.deepcopy(raw)
    if not isinstance(cfg, dict) or set(cfg) != {"config_version", "simulation", "homes"}:
        raise ValueError("Config can config_version, simulation, homes.")
    if type(cfg["config_version"]) is not int or cfg["config_version"] != 1:
        raise ValueError("config_version phai bang 1.")
    sim = cfg["simulation"]
    required = {"start", "step_seconds", "publish_interval_seconds", "seed", "weather"}
    if not isinstance(sim, dict) or set(sim) != required:
        raise ValueError(f"simulation can cac truong: {sorted(required)}")
    if not isinstance(sim["start"], str):
        raise ValueError("start phai la thoi gian ISO 8601 co mui gio.")
    sim["start"] = parse_start(sim["start"]).isoformat()
    if type(sim["step_seconds"]) is not int:
        raise ValueError("step_seconds phai la so nguyen.")
    number(sim["step_seconds"], "step_seconds", 1, 300)
    number(sim["publish_interval_seconds"], "publish_interval_seconds", 0, 60)
    if type(sim["seed"]) is not int:
        raise ValueError("seed phai la so nguyen.")
    if not isinstance(sim["weather"], str) or sim["weather"] not in WEATHER:
        raise ValueError("weather: auto, sunny, cloudy hoac rainy.")
    homes = cfg["homes"]
    if not isinstance(homes, list) or not 1 <= len(homes) <= 100:
        raise ValueError("Can tu 1 den 100 ho.")
    seen = set()
    for home in homes:
        if not isinstance(home, dict) or set(home) != {"id", "name", "pv_kw", "base_load_kw", "pv_enabled", "load_multiplier"}:
            raise ValueError("Moi ho can id, name, pv_kw, base_load_kw, pv_enabled, load_multiplier.")
        if not isinstance(home["id"], str) or not HOME_ID.fullmatch(home["id"]) or home["id"] in seen:
            raise ValueError("ID ho sai dinh dang hoac bi trung.")
        seen.add(home["id"])
        if not isinstance(home["name"], str) or not home["name"].strip() or len(home["name"]) > 60:
            raise ValueError("name can 1..60 ky tu.")
        number(home["pv_kw"], "pv_kw", 0, 100)
        number(home["base_load_kw"], "base_load_kw", 0.01, 20)
        number(home["load_multiplier"], "load_multiplier", 0.1, 5)
        if type(home["pv_enabled"]) is not bool:
            raise ValueError("pv_enabled phai la true hoac false.")
    return cfg


def load_config(path=DEFAULT_CONFIG):
    with Path(path).open(encoding="utf-8-sig") as stream:
        return validate_config(json.load(stream, object_pairs_hook=no_duplicate_keys, parse_constant=reject_constant))


def homes_dict(cfg):
    return {home["id"]: {key: value for key, value in home.items() if key != "id"} for home in cfg["homes"]}
