"""Package portable source for teammates; keep source paths and sanitize network data."""
import argparse
import hashlib
import json
import os
import re
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'submission/p2p-solar-team'
SKIP = {'node_modules', '__pycache__', '.git', '.venv', '.venv-ai', '.venv-backend',
        '.venv-runtime', '.venv-team', '.pytest_cache', '.local', '.vscode', '.pio',
        'managed_components', 'dist', 'test-results', 'cache', '.npm-team-cache'}


def omitted(path):
    if path.parts and path.parts[0] == 'data' and path.as_posix() != 'data/training_30days.csv':
        return True
    return any(part in SKIP or part.startswith('build') for part in path.parts) or \
        path.suffix in {'.pyc', '.tmp', '.log'} or \
        (path.name.startswith('sdkconfig') and path.name not in {'sdkconfig.defaults', 'sdkconfig.team.example'}) or \
        ('artifacts' in path.parts and path.parts[:2] != ('ai_model', 'artifacts'))


def copy_sources(name):
    source = ROOT / name
    for directory, folders, files in os.walk(source):
        folders[:] = [f for f in folders if not omitted((Path(directory) / f).relative_to(ROOT))]
        for name in files:
            src = Path(directory) / name
            rel = src.relative_to(ROOT)
            if omitted(rel) or src.is_symlink():
                continue
            dst = OUTPUT / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)


def sanitized_sdkconfig():
    source = ROOT / 'iot_code/firmware/esp32_edge/sdkconfig.esp32dev_ai'
    text = source.read_text(encoding='utf-8-sig')
    values = {'SOLAR_WIFI_SSID': 'YOUR_WIFI_SSID', 'SOLAR_WIFI_PASSWORD': 'YOUR_WIFI_PASSWORD',
              'SOLAR_MQTT_URI': 'mqtt://192.168.1.10:1885', 'SOLAR_MQTT_USERNAME': 'solar_edge',
              'SOLAR_MQTT_PASSWORD': 'YOUR_MQTT_PASSWORD'}
    for key, value in values.items():
        text, count = re.subn(rf'(?m)^CONFIG_{key}=.*$', lambda m: f'CONFIG_{key}="{value}"', text)
        if count != 1:
            raise ValueError(f'Cannot sanitize firmware field {key}')
    return text


def secrets():
    values = set()
    for file in (ROOT / 'iot_code/firmware/esp32_edge').glob('sdkconfig*'):
        if file.is_file():
            for _, value in re.findall(r'^CONFIG_SOLAR_(WIFI_PASSWORD|MQTT_PASSWORD|WIFI_SSID)="(.*?)"',
                                      file.read_text(encoding='utf-8-sig'), re.M):
                if value and not value.startswith('YOUR_') and len(value) >= 4:
                    values.add(value.encode())
    sketch = (ROOT / 'blockchainV2.ino').read_text(encoding='utf-8-sig')
    for field in ('wifi_ssids', 'wifi_passwords', 'mqtt_password'):
        match = re.search(rf'const char\*\s+{field}(?:\[\])?\s*=\s*([^;]+);', sketch)
        if match:
            values.update(v.encode() for v in re.findall(r'"([^"\r\n]+)"', match[1]) if len(v) >= 4 and not v.startswith('YOUR_'))
    return values


def archive():
    if not (OUTPUT / 'HUONG_DAN_CHAY.md').is_file():
        raise ValueError('Create the package first')
    sensitive = secrets()
    entries = []
    for file in sorted(OUTPUT.rglob('*')):
        if not file.is_file():
            continue
        rel = file.relative_to(OUTPUT)
        if omitted(rel) or rel.as_posix() == 'docs/TEAM_MANIFEST.json':
            continue
        content = file.read_bytes()
        # Avoid treating a password such as a numeric sequence as a leak inside
        # the unrelated hexadecimal alphabet or a model/dataset number.
        if any(re.search(rb'(?<![A-Za-z0-9.])' + re.escape(value) + rb'(?![A-Za-z0-9.])', content)
               for value in sensitive):
            raise ValueError(f'Personal network data detected in {rel}; archive not created')
        entries.append({'path': rel.as_posix(), 'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest()})
    manifest = {'schema_version': 1, 'purpose': 'teammate_12_households_and_one_esp32',
                'modes': ['12_household_software_market', 'one_esp32_int8_demo', 'one_esp32_real_sensors'],
                'hybrid_11_plus_1': False,
                'network_configuration': 'placeholders; generated locally by scripts/configure_team_esp32.ps1',
                'files': entries}
    mp = OUTPUT / 'docs/TEAM_MANIFEST.json'
    mp.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    target = OUTPUT.with_suffix('.zip')
    with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for entry in entries:
            z.write(OUTPUT / entry['path'], OUTPUT.name + '/' + entry['path'])
        z.write(mp, OUTPUT.name + '/docs/TEAM_MANIFEST.json')
    with zipfile.ZipFile(target) as z:
        if z.testzip() is not None:
            raise ValueError('Archive CRC check failed')
        for entry in entries:
            if hashlib.sha256(z.read(OUTPUT.name + '/' + entry['path'])).hexdigest() != entry['sha256']:
                raise ValueError('Archive hash mismatch')
    print(json.dumps({'folder': str(OUTPUT), 'zip': str(target), 'files': len(entries) + 1,
                      'zip_bytes': target.stat().st_size, 'personal_network_scan': 'passed'}, ensure_ascii=False))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--archive-only', action='store_true')
    ap.add_argument('--source-only', action='store_true')
    args = ap.parse_args()
    if args.archive_only:
        archive()
        return
    if OUTPUT.exists():
        ap.error('Team folder already exists; use --archive-only after reviewing updates')
    OUTPUT.mkdir(parents=True)
    for name in ('contracts', 'iot_code', 'firmware', 'ai_model', 'backend', 'blockchain', 'dashboard', 'config', 'tests', 'examples'):
        copy_sources(name)
    (OUTPUT / 'scripts').mkdir()
    for name in ('setup_edge_broker.ps1', 'configure_team_esp32.ps1'):
        shutil.copy2(ROOT / 'scripts' / name, OUTPUT / 'scripts' / name)
    for name in ('package.json', 'package-lock.json', 'hardhat.config.ts', 'requirements.txt', 'mosquitto.conf', '.gitignore'):
        shutil.copy2(ROOT / name, OUTPUT / name)
    sketch = (ROOT / 'blockchainV2.ino').read_text(encoding='utf-8-sig')
    values = {'wifi_ssids': '{"YOUR_WIFI_SSID"}', 'wifi_passwords': '{"YOUR_WIFI_PASSWORD"}',
              'mqtt_server': '"192.168.1.10"', 'mqtt_password': '"YOUR_MQTT_PASSWORD"'}
    for field, value in values.items():
        sketch, count = re.subn(rf'(const char\*\s+{field}(?:\[\])?\s*=\s*)[^;]+;',
                                lambda m: m[1] + value + ';', sketch)
        if count != 1:
            raise ValueError(f'Cannot sanitize sketch field {field}')
    (OUTPUT / 'blockchainV2.ino').write_text(sketch, encoding='utf-8')
    fw = OUTPUT / 'iot_code/firmware/esp32_edge'
    (fw / 'sdkconfig.team.example').write_text(sanitized_sdkconfig(), encoding='utf-8')
    defaults = (fw / 'sdkconfig.defaults').read_text(encoding='utf-8-sig')
    defaults = re.sub(r'(?m)^CONFIG_SOLAR_MQTT_URI=.*$', 'CONFIG_SOLAR_MQTT_URI="mqtt://192.168.1.10:1885"', defaults)
    (fw / 'sdkconfig.defaults').write_text(defaults, encoding='utf-8')
    kconfig = (fw / 'main/Kconfig.projbuild').read_text(encoding='utf-8-sig')
    kconfig = kconfig.replace('mqtt://10.207.103.195:1885', 'mqtt://192.168.1.10:1885')
    (fw / 'main/Kconfig.projbuild').write_text(kconfig, encoding='utf-8')
    # Independent build tree: cannot overwrite the author's existing firmware cache.
    ini = (fw / 'platformio.ini').read_text(encoding='utf-8-sig').replace('/build/solar_edge_ai', '/build/solar_team_edge_ai')
    (fw / 'platformio.ini').write_text(ini, encoding='utf-8')
    for folder, description in [('esp32_edge', 'Firmware chính ESP-IDF: INA219, DS18B20, LCD, relay và AI INT8.'),
                                ('blockchain_v2', 'Firmware Arduino tham chiếu: đủ cảm biến, không có suy luận INT8.')]:
        (OUTPUT / 'firmware' / folder / 'README.md').write_text(
            f'# {folder}\n\n{description}\n\nXem [hướng dẫn đầy đủ](../../HUONG_DAN_CHAY.md) ở gốc gói. '
            'Thông tin Wi-Fi/MQTT là placeholder; cần tự cấu hình trước khi nạp.\n', encoding='utf-8')
    legacy_ini = OUTPUT / 'iot_code/firmware/blockchain_v2/platformio.ini'
    text = legacy_ini.read_text(encoding='utf-8-sig').replace('platform = espressif32\n', 'platform = espressif32@6.13.0\n')
    legacy_ini.write_text(text, encoding='utf-8')
    (OUTPUT / 'docs').mkdir()
    for name in ('MQTT_MARKET_SIMULATION.md', 'MQTT_SIMULATION_VALIDATION.md', 'SMART_CONTRACT_FEATURES.md'):
        shutil.copy2(ROOT / name, OUTPUT / 'docs' / name)
    if (ROOT / 'docs/TEAM_VALIDATION.md').exists():
        shutil.copy2(ROOT / 'docs/TEAM_VALIDATION.md', OUTPUT / 'docs/TEAM_VALIDATION.md')
    shutil.copy2(ROOT / 'docs/HUONG_DAN_CHAY_CHO_NHOM.md', OUTPUT / 'HUONG_DAN_CHAY.md')
    (OUTPUT / 'README.md').write_text('# P2P Solar – gói chạy cho thành viên nhóm\n\n'
        'Bắt đầu với [HUONG_DAN_CHAY.md](HUONG_DAN_CHAY.md).\n\n'
        'Gồm demo MQTT 12 hộ trên máy tính và firmware một ESP32 có INA219, DS18B20, LCD, relay và AI INT8. '
        'Hai demo chạy riêng; chưa có chế độ kết hợp 11+1. Token/chain là thử nghiệm local.\n', encoding='utf-8')
    (OUTPUT / 'data').mkdir()
    shutil.copy2(ROOT / 'data/training_30days.csv', OUTPUT / 'data/training_30days.csv')
    with (OUTPUT / '.gitignore').open('a', encoding='utf-8') as file:
        file.write('\n.venv-team/\n!iot_code/firmware/esp32_edge/sdkconfig.team.example\n!iot_code/firmware/esp32_edge/sdkconfig.defaults\n')
    if not args.source_only:
        archive()
    else:
        print(f'Team source folder created: {OUTPUT}')


if __name__ == '__main__':
    main()
