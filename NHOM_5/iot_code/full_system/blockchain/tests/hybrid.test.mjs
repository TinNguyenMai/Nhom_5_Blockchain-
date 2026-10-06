import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { id } from 'ethers';
import { hardwareSource, edgeAiSource, validateHardwareForecast } from '../lib/hardware-source.mjs';
import { runHybrid } from '../lib/hybrid-market.mjs';
import { createSimulation, simulationConfig } from '../lib/simulation-runtime.mjs';
import { ROOT } from '../lib/files.mjs';
import { compile } from '../compile.mjs';

export function fixture(now = Date.now(), power = .06) {
  const stamp = new Date(Math.floor(now / 300000) * 300000 + 7 * 3600000).toISOString().slice(0, 19) + '+07:00';
  return { schema_version: 1, run_id: 'a'.repeat(32), household_id: 'home_01', event_id: 'a'.repeat(32) + ':home_01:0',
    timestamp: stamp, published_at: new Date(now).toISOString(), received_at: new Date(now).toISOString(), interval_seconds: 300,
    irradiance_w_m2: 0, temperature_c: 0, cloud_cover: 0, solar_power_kw: 0, load_power_kw: power,
    net_power_kw: -power, solar_energy_kwh: 0, load_energy_kwh: power / 12,
    surplus_energy_kwh: 0, deficit_energy_kwh: power / 12, data_mode: 'real', demo_scenario: 'none',
    solar_voltage_v: 0, solar_current_a: 0, load_voltage_v: 12, load_current_a: power * 1000 / 12,
    temperature_source: 'unavailable', temperature_valid: false };
}

test('zero PV uses real measured deficit; reject stale/demo/tampered sources and never round sub-Wh upward', () => {
  const now = Date.parse('2026-10-05T20:02:00+07:00'), config = simulationConfig({ scenario: 'hybrid', hybridSource: 'telemetry' });
  const reading = fixture(now), home = config.homes[0], source = hardwareSource(reading, home, now);
  assert.equal(source.action, 'buy'); assert.equal(source.quantity_wh, '5');
  assert.equal(hardwareSource(fixture(now, 0), home, now).action, 'hold');
  assert.equal(hardwareSource(fixture(now, .003), home, now).quantity_wh, '0');
  assert.equal(hardwareSource(fixture(now, .012), home, now).quantity_wh, '1');
  assert.throws(() => hardwareSource({ ...reading, data_mode: 'simulation' }, home, now), /thật/);
  assert.throws(() => hardwareSource(reading, home, now + 361000), /cũ/);
  assert.throws(() => hardwareSource({ ...reading, timestamp: '2026-10-05T19:00:00+07:00' }, home, now), /đồng hồ/);
  assert.throws(() => validateHardwareForecast({ ...source, household_id: 'home_01', quantity_wh: '6' }, config, now), /thay đổi/);
  assert.throws(() => simulationConfig({ scenario: 'hybrid', homes: 11 }), /12 hộ/);
});

function aiFixture(reading, modelVersion, load = .12) {
  const target = new Date(Date.parse(reading.timestamp) + 300000 + 7 * 3600000).toISOString().slice(0, 19) + '+07:00';
  return { schema_version: 1, household_id: 'home_01', run_id: reading.run_id, input_event_id: reading.event_id,
    input_timestamp: reading.timestamp, target_timestamp: target, interval_seconds: 300,
    model_version: modelVersion, device_kind: 'esp32', device_id: 'esp32-012345abcdef', data_mode: reading.data_mode, history_samples: 12,
    ...(reading.time_mode === 'accelerated' ? { time_mode: 'accelerated', sampling_seconds: 5 } : {}),
    predicted_solar_kw: 0, predicted_load_kw: load, predicted_net_kw: -load, predicted_surplus_kwh: 0,
    inference_us: 150, arena_used_bytes: 8192, free_heap_bytes: 100000, clipped_features: 0, model_bytes: 5832,
    received_at: reading.received_at, late: false };
}

test('AI quantity comes from prediction, with real matching input, pinned model, fresh target and immutable evidence', () => {
  const now = Date.parse('2026-10-05T20:02:00+07:00'), config = simulationConfig({ scenario: 'hybrid', hybridSource: 'ai' });
  const reading = fixture(now), prediction = aiFixture(reading, config.ai_model_version);
  const make = (p = prediction, r = reading) => edgeAiSource(r, p, config.homes[0], now, config.ai_model_version);
  const source = make();
  assert.equal(source.basis, 'esp32_forecast'); assert.equal(source.quantity_wh, '10');
  assert.equal(hardwareSource(reading, config.homes[0], now).quantity_wh, '5');
  assert.equal(make(aiFixture(reading, config.ai_model_version, .003)).action, 'hold');
  for (const changes of [{ data_mode: 'simulation' }, { history_samples: 11 }, { model_version: 'wrong-model' },
    { run_id: 'b'.repeat(32) }, { input_event_id: reading.event_id + '1' }, { target_timestamp: reading.timestamp },
    { late: true }, { device_kind: 'pc_reference' }]) assert.throws(() => make({ ...prediction, ...changes }), /dự báo Edge AI/);
  assert.throws(() => make({ ...prediction, received_at: '2026-10-05T19:00:00+07:00' }), /cũ/);
  assert.throws(() => make({ ...prediction, predicted_net_kw: 1 }), /nhất quán/);
  assert.throws(() => validateHardwareForecast({ ...source, household_id: 'home_01', quantity_wh: '5' }, config, now), /thay đổi/);
  assert.throws(() => validateHardwareForecast({ ...hardwareSource(reading, config.homes[0], now), household_id: 'home_01' }, config, now), /Nguồn ESP32/);
});

test('5-second simulation uses virtual model time, fresh arrival time and explicit provenance; real AI rejects it', () => {
  const now = Date.parse('2026-10-05T20:02:00+07:00'), config = simulationConfig({ scenario: 'hybrid', hybridSource: 'ai-demo' });
  const reading = { ...fixture(now), timestamp: '2026-10-02T06:00:00+07:00', data_mode: 'simulation', demo_scenario: 'buy', time_mode: 'accelerated', sampling_seconds: 5 };
  const prediction = aiFixture(reading, config.ai_model_version);
  const source = edgeAiSource(reading, prediction, config.homes[0], now, config.ai_model_version, true);
  assert.equal(source.quantity_wh, '10'); assert.equal(source.policy_version, 'edge-ai-accelerated5s-v1');
  validateHardwareForecast({ ...source, household_id: 'home_01' }, config, now);
  assert.throws(() => edgeAiSource(reading, prediction, config.homes[0], now, config.ai_model_version), /thật/);
  assert.throws(() => edgeAiSource(reading, prediction, config.homes[0], now + 21000, config.ai_model_version, true), /cũ/);
  assert.throws(() => edgeAiSource(reading, { ...prediction, sampling_seconds: 300 }, config.homes[0], now, config.ai_model_version, true), /5s/);
});

test('5-second real sensor source keeps measured provenance, needs fresh arrival and is not interchangeable with other modes', () => {
  const now = Date.parse('2026-10-05T20:02:00+07:00'), config = simulationConfig({ scenario: 'hybrid' });
  assert.equal(config.hybrid_source, 'ai-live');
  const reading = { ...fixture(now), timestamp: '2026-10-06T03:15:00+07:00', time_mode: 'accelerated', sampling_seconds: 5 };
  const prediction = aiFixture(reading, config.ai_model_version), home = config.homes[0];
  const source = edgeAiSource(reading, prediction, home, now, config.ai_model_version, true, false);
  assert.equal(source.quantity_wh, '10'); assert.equal(source.policy_version, 'edge-ai-live5s-v1');
  assert.equal(source.input.data_mode, 'real'); assert.equal(source.ai_prediction.data_mode, 'real');
  validateHardwareForecast({ ...source, household_id: 'home_01' }, config, now);
  assert.throws(() => edgeAiSource(reading, prediction, home, now, config.ai_model_version), /thật/);
  assert.throws(() => edgeAiSource(reading, prediction, home, now, config.ai_model_version, true), /mô phỏng 5s/);
  assert.throws(() => edgeAiSource(reading, prediction, home, now + 21000, config.ai_model_version, true, false), /cũ/);
  assert.throws(() => edgeAiSource({ ...reading, data_mode: 'simulation', demo_scenario: 'buy' }, { ...prediction, data_mode: 'simulation' }, home, now, config.ai_model_version, true, false), /INA219 thật nhịp 5s/);
  assert.throws(() => edgeAiSource(reading, { ...prediction, data_mode: 'simulation' }, home, now, config.ai_model_version, true, false), /cảm biến thật 5s/);
  assert.throws(() => validateHardwareForecast({ ...source, household_id: 'home_01' }, simulationConfig({ scenario: 'hybrid', hybridSource: 'ai-demo' }), now), /mô phỏng 5s/);
});

for (const sourceMode of ['telemetry', 'ai', 'ai-demo', 'ai-live']) test(`test fixture → ${sourceMode} source + 11 MQTT agents → local receipts and virtual delivery`, { timeout: 240000 }, async () => {
  compile();
  const directory = path.join(ROOT, 'build', 'hybrid-fixture-test');
  fs.mkdirSync(directory, { recursive: true });
  let reading;
  const backend = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const row = reading || fixture();
    res.end(JSON.stringify(req.url === '/health' ? { mqtt: { connected: true, subscribed: true } }
      : { items: [req.url.startsWith('/api/predictions') ? aiFixture(row, simulationConfig({ scenario: 'hybrid' }).ai_model_version) : row] }));
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  let runtime;
  try {
    runtime = await createSimulation({ config: simulationConfig({ scenario: 'hybrid', hybridSource: sourceMode }), directory: path.join(directory, String(Date.now())) });
    reading = fixture();
    if (sourceMode === 'ai-demo') Object.assign(reading, { timestamp: '2026-10-02T06:00:00+07:00', data_mode: 'simulation', demo_scenario: 'buy', time_mode: 'accelerated', sampling_seconds: 5 });
    if (sourceMode === 'ai-live') Object.assign(reading, { time_mode: 'accelerated', sampling_seconds: 5 });
    const report = await runHybrid(runtime, { backendUrl: `http://127.0.0.1:${backend.address().port}`, hardwareTimeout: 1000 });
    assert.equal(report.homes.length, 12); assert.equal(report.conserved, true); assert.equal(report.escrow, '0');
    assert.equal(report.physical_delivery_verified, false); assert.equal(report.data_kind, { 'ai-demo': 'hybrid_accelerated_simulation', 'ai-live': 'hybrid_accelerated_measurement' }[sourceMode] || 'hybrid_simulation');
    const sourceOrder = report.rounds[0].orders.find(o => o.home === 'home_01');
    const q = sourceMode !== 'telemetry' ? '10' : '5';
    assert.equal(sourceOrder.basis, sourceMode !== 'telemetry' ? 'esp32_forecast' : 'esp32_telemetry'); assert.equal(sourceOrder.side, 1); assert.equal(sourceOrder.quantity_wh, q);
    const source = JSON.parse(fs.readFileSync(path.join(runtime.directory, 'esp32-source.json')));
    assert.equal(sourceOrder.source_id, source.source_id); assert.equal(sourceOrder.data_hash, source.data_hash);
    assert.equal(report.homes[0].telemetry.solar_power_kw, 0);
    assert.equal(report.homes[0].prediction.device_kind, 'esp32');
    assert.ok(report.homes.slice(1).every(h => h.prediction.device_kind === 'simulator' && h.telemetry.virtual_profile === 'daytime_counterparty'));
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(runtime.directory, 'meters.json'))).latest).length, 11);
    assert.ok(report.rounds[0].trades.some(t => t.buyer === 'home_01' && t.delivered_wh === q));
    const request = Object.values(runtime.gateway.journal.data.requests).find(r => r.request.household_id === 'home_01' && r.request.action === 'place_order');
    assert.equal(request.steps.market.receipt.status, 1);
    const r = await runtime.admin('open_round', { key: id('duplicate-hardware-source-test'), bidding_seconds: 300 });
    const duplicate = await runtime.request('solar/home_01/order/request', runtime.envelope('home_01', 'place_order',
      { ...request.request.payload, round_id: r.result.round_id }));
    assert.equal(duplicate.status, 'rejected'); assert.equal(duplicate.error, 'Duplicate');
    fs.writeFileSync(path.join(directory, 'report-location.json'), JSON.stringify({ directory: runtime.directory, fixture: true }));
    console.log(`PASS hybrid ${sourceMode} fixture: ${report.rounds[0].trades.length} trades; ${q} Wh hardware-source buy; escrow=0; duplicate source blocked. Report ${runtime.directory}`);
  } finally {
    await runtime?.close(); await new Promise(resolve => backend.close(resolve));
  }
});
