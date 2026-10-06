import assert from "node:assert/strict";
import { id } from "ethers";
import { randomUUID } from "node:crypto";
import { writeJson } from "./lib/files.mjs";
import path from "node:path";
import { evaluationSummary } from './lib/simulation-evaluation.mjs';
import { delay } from './lib/market.mjs';
import { runHybrid } from './lib/hybrid-market.mjs';

export const SCENARIOS = [
  { id: 'hybrid', name: '1 ESP32 + 11 hộ mô phỏng', description: 'ESP32 đo INA219 thật, lấy mẫu mỗi 5 giây và chạy Edge AI trên board; dự báo đầu tiên khoảng 60 giây. Có lựa chọn mẫu mô phỏng hoặc đo thật 5 phút/mẫu; 11 hộ tạo đối tác ảo. Giao điện dùng công tơ ảo; mỗi lượt chạy một phiên.' },
  { id: "community", name: "Cộng đồng biến động · 12 phiên", description: "Một giờ mô phỏng: nắng/mây/mưa, tải biến đổi, nhiều hộ giao dịch, giao thiếu và phục hồi uy tín." },
  { id: "full-demo", name: "Toàn bộ chức năng", description: "Giao đủ, ưu tiên, hủy, giao thiếu, uy tín, quá hạn và phục hồi MQTT." },
  { id: "basic", name: "Thị trường nhiều hộ", description: "Các hộ tự tạo đề xuất từ điện phát và tải, đặt lệnh, giao đủ." },
  { id: "priority", name: "Ưu tiên người mua", description: "Bệnh viện, trường mầm non, hộ đặc biệt và thứ tự theo giá." },
  { id: "reputation", name: "Uy tín và đặt cọc", description: "Giao thiếu, phạt cọc, giới hạn nhiều phiên, giảm và phục hồi điểm." },
  { id: "resilience", name: "MQTT và phục hồi", description: "Bản tin trùng, khởi động lại sau khi ký và mất kết nối broker." }
];

export async function runScenarios(runtime, scenario = "full-demo", options = {}) {
  const { onCheck = () => {} } = options;
  if (!SCENARIOS.some(s => s.id === scenario)) throw new Error("Unknown simulation scenario");
  if (scenario === 'hybrid') return runHybrid(runtime, options);
  const { chain, config } = runtime;
  const checks = [], { market, token, provider, manifest } = chain;
  let sequence = 0;
  const A = "home_01", B = "home_02", H = "home_03", K = "home_05", S = "home_06";
  const address = h => manifest.households[h];
  const check = async (name, body) => {
    const start = Date.now();
    const checkIndex = checks.length;
    runtime.evaluationContext = { check_index: checkIndex, check_name: name };
    const before = await runtime.gateway.snapshot({ action: 'check_start' });
    const startPoint = runtime.history.at(-1).index;
    const oldRounds = new Set(before.rounds.map(r => r.round_id));
    const evidence = state => ({ start_point: startPoint, end_point: runtime.history.at(-1).index,
      round_ids: state.rounds.filter(r => !oldRounds.has(r.round_id)).map(r => r.round_id),
      summary: evaluationSummary(state.rounds.filter(r => !oldRounds.has(r.round_id))) });
    try {
      await body();
      const state = await runtime.gateway.snapshot({ action: 'check_end' }); assert.equal(state.conserved, true, "Token conservation");
      const entry = { name, passed: true, duration_ms: Date.now() - start, evidence: evidence(state) };
      checks.push(entry); onCheck(entry);
    } catch (e) {
      let state;
      try { state = await runtime.gateway.snapshot({ action: 'check_failed' }); } catch {}
      const entry = { name, passed: false, error: e.shortMessage || e.message, duration_ms: Date.now() - start,
        ...(state ? { evidence: evidence(state) } : {}) };
      checks.push(entry); onCheck(entry); throw e;
    } finally { runtime.evaluationContext = {}; writeJson(path.join(runtime.directory, "checks.json"), checks); }
  };
  const ok = r => { assert.equal(r.status, "confirmed", r.error); return r.result; };
  const rejected = (r, reason) => { assert.equal(r.status, "rejected", JSON.stringify(r)); assert.match(r.error, new RegExp(reason)); };
  const sample = async (profile) => {
    await Promise.all(config.homes.map(h => runtime.command(h.id, "sample", { sequence, ...(profile ? { profile } : {}) })));
    const deadline = Date.now() + 8000;
    while (!config.homes.every(h => runtime.gateway.predictions[h.id]?.input_event_id === `${runtime.runId}:${h.id}:${sequence}` &&
      runtime.gateway.telemetry[h.id]?.event_id === `${runtime.runId}:${h.id}:${sequence}`)) {
      if (Date.now() >= deadline) throw new Error(`Gateway chưa nhận đủ dữ liệu đo và dự báo hợp lệ cho khoảng ${sequence}`);
      await delay(25);
    }
    sequence++;
  };
  const open = async (profile) => {
    const r = ok(await runtime.admin("open_round", { key: id(`simulation:${runtime.runId}:${randomUUID()}`), bidding_seconds: config.bidding_seconds }));
    await sample(profile);
    const reading = runtime.gateway.telemetry[A], prediction = runtime.gateway.predictions[A];
    runtime.roundMetadata[r.round_id] = { sample_timestamp: reading?.timestamp, target_timestamp: prediction?.target_timestamp,
      interval_seconds: config.step_seconds, profile: profile || 'contract-test',
      event: reading?.scenario_event || '', weather: reading?.weather || 'sunny',
      total_solar_kw: config.homes.reduce((n, h) => n + Number(runtime.gateway.telemetry[h.id].solar_power_kw), 0),
      total_load_kw: config.homes.reduce((n, h) => n + Number(runtime.gateway.telemetry[h.id].load_power_kw), 0) };
    return r.round_id;
  };
  const order = (r, h, side, q = "100", price = side === 0 ? "2000" : "3000", extra = {}) =>
    runtime.command(h, "place_order", { round_id: r, side, quantity_wh: String(q), price: String(price), override_reason: "deterministic_contract_scenario", ...extra });
  const close = async r => {
    const round = await market.rounds(r), block = await provider.getBlock("latest");
    if (BigInt(block.timestamp) < round.closesAt) {
      await provider.send("evm_setNextBlockTimestamp", [Number(round.closesAt)]); await provider.send("evm_mine", []);
    }
    ok(await runtime.admin("settle", { round_id: r }));
    return market.getTrades(r);
  };
  const deliver = async (r, ratio = 10000, index, extra = {}) => {
    const orders = await market.getOrders(r), trades = await market.getTrades(r);
    for (let i = 0; i < trades.length; i++) {
      if (index !== undefined && i !== index) continue;
      if (trades[i].status !== 0n) continue;
      const seller = Object.entries(manifest.households).find(([, a]) => a.toLowerCase() === orders[Number(trades[i].sellIndex)].trader.toLowerCase())[0];
      const buyer = Object.entries(manifest.households).find(([, a]) => a.toLowerCase() === orders[Number(trades[i].buyIndex)].trader.toLowerCase())[0];
      const result = await runtime.command(seller, "delivery", { round_id: r, trade_index: String(i), buyer,
        quantity_wh: String(trades[i].quantityWh), delivery_bps: ratio, ...extra });
      if (!extra.invalid && !extra.offline) ok(result);
      else if (extra.invalid) rejected(result, "Invalid delivery evidence");
    }
  };
  const pair = async (ratio = 10000) => {
    const r = await open(); ok(await order(r, A, 0)); ok(await order(r, B, 1));
    await close(r); await deliver(r, ratio); return r;
  };
  const priority = (home, category) => runtime.admin("set_priority", { home, category,
    verification: { kind: "simulated_registry", record_id: `${runtime.runId}:${home}:${category}` } });

  for (const h of config.homes) if (h.category !== "ordinary") ok(await priority(h.id, h.category));

  if (scenario === 'community') {
    const events = ['Nắng ổn định', 'Tải bắt đầu tăng', 'Mây che, tải cao', 'Mưa; Nhà 1 gián đoạn giao',
      'Nắng trở lại; Nhà 1 giao thiếu', 'Mây và sự cố Nhà 7', 'Mưa, đỉnh phụ tải',
      'Nguồn cung phục hồi', 'Tải tăng; sự cố Nhà 1 và Nhà 8', 'Giao đủ, phục hồi uy tín',
      'Mây nhẹ, tải giảm', 'Nắng, kết thúc phục hồi'];
    for (let step = 0; step < events.length; step++) await check(`Phiên ${step + 1}/12 · ${events[step]}`, async () => {
      const r = await open('community');
      for (const h of config.homes) {
        const forecast = runtime.gateway.predictions[h.id];
        if (forecast.action !== 'hold' && forecast.quantity_wh !== '0') ok(await runtime.command(h.id, 'place_order', { round_id: r }));
      }
      const orders = await market.getOrders(r), trades = await close(r);
      for (let i = 0; i < trades.length; i++) {
        const seller = Object.entries(manifest.households).find(([, a]) => a.toLowerCase() === orders[Number(trades[i].sellIndex)].trader.toLowerCase())[0];
        const ratio = step === 3 && seller === A ? 0 : step === 4 && seller === A ? 4000
          : step === 5 && seller === 'home_07' ? 7000
          : step === 8 && [A, 'home_08'].includes(seller) ? 0 : 10000;
        await deliver(r, ratio, i);
      }
      assert.equal(await token.balanceOf(manifest.market), 0n);
    });
  }

  if (["full-demo", "basic"].includes(scenario)) await check("Nhiều hộ: dự báo → MQTT → khóa tiền → khớp → giao đủ", async () => {
    const r = await open();
    for (const h of config.homes) {
      const forecast = runtime.gateway.predictions[h.id];
      assert.equal(forecast.device_kind, "simulator");
      if (forecast.action !== "hold" && forecast.quantity_wh !== "0") ok(await runtime.command(h.id, "place_order", { round_id: r }));
    }
    const trades = await close(r);
    assert.ok(trades.length > 0); assert.ok(await token.balanceOf(manifest.market) > 0n);
    assert.equal(Object.keys(runtime.gateway.telemetry).length, config.homes.length);
    assert.ok((await market.getOrders(r)).every(o => o.basis === 2n));
    await deliver(r);
    assert.equal(await token.balanceOf(manifest.market), 0n);
  });

  if (["full-demo", "priority"].includes(scenario)) {
    ok(await priority(B, "ordinary")); ok(await priority(H, "hospital")); ok(await priority(K, "kindergarten")); ok(await priority(S, "special"));
    ok(await priority("home_04", "hospital"));
    for (const [home, name] of [[H, "Bệnh viện công"], ["home_04", "Bệnh viện tư"], [K, "Trường mầm non"], [S, "Hộ đặc biệt"]]) await check(`${name} thắng hộ thường cùng giá dù đặt sau`, async () => {
      const r = await open(); ok(await order(r, A, 0, "60")); ok(await order(r, B, 1, "60")); ok(await order(r, home, 1, "60"));
      const trades = await close(r); assert.equal(trades[0].buyIndex, 2n); await deliver(r);
    });
    await check("Giá cao hơn vẫn thắng nhóm ưu tiên", async () => {
      const r = await open(); ok(await order(r, A, 0)); ok(await order(r, H, 1)); ok(await order(r, B, 1, "100", "3500"));
      const trades = await close(r); assert.equal(trades[0].buyIndex, 2n); await deliver(r);
    });
    await check("Hai nhóm ưu tiên ngang giá dùng thứ tự đặt lệnh", async () => {
      const r = await open(); ok(await order(r, A, 0)); ok(await order(r, H, 1)); ok(await order(r, K, 1));
      const trades = await close(r); assert.equal(trades[0].buyIndex, 1n); await deliver(r);
    });
  }

  if (scenario === "full-demo") {
    await check("Hủy đúng hạn hoàn tiền; không hủy hai lần hoặc đặt lại", async () => {
      const r = await open(), before = await token.balanceOf(address(B));
      const placed = ok(await order(r, B, 1));
      assert.equal(await token.balanceOf(address(B)), before - 300000n);
      ok(await runtime.command(B, "cancel_order", { round_id: r, order_index: String(placed.order_index) }));
      assert.equal(await token.balanceOf(address(B)), before);
      rejected(await runtime.command(B, "cancel_order", { round_id: r, order_index: String(placed.order_index) }), "Duplicate");
      rejected(await order(r, B, 1), "Duplicate"); await close(r);
    });
    await check("Giá không giao nhau: không khớp và hoàn toàn bộ", async () => {
      const r = await open(); ok(await order(r, A, 0, "100", "4000")); ok(await order(r, B, 1));
      assert.equal((await close(r)).length, 0); assert.equal(await token.balanceOf(manifest.market), 0n);
    });
    await check("Khớp theo giá bán thấp nhất, trả phần điện khớp và hoàn giá dư", async () => {
      const seller = config.homes.length > 6 ? "home_07" : "home_04";
      const r = await open(), before = await token.balanceOf(address(B));
      ok(await order(r, B, 1, "150", "3000")); ok(await order(r, A, 0, "100", "2000")); ok(await order(r, seller, 0, "100", "1900"));
      const trades = await close(r); assert.equal(trades[0].sellIndex, 2n); assert.equal(trades[1].quantityWh, 50n);
      assert.equal(await token.balanceOf(manifest.market), 290000n);
      await deliver(r); assert.equal(await token.balanceOf(address(B)), before - 290000n);
    });
    await check("Chặn kết toán sớm, đặt lệnh muộn và quyền điều phối giả", async () => {
      const r = await open(); rejected(await runtime.admin("settle", { round_id: r }), "TooEarly");
      const fake = runtime.envelope(B, "open_round", { key: id(randomUUID()), bidding_seconds: 300 });
      rejected(await runtime.request("solar/market/round/request", fake), "Unauthorized MQTT action");
      await close(r); rejected(await order(r, A, 0), "Closed");
    });
    await check("Ngân sách thiếu: không có lệnh ảo hay điện cam kết", async () => {
      const r = await open(); rejected(await order(r, B, 1, "1000000", "1000000000000"), "ERC20InsufficientBalance");
      assert.equal((await market.getOrders(r)).length, 0); assert.equal(await market.activeQuantityWh(address(B)), 0n); await close(r);
    });
  }

  if (["full-demo", "reputation"].includes(scenario)) {
    await check("Hai lần không giao điện: điểm 60, cọc 10%, giới hạn giảm", async () => {
      await pair(0); await pair(0);
      assert.equal((await market.reputations(address(A))).score, 60n);
      assert.equal(await market.collateralBps(address(A)), 1000n);
      assert.equal(await market.quantityLimitWh(address(A)), 500_000_000n);
    });
    await check("Giới hạn cộng dồn mua/bán trên nhiều phiên và cọc hai bên", async () => {
      const r1 = await open(), r2 = await open(), r3 = await open();
      ok(await order(r1, A, 0, "300000000", "1")); ok(await order(r2, A, 1, "200000000", "1"));
      const book1 = await market.getOrders(r1), book2 = await market.getOrders(r2);
      assert.equal(book1[0].collateral, 30000000n); assert.equal(book2[0].collateral, 20000000n);
      assert.equal(await market.activeQuantityWh(address(A)), 500_000_000n);
      rejected(await order(r3, A, 0, "1", "1"), "QuantityLimit");
      ok(await runtime.command(A, "cancel_order", { round_id: r1, order_index: "0" }));
      ok(await runtime.command(A, "cancel_order", { round_id: r2, order_index: "0" }));
      await close(r1); await close(r2); await close(r3);
      assert.equal(await market.activeQuantityWh(address(A)), 0n);
    });
    await check("Cọc bắt buộc cho người bán uy tín thấp", async () => {
      const r = await open();
      // Prior approvals are reset by previous orders; skip the new allowance deliberately.
      rejected(await order(r, A, 0, "100", "2000", { approval: "skip" }), "ERC20InsufficientAllowance");
      assert.equal((await market.getOrders(r)).length, 0); await close(r);
    });
    await check("Giao 40%: thanh toán đo thực, phạt cọc và giảm điểm xuống 40", async () => {
      const beforeA = await token.balanceOf(address(A)), beforeB = await token.balanceOf(address(B));
      const r = await pair(4000), t = (await market.getTrades(r))[0];
      assert.equal(t.sellerCollateral, 20000n); assert.equal(t.deliveredWh, 40n);
      assert.equal(await token.balanceOf(address(A)), beforeA + 68000n);
      assert.equal(await token.balanceOf(address(B)), beforeB - 68000n);
      assert.equal((await market.reputations(address(A))).score, 40n);
      assert.equal(await market.collateralBps(address(A)), 2500n);
      rejected(await runtime.admin("expire_trade", { round_id: r, trade_index: "0" }), "AlreadyResolved");
      // Another confirmation is rejected rather than paying twice.
      const repeat = await runtime.command(A, "delivery", { round_id: r, trade_index: "0", buyer: B, quantity_wh: "100", delivery_bps: 10000 });
      rejected(repeat, "AlreadyResolved");
    });
    await check("Điểm thấp giới hạn lệnh mới; giao đủ phục hồi điểm", async () => {
      const r = await open(); rejected(await order(r, A, 0, "100000001", "1"), "QuantityLimit"); await close(r);
      await pair(10000); assert.equal((await market.reputations(address(A))).score, 42n);
    });
  }

  if (scenario === "full-demo") {
    await check("Không có xác nhận: quá hạn hoàn tiền và không tự quy vi phạm", async () => {
      const r = await open(), beforeA = await token.balanceOf(address(A)), beforeB = await token.balanceOf(address(B));
      const score = (await market.reputations(address(A))).score;
      ok(await order(r, A, 0)); ok(await order(r, B, 1)); await close(r);
      await deliver(r, 10000, undefined, { offline: true });
      rejected(await runtime.admin("expire_trade", { round_id: r, trade_index: "0" }), "TooEarly");
      await provider.send("evm_setNextBlockTimestamp", [Number((await market.rounds(r)).confirmationDeadline)]); await provider.send("evm_mine", []);
      const late = await runtime.command(A, "delivery", { round_id: r, trade_index: "0", buyer: B, quantity_wh: "100", delivery_bps: 10000 });
      rejected(late, "ConfirmationExpired");
      ok(await runtime.admin("expire_trade", { round_id: r, trade_index: "0" }));
      assert.equal(await token.balanceOf(address(A)), beforeA); assert.equal(await token.balanceOf(address(B)), beforeB);
      assert.equal((await market.reputations(address(A))).score, score);
    });
    await check("Hai phiên khớp giữ escrow độc lập; bằng chứng sai bị chặn", async () => {
      const r1 = await open(), r2 = await open();
      for (const r of [r1, r2]) { ok(await order(r, A, 0)); ok(await order(r, B, 1)); }
      await close(r1); await close(r2);
      const escrow = await token.balanceOf(manifest.market);
      await deliver(r1, 10000, undefined, { invalid: true });
      assert.equal(await token.balanceOf(manifest.market), escrow);
      await deliver(r1); assert.ok(await token.balanceOf(manifest.market) > 0n);
      assert.equal((await market.getTrades(r2))[0].status, 0n);
      await deliver(r2); assert.equal(await token.balanceOf(manifest.market), 0n);
    });
  }

  if (["full-demo", "resilience"].includes(scenario)) {
    await check("Bản tin lặp và gateway khởi động lại không gửi thêm giao dịch", async () => {
      const r = await open(), mid = randomUUID();
      const message = runtime.envelope(B, "place_order", { round_id: r, side: 1, quantity_wh: "100", price: "3000", override_reason: "duplicate_scenario" }, mid);
      const topic = `solar/${B}/simulation/request`;
      const first = await runtime.request(topic, message); ok(first);
      const again = await runtime.request(topic, message); ok(again);
      assert.equal(first.result.transaction_hash, again.result.transaction_hash);
      await runtime.restartGateway();
      const resumed = await runtime.request(topic, message); ok(resumed);
      assert.equal(resumed.result.transaction_hash, first.result.transaction_hash);
      assert.equal((await market.getOrders(r)).length, 1);
      ok(await runtime.command(B, "cancel_order", { round_id: r, order_index: "0" })); await close(r);
    });
    await check("Gateway dừng sau receipt: phục hồi đúng transaction đã ký", async () => {
      const r = await open();
      let notify; const hit = new Promise(resolve => { notify = resolve; });
      let injected = false;
      runtime.gateway.hooks.afterTransaction = (record, step) => {
        if (!injected && record.request.action === "place_order" && step === "market") {
          injected = true; notify(); throw Object.assign(new Error("Simulated crash after mined transaction"), { simulatedCrash: true });
        }
      };
      const pending = order(r, B, 1);
      // Attach rejection immediately so an unexpected timeout never becomes unhandled.
      pending.catch(() => {});
      let timer;
      try { await Promise.race([hit, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Crash injection was not reached")), 20000); })]); }
      finally { clearTimeout(timer); }
      const wire = Object.values(runtime.gateway.journal.data.requests).find(x => x.request.action === "place_order" && x.request.payload.round_id === r);
      const hash = wire.steps.market.hash;
      await runtime.restartGateway(); const restored = ok(await pending);
      assert.equal(restored.transaction_hash, hash); assert.equal((await market.getOrders(r)).length, 1);
      ok(await runtime.command(B, "cancel_order", { round_id: r, order_index: "0" })); await close(r);
    });
    await check("Broker khởi động lại: kết nối lại và tiếp tục cùng lượt", async () => {
      const r = await open(); ok(await order(r, A, 0));
      await runtime.restartBroker(); ok(await order(r, B, 1)); await close(r); await deliver(r);
      assert.equal(await token.balanceOf(manifest.market), 0n);
    });
  }

  const snapshot = await runtime.gateway.snapshot();
  assert.ok(snapshot.rounds.every(r => r.trades.every(t => t.status !== "pending")), "Every demo trade must have a terminal outcome");
  assert.equal(snapshot.escrow, "0");
  const report = { ...snapshot, scenario, checks, passed: checks.every(c => c.passed), mqtt_port: runtime.broker.port,
    data_kind: "hardware_free_simulation", physical_delivery_verified: false, completed_at: new Date().toISOString(),
    mqtt_events: runtime.events, report_directory: runtime.directory };
  writeJson(path.join(runtime.directory, "report.json"), report);
  return report;
}
