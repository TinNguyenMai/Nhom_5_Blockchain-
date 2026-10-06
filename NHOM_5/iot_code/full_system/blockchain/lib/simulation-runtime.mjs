import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { ROOT, readJson, writeJson } from "./files.mjs";
import { startNode, freePort } from "./test-node.mjs";
import { localProvider, deployContracts, confirmed } from "./chain.mjs";
import { SimulationMqtt } from "./simulation-mqtt.mjs";
import { MqttGateway } from "../mqtt-gateway.mjs";
import { delay } from "./market.mjs";
import { evaluationPoint } from "./simulation-evaluation.mjs";

export function simulationConfig({ configFile = path.join(ROOT, "config", "market_simulation.json"), homes, seed, scenario, hybridSource = 'ai-live' } = {}) {
  const cfg = readJson(configFile);
  if (homes !== undefined) {
    if (!Number.isInteger(homes) || homes < 6 || homes > 32) throw new Error("--homes must be 6..32 (contract limit)");
    cfg.homes = cfg.homes.slice(0, homes);
    while (cfg.homes.length < homes) {
      const n = cfg.homes.length + 1;
      cfg.homes.push({ id: `home_${String(n).padStart(2, "0")}`, name: `Nhà ${n}`, pv_kw: n % 2 ? 5 : 0,
        base_load_kw: n % 2 ? .7 : 1.2, category: "ordinary", ask: 2000 + n % 3 * 100, bid: 3000, delivery_bps: 10000 });
    }
  }
  if (seed !== undefined) cfg.seed = seed;
  if (cfg.schema_version !== 1 || !Number.isSafeInteger(cfg.seed) || cfg.step_seconds !== 300 ||
      !Number.isInteger(cfg.bidding_seconds) || cfg.bidding_seconds < 120 || cfg.bidding_seconds > 3600 ||
      !Number.isInteger(cfg.initial_slc) || cfg.initial_slc < 1 || cfg.initial_slc > 10000 ||
      !Array.isArray(cfg.homes) || cfg.homes.length < 6 || cfg.homes.length > 32 || !Number.isFinite(Date.parse(cfg.start)))
    throw new Error("Invalid market simulation configuration");
  const ids = new Set();
  for (const [index, h] of cfg.homes.entries()) {
    if (h.id !== `home_${String(index + 1).padStart(2, "0")}` || ids.has(h.id) || typeof h.name !== "string" ||
        !["ordinary", "hospital", "kindergarten", "special"].includes(h.category) ||
        !Number.isFinite(h.pv_kw) || h.pv_kw < 0 || h.pv_kw > 100 || !Number.isFinite(h.base_load_kw) || h.base_load_kw <= 0 || h.base_load_kw > 20 ||
        !Number.isInteger(h.ask) || !Number.isInteger(h.bid) || Math.min(h.ask, h.bid) <= 0 || Math.max(h.ask, h.bid) > 1e12 ||
        !Number.isInteger(h.delivery_bps) || h.delivery_bps < 0 || h.delivery_bps > 10000) throw new Error(`Invalid profile: ${h.id}`);
    ids.add(h.id);
  }
  if (scenario === 'hybrid') {
    if (cfg.homes.length !== 12) throw new Error('Bản ESP32 yêu cầu đúng 12 hộ: 1 ESP32 + 11 hộ mô phỏng');
    cfg.hybrid = true;
    if (!['ai-live', 'ai-demo', 'ai', 'telemetry'].includes(hybridSource)) throw new Error('Nguồn ESP32 phải là ai-live, ai-demo, ai hoặc telemetry');
    cfg.hybrid_source = hybridSource;
    cfg.ai_model_version = readJson(path.join(ROOT, 'ai_model/artifacts/metadata.json')).model_version;
    cfg.homes[0].name = hybridSource === 'ai-demo' ? 'Nhà 1 · ESP32 Edge AI / mô phỏng 5s' : hybridSource === 'ai-live' ? 'Nhà 1 · ESP32 Edge AI / INA219 5s' : 'Nhà 1 · ESP32 / INA219';
    cfg.homes.forEach(h => { h.source_kind = h.id === 'home_01' ? hybridSource !== 'telemetry' ? 'esp32_forecast' : 'esp32_telemetry' : 'simulator'; });
  }
  return cfg;
}

async function stopChild(child) {
  if (!child || !child.pid || child.exitCode !== null || child.killed) return;
  const done = new Promise(resolve => child.once("exit", resolve));
  child.kill(); const timer = setTimeout(() => child.kill("SIGKILL"), 4000);
  await done; clearTimeout(timer);
}

export async function startBroker({ port = 0, bin, directory }) {
  const brokerPort = port || await freePort();
  const executable = bin || process.env.SOLAR_MOSQUITTO_BIN || (process.platform === "win32" ? "C:/Program Files/mosquitto/mosquitto.exe" : "mosquitto");
  const config = path.join(directory, "mosquitto.conf");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(config, `listener ${brokerPort} 127.0.0.1\nallow_anonymous true\n`);
  // Verify availability before launching; never attach to or terminate an existing broker.
  const probe = net.createServer();
  await new Promise((resolve, reject) => probe.once("error", reject).listen(brokerPort, "127.0.0.1", resolve));
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(executable, ["-c", config], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let log = "", error;
  child.on("error", e => { error = e; });
  child.stdout.on("data", d => { log = (log + d).slice(-2000); });
  child.stderr.on("data", d => { log = (log + d).slice(-2000); });
  for (let i = 0; i < 80; i++) {
    if (error || child.exitCode !== null) throw new Error(`Mosquitto failed: ${error?.message || log}`);
    const open = await new Promise(resolve => {
      const socket = net.connect(brokerPort, "127.0.0.1");
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
    if (open) return { child, port: brokerPort, bin: executable, directory };
    await delay(100);
  }
  await stopChild(child); throw new Error("Mosquitto startup timeout");
}

export async function createSimulation({ config, directory, root, python, mqttPort = 0, onSnapshot, onEvent, hooks } = {}) {
  const runId = randomUUID().replaceAll("-", "");
  const dir = directory || path.join(root || path.join(ROOT, "data", "market-simulation"), runId);
  fs.mkdirSync(dir, { recursive: true });
  const runtime = { runId, directory: dir, config, events: [], stopped: false, history: [], evaluationContext: {}, roundMetadata: {} };
  const capture = (snapshot, context = {}) => {
    if (runtime.hardware) snapshot.hardware = { ...runtime.hardware };
    for (const round of snapshot.rounds) Object.assign(round, runtime.roundMetadata[round.round_id] || {});
    const point = evaluationPoint(snapshot, { index: runtime.history.length, ...runtime.evaluationContext, ...context });
    runtime.history.push(point);
    snapshot.evaluation = { version: 1, initial_tokens: String(BigInt(config.homes.length * config.initial_slc) * 1_000_000n),
      active_check: runtime.evaluationContext.check_name || null, history: [...runtime.history] };
    writeJson(path.join(dir, 'evaluation-history.json'), snapshot.evaluation);
    onSnapshot?.(snapshot);
  };
  runtime.close = async () => {
    if (runtime.stopped) return; runtime.stopped = true;
    await runtime.gateway?.close();
    await runtime.peer?.close(); await runtime.mqtt?.close();
    await stopChild(runtime.simulator);
    await stopChild(runtime.broker?.child);
    runtime.chain?.provider.destroy(); await stopChild(runtime.node?.child);
  };
  try {
    const py = python || process.env.SOLAR_TEST_PYTHON || path.join(ROOT, ".venv-backend", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    runtime.python = py;
    runtime.node = await startNode({ config: path.join(ROOT, "blockchain", "simulation-hardhat.config.mjs") });
    const provider = await localProvider(runtime.node.rpc);
    runtime.chain = { provider };
    runtime.chain = await deployContracts(provider, config.homes.length);
    runtime.chain.manifest.simulation_run_id = runId;
    runtime.chain.manifest.profiles = config.homes;
    if (config.initial_slc !== 1000) for (const signer of runtime.chain.homes) {
      const target = BigInt(config.initial_slc) * 1_000_000n, defaultAmount = 1_000_000_000n;
      if (target > defaultAmount) await confirmed(runtime.chain.token.transfer(await signer.getAddress(), target - defaultAmount));
      else await confirmed(runtime.chain.token.connect(signer).transfer(await runtime.chain.admin.getAddress(), defaultAmount - target));
    }
    const manifestFile = path.join(dir, "deployment.json"), configFile = path.join(dir, "config.json");
    writeJson(manifestFile, runtime.chain.manifest); writeJson(configFile, config);
    runtime.broker = await startBroker({ port: mqttPort, directory: path.join(dir, "broker") });
    const opts = { python: py, port: runtime.broker.port, runId, manifestFile };
    runtime.mqtt = new SimulationMqtt({ ...opts, db: path.join(dir, "mqtt.sqlite3"), clientId: `gateway-${runId}` });
    await runtime.mqtt.ready;
    const event = e => { runtime.events.push(e); if (runtime.events.length > 1000) runtime.events.shift(); onEvent?.(e); };
    runtime.gateway = new MqttGateway({ chain: runtime.chain, mqtt: runtime.mqtt, runId, directory: dir, config, onSnapshot: capture, onEvent: event, hooks });
    runtime.peer = new SimulationMqtt({ ...opts, clientId: `orchestrator-${runId}` });
    await runtime.peer.ready;
    runtime.simulator = spawn(py, ["-u", "-m", "iot_code.market_simulator", "--config", configFile,
      "--manifest", manifestFile, "--run", runId, "--port", String(runtime.broker.port), "--state", path.join(dir, "meters.json")],
      { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise((resolve, reject) => {
      let log = "";
      const timer = setTimeout(() => reject(new Error(`Household simulator timed out: ${log}`)), 25000);
      runtime.simulator.on("error", e => { clearTimeout(timer); reject(e); });
      runtime.simulator.stderr.on("data", d => { log = (log + d).slice(-3000); });
      runtime.simulator.once("exit", c => { clearTimeout(timer); reject(new Error(`Household simulator exited (${c}): ${log}`)); });
      createInterface({ input: runtime.simulator.stdout }).on("line", line => {
        try { if (JSON.parse(line).type === "ready") { clearTimeout(timer); resolve(); } } catch {}
      });
    });
    runtime.envelope = (home, action, payload, messageId = randomUUID()) => ({ schema_version: 1, message_id: messageId,
      run_id: runId, deployment_id: runtime.chain.manifest.deployment_id, household_id: home,
      created_at: new Date().toISOString(), action, payload });
    runtime.request = async (topic, message, timeout = 45000) => {
      const correlation = message.correlation_id || message.message_id;
      return new Promise((resolve, reject) => {
        const finish = (e, value) => {
          clearTimeout(timer); clearInterval(retry); runtime.peer.off("message", listener); e ? reject(e) : resolve(value);
        };
        const listener = e => {
          if (!e.topic.endsWith("/status") || e.payload.correlation_id !== correlation || e.payload.status === "retry") return;
          finish(null, e.payload);
        };
        const timer = setTimeout(() => finish(new Error(`MQTT response timeout: ${message.action} ${correlation}`)), timeout);
        const send = () => runtime.peer.publish(topic, message).catch(() => {});
        const retry = setInterval(send, 10000);
        runtime.peer.on("message", listener); send();
      });
    };
    runtime.command = (home, action, payload, mid) => runtime.request(`solar/${home}/simulation/request`, runtime.envelope(home, action, payload, mid));
    runtime.admin = (action, payload, mid) => runtime.request(action === "set_priority" ? "solar/market/priority/request" :
      action === "expire_trade" ? "solar/market/delivery/request" : "solar/market/round/request", runtime.envelope("coordinator", action, payload, mid));
    runtime.restartGateway = async newHooks => {
      await runtime.gateway.close();
      runtime.gateway = new MqttGateway({ chain: runtime.chain, mqtt: runtime.mqtt, runId, directory: dir, config, onSnapshot: capture, onEvent: event, hooks: newHooks || {} });
      await runtime.gateway.recover();
    };
    runtime.restartBroker = async () => {
      const old = runtime.broker; await stopChild(old.child);
      runtime.mqtt.connected = false; runtime.peer.connected = false;
      runtime.broker = await startBroker({ port: old.port, bin: old.bin, directory: old.directory });
      const deadline = Date.now() + 20000;
      while ((!runtime.mqtt.connected || !runtime.peer.connected) && Date.now() < deadline) await delay(100);
      if (!runtime.mqtt.connected || !runtime.peer.connected) throw new Error("MQTT did not reconnect after broker restart");
    };
    await runtime.gateway.snapshot();
    return runtime;
  } catch (e) { await runtime.close(); throw e; }
}
