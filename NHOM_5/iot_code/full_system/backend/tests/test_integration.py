"""Real MQTT + actual simulator + HTTP + restart. Forecasts are test fixtures,
not model inference, and do not establish ESP32 hardware performance.
"""
import asyncio
import json
import os
from pathlib import Path
import signal
import socket
import sys
import tempfile
import threading
import unittest

import httpx
import paho.mqtt.client as mqtt
from amqtt.broker import Broker as AMQTTBroker

from backend.settings import ROOT
from test_backend import prediction


class Broker(AMQTTBroker):
    """Close all test transports, including connections without MQTT CONNECT."""
    def __init__(self, config):
        super().__init__(config)
        self.writers = set()

    async def stream_connected(self, reader, writer, listener_name):
        self.writers.add(writer)
        try:
            await super().stream_connected(reader, writer, listener_name)
        finally:
            writer.close()
            await writer.wait_closed()
            self.writers.discard(writer)

    async def shutdown(self):
        for writer in list(self.writers):
            writer.close()
        await super().shutdown()


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Integration(unittest.IsolatedAsyncioTestCase):
    async def test_mqtt_simulator_http_restart(self):
        mqtt_port, http_port = free_port(), free_port()
        broker = Broker({"listeners": {"default": {"type": "tcp", "bind": f"127.0.0.1:{mqtt_port}"}},
                         "plugins": {"amqtt.plugins.authentication.AnonymousAuthPlugin": {"allow_anonymous": True}}})
        fixture = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="wire-fixture-only")
        subscribed = threading.Event()
        sample_count = [0]

        def on_connect(c, u, f, r, p):
            c.subscribe("solar/home_01/telemetry", 1)

        def on_message(c, u, msg):
            row = json.loads(msg.payload)
            sample_count[0] += 1
            if sample_count[0] >= 12:
                # Emulate only the wire format. Never label this test as AI/board validation.
                payload = json.dumps(prediction(row)).encode()
                c.publish("solar/home_01/prediction", payload, qos=1)
                c.publish("solar/home_01/prediction", payload, qos=1)

        fixture.on_connect = on_connect
        fixture.on_subscribe = lambda c, u, m, r, p: subscribed.set()
        fixture.on_message = on_message
        fixture.connect_async("127.0.0.1", mqtt_port)
        fixture.loop_start()
        processes, tasks, logs = [], [], []

        async def spawn(*args):
            proc = await asyncio.create_subprocess_exec(sys.executable, "-u", *args, cwd=ROOT,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
            processes.append(proc)
            async def drain():
                async for line in proc.stdout:
                    logs.append(line.decode(errors="replace").rstrip())
            tasks.append(asyncio.create_task(drain()))
            return proc

        async def stop(proc):
            if proc.returncode is None:
                if os.name == "nt":
                    proc.terminate()
                else:
                    proc.send_signal(signal.SIGINT)
                try:
                    await asyncio.wait_for(proc.wait(), 10)
                except asyncio.TimeoutError:
                    proc.kill(); await proc.wait()

        async def until(check, timeout=15):
            deadline = asyncio.get_running_loop().time() + timeout
            while asyncio.get_running_loop().time() < deadline:
                try:
                    result = await check()
                    if result:
                        return result
                except (httpx.HTTPError, KeyError):
                    pass
                await asyncio.sleep(.05)
            self.fail("Integration timed out\n" + "\n".join(logs[-25:]))

        try:
            with tempfile.TemporaryDirectory() as tmp:
                cmd = ["-m", "backend", "--mqtt-port", str(mqtt_port), "--port", str(http_port), "--db", str(Path(tmp) / "phase2.sqlite3")]
                proc = await spawn(*cmd)
                async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{http_port}", timeout=2, trust_env=False) as http:
                    async def alive():
                        return (await http.get("/health")).status_code == 200
                    await until(alive)
                    self.assertEqual((await http.get("/ready")).status_code, 503)
                    # Broker starts later: backend must recover without a restart.
                    await broker.start()
                    async def ready():
                        return subscribed.is_set() and (await http.get("/ready")).status_code == 200
                    await until(ready)
                    sim = await spawn("-m", "iot_code.simulator", "--port", str(mqtt_port), "--config", "config/edge_demo.json",
                                      "--dataset", "--steps", "30", "--interval", "0.10", "--quiet", "--run-dir", str(Path(tmp) / "runs"))
                    self.assertEqual(await asyncio.wait_for(sim.wait(), 20), 0)

                    async def complete():
                        data = (await http.get("/health")).json()
                        return data if data["counts"]["telemetry"] == 90 and data["counts"]["predictions"] == 19 else None
                    before = await until(complete)
                    self.assertEqual(before["counts"]["proposals"], 19)
                    self.assertGreaterEqual(before["mqtt"]["duplicates"], 19)
                    self.assertEqual(before["mqtt"]["rejected"], 0)
                    proposals = (await http.get("/api/proposals")).json()["items"]
                    self.assertEqual(sum(p["status"] == "observed" for p in proposals), 18)
                    self.assertEqual(sum(p["status"] == "stopped" for p in proposals), 1)
                    self.assertTrue(all(not p["eligible_for_review"] and not p["on_chain"] for p in proposals))
                    self.assertEqual(len((await http.get("/api/homes")).json()["items"]), 3)
                    await stop(proc)
                    proc = await spawn(*cmd)
                    await until(ready)
                    after = (await http.get("/health")).json()
                    self.assertEqual(before["counts"], after["counts"])
                    self.assertEqual(after["mqtt"]["duplicates"], 0)
                    await stop(proc)
        finally:
            fixture.disconnect()
            await asyncio.to_thread(fixture.loop_stop)
            for p in processes:
                await stop(p)
            await asyncio.gather(*tasks, return_exceptions=True)
            await asyncio.wait_for(broker.shutdown(), 10)
