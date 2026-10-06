import { parseArgs } from "node:util";
import { SimulationController } from "./lib/simulation-controller.mjs";
import { simulationServer } from "./simulation-server.mjs";

const { values } = parseArgs({ options: {
  homes: { type: "string", default: "12" }, scenario: { type: "string", default: "community" },
  seed: { type: "string", default: "20261003" }, config: { type: "string" }, python: { type: "string" },
  "mqtt-port": { type: "string", default: "0" }, "ui-port": { type: "string", default: "5260" },
  "no-dashboard": { type: "boolean", default: false }, "serve-only": { type: "boolean", default: false }
  , "esp-backend": { type: 'string', default: 'http://127.0.0.1:8000' }, "hardware-timeout": { type: 'string' }, "esp-source": { type: 'string', default: 'ai-live' }
} });
const port = Number(values["ui-port"]), mqttPort = Number(values["mqtt-port"]);
if (![port, mqttPort].every(p => Number.isInteger(p) && p >= 0 && p <= 65535)) throw new Error("Invalid port");
const hardwareTimeout = values['hardware-timeout'] === undefined ? undefined : Number(values['hardware-timeout']) * 1000;
if (hardwareTimeout !== undefined && (!Number.isFinite(hardwareTimeout) || hardwareTimeout < 1000 || hardwareTimeout > 7200000)) throw new Error('Invalid hardware timeout');
if (!['ai-live', 'ai-demo', 'ai', 'telemetry'].includes(values['esp-source'])) throw new Error('Invalid ESP source');
const controller = new SimulationController({ python: values.python, mqttPort, backendUrl: values['esp-backend'], hardwareTimeout, defaultScenario: values.scenario, hybridSource: values['esp-source'] });
let server, stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  await controller.close(); if (server) server.close();
}
process.on("SIGINT", () => { stop().then(() => process.exit(0)); });
process.on("SIGTERM", () => { stop().then(() => process.exit(0)); });
try {
  if (!values["no-dashboard"]) {
    server = simulationServer(controller);
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
    console.log(`MQTT MARKET SIMULATION: http://127.0.0.1:${server.address().port}/simulation`);
  }
  if (!values["serve-only"]) await controller.run({ configFile: values.config, homes: Number(values.homes), seed: Number(values.seed), scenario: values.scenario });
  if (values["no-dashboard"]) await stop();
  else console.log("Giữ terminal mở để xem MQTT/chain và chạy lượt mới trên dashboard. Ctrl+C để dừng.");
} catch (e) { console.error(`SIMULATION ERROR: ${e.shortMessage || e.message}`); process.exitCode = 1; await stop(); }
