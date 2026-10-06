import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { id, Transaction, keccak256 } from "ethers";
import { createSimulation, simulationConfig } from "../lib/simulation-runtime.mjs";
import { runScenarios } from "../market-orchestrator.mjs";
import { validateRequest, uint } from "../lib/mqtt-schema.mjs";

test("wire units/configuration reject ambiguous, negative, duplicate and oversized values", () => {
  for (const value of ["-1", "1.5", "01", "1e3", 1, true]) assert.throws(() => uint(value, "value"));
  assert.throws(() => simulationConfig({ homes: 33 }));
  assert.throws(() => simulationConfig({ homes: 5 }));
  const manifest = { deployment_id: "0x" + "1".repeat(64), households: { home_01: "0x" + "2".repeat(40) } };
  const request = { schema_version: 1, message_id: "request", run_id: "a".repeat(32), deployment_id: manifest.deployment_id,
    household_id: "home_01", action: "set_priority", payload: { home: "home_01", category: "hospital", verification: {} } };
  assert.throws(() => validateRequest("solar/market/priority/request", request, { manifest, runId: request.run_id }), /Unauthorized/);
});

test("all MQTT market functions with 12 wallets, durable restart and exactly one signed transaction", { timeout: 300000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solar-market-mqtt-"));
  let runtime;
  try {
    runtime = await createSimulation({ config: simulationConfig({ homes: 12 }), directory });
    const report = await runScenarios(runtime, "full-demo", { onCheck: c => console.log(`${c.passed ? "PASS" : "FAIL"} ${c.name}`) });
    assert.equal(report.checks.length, 22); assert.equal(report.passed, true); assert.equal(report.escrow, "0");
    assert.equal(report.homes.length, 12); assert.equal(report.conserved, true);
    const history = report.evaluation.history;
    assert.ok(history.length > 100, 'captures transaction steps, not only the final outcome');
    assert.equal(history[0].index, 0);
    assert.ok(history.every((p, i) => p.index === i && p.total_tokens === report.evaluation.initial_tokens));
    assert.ok(history.some(p => BigInt(p.escrow) > 0n), 'illustrates funds held before confirmation');
    assert.equal(history.at(-1).escrow, '0');
    assert.ok(report.checks.every(c => c.evidence.round_ids.length > 0));
    const partial = report.checks.find(c => c.name.startsWith('Giao 40%'));
    assert.equal(partial.evidence.summary.committed_wh, '100');
    assert.equal(partial.evidence.summary.delivered_wh, '40');
    assert.equal(partial.evidence.summary.paid, '80000');
    assert.equal(partial.evidence.summary.refund, '120000');
    assert.equal(partial.evidence.summary.penalty, '12000');
    const repPoints = history.filter(p => p.index >= partial.evidence.start_point && p.index <= partial.evidence.end_point);
    assert.equal(repPoints[0].homes.find(h => h.id === 'home_01').score, 60);
    assert.equal(repPoints.at(-1).homes.find(h => h.id === 'home_01').score, 40);
    const recovery = report.checks.find(c => c.name.startsWith('Gateway dừng sau receipt'));
    assert.ok(history.some(p => p.check_name === recovery.name && p.action === 'place_order'), 'history survives gateway replacement');
    const persisted = JSON.parse(fs.readFileSync(path.join(directory, 'evaluation-history.json'), 'utf8'));
    assert.equal(persisted.history.length, history.length);
    assert.ok(report.mqtt.duplicate_requests > 0);
    const open = await runtime.admin("open_round", { key: id(randomUUID()), bidding_seconds: 300 });
    const r = open.result.round_id;
    await runtime.command("home_02", "sample", { sequence: 100 });
    let notify; const hit = new Promise(resolve => { notify = resolve; });
    runtime.gateway.hooks.beforeBroadcast = (record, step) => {
      if (record.request.action === "place_order" && step === "market") {
        notify(record); throw Object.assign(new Error("Crash BEFORE broadcast"), { simulatedCrash: true });
      }
    };
    const message = runtime.envelope("home_02", "place_order", { round_id: r, side: 1, quantity_wh: "100", price: "3000", override_reason: "recovery_test" });
    const pending = runtime.request("solar/home_02/simulation/request", message); pending.catch(() => {});
    let timer;
    const record = await Promise.race([hit, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("No prepared transaction")), 20000); })]).finally(() => clearTimeout(timer));
    const signed = record.steps.market;
    assert.equal(await runtime.chain.provider.getTransaction(signed.hash), null);
    assert.equal(keccak256(signed.raw), signed.hash);
    await runtime.restartGateway();
    const result = await pending;
    assert.equal(result.status, "confirmed"); assert.equal(result.result.transaction_hash, signed.hash);
    assert.equal((await runtime.chain.market.getOrders(r)).length, 1);
    assert.equal(Transaction.from(signed.raw).from, runtime.chain.manifest.households.home_02);
    const duplicate = await runtime.request("solar/home_02/simulation/request", message);
    assert.equal(duplicate.result.transaction_hash, signed.hash);
    const conflict = await runtime.request("solar/home_02/simulation/request", { ...message, payload: { ...message.payload, quantity_wh: "99" } });
    assert.equal(conflict.status, "rejected"); assert.match(conflict.error, /Conflicting/);
    await runtime.command("home_02", "cancel_order", { round_id: r, order_index: "0" });
    const round = await runtime.chain.market.rounds(r);
    await runtime.chain.provider.send("evm_setNextBlockTimestamp", [Number(round.closesAt)]); await runtime.chain.provider.send("evm_mine", []);
    await runtime.admin("settle", { round_id: r });
    const final = await runtime.gateway.snapshot(); assert.equal(final.escrow, "0"); assert.equal(final.conserved, true);
    for (const request of Object.values(runtime.gateway.journal.data.requests)) for (const tx of Object.values(request.steps)) {
      assert.equal(keccak256(tx.raw), tx.hash);
      assert.equal((await runtime.chain.provider.getTransactionReceipt(tx.hash)).status, 1);
    }
    console.log(`SIMULATION REPORT: ${path.join(directory, "report.json")}`);
  } finally { await runtime?.close(); }
});

test("32 households publish real MQTT messages and fit the contract order bound", { timeout: 120000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solar-market-32-"));
  let runtime;
  try {
    runtime = await createSimulation({ config: simulationConfig({ homes: 32 }), directory });
    const report = await runScenarios(runtime, "basic");
    assert.equal(report.homes.length, 32); assert.equal(report.rounds[0].orders.length, 32);
    assert.equal(report.passed, true); assert.equal(report.conserved, true); assert.equal(report.escrow, "0");
    assert.ok(report.evaluation.history.every(p => p.homes.length === 32));
  } finally { await runtime?.close(); }
});
