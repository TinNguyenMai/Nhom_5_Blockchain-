"""Train chronological 20/5/5-day split and export an integer-only TFLite MLP."""
import argparse
import csv
from datetime import timedelta
import hashlib
import json
import os
from pathlib import Path

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
os.environ.setdefault("TF_NUM_INTEROP_THREADS", "1")
os.environ.setdefault("TF_NUM_INTRAOP_THREADS", "1")
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("TF_ENABLE_ONEDNN_OPTS", "0")
import numpy as np
import tensorflow as tf

from .features import HOUSE, WINDOW, STEP, FIELDS, N_FEATURES, History, parse_time, quantize, postprocess

ROOT = Path(__file__).resolve().parent.parent


def load_dataset(path):
    with path.open(encoding="utf-8-sig", newline="") as stream:
        rows = [row for row in csv.DictReader(stream) if row["household_id"] == HOUSE]
    if len(rows) != 30 * 288 or len({r["run_id"] for r in rows}) != 1:
        raise ValueError("Expected exactly one complete 30-day run for home_01 (8640 rows)")
    rows.sort(key=lambda row: parse_time(row["timestamp"]))
    start = parse_time(rows[0]["timestamp"])
    if (start.hour, start.minute, start.second) != (0, 0, 0):
        raise ValueError("30-day dataset must start at midnight")
    history = History()
    x, y, previous, stamps = [], [], [], []
    for i, row in enumerate(rows):
        if parse_time(row["timestamp"]) != start + timedelta(seconds=i * STEP):
            raise ValueError("Duplicate or missing interval in dataset")
        vector = history.add(row)
        if vector is not None and i + 1 < len(rows):
            target = rows[i + 1]
            x.append(vector)
            y.append([float(target[k]) for k in FIELDS[:2]])
            previous.append([float(row[k]) for k in FIELDS[:2]])
            stamps.append(parse_time(target["timestamp"]))
    x, y, previous = [np.asarray(v, dtype=np.float32) for v in (x, y, previous)]
    masks = {
        "train": np.asarray([t < start + timedelta(days=20) for t in stamps]),
        "validation": np.asarray([start + timedelta(days=20) <= t < start + timedelta(days=25) for t in stamps]),
        "test": np.asarray([t >= start + timedelta(days=25) for t in stamps]),
    }
    return rows, x, y, previous, stamps, masks


def scores(truth, prediction):
    difference = prediction - truth
    return {name: {"mae_kw": float(np.mean(np.abs(difference[:, i]))),
                   "rmse_kw": float(np.sqrt(np.mean(difference[:, i] ** 2)))}
            for i, name in enumerate(("solar", "load"))}


def interpreter_for(content):
    interpreter = tf.lite.Interpreter(model_content=content, num_threads=1)
    interpreter.allocate_tensors()
    return interpreter


def infer(interpreter, x):
    a, b = interpreter.get_input_details()[0], interpreter.get_output_details()[0]
    output = []
    for row in x:
        data = quantize(row, *a["quantization"]) if a["dtype"] == np.int8 else row.astype(np.float32)
        interpreter.set_tensor(a["index"], data[None, :])
        interpreter.invoke()
        result = interpreter.get_tensor(b["index"])[0].astype(np.float32)
        if b["dtype"] == np.int8:
            scale, zero = b["quantization"]
            result = (result - zero) * scale
        output.append(result)
    return np.asarray(output)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", type=Path, default=Path("data/training_30days.csv"))
    parser.add_argument("--output", type=Path, default=ROOT / "ai_model/artifacts")
    parser.add_argument("--epochs", type=int, default=180)
    args = parser.parse_args()
    tf.keras.utils.set_random_seed(42)
    tf.config.experimental.enable_op_determinism()
    rows, x, y, previous, stamps, masks = load_dataset(args.csv)
    train, val, test = [masks[k] for k in ("train", "validation", "test")]
    output_scale = np.maximum(np.std((y - previous)[train], axis=0), .01).astype(np.float32)
    target = (y - previous) / output_scale
    inputs = tf.keras.Input(shape=(N_FEATURES,), name="history")
    z = tf.keras.layers.Dense(32, activation="relu")(inputs)
    z = tf.keras.layers.Dense(16, activation="relu")(z)
    outputs = tf.keras.layers.Dense(2, name="next_delta")(z)
    model = tf.keras.Model(inputs, outputs)
    model.compile(optimizer=tf.keras.optimizers.Adam(.001), loss="mse")
    rng = np.random.default_rng(42)
    best_loss, best_weights, best_epoch, stale = float("inf"), None, 0, 0
    indices = np.flatnonzero(train)
    # Explicit batches avoid large tf.data thread pools on small CPU machines.
    for epoch in range(args.epochs):
        rng.shuffle(indices)
        for offset in range(0, len(indices), 128):
            batch = indices[offset:offset + 128]
            model.train_on_batch(x[batch], target[batch])
        val_pred = model(x[val], training=False).numpy()
        val_loss = float(np.mean((val_pred - target[val]) ** 2))
        if val_loss < best_loss - .0001:
            best_loss, best_weights, best_epoch, stale = val_loss, model.get_weights(), epoch + 1, 0
        else:
            stale += 1
        if epoch % 10 == 0:
            print(f"epoch={epoch + 1} validation_mse={val_loss:.5f}", flush=True)
        if stale >= 25:
            break
    model.set_weights(best_weights)
    args.output.mkdir(parents=True, exist_ok=True)
    model.save(args.output / "model.keras")
    converter = tf.lite.TFLiteConverter.from_keras_model(model)
    fp32 = converter.convert()
    converter = tf.lite.TFLiteConverter.from_keras_model(model)
    calibration = x[train][np.linspace(0, train.sum() - 1, 512, dtype=int)]
    converter.optimizations = [tf.lite.Optimize.DEFAULT]
    converter.representative_dataset = lambda: ([row[None, :]] for row in calibration)
    converter.target_spec.supported_ops = [tf.lite.OpsSet.TFLITE_BUILTINS_INT8]
    converter.inference_input_type = tf.int8
    converter.inference_output_type = tf.int8
    integer = converter.convert()
    (args.output / "model_fp32.tflite").write_bytes(fp32)
    (args.output / "model_int8.tflite").write_bytes(integer)
    fp, q = interpreter_for(fp32), interpreter_for(integer)
    # Enforce the firmware's tiny resolver and full integer execution.
    ops = sorted({op["op_name"] for op in q._get_ops_details() if op["op_name"] != "DELEGATE"})
    if ops != ["FULLY_CONNECTED"] or any(t["dtype"] == np.float32 for t in q.get_tensor_details()):
        raise RuntimeError(f"Unsupported integer model: {ops}")
    metrics = {"notes": "Synthetic simulator data, chronological held-out test; not real-sensor accuracy.",
               "best_epoch": best_epoch, "parameters": model.count_params(),
               "model_bytes": {"fp32": len(fp32), "int8": len(integer)}, "splits": {}}
    for name in ("validation", "test"):
        mask = masks[name]
        result = {"persistence": scores(y[mask], previous[mask])}
        for label, interpreter in (("fp32", fp), ("int8", q)):
            pred = np.maximum(0, previous[mask] + infer(interpreter, x[mask]) * output_scale)
            result[label] = scores(y[mask], pred)
        metrics["splits"][name] = result
    model_hash = hashlib.sha256(integer).hexdigest()
    metadata = {
        "model_version": "home01-next5m-int8-" + model_hash[:12],
        "model_sha256": model_hash, "dataset_sha256": hashlib.sha256(args.csv.read_bytes()).hexdigest(),
        "household_id": HOUSE, "window": WINDOW, "interval_seconds": STEP,
        "feature_contract": "v1", "n_features": N_FEATURES, "fields": list(FIELDS),
        "output_kind": "residual_added_to_last_power", "output_scale": output_scale.tolist(),
        "ops": ops, "input_quantization": list(q.get_input_details()[0]["quantization"]),
        "output_quantization": list(q.get_output_details()[0]["quantization"]),
        "training_config": {"pv_kw": 4.0, "base_load_kw": .65, "pv_enabled": True, "load_multiplier": 1.0, "weather": "auto"},
        "split": {name: {"samples": int(mask.sum()), "first_target": stamps[np.flatnonzero(mask)[0]].isoformat(), "last_target": stamps[np.flatnonzero(mask)[-1]].isoformat()} for name, mask in masks.items()},
        "tensorflow_version": tf.__version__, "keras_version": tf.keras.__version__, "seed": 42,
    }
    (args.output / "metadata.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    (args.output / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    # A daylight vector from TRAIN data: the board checks its kernel output at boot.
    index = next(i for i in range(len(x)) if train[i] and previous[i, 0] > 1.5)
    a, b = q.get_input_details()[0], q.get_output_details()[0]
    vector = quantize(x[index], *a["quantization"])
    q.set_tensor(a["index"], vector[None, :]); q.invoke()
    expected = q.get_tensor(b["index"])[0].tolist()
    golden = {"features": x[index].tolist(), "input_int8": vector.tolist(), "output_int8": expected}
    (args.output / "selftest.json").write_text(json.dumps(golden, indent=2), encoding="utf-8")
    header = "// Generated by python -m ai_model.train; do not edit.\n#pragma once\n#include <cstdint>\n"
    header += f'constexpr char kModelVersion[] = "{metadata["model_version"]}";\n'
    header += f'constexpr float kOutputScale[2] = {{{output_scale[0]:.9g}f, {output_scale[1]:.9g}f}};\n'
    header += "alignas(16) const unsigned char kModel[] = {\n"
    header += "\n".join(",".join(str(v) for v in integer[i:i + 24]) + "," for i in range(0, len(integer), 24)) + "\n};\n"
    header += "constexpr int8_t kSelfTestInput[] = {" + ",".join(map(str, vector.tolist())) + "};\n"
    header += "constexpr int8_t kSelfTestExpected[] = {" + ",".join(map(str, expected)) + "};\n"
    firmware = ROOT / "iot_code/firmware/esp32_edge/main/model_data.h"
    firmware.parent.mkdir(parents=True, exist_ok=True)
    firmware.write_text(header, encoding="utf-8")
    print(json.dumps(metrics, indent=2), flush=True)


if __name__ == "__main__":
    main()
