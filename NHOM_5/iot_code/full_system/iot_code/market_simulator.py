"""Hardware-free household agents; MQTT commands generate telemetry and delivery."""
import argparse
import json
import os
import queue
import signal
from datetime import timedelta
from pathlib import Path
from .model import SolarModel, parse_start
from .household_agent import HouseholdAgent
from .delivery_model import delivery_record
from .market_profiles import community_reading


def main():
    parser = argparse.ArgumentParser()
    for key in ("config", "manifest", "run", "state"):
        parser.add_argument("--" + key, required=True)
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text(encoding="utf-8"))
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    state_file = Path(args.state)
    state = json.loads(state_file.read_text(encoding="utf-8")) if state_file.exists() else {"commands": {}, "meters": {}, "latest": {}, "sequence": 0}
    homes = {h["id"]: h for h in config["homes"] if not (config.get('hybrid') and h['id'] == 'home_01')}
    state.setdefault("inputs", {})
    inbox = queue.Queue()
    agents = {}
    stopped = False
    def stop(*a):
        nonlocal stopped
        stopped = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    def save():
        state_file.parent.mkdir(parents=True, exist_ok=True)
        tmp = state_file.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, state_file)
    def envelope(hid, msg_id, **fields):
        return {"schema_version": 1, "message_id": msg_id, "run_id": args.run,
            "deployment_id": manifest["deployment_id"], "household_id": hid, **fields}
    try:
        for hid, home in homes.items():
            agents[hid] = HouseholdAgent(home, args.run, manifest["deployment_id"], args.port, inbox)
        for agent in agents.values():
            if not agent.ready.wait(20):
                raise TimeoutError("Household MQTT subscribe timed out")
        print(json.dumps({"type": "ready", "homes": len(agents)}), flush=True)
        while not stopped:
            try:
                hid, request = inbox.get(timeout=.1)
            except queue.Empty:
                continue
            mid = request["message_id"]
            if mid in state["inputs"] and state["inputs"][mid] != request:
                agents[hid].publish(f"solar/{hid}/simulation/status", envelope(hid, mid + "-conflict",
                    correlation_id=mid, status="rejected", error="Conflicting simulation command identity"))
                continue
            outbound = state["commands"].get(mid)
            if outbound is None:
                action = request["action"]
                p = request.get("payload", {})
                if action == "sample":
                    sequence = int(p["sequence"])
                    stamp = parse_start(config["start"]) + timedelta(seconds=sequence * config["step_seconds"])
                    if config.get('hybrid'):
                        stamp = parse_start(p['timestamp'])
                    # Each request samples the selected home; fixed per-home seeds avoid arrival-order randomness.
                    if p.get('profile') == 'community':
                        reading = community_reading(config, homes[hid], stamp, args.run, sequence)
                    elif config.get('hybrid'):
                        # Explicit daytime model for virtual counterparties, even when hardware is at night.
                        model_stamp = stamp.replace(hour=12)
                        sample_model = SolarModel(config['seed'] + sequence * 101 + list(homes).index(hid), {hid: homes[hid]}, 'sunny')
                        reading = next(sample_model.generate(model_stamp, config['step_seconds'], args.run, sequence))
                        reading.update(timestamp=stamp.isoformat(), virtual_profile='daytime_counterparty',
                                       model_timestamp=model_stamp.isoformat())
                    else:
                        sample_model = SolarModel(config["seed"] + sequence * 101 + list(homes).index(hid), {hid: homes[hid]}, "sunny")
                        reading = next(sample_model.generate(stamp, config["step_seconds"], args.run, sequence))
                    reading.update(envelope(hid, mid + "-telemetry"))
                    reading["basis"] = "simulated_meter"
                    surplus = max(0, int(round((reading["solar_energy_kwh"] - reading["load_energy_kwh"]) * 1000)))
                    deficit = max(0, int(round((reading["load_energy_kwh"] - reading["solar_energy_kwh"]) * 1000)))
                    side = "sell" if surplus > 0 else "buy" if deficit > 0 else "hold"
                    prediction = envelope(hid, mid + "-prediction", basis="simulated_forecast", device_kind="simulator",
                        action=side, input_event_id=reading["event_id"], input_message_id=reading["message_id"],
                        timestamp=reading["timestamp"], target_timestamp=(stamp + timedelta(seconds=300)).isoformat(),
                        quantity_wh=str(surplus or deficit), price=str(homes[hid]["ask" if side == "sell" else "bid"] +
                            (50 * ((sequence + list(homes).index(hid)) % 5) if p.get('profile') == 'community' else 0)))
                    state["latest"][hid] = prediction
                    outbound = [[f"solar/{hid}/telemetry", reading], [f"solar/{hid}/prediction", prediction],
                        [f"solar/{hid}/simulation/status", envelope(hid, mid + "-status", correlation_id=mid, status="sampled", prediction=prediction)]]
                elif action in ("place_order", "cancel_order"):
                    p = dict(p)
                    if action == "place_order":
                        prediction = state["latest"].get(hid)
                        if not prediction:
                            raise ValueError("Sample household before placing an order")
                        p.setdefault("side", 0 if prediction["action"] == "sell" else 1)
                        p.setdefault("quantity_wh", prediction["quantity_wh"])
                        p.setdefault("price", prediction["price"])
                        p["forecast"] = prediction
                        p["basis"] = "simulated_forecast"
                    outbound = [[f"solar/{hid}/order/request", envelope(hid, mid, action=action, payload=p)]]
                elif action == "delivery":
                    # Offline deliberately emits no delivery evidence for the oracle.
                    if p.get("offline"):
                        outbound = [[f"solar/{hid}/simulation/status", envelope(hid, mid + "-offline", correlation_id=mid, status="offline")]]
                    else:
                        measured = delivery_record(state["meters"], hid, p["buyer"], int(p["quantity_wh"]), int(p.get("delivery_bps", homes[hid]["delivery_bps"])))
                        if p.get("invalid"):
                            measured["delivered_wh"] = str(int(p["quantity_wh"]) + 1)
                        outbound = [[f"solar/{hid}/delivery", envelope(hid, mid, action="confirm_trade",
                            payload={"round_id": p["round_id"], "trade_index": p["trade_index"], **measured})]]
                else:
                    raise ValueError("Unknown household action")
                # Atomic ledger/outbox precedes publishing: replay sends the same meter readings and IDs.
                state["commands"][mid] = outbound
                state["inputs"][mid] = request
                save()
            for topic, payload in outbound:
                # IPC control IDs may appear on an input and output topic; output is a distinct wire identity.
                if payload["message_id"] == mid:
                    payload = dict(payload, message_id=mid + "-wire", correlation_id=mid)
                agents[hid].publish(topic, payload)
    finally:
        for agent in agents.values():
            agent.close()


if __name__ == "__main__":
    main()
