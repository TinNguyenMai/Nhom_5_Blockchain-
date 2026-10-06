"""Advisory quantities only. No matching, payment or contract execution."""
from decimal import Decimal, ROUND_DOWN


def propose(prediction, reserve, minimum):
    # kW * 300/3600 -> kWh. Never use real MQTT waiting time here.
    net = Decimal(str(prediction["predicted_solar_kw"])) - Decimal(str(prediction["predicted_load_kw"]))
    energy = net * Decimal(prediction["interval_seconds"]) / Decimal(3600)
    if energy > 0:
        action = "sell"
        quantity = energy * (Decimal(1) - Decimal(str(reserve)))
    else:
        action = "buy"
        quantity = -energy
    quantity = quantity.quantize(Decimal("0.000001"), rounding=ROUND_DOWN)
    if quantity < Decimal(str(minimum)):
        action, quantity = "hold", Decimal(0)
    return {"action": action, "quantity_kwh": float(quantity),
            "forecast_net_kwh": float(energy), "sell_reserve": reserve,
            "minimum_kwh": minimum, "policy_version": "reserve-v1"}
