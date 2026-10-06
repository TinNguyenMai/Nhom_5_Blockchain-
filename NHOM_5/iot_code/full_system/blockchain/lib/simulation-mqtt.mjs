import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { ROOT } from "./files.mjs";

export class SimulationMqtt extends EventEmitter {
  constructor({ python, port, runId, manifestFile, db, clientId = randomUUID() }) {
    super(); this.pending = new Map(); this.connected = false; this.errors = "";
    // At most 32 simultaneous household RPC waiters, all removed on completion/timeout.
    this.setMaxListeners(64);
    this.on("error", e => { this.errors = e.error || String(e); });
    this.child = spawn(python, ["-u", "-m", "iot_code.market_transport", "--port", String(port),
      "--run", runId, "--manifest", manifestFile, "--client-id", `solar-sim-${clientId}`,
      ...(db ? ["--db", db] : [])], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MQTT did not start: ${this.errors}`)), 20000);
      this.once("ready", () => { clearTimeout(timer); resolve(); });
      this.child.once("error", e => { clearTimeout(timer); reject(e); });
      this.child.once("exit", code => { clearTimeout(timer); reject(new Error(`MQTT worker exited (${code}): ${this.errors}`)); });
    });
    this.child.stderr.on("data", d => { this.errors = (this.errors + d).slice(-3000); });
    createInterface({ input: this.child.stdout }).on("line", line => {
      let e; try { e = JSON.parse(line); } catch { return; }
      if (e.type === "ready") { this.connected = true; this.emit("ready"); }
      if (e.type === "disconnected") this.connected = false;
      if (e.type === "published" || e.type === "publish_error") {
        const p = this.pending.get(e.id);
        if (p) { clearTimeout(p.timer); this.pending.delete(e.id); e.type === "published" ? p.resolve() : p.reject(new Error(e.error)); }
      }
      this.emit(e.type, e);
    });
    this.child.on("exit", () => {
      this.connected = false;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(`MQTT worker stopped: ${this.errors}`)); }
      this.pending.clear();
    });
  }
  async publish(topic, payload) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("MQTT publish timeout")); }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ op: "publish", id, topic, payload }) + "\n", e => {
        if (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
      });
    });
  }
  async close() {
    if (this.child.pid && this.child.exitCode === null && !this.child.killed) {
      const done = new Promise(resolve => this.child.once("exit", resolve));
      this.child.stdin.end(JSON.stringify({ op: "stop" }) + "\n");
      const timer = setTimeout(() => this.child.kill(), 3000);
      await done; clearTimeout(timer);
    }
  }
}
