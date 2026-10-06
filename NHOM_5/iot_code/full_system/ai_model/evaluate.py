"""Re-evaluate the delivered models without retraining or selecting on test data."""
import argparse
import hashlib
import json
from pathlib import Path
from .train import load_dataset, interpreter_for, infer, scores, np


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", type=Path, default=Path("data/training_30days.csv"))
    parser.add_argument("--artifacts", type=Path, default=Path(__file__).resolve().parent / "artifacts")
    args = parser.parse_args()
    meta = json.loads((args.artifacts / "metadata.json").read_text())
    if hashlib.sha256(args.csv.read_bytes()).hexdigest() != meta["dataset_sha256"]:
        parser.error("Dataset differs from the recorded training dataset; do not reuse the recorded split blindly.")
    _, x, y, previous, stamps, masks = load_dataset(args.csv)
    test = masks["test"]
    prediction = {"persistence": previous[test]}
    for name in ("fp32", "int8"):
        interpreter = interpreter_for((args.artifacts / f"model_{name}.tflite").read_bytes())
        prediction[name] = np.maximum(0, previous[test] + infer(interpreter, x[test]) * meta["output_scale"])
    truth = y[test]
    results = {"model_version": meta["model_version"], "dataset_sha256": meta["dataset_sha256"], "test": {}}
    for period, mask in (("all", np.ones(len(truth), dtype=bool)), ("daylight", truth[:, 0] > 0), ("night", truth[:, 0] == 0)):
        results["test"][period] = {"samples": int(mask.sum()), **{name: scores(truth[mask], values[mask]) for name, values in prediction.items()}}
    destination = args.artifacts / "evaluation.json"
    destination.write_text(json.dumps(results, indent=2), encoding="utf-8")
    targets = [stamp for stamp, selected in zip(stamps, test) if selected]
    visualization = {"model_version": meta["model_version"], "dataset_sha256": meta["dataset_sha256"],
        "source_kind": "held_out_test", "interval_seconds": 300,
        "notes": "Tập test 5 ngày theo thời gian của Nhà 1; dữ liệu mô phỏng, không phải số đo cảm biến thật hoặc lượt thị trường hiện tại.",
        "points": [{"timestamp": stamp.isoformat(), **{field: {"actual": float(truth[i, j]),
            **{name: float(values[i, j]) for name, values in prediction.items()}}
            for j, field in enumerate(("solar", "load"))}} for i, stamp in enumerate(targets)]}
    (args.artifacts / "visualization.json").write_text(json.dumps(visualization, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
