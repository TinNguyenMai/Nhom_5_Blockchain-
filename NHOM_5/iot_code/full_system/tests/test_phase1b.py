import copy
import time
import unittest

from iot_code.config import load_config, homes_dict, validate_config, no_duplicate_keys
from iot_code.model import SolarModel, parse_start, validate_reading
from iot_code.panel import Mailbox
from iot_code.runtime import Runtime


class Phase1BTests(unittest.TestCase):
    def setUp(self):
        self.cfg = load_config()
        self.homes = homes_dict(self.cfg)
        self.model = SolarModel(42, self.homes)
        self.runtime = Runtime(self.model, "run", 5)

    def command(self, action, **values):
        return {"request_id": f"request-{len(self.runtime.handled)}", "run_id": "run", "issued_at": time.time(), "action": action, **values}

    def test_configuration_is_external_and_dynamic(self):
        cfg = copy.deepcopy(self.cfg)
        cfg["homes"].append({**cfg["homes"][0], "id": "home_04", "name": "Nhà 4"})
        homes = homes_dict(validate_config(cfg))
        readings = list(SolarModel(42, homes).generate(parse_start("2026-09-01T12:00:00+07:00"), 300, "test", 0))
        self.assertEqual(len(readings), 4)
        validate_reading(readings[-1], "solar/home_04/telemetry", homes)

    def test_bad_configs(self):
        for field, value in [("id", "home/invalid"), ("pv_kw", -1), ("pv_kw", float("nan")), ("pv_enabled", 1), ("load_multiplier", 0), ("name", "")]:
            cfg = copy.deepcopy(self.cfg)
            cfg["homes"][0][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                validate_config(cfg)
        cfg = copy.deepcopy(self.cfg)
        cfg["homes"].append(copy.deepcopy(cfg["homes"][0]))
        with self.assertRaises(ValueError):
            validate_config(cfg)
        with self.assertRaises(ValueError):
            no_duplicate_keys([("a", 1), ("a", 2)])

    def test_day_weather_and_night(self):
        noon = parse_start("2026-09-01T12:00:00+07:00")
        values = [next(SolarModel(42, self.homes, weather).generate(noon, 300, "test", 0))["solar_power_kw"] for weather in ("sunny", "cloudy", "rainy")]
        self.assertGreater(values[0], values[1])
        self.assertGreater(values[1], values[2])
        night = parse_start("2026-09-01T20:00:00+07:00")
        self.assertEqual(next(SolarModel(42, self.homes, "sunny").generate(night, 300, "test", 0))["solar_power_kw"], 0)

    def test_pv_off_and_double_load(self):
        self.model.homes["home_01"].update(pv_enabled=False, load_multiplier=2)
        args = (parse_start("2026-09-01T12:00:00+07:00"), 300, "test", 0)
        changed = next(self.model.generate(*args))
        original = next(SolarModel(42, self.homes).generate(*args))
        self.assertEqual(changed["solar_power_kw"], 0)
        self.assertAlmostEqual(changed["load_power_kw"], original["load_power_kw"] * 2, delta=0.00011)
        self.assertTrue(self.homes["home_01"]["pv_enabled"])

    def test_pause_resume_interval(self):
        self.assertTrue(self.runtime.apply(self.command("pause"))[0]["ok"])
        self.assertTrue(self.runtime.paused)
        self.assertTrue(self.runtime.apply(self.command("resume"))[0]["ok"])
        self.assertFalse(self.runtime.paused)
        self.assertTrue(self.runtime.apply(self.command("interval", value=1))[0]["ok"])
        self.assertEqual(self.runtime.interval, 1)

    def test_duplicate_command_is_not_applied_again(self):
        command = self.command("pause")
        first, processed = self.runtime.apply(command)
        self.assertTrue(processed)
        self.runtime.apply(self.command("resume"))
        duplicate, processed = self.runtime.apply(command)
        self.assertEqual(first, duplicate)
        self.assertFalse(processed)
        self.assertFalse(self.runtime.paused)

    def test_reject_invalid_command_atomically(self):
        cases = [self.command("interval", value=-1), self.command("weather", value="storm"), self.command("home", household_id="home_01", changes={"pv_enabled": False, "load_multiplier": 99}), self.command("pause", issued_at=time.time()-20), self.command("pause", run_id="wrong")]
        for index, command in enumerate(cases):
            command["request_id"] = str(index)
            self.assertFalse(self.runtime.apply(command)[0]["ok"])
        self.assertTrue(self.model.homes["home_01"]["pv_enabled"])
        self.assertEqual(self.runtime.interval, 5)

    def test_dataset_commands_locked(self):
        self.runtime.dataset = True
        self.assertFalse(self.runtime.apply(self.command("pause"))[0]["ok"])
        self.assertFalse(self.runtime.paused)

    def test_snapshot_is_not_mutable_reference(self):
        snapshot = self.runtime.snapshot()
        snapshot["homes"]["home_01"]["pv_kw"] = 99
        self.assertEqual(self.model.homes["home_01"]["pv_kw"], 4)

    def test_panel_mailbox_coalesces_and_is_bounded(self):
        box = Mailbox()
        for index in range(1000):
            box.put("same", index)
        self.assertEqual(box.take(), {"same": 999})
        for index in range(1000):
            box.put(str(index), index)
        self.assertLessEqual(len(box.take()), 250)


if __name__ == "__main__":
    unittest.main()
