"""CPU reference only. The deployed board uses the embedded C++ interpreter."""
from datetime import timedelta
import json
from pathlib import Path
import time
import numpy as np

from .features import HOUSE, STEP, History, parse_time, quantize, postprocess

ARTIFACTS = Path(__file__).resolve().parent / "artifacts"


class Predictor:
    def __init__(self, artifacts=ARTIFACTS):
        import tensorflow as tf
        self.metadata = json.loads((artifacts / "metadata.json").read_text(encoding="utf-8"))
        self.model_bytes = (artifacts / "model_int8.tflite").stat().st_size
        self.interpreter = tf.lite.Interpreter(model_path=str(artifacts / "model_int8.tflite"), num_threads=1)
        self.interpreter.allocate_tensors()
        self.input = self.interpreter.get_input_details()[0]
        self.output = self.interpreter.get_output_details()[0]
        self.history = History()

    def add(self, row):
        vector = self.history.add(row)
        if vector is None:
            return None
        quantized = quantize(vector, *self.input["quantization"])
        self.interpreter.set_tensor(self.input["index"], quantized[None, :])
        before = time.perf_counter_ns()
        self.interpreter.invoke()
        elapsed = (time.perf_counter_ns() - before) / 1000
        scale, zero = self.output["quantization"]
        residual = (self.interpreter.get_tensor(self.output["index"])[0].astype(np.float32) - zero) * scale
        solar, load = postprocess(residual, row, self.metadata["output_scale"])
        scale, zero = self.input["quantization"]
        raw = np.asarray(vector) / scale + zero
        return {
            "schema_version": 1, "household_id": HOUSE, "run_id": row["run_id"],
            "input_event_id": row["event_id"], "input_timestamp": row["timestamp"],
            "target_timestamp": (parse_time(row["timestamp"]) + timedelta(seconds=STEP)).isoformat(),
            "interval_seconds": STEP, "model_version": self.metadata["model_version"],
            "device_kind": "pc_reference", "device_id": "pc-reference",
            "predicted_solar_kw": solar, "predicted_load_kw": load,
            "predicted_net_kw": solar - load, "predicted_surplus_kwh": max(0, solar - load) / 12,
            "inference_us": elapsed, "arena_used_bytes": None, "free_heap_bytes": None,
            "clipped_features": int(np.count_nonzero((raw < -128.5) | (raw > 127.5))),
            "model_bytes": self.model_bytes,
        }
