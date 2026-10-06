"""Host checks for actual firmware decoding, aggregation and backend wire compatibility."""
from datetime import datetime, timezone, timedelta
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from backend.validation import telemetry

ROOT = Path(__file__).resolve().parent.parent
FRAMEWORK = Path(os.environ.get("USERPROFILE", Path.home())) / ".platformio/packages/framework-espidf"
CJSON = FRAMEWORK / "components/json/cJSON"


@unittest.skipUnless(shutil.which("gcc") and shutil.which("g++") and (CJSON / "cJSON.c").exists(),
                     "Requires host C/C++ compilers and PlatformIO ESP-IDF cJSON")
class PowerMeasurementTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temp.cleanup)
        obj = str(Path(cls.temp.name) / "cjson.o")
        cls.binary = str(Path(cls.temp.name) / "power_probe.exe")
        subprocess.run(["gcc", "-c", str(CJSON / "cJSON.c"), "-o", obj], check=True, capture_output=True)
        subprocess.run(["g++", "-std=c++17", "-O2", "-Wall", "-Wextra", "-Werror",
                        "-I", str(ROOT / "iot_code/firmware/esp32_edge/main"), "-I", str(CJSON),
                        str(ROOT / "tests/power_measurement_probe.cc"),
                        str(ROOT / "iot_code/firmware/esp32_edge/main/real_telemetry.cc"), obj,
                        "-o", cls.binary], check=True, capture_output=True)

    def probe(self, case):
        result = subprocess.run([self.binary, case], check=True, capture_output=True, text=True)
        return [json.loads(line) for line in result.stdout.splitlines()]

    def test_ina219_units_zero_reverse_overflow_and_unready(self):
        self.probe("decode")

    def test_board_zero_noise_keeps_real_telemetry_and_preserves_raw_diagnostics(self):
        record, raw = self.probe("zero_noise")
        clean = telemetry(record, "solar/home_01/telemetry", {"home_01"})
        self.assertAlmostEqual(clean["solar_power_kw"], .000006, places=10)
        self.assertAlmostEqual(clean["solar_current_a"], .0018, places=8)
        self.assertEqual(clean["load_power_kw"], 0)
        self.assertEqual(clean["load_current_a"], 0)
        self.assertEqual(record["measurement_samples"], 600)
        self.assertAlmostEqual(record["zero_current_deadband_a"], .0005, places=9)
        self.assertLess(raw["load_current_a"], 0)
        self.assertLess(raw["load_power_w"], 0)
        self.assertTrue(raw["load_valid"])

    def test_full_intervals_skip_partial_faults_sampling_gaps_and_clock_jumps(self):
        self.probe("intervals")

    def test_real_firmware_json_accepted_by_backend_without_w_kw_confusion(self):
        first, second = self.probe("telemetry")
        clean = telemetry(first, "solar/home_01/telemetry", {"home_01"})
        self.assertEqual((clean["data_mode"], clean["demo_scenario"]), ("real", "none"))
        self.assertAlmostEqual(clean["solar_power_kw"], .003, places=8)
        self.assertAlmostEqual(clean["load_power_kw"], .001, places=8)
        self.assertAlmostEqual(clean["solar_energy_kwh"], .00025, places=8)
        self.assertAlmostEqual(clean["surplus_energy_kwh"], .002 / 12, places=8)
        expected = datetime.fromtimestamp(1800000000, timezone(timedelta(hours=7))).isoformat()
        self.assertEqual(clean["timestamp"], expected)
        self.assertEqual(first["measurement_samples"], 600)
        self.assertEqual(first["temperature_source"], "unavailable")
        legacy = {k: v for k, v in first.items() if k not in ("temperature_valid", "temperature_samples")}
        self.assertFalse(telemetry(legacy, "solar/home_01/telemetry", {"home_01"})["temperature_valid"])
        self.assertEqual(first["weather_source"], "estimated_from_power")
        self.assertNotEqual(first["event_id"], second["event_id"])

    def test_fast_window_averages_real_reads_into_accelerated_sample_accepted_by_backend(self):
        record, = self.probe("window")
        clean = telemetry(record, "solar/home_01/telemetry", {"home_01"})
        self.assertEqual((clean["data_mode"], clean["demo_scenario"]), ("real", "none"))
        self.assertEqual((clean["time_mode"], clean["sampling_seconds"]), ("accelerated", 5))
        self.assertEqual(clean["interval_seconds"], 300)
        self.assertAlmostEqual(clean["solar_power_kw"], .003, places=8)
        self.assertEqual(record["measurement_samples"], 10)
        self.assertEqual(clean["temperature_source"], "ds18b20")

    def test_live_missing_sensor_is_null_and_clock_does_not_block_measurements(self):
        unsynced, synced = self.probe("live")
        self.assertIsNone(unsynced["timestamp"])
        self.assertFalse(unsynced["time_synced"])
        self.assertEqual(unsynced["solar_power_w"], 3)
        self.assertTrue(unsynced["solar_valid"])
        self.assertFalse(unsynced["load_valid"])
        for suffix in ("power_w", "voltage_v", "current_a"):
            self.assertIsNone(unsynced["load_" + suffix])
        self.assertTrue(synced["load_valid"])
        self.assertEqual(synced["load_power_w"], 0)
        self.assertTrue(synced["time_synced"])

    def test_new_run_restarts_ai_history_and_rejects_late_demo_samples(self):
        self.probe("history")

    def test_temperature_average_missing_sensor_and_backend_provenance(self):
        average, missing, negative, invalid = self.probe("temperature")
        clean = telemetry(average, "solar/home_01/telemetry", {"home_01"})
        self.assertEqual(clean["temperature_c"], 25)
        self.assertEqual(clean["temperature_source"], "ds18b20")
        self.assertTrue(clean["temperature_valid"])
        self.assertEqual(clean["temperature_samples"], 300)
        clean = telemetry(missing, "solar/home_01/telemetry", {"home_01"})
        self.assertEqual(clean["temperature_c"], 0)
        self.assertFalse(clean["temperature_valid"])
        self.assertEqual(clean["temperature_source"], "unavailable")
        self.assertEqual(clean["temperature_samples"], 0)
        self.assertEqual(negative["temperature_c"], -10)
        self.assertTrue(negative["temperature_valid"])
        self.assertIsNone(invalid["temperature_c"])
        self.assertFalse(invalid["temperature_valid"])
        for changed in ({"temperature_valid": False}, {"temperature_c": 126},
                        {"temperature_samples": 0}, {"temperature_source": "simulation"}):
            with self.assertRaises(ValueError):
                telemetry({**average, **changed}, "solar/home_01/telemetry", {"home_01"})
