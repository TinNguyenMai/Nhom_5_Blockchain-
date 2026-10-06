import copy
import csv
from datetime import datetime, timedelta, timezone
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from ai_model.features import History, feature_vector, validate_reading, quantize
from iot_code.model import SolarModel
from iot_code.edge_monitor import Scoreboard

ROOT = Path(__file__).resolve().parent.parent
RUN = "1" * 32


def readings(count=30, start="2026-09-05T23:00:00+07:00"):
    model = SolarModel()
    stamp = datetime.fromisoformat(start)
    return [list(model.generate(stamp + timedelta(minutes=5*i), 300, RUN, i))[0] for i in range(count)]


def prediction(row):
    return {"schema_version": 1, "household_id": "home_01", "run_id": row["run_id"], "input_event_id": row["event_id"],
            "input_timestamp": row["timestamp"], "target_timestamp": (datetime.fromisoformat(row["timestamp"]) + timedelta(minutes=5)).isoformat(),
            "interval_seconds": 300, "model_version": "test-only", "device_kind": "esp32", "device_id": "test-device", "predicted_solar_kw": 1.,
            "predicted_load_kw": .5, "predicted_net_kw": .5, "predicted_surplus_kwh": .5/12, "inference_us": 100}


class EdgeTests(unittest.TestCase):
    def test_history_duplicates_gaps_runs_and_midnight(self):
        rows = readings()
        history = History()
        for row in rows[:11]:
            self.assertIsNone(history.add(row))
        result = history.add(rows[11])
        self.assertEqual(len(result), 53)
        self.assertEqual(result[-1], 1) # Sunday midnight is weekend.
        self.assertIsNone(history.add(rows[11]))
        self.assertIsNone(history.add(rows[9]))
        self.assertEqual(len(history.rows), 12)
        self.assertIsNone(history.add(rows[13])) # Lost one packet.
        self.assertEqual(len(history.rows), 1)
        new = dict(rows[0], run_id="2" * 32, event_id="2" * 32 + ":home_01:0")
        self.assertIsNone(history.add(new)); self.assertEqual(len(history.rows), 1)
        self.assertIsNone(history.add(rows[14])) # Old run must not return.
        self.assertEqual(history.rows[0]["run_id"], "2" * 32)

    def test_invalid_input_rejected(self):
        row = readings(1)[0]
        for key, value in (("cloud_cover", float("nan")), ("interval_seconds", 60), ("timestamp", "2026-09-01T00:00:00+00:00"), ("event_id", "bad"), ("solar_power_kw", -1)):
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate_reading(dict(row, **{key: value}))
        with self.assertRaises(ValueError): validate_reading([])

    def test_no_future_fields_enter_features(self):
        rows = readings(13)
        vector = feature_vector(rows[:12])
        rows[12]["solar_power_kw"] = 999
        for row in rows[:12]:
            row["published_at"] = "2030-01-01T00:00:00Z"
            row["net_power_kw"] = -99
        self.assertEqual(vector, feature_vector(rows[:12]))

    def test_monitor_matches_once_and_excludes_late_forecasts(self):
        rows = readings(4)
        with tempfile.TemporaryDirectory() as temp:
            board = Scoreboard(Path(temp) / "new")
            board.receive("solar/home_01/telemetry", rows[0])
            p = prediction(rows[0])
            board.receive("solar/home_01/prediction", p)
            board.receive("solar/home_01/prediction", p)
            board.receive("solar/home_01/telemetry", rows[1])
            board.receive("solar/home_01/telemetry", rows[1])
            board.receive("solar/home_01/telemetry", rows[2])
            board.receive("solar/home_01/prediction", prediction(rows[1]))
            pc = dict(prediction(rows[2]), device_kind="pc_reference", device_id="pc")
            board.receive("solar/home_01/prediction", pc)
            self.assertEqual(board.accepted, 2)
            self.assertEqual(board.late, 1)
            self.assertTrue(all(v["count"] == 1 for v in board.summary()["metrics"].values()))
            self.assertEqual(len(board.pending), 0)
            board.close()
            with (Path(temp) / "new/scores.csv").open() as stream:
                self.assertEqual(len(list(csv.DictReader(stream))), 2)
            with self.assertRaises(FileExistsError): Scoreboard(Path(temp) / "new")

    @unittest.skipUnless(shutil.which("g++") and importlib.util.find_spec("numpy"), "Requires C++ compiler and numpy")
    def test_firmware_python_feature_and_quantization_parity(self):
        import numpy as np
        metadata = json.loads((ROOT / "ai_model/artifacts/metadata.json").read_text())
        scale, zero = metadata["input_quantization"]
        cases = [readings(12, start) for start in ("2026-09-04T23:00:00+07:00", "2026-09-06T23:00:00+07:00", "2026-09-02T11:00:00+07:00", "2028-02-29T23:00:00+07:00")]
        data = [f"{len(cases)} {scale:.12g} {zero}"]
        for rows in cases:
            for row in rows:
                local = datetime.fromisoformat(row["timestamp"]).replace(tzinfo=timezone.utc).timestamp()
                data.append(" ".join(map(str, (int(local), row["solar_power_kw"], row["load_power_kw"], row["irradiance_w_m2"], row["cloud_cover"]))))
        with tempfile.TemporaryDirectory() as temp:
            binary = str(Path(temp) / "probe")
            subprocess.run(["g++", "-std=c++17", "-O2", "-Wall", "-Wextra", "-Werror", "-I", str(ROOT / "iot_code/firmware/esp32_edge/main"), str(ROOT / "tests/edge_features_probe.cc"), "-o", binary], check=True, capture_output=True)
            result = subprocess.run([binary], input="\n".join(data), text=True, capture_output=True, check=True)
        for rows, line in zip(cases, result.stdout.splitlines()):
            values = np.asarray([float(v) for v in line.split()])
            expected = np.asarray(feature_vector(rows), dtype=np.float32)
            np.testing.assert_allclose(values[:53], expected, atol=1e-7)
            np.testing.assert_array_equal(values[53:], quantize(expected, scale, zero))

    @unittest.skipUnless(importlib.util.find_spec("tensorflow"), "Requires ai_model/requirements.txt")
    def test_saved_model_selftest_and_runtime_contract(self):
        import hashlib
        import numpy as np
        from ai_model.predictor import Predictor, ARTIFACTS
        predictor = Predictor()
        golden = json.loads((ARTIFACTS / "selftest.json").read_text())
        self.assertEqual(hashlib.sha256((ARTIFACTS / "model_int8.tflite").read_bytes()).hexdigest(), predictor.metadata["model_sha256"])
        self.assertEqual(predictor.input["dtype"], np.int8)
        self.assertEqual(predictor.output["dtype"], np.int8)
        predictor.interpreter.set_tensor(predictor.input["index"], np.asarray([golden["input_int8"]], dtype=np.int8))
        predictor.interpreter.invoke()
        np.testing.assert_array_equal(predictor.interpreter.get_tensor(predictor.output["index"])[0], golden["output_int8"])
        for row in readings(12, "2026-09-02T11:00:00+07:00"):
            result = predictor.add(row)
        self.assertEqual(result["device_kind"], "pc_reference")
        self.assertEqual(result["target_timestamp"], "2026-09-02T12:00:00+07:00")
        self.assertIsNone(result["arena_used_bytes"])


if __name__ == "__main__":
    unittest.main()
