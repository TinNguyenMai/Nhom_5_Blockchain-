import assert from 'node:assert/strict';
import path from 'node:path';
import { id } from 'ethers';
import { randomUUID } from 'node:crypto';
import { hardwareSource, edgeAiSource } from './hardware-source.mjs';
import { writeJson } from './files.mjs';
import { delay } from './market.mjs';
import { evaluationSummary } from './simulation-evaluation.mjs';

export async function probeHardware(backendUrl = 'http://127.0.0.1:8000', simulated = false) {
  const base = new URL(backendUrl);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(base.hostname))
    throw new Error('Backend ESP32 phải là HTTP trên máy local');
  const get = async route => {
    const response = await fetch(new URL(route, base), { signal: AbortSignal.timeout(2500) });
    if (!response.ok) throw new Error(`Backend ESP32: HTTP ${response.status}`);
    return response.json();
  };
  const health = await get('/health');
  if (!health.mqtt?.connected || !health.mqtt?.subscribed) throw new Error('Backend chưa kết nối và subscribe MQTT của ESP32');
  // Old accelerated demo runs may have future sample dates; live arrival time must win.
  const records = await get('/api/telemetry?household_id=home_01&limit=1&order=received');
  const reading = records.items?.[0];
  if (!reading) throw new Error('Chưa có số đo Nhà 1; bật ESP32 và chờ bản tin 5 phút');
  if (!simulated && reading.data_mode !== 'real') throw new Error('Bản tin Nhà 1 gần nhất là demo; dùng demo off trên ESP32 và chờ số đo thật');
  return reading;
}

export async function probeHardwareSource(backendUrl, home, { sourceMode = 'ai-live', modelVersion } = {}) {
  const fast = ['ai-demo', 'ai-live'].includes(sourceMode), simulated = sourceMode === 'ai-demo';
  const reading = await probeHardware(backendUrl, simulated);
  // Validate measured provenance/freshness even while waiting for the AI buffer.
  hardwareSource(reading, home, Date.now(), fast, simulated);
  if (sourceMode === 'telemetry') return hardwareSource(reading, home, Date.now());
  if (!['ai', 'ai-demo', 'ai-live'].includes(sourceMode)) throw new Error('Nguồn ESP32 không hợp lệ');
  const response = await fetch(new URL(`/api/predictions?household_id=home_01&run_id=${reading.run_id}&limit=5&order=received`, backendUrl),
    { signal: AbortSignal.timeout(2500) });
  if (!response.ok) throw new Error(`Backend dự báo AI: HTTP ${response.status}`);
  const records = await response.json();
  const prediction = records.items?.find(p => p.input_event_id === reading.event_id);
  return edgeAiSource(reading, prediction, home, Date.now(), modelVersion, fast, simulated);
}

export async function runHybrid(runtime, { onCheck = () => {}, backendUrl = 'http://127.0.0.1:8000', hardwareTimeout } = {}) {
  const { config, chain } = runtime;
  assert.equal(config.hybrid, true);
  const sourceMode = config.hybrid_source || 'ai-live';
  const ai = sourceMode !== 'telemetry', fast = ['ai-demo', 'ai-live'].includes(sourceMode), simulated = sourceMode === 'ai-demo';
  const label = simulated ? 'Edge AI trên dữ liệu mô phỏng 5s' : fast ? 'Edge AI trên số đo INA219 thật 5s' : ai ? 'dự báo Edge AI từ số đo thật' : 'số đo thật';
  const update = fields => {
    runtime.hardware = { ...runtime.hardware, ...fields };
    runtime.events.push({ action: 'hardware_status', ...runtime.hardware });
    runtime.onHardware?.(runtime.hardware);
  };
  update({ phase: 'waiting', message: simulated ? 'Đang chờ Edge AI trên dữ liệu mô phỏng 5s từ ESP32' : fast ? 'Đang chờ INA219 thật 5s và dự báo Edge AI của Nhà 1' : ai ? 'Đang chờ INA219 thật và dự báo Edge AI của Nhà 1' : 'Đang chờ telemetry INA219 thật từ Nhà 1', backend_url: backendUrl,
    source_mode: sourceMode, sampling_seconds: fast ? 5 : 300, input_mode: simulated ? 'simulation' : 'real',
    physical_delivery_verified: false, simulated_homes: 11 });
  const deadline = Date.now() + (hardwareTimeout ?? (fast ? 120000 : ai ? 3900000 : 360000));
  let source;
  while (!runtime.stopped) {
    try {
      source = await probeHardwareSource(backendUrl, config.homes[0], { sourceMode, modelVersion: config.ai_model_version });
      break;
    } catch (error) {
      update({ phase: 'waiting', message: error.message });
      if (Date.now() >= deadline) throw new Error(`Chưa nhận nguồn ESP32 hợp lệ: ${error.message}`);
      await delay(Math.min(5000, Math.max(1, deadline - Date.now())));
    }
  }
  if (runtime.stopped) throw new Error('Đã dừng phiên ESP32');
  writeJson(path.join(runtime.directory, 'esp32-source.json'), source);
  update({ phase: 'received', message: source.action === 'hold'
    ? `Đã nhận ${ai ? 'dự báo Edge AI' : 'số đo thật'}; điện năng ròng dưới 1 Wh nên Nhà 1 giữ nguyên`
    : `Đã nhận ${ai ? 'dự báo Edge AI' : 'số đo thật'}; Nhà 1 đề xuất ${source.action === 'buy' ? 'mua' : 'bán'} ${source.quantity_wh} Wh`,
    event_id: source.input.event_id, received_at: source.received_at, sample_timestamp: source.input.timestamp,
    solar_power_kw: source.input.solar_power_kw, load_power_kw: source.input.load_power_kw,
    action: source.action, quantity_wh: source.quantity_wh, policy: source.policy_version,
    model_version: source.ai_prediction?.model_version, predicted_solar_kw: source.ai_prediction?.predicted_solar_kw,
    predicted_load_kw: source.ai_prediction?.predicted_load_kw });
  const sequence = 0;
  const telemetry = { ...source.input, ...runtime.envelope('home_01', 'telemetry', {}),
    event_id: `${runtime.runId}:home_01:${sequence}`, source_event_id: source.input.event_id, basis: simulated ? 'esp32_simulated_input' : 'esp32_meter' };
  const forecast = { ...source, ...runtime.envelope('home_01', source.action, {}), action: source.action };
  delete telemetry.payload; delete forecast.payload;
  await runtime.peer.publish('solar/home_01/telemetry', telemetry);
  await runtime.peer.publish('solar/home_01/esp32/source', forecast);
  await Promise.all(config.homes.slice(1).map(h => runtime.command(h.id, 'sample', { sequence,
    timestamp: source.input.timestamp, profile: 'hybrid_daytime' }).then(r => assert.equal(r.status, 'sampled', r.error))));
  const mqttDeadline = Date.now() + 10000;
  while (!config.homes.every(h => runtime.gateway.telemetry[h.id] && runtime.gateway.predictions[h.id])) {
    if (Date.now() > mqttDeadline) throw new Error(`Thiếu dữ liệu nguồn MQTT: ${runtime.mqtt.errors}`);
    await delay(50);
  }
  assert.equal(runtime.gateway.predictions.home_01.source_id, source.source_id);
  const ok = r => { assert.equal(r.status, 'confirmed', r.error); return r.result; };
  const started = Date.now();
  runtime.evaluationContext = { check_index: 0, check_name: `1 ESP32 thật + 11 hộ mô phỏng · ${ai ? 'AI' : 'số đo'} → lệnh → khớp → thanh toán` };
  await runtime.gateway.snapshot({ action: 'check_start' });
  const startPoint = runtime.history.at(-1).index;
  const opened = ok(await runtime.admin('open_round', { key: id(`hybrid:${runtime.runId}:${randomUUID()}`), bidding_seconds: config.bidding_seconds }));
  const r = opened.round_id;
  runtime.roundMetadata[r] = { sample_timestamp: source.input.timestamp, target_timestamp: source.target_timestamp,
    interval_seconds: 300, sampling_seconds: fast ? 5 : 300, time_mode: fast ? 'accelerated' : 'realtime', profile: 'hybrid', event: `Nhà 1: ${simulated ? 'Edge AI mô phỏng 5s' : fast ? 'INA219 thật 5s + Edge AI' : ai ? 'INA219 thật + Edge AI' : 'INA219 thật'}; 11 hộ: mô hình nắng ảo`,
    total_solar_kw: config.homes.reduce((n, h) => n + runtime.gateway.telemetry[h.id].solar_power_kw, 0),
    total_load_kw: config.homes.reduce((n, h) => n + runtime.gateway.telemetry[h.id].load_power_kw, 0) };
  for (const h of config.homes) if (h.category !== 'ordinary') ok(await runtime.admin('set_priority', {
    home: h.id, category: h.category, verification: { kind: 'simulated_registry', record_id: `${runtime.runId}:${h.id}` } }));
  // Submit the hardware order first; its exact measured quantity must not be replaced by a simulation profile.
  if (source.action !== 'hold') ok(await runtime.request('solar/home_01/order/request', runtime.envelope('home_01', 'place_order', {
    round_id: r, side: source.action === 'sell' ? 0 : 1, quantity_wh: source.quantity_wh,
    price: source.price, basis: source.basis, forecast } )));
  for (const h of config.homes.slice(1)) if (runtime.gateway.predictions[h.id].action !== 'hold')
    ok(await runtime.command(h.id, 'place_order', { round_id: r }));
  const round = await chain.market.rounds(r);
  await chain.provider.send('evm_setNextBlockTimestamp', [Number(round.closesAt)]);
  await chain.provider.send('evm_mine', []);
  ok(await runtime.admin('settle', { round_id: r }));
  const orders = await chain.market.getOrders(r), trades = await chain.market.getTrades(r);
  const homeFor = a => Object.entries(chain.manifest.households).find(([, address]) => address.toLowerCase() === a.toLowerCase())[0];
  // This oracle is explicitly virtual. Real telemetry does not prove physical delivery between houses.
  for (const [index, trade] of trades.entries()) {
    const seller = homeFor(orders[Number(trade.sellIndex)].trader), buyer = homeFor(orders[Number(trade.buyIndex)].trader);
    const measurement = { kind: 'paired_simulated_meters', seller, buyer };
    for (const [prefix, home, direction] of [['seller', seller, 'export'], ['buyer', buyer, 'import']]) {
      const meter = `${home}:${direction}`, start = BigInt(runtime.gateway.journal.data.meters[meter] || 0);
      measurement[`${prefix}_meter_id`] = meter;
      measurement[`${prefix}_start_wh`] = String(start);
      measurement[`${prefix}_end_wh`] = String(start + trade.quantityWh);
    }
    ok(await runtime.request(`solar/${seller}/delivery`, runtime.envelope(seller, 'confirm_trade', {
      round_id: r, trade_index: String(index), delivered_wh: String(trade.quantityWh), measurement })));
  }
  update({ phase: 'completed', message: source.action === 'hold'
    ? 'Phiên hoàn tất; Nhà 1 giữ nguyên vì dưới ngưỡng 1 Wh, 11 hộ vẫn giao dịch'
    : `Phiên hoàn tất: lệnh Nhà 1 dùng ${label}; giao điện được xác nhận bằng công tơ ảo` });
  const snapshot = await runtime.gateway.snapshot({ action: 'check_end' });
  assert.equal(snapshot.conserved, true); assert.equal(snapshot.escrow, '0');
  assert.ok(snapshot.rounds.every(x => x.trades.every(t => t.status !== 'pending')));
  const entry = { name: runtime.evaluationContext.check_name, passed: true, duration_ms: Date.now() - started,
    evidence: { start_point: startPoint, end_point: runtime.history.at(-1).index, round_ids: [r], summary: evaluationSummary(snapshot.rounds) } };
  onCheck(entry);
  const report = { ...snapshot, checks: [entry], passed: true, scenario: 'hybrid', data_kind: simulated ? 'hybrid_accelerated_simulation' : fast ? 'hybrid_accelerated_measurement' : 'hybrid_simulation',
    physical_delivery_verified: false, hardware: runtime.hardware, source_policy: source.policy_version,
    completed_at: new Date().toISOString(), mqtt_events: runtime.events, report_directory: runtime.directory };
  writeJson(path.join(runtime.directory, 'checks.json'), report.checks);
  writeJson(path.join(runtime.directory, 'report.json'), report);
  return report;
}
