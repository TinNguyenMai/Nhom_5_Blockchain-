"""Export paired, recorded ESP32 forecasts for the dashboard without retraining."""
import argparse
import csv
import hashlib
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--scores', type=Path, required=True)
    parser.add_argument('--artifacts', type=Path, default=Path(__file__).parent / 'artifacts')
    args = parser.parse_args()
    meta = json.loads((args.artifacts / 'metadata.json').read_text(encoding='utf-8'))
    with args.scores.open(encoding='utf-8-sig', newline='') as stream:
        rows = list(csv.DictReader(stream))
    if not rows or any(r['model_version'] != meta['model_version'] or r['device_kind'] != 'esp32' for r in rows):
        raise ValueError('Expected paired ESP32 measurements for the delivered model')
    runs = {r['run_id'] for r in rows}
    if len(runs) != 1 or len({r['target_timestamp'] for r in rows}) != len(rows):
        raise ValueError('Expected one run with unique target timestamps')
    rows.sort(key=lambda r: r['target_timestamp'])
    points = []
    for row in rows:
        point = {'timestamp': row['target_timestamp']}
        for field in ('solar', 'load'):
            actual = float(row[f'actual_{field}_kw'])
            point[field] = {'actual': actual, 'int8': float(row[f'predicted_{field}_kw']),
                            'persistence': actual + float(row[f'persistence_{field}_error_kw'])}
        points.append(point)
    result = {'model_version': meta['model_version'], 'source_kind': 'recorded_esp32_demo',
              'run_id': runs.pop(), 'source_file': args.scores.as_posix(),
              'source_sha256': hashlib.sha256(args.scores.read_bytes()).hexdigest(),
              'notes': 'Dự báo INT8 ghi nhận từ ESP32 trên telemetry mô phỏng; phiên demo đã lưu, không phải lượt thị trường hiện tại hoặc tập test 5 ngày.',
              'interval_seconds': 300, 'points': points}
    destination = args.artifacts / 'visualization.json'
    destination.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'Exported {len(points)} paired targets to {destination}')


if __name__ == '__main__':
    main()
