import json
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path
from backend.market_storage import MarketStore
from backend.market_validation import market_message
from iot_code.delivery_model import delivery_record
from iot_code.model import SolarModel, parse_start
from iot_code.model import validate_reading
from iot_code.market_profiles import community_reading


class MarketSimulationTests(unittest.TestCase):
    def setUp(self):
        self.run = "a" * 32
        self.deployment = "0x" + "b" * 64
        self.homes = {"home_01": {"pv_kw": 6, "base_load_kw": .5}}
        self.reading = next(SolarModel(42, self.homes, "sunny").generate(parse_start("2026-10-03T11:00:00+07:00"), 300, self.run, 0))
        self.reading.update(message_id="source", deployment_id=self.deployment)
        difference = round((self.reading["solar_energy_kwh"] - self.reading["load_energy_kwh"]) * 1000)
        self.forecast = {"schema_version": 1, "message_id": "forecast", "run_id": self.run, "deployment_id": self.deployment,
            "household_id": "home_01", "input_event_id": self.reading["event_id"], "input_message_id": "source",
            "device_kind": "simulator", "basis": "simulated_forecast", "action": "sell", "quantity_wh": str(difference),
            "price": "2000", "target_timestamp": (parse_start(self.reading["timestamp"]) + timedelta(seconds=300)).isoformat()}

    def test_topic_run_deployment_and_simulation_label_are_checked(self):
        valid = market_message("solar/home_01/telemetry", json.dumps(self.reading).encode(), self.run, self.deployment, self.homes)
        self.assertEqual(valid["event_id"], self.reading["event_id"])
        for change in ({"run_id": "c" * 32}, {"deployment_id": "0x" + "d" * 64}, {"schema_version": True}, {"household_id": "home_02"}):
            with self.assertRaises(ValueError):
                market_message("solar/home_01/telemetry", json.dumps({**self.reading, **change}).encode(), self.run, self.deployment, self.homes)
        for change in ({"device_kind": "esp32"}, {"basis": "esp32_forecast"}):
            with self.assertRaises(ValueError):
                market_message("solar/home_01/prediction", json.dumps({**self.forecast, **change}).encode(), self.run, self.deployment, self.homes)

    def test_history_is_durable_idempotent_and_rejects_conflicts(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "market.sqlite3"
            store = MarketStore(file)
            self.assertEqual(store.store("solar/home_01/telemetry", self.reading), "stored")
            self.assertEqual(store.store("solar/home_01/telemetry", self.reading), "duplicate")
            with self.assertRaisesRegex(ValueError, "Conflicting"):
                store.store("solar/home_01/telemetry", {**self.reading, "load_power_kw": 12})
            store.close()
            reopened = MarketStore(file)
            self.assertEqual(reopened.store("solar/home_01/telemetry", self.reading), "duplicate")
            reopened.close()

    def test_forecast_must_have_matching_stored_input(self):
        with tempfile.TemporaryDirectory() as directory:
            store = MarketStore(Path(directory) / "market.sqlite3")
            with self.assertRaisesRegex(ValueError, "absent"):
                store.store("solar/home_01/prediction", self.forecast)
            store.store("solar/home_01/telemetry", self.reading)
            with self.assertRaisesRegex(ValueError, "does not match"):
                store.store("solar/home_01/prediction", {**self.forecast, "quantity_wh": "999999"})
            self.assertEqual(store.store("solar/home_01/prediction", self.forecast), "stored")
            store.close()

    def test_paired_meters_conserve_delivery_and_accumulate_integer_wh(self):
        meters = {}
        first = delivery_record(meters, "seller", "buyer", 101, 4000)
        self.assertEqual(first["delivered_wh"], "40")
        second = delivery_record(meters, "seller", "buyer", 60, 10000)
        self.assertEqual(second["measurement"]["seller_start_wh"], "40")
        self.assertEqual(meters["seller:export"], 100)
        self.assertEqual(meters["buyer:import"], 100)
        for quantity, ratio in ((True, 10000), (0, 10000), (10, -1), (10, 10001)):
            with self.assertRaises(ValueError):
                delivery_record(meters, "seller", "buyer", quantity, ratio)

    def test_community_disturbances_are_reproducible_and_preserve_meter_units(self):
        config = json.loads(Path('config/market_simulation.json').read_text(encoding='utf-8'))
        start = parse_start(config['start'])
        readings = [community_reading(config, h, start + timedelta(seconds=i * 300), self.run, i)
                    for i in range(12) for h in config['homes']]
        for reading in readings:
            validate_reading(reading, f"solar/{reading['household_id']}/telemetry", {h['id'] for h in config['homes']})
            market_message(f"solar/{reading['household_id']}/telemetry", json.dumps({**reading,
                'message_id': reading['event_id'].replace(':', '-'), 'deployment_id': self.deployment}).encode(),
                self.run, self.deployment, {h['id'] for h in config['homes']})
        h = config['homes'][0]
        repeated = community_reading(config, h, start, self.run, 0)
        self.assertEqual(repeated['solar_power_kw'], readings[0]['solar_power_kw'])
        self.assertEqual(repeated['load_power_kw'], readings[0]['load_power_kw'])
        self.assertLess(readings[3 * 12]['solar_power_kw'], readings[0]['solar_power_kw'] * .4)
        self.assertGreater(readings[6 * 12]['load_power_kw'], readings[0]['load_power_kw'])
        for bad in (True, -1, 12):
            with self.assertRaises(ValueError):
                community_reading(config, h, start, self.run, bad)


if __name__ == "__main__":
    unittest.main()
