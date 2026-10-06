"""Phase 2 regression tests. Fixtures are synthetic; no physical-board claim."""
from dataclasses import replace
from datetime import timedelta
import json

from fastapi.testclient import TestClient
import pytest

from backend.api import create_app
from backend.policy import propose
from backend.service import Service
from backend.settings import Settings, ROOT
from iot_code.config import homes_dict, load_config
from iot_code.model import SolarModel, parse_start

RUN = "a" * 32
HOMES = homes_dict(load_config(ROOT / "config" / "edge_demo.json"))


def reading(sequence=0, run=RUN):
    model = SolarModel(123, HOMES)
    return next(model.generate(parse_start("2026-10-01T10:00:00+07:00") + timedelta(minutes=5*sequence), 300, run, sequence))


def prediction(row=None, solar=2.0, load=0.8):
    row = row or reading()
    return {"schema_version": 1, "household_id": "home_01", "run_id": row["run_id"],
            "input_event_id": row["event_id"], "input_timestamp": row["timestamp"],
            "target_timestamp": (parse_start(row["timestamp"]) + timedelta(minutes=5)).isoformat(),
            "interval_seconds": 300, "model_version": "wire-fixture-not-real-inference",
            "device_kind": "esp32", "device_id": "esp32-000000000001",
            "predicted_solar_kw": solar, "predicted_load_kw": load,
            "predicted_net_kw": solar-load, "predicted_surplus_kwh": max(solar-load, 0)/12,
            "inference_us": 0, "arena_used_bytes": 0, "free_heap_bytes": 0,
            "clipped_features": 0, "model_bytes": 5832}


def send(s, p, kind="telemetry"):
    topic = "solar/home_01/prediction" if kind == "prediction" else "solar/home_01/telemetry"
    return s.ingest(topic, json.dumps(p).encode())


@pytest.fixture
def service(tmp_path):
    return Service(Settings(db_path=tmp_path / "demo.sqlite3", mqtt_enabled=False))


def test_sell_buy_hold_quantities():
    assert propose(prediction(solar=3.0, load=1.0), .2, .01)["quantity_kwh"] == .133333
    buy = propose(prediction(solar=0.2, load=1.4), .2, .01)
    assert buy["action"] == "buy" and buy["quantity_kwh"] == .1
    assert propose(prediction(solar=1.1, load=1.0), .2, .01)["action"] == "hold"
    assert propose(prediction(solar=1.0, load=1.0), .2, .01)["quantity_kwh"] == 0


def test_deduplicate_and_restart(service):
    row, p = reading(), prediction()
    assert send(service, row) == "stored"
    assert send(service, row) == "duplicate"
    assert send(service, p, "prediction") == "stored"
    assert send(service, p, "prediction") == "duplicate"
    second = Service(service.settings)
    assert send(second, p, "prediction") == "duplicate"
    assert second.store.counts() == {"runs": 1, "telemetry": 1, "predictions": 1, "proposals": 1}


def test_live_arrival_order_wins_over_future_demo_sample(service, monkeypatch):
    monkeypatch.setattr('backend.storage.now_iso', lambda: '2026-10-05T12:00:00+00:00')
    assert send(service, reading(sequence=2000)) == 'stored'
    monkeypatch.setattr('backend.storage.now_iso', lambda: '2026-10-05T12:05:00+00:00')
    assert send(service, reading(sequence=0)) == 'stored'
    assert service.store.records('telemetry', limit=1)['items'][0]['event_id'].endswith(':2000')
    assert service.store.records('telemetry', limit=1, order_by_received=True)['items'][0]['event_id'].endswith(':0')


def test_identity_conflict_preserves_original(service):
    send(service, reading())
    p = prediction()
    send(service, p, "prediction")
    changed = prediction(solar=4.0)
    assert send(service, changed, "prediction") == "rejected"
    assert service.store.records("predictions")["items"][0]["predicted_solar_kw"] == 2.0
    altered = {**reading(), "temperature_c": 15}
    assert send(service, altered) == "rejected"


@pytest.mark.parametrize("mutate", [
    lambda p: p.update(predicted_solar_kw=float("nan")),
    lambda p: p.update(device_kind="pc_reference"),
    lambda p: p.update(target_timestamp=p["input_timestamp"]),
    lambda p: p.update(run_id="not-a-run"),
    lambda p: p.update(predicted_net_kw=77),
    lambda p: p.update(arena_used_bytes=-1),
    lambda p: p.update(schema_version=True),
    lambda p: p.update(input_event_id="a"*32+":home_02:0"),
])
def test_reject_bad_predictions(service, mutate):
    p = prediction(); mutate(p)
    assert send(service, p, "prediction") == "rejected"
    assert service.store.counts()["predictions"] == 0


def test_retained_and_invalid_json(service):
    raw = json.dumps(reading()).encode()
    assert service.ingest("solar/home_01/telemetry", raw, retained=True) == "ignored"
    assert service.ingest("solar/home_01/telemetry", b'{"run_id":1,"run_id":2}') == "rejected"
    assert service.ingest("solar/home_01/telemetry", b"x"*17000) == "rejected"
    assert service.store.counts()["telemetry"] == 0


def test_actuator_ack_validation(service):
    ack = {"schema_version": 1, "household_id": "home_01", "run_id": RUN,
           "round_id": 7, "action": "sell", "relay1_on": False,
           "relay2_on": True, "state": "applied"}
    assert service.ingest("solar/home_01/actuator/status", json.dumps(ack).encode()) == "stored"
    assert service.status()["last_actuator_ack"] == ack
    assert service.ingest("solar/home_01/actuator/status",
                          json.dumps({**ack, "relay2_on": "yes"}).encode()) == "rejected"


def test_topic_and_step_mismatch(service):
    row = reading()
    assert service.ingest("solar/home_02/telemetry", json.dumps(row).encode()) == "rejected"
    row["interval_seconds"] = 60
    assert send(service, row) == "rejected"


def test_esp32_demo_provenance_is_validated_and_preserved(service):
    row = reading()
    row.update(data_mode="simulation", demo_scenario="sell",
               solar_voltage_v=230.0, solar_current_a=10.0,
               load_voltage_v=229.0, load_current_a=2.0)
    assert send(service, row) == "stored"
    saved = service.store.records("telemetry")["items"][0]
    assert saved["data_mode"] == "simulation" and saved["demo_scenario"] == "sell"
    bad = reading(1)
    bad.update(data_mode="simulation", demo_scenario="unknown",
               solar_voltage_v=230.0, solar_current_a=10.0,
               load_voltage_v=229.0, load_current_a=2.0)
    assert send(service, bad) == "rejected"


def test_edge_ai_prediction_provenance_survives_storage(service):
    p = {**prediction(), 'data_mode': 'real', 'history_samples': 12}
    assert send(service, p, 'prediction') == 'stored'
    saved = service.store.records('predictions', order_by_received=True)['items'][0]
    assert saved['data_mode'] == 'real' and saved['history_samples'] == 12
    bad = {**prediction(reading(1)), 'data_mode': 'real', 'history_samples': 11}
    assert send(service, bad, 'prediction') == 'rejected'
    assert service.store.counts()['predictions'] == 1


def test_accelerated_5s_timing_is_validated_and_preserved(service):
    row = reading()
    row.update(data_mode='simulation', demo_scenario='buy', time_mode='accelerated', sampling_seconds=5,
               solar_voltage_v=12, solar_current_a=1, load_voltage_v=12, load_current_a=1)
    assert send(service, row) == 'stored'
    p = {**prediction(row), 'data_mode': 'simulation', 'history_samples': 12, 'time_mode': 'accelerated', 'sampling_seconds': 5}
    assert send(service, p, 'prediction') == 'stored'
    assert service.store.records('telemetry')['items'][0]['sampling_seconds'] == 5
    assert service.store.records('predictions')['items'][0]['time_mode'] == 'accelerated'
    assert send(service, {**reading(1), 'time_mode': 'accelerated', 'sampling_seconds': 300}) == 'rejected'
    live = {**reading(2), 'data_mode': 'real', 'demo_scenario': 'none', 'time_mode': 'accelerated', 'sampling_seconds': 5,
            'solar_voltage_v': 5, 'solar_current_a': 0, 'load_voltage_v': 5, 'load_current_a': .1}
    assert send(service, live) == 'stored'
    p = {**prediction(live), 'data_mode': 'real', 'history_samples': 12, 'time_mode': 'accelerated', 'sampling_seconds': 5}
    assert send(service, p, 'prediction') == 'stored'
    assert send(service, {**prediction(reading(3)), 'data_mode': 'simulation', 'history_samples': 12,
                          'time_mode': 'realtime', 'sampling_seconds': 300}, 'prediction') == 'rejected'


def test_out_of_order_linking_and_expiry(service):
    assert send(service, prediction(), "prediction") == "stored"
    assert service.store.proposals(True)["items"][0]["status"] == "awaiting_input"
    send(service, reading())
    assert service.store.proposals(True)["items"][0]["status"] == "proposed"
    send(service, reading(1))
    item = service.store.proposals(True)["items"][0]
    assert item["status"] == "observed" and not item["eligible_for_review"]
    assert item["actual_net_kwh"] is not None


def test_late_forecast_cannot_be_proposed(service):
    send(service, reading()); send(service, reading(1))
    send(service, prediction(), "prediction")
    assert service.store.proposals(True)["items"][0]["status"] == "late"


def test_gap_cannot_leave_old_offer_active(service):
    send(service, reading()); send(service, prediction(), "prediction")
    send(service, reading(2))
    assert service.store.proposals(True)["items"][0]["status"] == "expired"


def test_new_run_does_not_mix_history(service):
    send(service, reading()); send(service, prediction(), "prediction")
    send(service, reading(run="b"*32))
    assert service.store.proposals(True, run_id=RUN)["items"][0]["status"] == "archived"
    assert service.store.homes(HOMES)["run_id"] == "b"*32
    assert service.store.records("telemetry", run_id=RUN)["total"] == 1
    # Delayed message from an already-known old run cannot select it as newest.
    send(service, reading(3))
    assert service.store.homes(HOMES)["run_id"] == "b"*32


def test_stop_and_disconnection_prevent_review(service):
    send(service, reading()); send(service, prediction(), "prediction")
    assert service.store.proposals(False)["items"][0]["status"] == "disconnected"
    service.ingest("solar/simulator/state", json.dumps({"run_id": RUN, "status": "stopped"}).encode())
    assert service.store.proposals(True)["items"][0]["status"] == "stopped"


def test_stale_prediction_and_policy_snapshot(service):
    send(service, reading()); send(service, prediction(), "prediction")
    with service.store.connection() as db:
        db.execute("UPDATE predictions SET received_at='2020-01-01T00:00:00+00:00'")
    changed = Service(replace(service.settings, sell_reserve=.7))
    p = changed.store.proposals(True)["items"][0]
    assert p["sell_reserve"] == .2 and p["status"] == "stale"


def test_latest_house_not_regressed_by_delayed_packets(service):
    send(service, reading(2)); send(service, reading(0))
    home = service.store.homes(HOMES)["items"][0]
    assert home["telemetry"]["event_id"].endswith(":2")


def test_device_filter(tmp_path):
    s = Service(Settings(db_path=tmp_path / "d.db", mqtt_enabled=False, device_id="esp32-6825ddef0120"))
    assert send(s, prediction(), "prediction") == "rejected"


def test_api_history_pagination_validation_and_lifespan(tmp_path):
    app = create_app(Settings(db_path=tmp_path / "api.db", mqtt_enabled=False))
    with TestClient(app) as client:
        assert client.get("/health").json()["counts"]["telemetry"] == 0
        assert client.get("/ready").status_code == 503
        send(app.state.service, reading()); send(app.state.service, reading(1))
        result = client.get("/api/telemetry?limit=1&offset=1").json()
        assert result["total"] == 2 and len(result["items"]) == 1
        assert client.get("/api/telemetry?limit=1000").status_code == 422
        assert client.get("/api/homes?run_id=bad").status_code == 422
        assert client.post("/api/proposals", json={}).status_code == 405
        actuator = {"deployment_id": "0x" + "a"*64, "transaction_hash": "0x" + "b"*64,
                    "round_id": 1, "action": "sell", "source_hash_verified": False,
                    "settlement_status": 1, "duration_seconds": 15}
        assert client.post("/api/demo/actuator", json=actuator).status_code == 422
        assert client.get("/api/overview").json()["selected_run_id"] == RUN
        assert client.get("/openapi.json").status_code == 200
        assert "SOLAR LAB" in client.get("/").text
    with TestClient(app) as client:
        assert client.get("/health").json()["counts"]["telemetry"] == 2
