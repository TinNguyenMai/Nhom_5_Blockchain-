"""Regression coverage for independent PV/load commands and status explanations."""
import time
import unittest

from iot_code.config import load_config, homes_dict
from iot_code.model import SolarModel, parse_start
from iot_code.panel import pv_changes, load_changes, pv_status_text, command_feedback
from iot_code.runtime import Runtime


class PVControlTests(unittest.TestCase):
    def setUp(self):
        self.model = SolarModel(42, homes_dict(load_config()), "sunny")
        self.runtime = Runtime(self.model, "pv-test", 5)
        self.sequence = 0

    def apply(self, changes):
        self.sequence += 1
        command = {"action": "home", "household_id": "home_01", "changes": changes,
                   "request_id": str(self.sequence), "run_id": "pv-test", "issued_at": time.time()}
        ack, _ = self.runtime.apply(command)
        self.assertTrue(ack["ok"], ack)
        return command

    def reading(self, hour):
        return next(self.model.generate(parse_start(f"2026-09-01T{hour}+07:00"), 300, "pv-test", self.sequence))

    def test_repeated_off_on_at_noon_preserves_load(self):
        self.apply(load_changes("2"))
        for _ in range(3):
            self.apply(pv_changes("Tắt"))
            self.assertEqual(self.reading("12:00:00")["solar_power_kw"], 0)
            command = self.apply(pv_changes("Bật"))
            self.assertGreater(self.reading("12:00:00")["solar_power_kw"], 0)
            self.assertEqual(self.model.homes["home_01"]["load_multiplier"], 2)
            self.assertIn("PV BẬT", command_feedback(command))
        self.assertEqual(self.model.homes["home_02"]["load_multiplier"], 1)

    def test_on_at_night_is_enabled_but_does_not_generate(self):
        self.apply(pv_changes("Tắt"))
        self.apply(pv_changes("Bật"))
        reading = self.reading("23:20:00")
        home = self.model.homes["home_01"]
        self.assertTrue(home["pv_enabled"])
        self.assertEqual(reading["solar_power_kw"], 0)
        self.assertIn("ban đêm", pv_status_text(home, reading, "running", True))
        self.assertGreater(self.reading("08:00:00")["solar_power_kw"], 0)

    def test_load_does_not_toggle_pv(self):
        self.apply(pv_changes("Tắt"))
        self.apply(load_changes("1.5"))
        self.assertFalse(self.model.homes["home_01"]["pv_enabled"])
        self.assertEqual(pv_changes("Bật"), {"pv_enabled": True})
        self.assertEqual(load_changes("1.5"), {"load_multiplier": 1.5})

    def test_invalid_choices(self):
        for value in ("", "on", None):
            with self.assertRaises(ValueError):
                pv_changes(value)
        for value in ("nan", "inf", "0", "6", "abc", "1,5"):
            with self.assertRaises(ValueError):
                load_changes(value)

    def test_paused_missing_no_pv_and_stale_explanations(self):
        home = self.model.homes["home_01"]
        self.assertIn("Tiếp tục", pv_status_text(home, None, "paused", True))
        self.assertIn("chờ số đo", pv_status_text(home, None, "running", True))
        self.assertIn("chưa lắp PV", pv_status_text(self.model.homes["home_03"], None, "running", True))
        self.assertIn("Trạng thái cũ", pv_status_text(home, None, "running", False))
        self.assertIn("Trạng thái cũ", pv_status_text(home, None, "stopped", True))


if __name__ == "__main__":
    unittest.main()
