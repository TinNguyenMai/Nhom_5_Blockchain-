import copy
from datetime import timedelta
import unittest

from iot_code.model import HOMES, SolarModel, parse_start, validate_reading


class ModelTests(unittest.TestCase):
    def test_full_day_balances_and_time_order(self):
        start = parse_start("2026-09-01T00:00:00+07:00")
        model = SolarModel(42)
        surplus_seen = False
        count = 0
        for step in range(288):
            timestamp = start + timedelta(seconds=step * 300)
            readings = list(model.generate(timestamp, 300, "test", step))
            self.assertEqual({item["household_id"] for item in readings}, set(HOMES))
            for reading in readings:
                validate_reading(reading, f"solar/{reading['household_id']}/telemetry")
                self.assertEqual(parse_start(reading["timestamp"]), timestamp)
                self.assertAlmostEqual(reading["solar_energy_kwh"] - reading["load_energy_kwh"], reading["surplus_energy_kwh"] - reading["deficit_energy_kwh"], places=6)
                if timestamp.hour < 6 or timestamp.hour >= 18 or reading["household_id"] == "home_03":
                    self.assertEqual(reading["solar_power_kw"], 0)
                    self.assertGreater(reading["deficit_energy_kwh"], 0)
                surplus_seen |= reading["surplus_energy_kwh"] > 0
                count += 1
        self.assertEqual(count, 864)
        self.assertTrue(surplus_seen)

    def test_seed_reproducibility_excluding_wall_clock(self):
        arguments = (parse_start("2026-09-01T12:00:00+07:00"), 300, "same", 0)
        first = list(SolarModel(7).generate(*arguments))
        second = list(SolarModel(7).generate(*arguments))
        for a, b in zip(first, second):
            a.pop("published_at")
            b.pop("published_at")
            self.assertEqual(a, b)

    def test_timezone_required_and_utc_normalized(self):
        with self.assertRaises(ValueError):
            parse_start("2026-09-01T12:00:00")
        self.assertEqual(parse_start("2026-09-01T05:00:00+00:00").hour, 12)

    def test_reject_malformed_readings_and_wrong_topic(self):
        good = next(SolarModel().generate(parse_start("2026-09-01T12:00:00+07:00"), 300, "test", 0))
        for field, value in [("solar_power_kw", float("nan")), ("load_power_kw", -1), ("solar_energy_kwh", 100), ("interval_seconds", 0), ("cloud_cover", 2), ("event_id", "wrong"), ("schema_version", True), ("timestamp", None)]:
            with self.subTest(field=field):
                bad = copy.deepcopy(good)
                bad[field] = value
                with self.assertRaises(ValueError):
                    validate_reading(bad, "solar/home_01/telemetry")
        with self.assertRaises(ValueError):
            validate_reading(good, "solar/home_02/telemetry")
        with self.assertRaises(ValueError):
            validate_reading([], "solar/home_01/telemetry")


if __name__ == "__main__":
    unittest.main()
