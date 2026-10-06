"""Wire validation for the hardware-free simulation; separate from ESP32 data."""
import re
from .validation import decode, telemetry


def market_message(topic, raw, run_id, deployment_id, homes):
    p = decode(raw)
    if p.get("run_id") != run_id or p.get("deployment_id") != deployment_id:
        raise ValueError("Message belongs to another simulation/deployment")
    if type(p.get("schema_version")) is not int or p["schema_version"] != 1 or not isinstance(p.get("message_id"), str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", p["message_id"]):
        raise ValueError("Invalid message identity")
    if not topic.startswith("solar/") or len(topic) > 200:
        raise ValueError("Invalid topic")
    house = p.get("household_id")
    if house not in homes and house != "coordinator":
        raise ValueError("Unknown household")
    parts = topic.split("/")
    if len(parts) > 2 and parts[1] in homes and house != parts[1]:
        raise ValueError("Topic household mismatch")
    if topic.endswith("/telemetry"):
        telemetry(p, topic, set(homes))
    if topic.endswith("/prediction"):
        if p.get("basis") != "simulated_forecast" or p.get("device_kind") != "simulator":
            raise ValueError("Simulation predictions must be explicitly labeled")
        if p.get("action") not in ("buy", "sell", "hold"):
            raise ValueError("Invalid prediction action")
        for k in ("quantity_wh", "price"):
            if not isinstance(p.get(k), str) or not p[k].isdigit():
                raise ValueError("Prediction units must be integer strings")
    if topic.endswith('/esp32/source'):
        if house != 'home_01' or p.get('basis') not in ('esp32_telemetry', 'esp32_forecast') or p.get('device_kind') != 'esp32':
            raise ValueError('Invalid hardware source identity')
        source = p.get('input', {})
        telemetry(source, 'solar/home_01/telemetry', set(homes))
        fast = source.get('data_mode') == 'simulation' and source.get('time_mode') == 'accelerated' and source.get('sampling_seconds') == 5 and p.get('policy_version') == 'edge-ai-accelerated5s-v1'
        if not fast and (source.get('data_mode') != 'real' or source.get('demo_scenario') != 'none'):
            raise ValueError('Hybrid source must contain real ESP32 telemetry')
        if p.get('action') not in ('buy', 'sell', 'hold'):
            raise ValueError('Invalid hardware action')
        for k in ('quantity_wh', 'price'):
            if not isinstance(p.get(k), str) or not p[k].isdigit():
                raise ValueError('Invalid hardware quantity/price')
    return p
