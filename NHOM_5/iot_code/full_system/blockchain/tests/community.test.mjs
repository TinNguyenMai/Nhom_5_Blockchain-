import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { compile } from '../compile.mjs';
import { createSimulation, simulationConfig } from '../lib/simulation-runtime.mjs';
import { runScenarios } from '../market-orchestrator.mjs';

test('variable community: real MQTT/chain receipts, diverse supply/demand, shortages and recovery', { timeout: 600000 }, async () => {
  compile();
  const directory = process.env.SOLAR_COMMUNITY_TEST_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'solar-community-'));
  let runtime;
  try {
    runtime = await createSimulation({ config: simulationConfig({ homes: 12 }), directory });
    const report = await runScenarios(runtime, 'community', { onCheck: c => console.log(`${c.passed ? 'PASS' : 'FAIL'} ${c.name}`) });
    assert.equal(report.rounds.length, 12); assert.equal(report.checks.length, 12);
    assert.equal(report.passed, true); assert.equal(report.escrow, '0'); assert.equal(report.conserved, true);
    assert.ok(report.rounds.every(r => r.profile === 'community' && r.interval_seconds === 300));
    for (let i = 1; i < report.rounds.length; i++) assert.equal(
      Date.parse(report.rounds[i].sample_timestamp) - Date.parse(report.rounds[i - 1].sample_timestamp), 300000);
    const trades = report.rounds.flatMap(r => r.trades);
    assert.ok(new Set(trades.map(t => t.seller)).size >= 3);
    assert.ok(new Set(trades.map(t => t.buyer)).size >= 4);
    assert.ok(new Set(trades.map(t => `${t.seller}:${t.buyer}`)).size >= 8);
    assert.ok(new Set(report.checks.map(c => c.evidence.summary.committed_wh)).size >= 6);
    assert.ok(report.checks.some(c => BigInt(c.evidence.summary.penalty) > 0n));
    assert.ok(report.rounds.some(r => r.total_load_kw > r.total_solar_kw));
    assert.ok(report.rounds.some(r => r.total_load_kw < r.total_solar_kw));
    const history = report.evaluation.history;
    assert.ok(history.every(p => p.total_tokens === report.evaluation.initial_tokens));
    const scores = history.map(p => p.homes.find(h => h.id === 'home_01').score);
    const min = Math.min(...scores);
    assert.ok(min < scores[0]); assert.ok(scores.at(-1) > min, 'delivery restores reputation after a shortage');
    assert.ok(history.some(p => p.homes.some(h => h.telemetry)));
    for (const record of Object.values(runtime.gateway.journal.data.requests).filter(r => r.request.action === 'place_order')) {
      assert.equal(record.request.payload.override_reason, undefined, 'orders use the MQTT forecast, without test overrides');
      assert.equal(record.steps.market.receipt.status, 1);
    }
    console.log(`COMMUNITY REPORT: ${path.join(directory, 'report.json')} (${trades.length} trades, ${history.length} history points)`);
  } finally { await runtime?.close(); }
});
