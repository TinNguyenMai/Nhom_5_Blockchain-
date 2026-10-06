import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { compile } from "./compile.mjs";
import { ROOT, readJson, writeJson } from "./lib/files.mjs";
import { startNode, freePort, runChild } from "./lib/test-node.mjs";
import { delay } from "./lib/market.mjs";

const { values } = parseArgs({ options: { python: { type: "string" } } });
const python = values.python || process.env.SOLAR_TEST_PYTHON || path.join(ROOT,
  ".venv-backend", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "solar-chain-test-"));
let node, backend, liveBackend, liveBridge;
try {
  compile(); node = await startNode();
  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  const env = { SOLAR_RPC: node.rpc, SOLAR_PHASE3_DIR: path.join(temp, "phase3") };
  backend = spawn(python, ["blockchain/tests/backend_fixture.py", "--db", path.join(temp, "test.sqlite3"), "--port", String(port)],
    { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "", spawnError;
  backend.on("error", e => { spawnError = e; });
  backend.stdout.on("data", d => { log += d; }); backend.stderr.on("data", d => { log += d; });
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (spawnError) throw spawnError;
    if (backend.exitCode !== null) throw new Error(`Fixture failed: ${log}`);
    try { if ((await fetch(`${url}/health`)).ok) { ready = true; break; } } catch {}
    await delay(250);
  }
  assert.ok(ready, `Backend fixture did not start: ${log}`);
  const command = args => runChild(process.execPath, args, env);
  await command(["blockchain/deploy.mjs"]);
  await command(["blockchain/bridge.mjs", "replay", "--backend", url, "--count", "3"]);
  await command(["blockchain/report.mjs"]);
  const get = async route => { const r = await fetch(`${url}${route}`); assert.ok(r.ok); return r.json(); };
  const status = await get("/api/blockchain/status"); assert.equal(status.connected, true);
  let rounds = await get("/api/blockchain/rounds"); assert.equal(rounds.total, 3);
  const proposals = await get("/api/proposals?run_id=" + "a".repeat(32));
  assert.ok(proposals.items.every(p => p.on_chain === true && p.chain_execution.mode === "replay" && !p.eligible_for_review));
  for (const item of rounds.items) {
    assert.equal(item.orders.length, 3); assert.equal(item.trades.length, 2);
    assert.equal(item.source_hash_verified, true); assert.ok(BigInt(item.market_balance_micro_slc) > 0n);
    assert.equal(item.pending_trade_count, 2);
    assert.ok(item.trades.every(t => t.status === "pending" && t.paid_micro_slc === "0"));
    assert.equal(item.mode, "replay"); assert.equal(item.energy_delivery_verified, false);
    assert.equal((await get(`/api/blockchain/rounds/${item.round_id}`)).current_chain_verified, true);
    assert.equal(item.orders.filter(o => o.basis === "demo_counterparty").length, 2);
  }
  const deployment = readJson(path.join(env.SOLAR_PHASE3_DIR, "deployment.json"));
  const delivery = path.join(temp, "delivery.json"), target = rounds.items.at(-1);
  writeJson(delivery, { deployment_id: deployment.deployment_id, round_id: target.round_id, trade_index: 0,
    delivered_wh: target.trades[0].quantity_wh, measurement: { kind: "synthetic_test_fixture", meter_id: "test-only" } });
  await command(["blockchain/admin.mjs", "confirm", "--round", target.round_id, "--trade", "0", "--evidence", delivery]);
  const attested = (await get(`/api/blockchain/rounds/${target.round_id}`)).report;
  assert.equal(attested.trades[0].status, "confirmed"); assert.ok(BigInt(attested.trades[0].paid_micro_slc) > 0n);
  const verification = path.join(temp, "priority.json");
  writeJson(verification, { deployment_id: deployment.deployment_id, trader: deployment.households.home_02,
    category: "hospital", verification: { kind: "synthetic_test_fixture" } });
  await command(["blockchain/admin.mjs", "priority", "--home", "home_02", "--category", "hospital", "--evidence", verification]);
  await command(["blockchain/report.mjs"]);
  rounds = await get("/api/blockchain/rounds");
  const before = rounds.items[0].balances;
  await command(["blockchain/bridge.mjs", "replay", "--backend", url, "--count", "3"]);
  await command(["blockchain/deploy.mjs"]);
  rounds = await get("/api/blockchain/rounds");
  assert.equal(rounds.total, 3); assert.deepEqual(rounds.items[0].balances, before);
  const manifest = readJson(path.join(env.SOLAR_PHASE3_DIR, "deployment.json"));
  const oldId = manifest.deployment_id;
  const reset = await fetch(node.rpc, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hardhat_reset", params: [] }) });
  // Some Hardhat 3 releases omit hardhat_reset; use evm snapshot reset in a fresh node instead.
  const resetResult = await reset.json();
  if (resetResult.error) {
    // Clear code at the market address models a restarted deployment without touching user nodes.
    const r = await fetch(node.rpc, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "hardhat_setCode", params: [manifest.market, "0x"] }) });
    assert.ok(!(await r.json()).error);
  }
  assert.equal((await get("/api/blockchain/status")).connected, false);
  assert.ok((await get("/api/proposals?run_id=" + "a".repeat(32))).items.every(p => p.on_chain === null));
  await command(["blockchain/deploy.mjs"]);
  assert.notEqual(readJson(path.join(env.SOLAR_PHASE3_DIR, "deployment.json")).deployment_id, oldId);
  assert.equal((await get("/api/blockchain/rounds")).total, 0);
  // Run the actual live CLI on a fresh deployment. Readiness is mocked only in
  // the Python fixture; SQL/API/transactions/receipts are real local components.
  const livePort = await freePort(), liveUrl = `http://127.0.0.1:${livePort}`;
  liveBackend = spawn(python, ["blockchain/tests/backend_fixture.py", "--db", path.join(temp, "live.sqlite3"),
    "--port", String(livePort), "--live"], { cwd: ROOT, env: { ...process.env, ...env }, stdio: "ignore" });
  let liveReady = false;
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${liveUrl}/ready`)).ok) { liveReady = true; break; } } catch {}
    await delay(250);
  }
  assert.ok(liveReady);
  liveBridge = spawn(process.execPath, ["blockchain/bridge.mjs", "live", "--backend", liveUrl, "--demo-counterparty"],
    { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let liveLog = "";
  liveBridge.stdout.on("data", d => { liveLog += d; }); liveBridge.stderr.on("data", d => { liveLog += d; });
  let liveRound;
  for (let i = 0; i < 120; i++) {
    const page = await get("/api/blockchain/rounds");
    if (page.items[0]?.settled) { liveRound = page.items[0]; break; }
    if (liveBridge.exitCode !== null) throw new Error(`Live CLI stopped: ${liveLog}`);
    await delay(250);
  }
  assert.ok(liveRound, `Live round did not settle: ${liveLog}`);
  assert.equal(liveRound.mode, "live"); assert.equal(liveRound.trades.length, 2);
  assert.equal(liveRound.source_hash_verified, true);
  assert.equal((await get(`/api/blockchain/rounds/${liveRound.round_id}`)).current_chain_verified, true);
  liveBridge.kill();
  console.log("INTEGRATION PASS: real FastAPI + SQLite + Ethers + Hardhat; replay 3 rounds/9 orders/6 trades; idempotent rerun; reset detected; live CLI 1 round/2 trades.");
  console.log("Forecasts in this automated test are synthetic fixtures, not ESP32 hardware inference.");
} catch (e) { console.error(e.stack || e.message); process.exitCode = 1; }
finally {
  for (const child of [liveBridge, liveBackend, backend, node?.child]) {
    if (child && child.exitCode === null) {
      await new Promise(resolve => { child.once("exit", resolve); child.kill(); });
    }
  }
  fs.rmSync(temp, { recursive: true, force: true });
}
