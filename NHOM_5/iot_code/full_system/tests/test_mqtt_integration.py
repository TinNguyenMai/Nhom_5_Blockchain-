"""Optional integration test: pip install amqtt==0.11.3 in a test environment."""
import asyncio
import csv
import json
import logging
from pathlib import Path
import signal
import socket
import sys
import tempfile
import time
import unittest
import uuid

import paho.mqtt.client as mqtt
from iot_code.config import load_config

try:
    from mqtt_test_broker import Broker
except ImportError:
    Broker = None

ROOT = Path(__file__).resolve().parent.parent


@unittest.skipIf(Broker is None, "Integration test optional: requires amqtt==0.11.3")
class MQTTTests(unittest.IsolatedAsyncioTestCase):
    async def test_control_and_dataset_pipeline(self):
        logging.getLogger("amqtt").setLevel(logging.ERROR)
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        broker = Broker({"listeners": {"default": {"type": "tcp", "bind": f"127.0.0.1:{port}"}}, "plugins": {"amqtt.plugins.authentication.AnonymousAuthPlugin": {"allow_anonymous": True}}})
        await broker.start()
        processes, tasks = [], []
        mailbox = asyncio.Queue()
        loop = asyncio.get_running_loop()
        watcher = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)

        def on_connect(client, userdata, flags, reason_code, properties):
            client.subscribe("solar/simulator/#", qos=1)

        def on_message(client, userdata, message):
            loop.call_soon_threadsafe(mailbox.put_nowait, (message.topic, json.loads(message.payload)))

        watcher.on_connect, watcher.on_message = on_connect, on_message
        watcher.connect("127.0.0.1", port)
        watcher.loop_start()

        async def start(module, *arguments):
            process = await asyncio.create_subprocess_exec(sys.executable, "-u", "-m", module, "--port", str(port), *arguments, cwd=ROOT, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
            processes.append(process)
            lines = []
            async def drain():
                async for line in process.stdout:
                    lines.append(line.decode().strip())
            tasks.append(asyncio.create_task(drain()))
            return process, lines

        async def until(predicate, seconds=10):
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                if predicate():
                    return
                await asyncio.sleep(.025)
            self.fail("Timed out waiting for pipeline condition")

        async def message(predicate):
            async def receive():
                while True:
                    topic, data = await mailbox.get()
                    if predicate(topic, data):
                        return data
            return await asyncio.wait_for(receive(), 10)

        async def command(run_id, action, **values):
            payload = {"request_id": uuid.uuid4().hex, "run_id": run_id, "issued_at": time.time(), "action": action, **values}
            info = watcher.publish(f"solar/simulator/{run_id}/command", json.dumps(payload), qos=1)
            await asyncio.to_thread(info.wait_for_publish, 5)
            return await message(lambda topic, data: topic.endswith("/ack") and data.get("request_id") == payload["request_id"])

        try:
            with tempfile.TemporaryDirectory(prefix="solar-test-") as directory:
                folder = Path(directory)
                config = load_config()
                config["simulation"]["publish_interval_seconds"] = .15
                config["homes"].append({**config["homes"][0], "id": "home_04", "name": "Nhà 4"})
                config_path = folder / "homes.json"
                config_path.write_text(json.dumps(config), encoding="utf-8")
                csv_path = folder / "telemetry.csv"
                common = ["--config", str(config_path)]
                def rows():
                    if not csv_path.exists():
                        return []
                    with csv_path.open() as stream:
                        return list(csv.DictReader(stream))
                collector, logs = await start("iot_code.subscriber", *common, "--output", str(csv_path))
                await until(lambda: any(line.startswith("READY") for line in logs))
                simulator, simlogs = await start("iot_code.simulator", *common, "--paused", "--quiet", "--run-dir", str(folder / "runs"))
                state = await message(lambda topic, data: topic.endswith("/state") and data.get("status") == "paused")
                run_id = state["run_id"]
                self.assertEqual(len(rows()), 0)
                self.assertTrue((await command(run_id, "weather", value="sunny"))["ok"])
                self.assertTrue((await command(run_id, "home", household_id="home_04", changes={"pv_enabled": False, "load_multiplier": 2}))["ok"])
                self.assertFalse((await command(run_id, "interval", value=-1))["ok"])
                watcher.publish(f"solar/simulator/{run_id}/command", '{"issued_at": NaN}', qos=1)
                self.assertTrue((await command(run_id, "resume"))["ok"])
                await until(lambda: len(rows()) >= 8)
                self.assertTrue((await command(run_id, "pause"))["ok"])
                await asyncio.sleep(.1)
                paused_rows = len(rows())
                await asyncio.sleep(.3)
                self.assertEqual(len(rows()), paused_rows)
                self.assertEqual(paused_rows % 4, 0)
                self.assertTrue(all(float(row["solar_power_kw"]) == 0 for row in rows() if row["household_id"] == "home_04"))
                # Re-enable the same PV through MQTT, without resetting its load.
                self.assertTrue((await command(run_id, "home", household_id="home_04", changes={"pv_enabled": True}))["ok"])
                state = await message(lambda topic, data: topic.endswith("/state") and data.get("homes", {}).get("home_04", {}).get("pv_enabled") is True)
                self.assertEqual(state["homes"]["home_04"]["load_multiplier"], 2)
                self.assertEqual(state["status"], "paused")
                self.assertTrue((await command(run_id, "resume"))["ok"])
                await until(lambda: any(float(row["solar_power_kw"]) > 0 for row in rows()[paused_rows:] if row["household_id"] == "home_04"))
                self.assertTrue((await command(run_id, "pause"))["ok"])
                await asyncio.sleep(.1)
                paused_rows = len(rows())
                self.assertTrue((await command(run_id, "interval", value=.2))["ok"])
                self.assertTrue((await command(run_id, "weather", value="rainy"))["ok"])
                self.assertTrue((await command(run_id, "resume"))["ok"])
                await until(lambda: len(rows()) > paused_rows)
                self.assertTrue((await command(run_id, "stop"))["ok"])
                await asyncio.wait_for(simulator.wait(), 5)
                self.assertEqual(simulator.returncode, 0, simlogs)
                await asyncio.sleep(.1)
                before_dataset = len(rows())
                self.assertEqual(before_dataset % 4, 0)
                self.assertTrue(any(float(row["cloud_cover"]) == .95 for row in rows()))
                self.assertTrue((folder / "runs" / f"{run_id}.commands.jsonl").exists())
                dataset, dslogs = await start("iot_code.simulator", *common, "--dataset", "--steps", "12", "--interval", "0.05", "--quiet", "--run-dir", str(folder / "runs"))
                state = await message(lambda topic, data: topic.endswith("/state") and data.get("run_id") != run_id and "controls_enabled" in data)
                self.assertFalse(state["controls_enabled"])
                self.assertFalse((await command(state["run_id"], "pause"))["ok"])
                await asyncio.wait_for(dataset.wait(), 10)
                self.assertEqual(dataset.returncode, 0, dslogs)
                await until(lambda: len(rows()) == before_dataset + 48)
                self.assertEqual(len({row["event_id"] for row in rows()}), len(rows()))
                self.assertTrue(any("12 khoang do, 48 ban tin" in line for line in dslogs))
                if sys.platform != "win32":
                    collector.send_signal(signal.SIGINT)
                else:
                    collector.terminate()
                await asyncio.wait_for(collector.wait(), 5)
        finally:
            for process in processes:
                if process.returncode is None:
                    process.terminate()
                    await process.wait()
            for task in tasks:
                await task
            watcher.disconnect()
            watcher.loop_stop()
            await broker.shutdown()
