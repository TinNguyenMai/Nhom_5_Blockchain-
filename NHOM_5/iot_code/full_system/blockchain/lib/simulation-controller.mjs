import fs from "node:fs";
import path from "node:path";
import { ROOT, writeJson, readJson } from "./files.mjs";
import { compile } from "../compile.mjs";
import { createSimulation, simulationConfig } from "./simulation-runtime.mjs";
import { runScenarios } from "../market-orchestrator.mjs";

export class SimulationController {
  constructor({ root = path.join(ROOT, "data", "market-simulation"), python, mqttPort = 0, log = console.log,
    backendUrl = 'http://127.0.0.1:8000', hardwareTimeout, defaultScenario = 'community', hybridSource = 'ai-live' } = {}) {
    Object.assign(this, { root, python, mqttPort, log, backendUrl, hardwareTimeout, defaultScenario, hybridSource });
    this.state = { status: "idle", snapshot: null, checks: [], events: [] };
    const latest = path.join(root, "latest.json");
    if (fs.existsSync(latest)) {
      this.state = readJson(latest); this.state.chain_live = false;
      if (["starting", "running"].includes(this.state.status)) this.state.status = "interrupted";
    }
    this.active = null; this.running = false;
  }
  persist() { writeJson(path.join(this.root, "latest.json"), this.state); }
  async run(options = {}) {
    if (this.running) throw new Error("A simulation is already running");
    const config = simulationConfig({ ...options, hybridSource: options.hybridSource || this.hybridSource });
    this.running = true;
    this.state = { status: "starting", scenario: options.scenario || "community", config, snapshot: null, checks: [], events: [], error: null };
    this.persist();
    try {
      await this.active?.close(); this.active = null;
      compile();
      const onEvent = e => { this.state.events.push(e); if (this.state.events.length > 100) this.state.events.shift(); };
      const onSnapshot = snapshot => { this.state.snapshot = snapshot; this.persist(); };
      this.active = await createSimulation({ config, root: this.root, python: this.python, mqttPort: this.mqttPort, onSnapshot, onEvent });
      this.active.onHardware = hardware => { this.state.hardware = hardware; this.persist(); };
      this.state.status = "running"; this.state.run_id = this.active.runId;
      this.state.mqtt_port = this.active.broker.port; this.state.chain_live = true;
      this.state.directory = this.active.directory;
      this.log(`MQTT: 127.0.0.1:${this.active.broker.port} | Hardhat: ${this.active.node.rpc} | ${config.homes.length} hộ`);
      this.persist();
      const report = await runScenarios(this.active, this.state.scenario, { backendUrl: this.backendUrl, hardwareTimeout: this.hardwareTimeout, onCheck: entry => {
        this.state.checks.push(entry); this.log(`${entry.passed ? "PASS" : "FAIL"} ${entry.name}${entry.error ? ": " + entry.error : ""}`); this.persist();
      } });
      this.state.status = "completed"; this.state.snapshot = report; this.state.completed_at = report.completed_at;
      this.persist();
      this.log(`SIMULATION PASS: ${report.checks.length} kịch bản; escrow=${report.escrow}; báo cáo: ${path.join(this.active.directory, "report.json")}`);
      return report;
    } catch (e) {
      this.state.status = "failed"; this.state.error = e.shortMessage || e.message;
      this.persist(); await this.active?.close(); this.active = null; this.state.chain_live = false; this.persist(); throw e;
    } finally { this.running = false; }
  }
  async close() {
    await this.active?.close(); this.active = null; this.state.chain_live = false;
    if (this.running) this.state.status = "interrupted";
    this.persist();
  }
}
