"""Real MQTT transport test with CPU reference, never labelled as board proof."""
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
import importlib.util
try:
    from mqtt_test_broker import Broker
except ImportError:
    Broker = None

ROOT = Path(__file__).resolve().parent.parent


@unittest.skipUnless(sys.platform != "win32" and Broker and importlib.util.find_spec("tensorflow"), "POSIX signal integration test; requires amqtt==0.11.3 and TensorFlow")
class EdgeMQTTTests(unittest.IsolatedAsyncioTestCase):
    async def test_simulator_reference_monitor(self):
        logging.getLogger("amqtt").setLevel(logging.ERROR)
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0)); port = probe.getsockname()[1]
        broker = Broker({"listeners": {"default": {"type": "tcp", "bind": f"127.0.0.1:{port}"}}, "plugins": {"amqtt.plugins.authentication.AnonymousAuthPlugin": {"allow_anonymous": True}}})
        await asyncio.wait_for(broker.start(), 10)
        processes, tasks = [], []
        async def start(module, *args):
            print(f"Starting {module}", flush=True)
            process = await asyncio.create_subprocess_exec(sys.executable, "-u", "-m", module, "--port", str(port), *args, cwd=ROOT, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
            processes.append(process)
            lines = []
            async def drain():
                async for line in process.stdout:
                    lines.append(line.decode().strip())
                    if lines[-1].startswith(("READY", "ERROR", "Traceback")):
                        print(f"{module}: {lines[-1]}", flush=True)
            tasks.append(asyncio.create_task(drain()))
            return process, lines
        async def until(predicate, seconds=45):
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                if predicate(): return
                await asyncio.sleep(.05)
            self.fail(f"MQTT pipeline timed out; monitor={monitor_logs}; reference={reference_logs}")
        try:
            with tempfile.TemporaryDirectory() as temp:
                folder = Path(temp)
                monitor, monitor_logs = await start("iot_code.edge_monitor", "--headless", "--allow-pc-reference", "--output-dir", str(folder / "edge"))
                reference, reference_logs = await start("ai_model.pc_reference")
                await until(lambda: any(s.startswith("READY") for s in monitor_logs) and any(s.startswith("READY") for s in reference_logs))
                simulator, simulator_logs = await start("iot_code.simulator", "--config", str(ROOT / "config/edge_demo.json"), "--dataset", "--steps", "30", "--interval", "0.2", "--quiet", "--run-dir", str(folder / "runs"))
                self.assertEqual(await asyncio.wait_for(simulator.wait(), 30), 0)
                await until(lambda: sum(s.startswith("SCORED") for s in monitor_logs) == 18)
                for process in (reference, monitor):
                    process.send_signal(signal.SIGINT)
                    self.assertEqual(await asyncio.wait_for(process.wait(), 10), 0)
                summary = json.loads((folder / "edge/summary.json").read_text())
                self.assertEqual(summary["accepted_predictions"], 19)
                self.assertEqual(summary["pending_without_actual"], 1)
                self.assertEqual(summary["late_excluded"], 0)
                with (folder / "edge/scores.csv").open() as stream: rows = list(csv.DictReader(stream))
                self.assertEqual(len(rows), 18)
                self.assertTrue(all(row["device_kind"] == "pc_reference" for row in rows))
        finally:
            for process in processes:
                if process.returncode is None:
                    process.terminate()
                    try: await asyncio.wait_for(process.wait(), 5)
                    except asyncio.TimeoutError:
                        process.kill(); await process.wait()
            await asyncio.gather(*tasks, return_exceptions=True)
            await asyncio.wait_for(broker.shutdown(), 10)
