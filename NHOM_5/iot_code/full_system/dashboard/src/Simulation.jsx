import React, { useEffect, useState } from "react";
import "./simulation.css";
import SimulationEvaluation from './SimulationEvaluation.jsx';

const number = (v, digits = 3) => Number(v || 0).toLocaleString("vi-VN", { maximumFractionDigits: digits });
const slc = v => number(Number(v || 0) / 1e6, 6);
const categories = ["Hộ thường", "Bệnh viện", "Trường mầm non", "Hộ đặc biệt"];
const statusNames = { idle: "Sẵn sàng", starting: "Đang khởi tạo", running: "Đang mô phỏng", completed: "Đã hoàn tất", failed: "Có lỗi", interrupted: "Lượt bị gián đoạn" };
const tradeNames = { pending: "Chờ xác nhận", confirmed: "Đã xác nhận", expired: "Đã hoàn tiền" };
async function get(route, options) {
  const res = await fetch(route, options), body = await res.json();
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}
export default function Simulation() {
  const [config, setConfig] = useState(null), [state, setState] = useState(null), [error, setError] = useState("");
  const [scenario, setScenario] = useState("community"), [homes, setHomes] = useState("12"), [seed, setSeed] = useState("20261003");
  const [sending, setSending] = useState(false), [roundId, setRoundId] = useState(""), [homeFilter, setHomeFilter] = useState("");
  const [checkFilter, setCheckFilter] = useState('all');
  const [hardware, setHardware] = useState(null);
  const [espSource, setEspSource] = useState('ai-live');
  useEffect(() => {
    let active = true, busy = false;
    get("/simulation/config").then(c => { if (active) { setConfig(c); setScenario(c.default_scenario || 'community'); setEspSource(c.default_esp_source || 'ai-live'); } }).catch(e => { if (active) setError(e.message); });
    const load = async () => {
      if (busy) return; busy = true;
      try { const s = await get("/simulation/state"); if (active) { setState(s); setError(""); } }
      catch (e) { if (active) setError(e.message); }
      finally { busy = false; }
    };
    load(); const timer = setInterval(load, 1500);
    return () => { active = false; clearInterval(timer); };
  }, []);
  useEffect(() => { setRoundId(""); setHomeFilter(""); setCheckFilter('all'); }, [state?.run_id]);
  useEffect(() => {
    if (scenario !== 'hybrid') return;
    setHomes('12'); let active = true;
    const load = () => get(`/simulation/hardware?source=${espSource}`).then(h => { if (active) setHardware(h); }).catch(e => { if (active) setHardware({ ready: false, message: e.message }); });
    load(); const timer = setInterval(load, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [scenario, espSource]);
  const snap = state?.snapshot, busy = sending || ["starting", "running"].includes(state?.status);
  const rounds = snap?.rounds || [], round = rounds.find(r => r.round_id === roundId) || rounds.at(-1);
  const passed = (state?.checks || []).filter(c => c.passed).length;
  const selected = config?.scenarios.find(s => s.id === scenario);
  const hybrid = scenario === 'hybrid', hybridReport = state?.scenario === 'hybrid';
  const fastSelected = espSource === 'ai-demo', fastReport = snap?.hardware?.source_mode === 'ai-demo';
  const liveSelected = espSource === 'ai-live', liveReport = snap?.hardware?.source_mode === 'ai-live';
  const pending = rounds.flatMap(r => r.trades).filter(t => t.status === "pending").length;
  async function run() {
    setSending(true); setError("");
    try {
      await get("/simulation/run", { method: "POST", headers: { "Content-Type": "application/json", "X-Solar-Session": config.session },
        body: JSON.stringify({ scenario, homes: Number(homes), seed: Number(seed), hybridSource: espSource }) });
      setState(await get("/simulation/state"));
    } catch (e) { setError(e.message); }
    finally { setSending(false); }
  }
  const householdName = h => snap?.homes.find(x => x.id === h)?.name || h;
  return <div className="sim-page">
    <header className="sim-header"><a className="sim-brand" href="/simulation">☀ SOLAR LAB <span>MQTT MARKET</span></a><div className={`sim-status ${state?.status || "idle"}`} role="status"><i/>{statusNames[state?.status] || "Đang kết nối"}</div></header>
    <main>
      <div className="sim-intro"><div><div className="sim-eyebrow">{hybrid ? fastSelected ? '1 ESP32 EDGE AI · MÔ PHỎNG NHANH 5s + 11 HỘ' : liveSelected ? '1 ESP32 · INA219 THẬT 5s + EDGE AI + 11 HỘ MÔ PHỎNG' : '1 ESP32 THẬT + 11 HỘ MÔ PHỎNG' : 'PHÒNG THỬ NGHIỆM KHÔNG PHẦN CỨNG'}</div><h1>Một cộng đồng.<br/>Mỗi giao dịch đều có bằng chứng.</h1><p>{hybrid ? fastSelected ? 'ESP32 chạy model INT8 trên mẫu mô phỏng mỗi 5 giây; đủ 12 mẫu có dự báo trong khoảng 60 giây. 11 hộ cung cấp đối tác ảo; Token chạy trên smart contract local.' : liveSelected ? 'ESP32 đo INA219 thật, lấy trung bình mỗi 5 giây và chạy model INT8 trên board; đủ 12 mẫu có dự báo trong khoảng 60 giây, gửi qua MQTT. 11 hộ cung cấp đối tác ảo; Token chạy trên smart contract local.' : 'Nhà 1 dùng INA219 thật và dự báo Edge AI qua MQTT để đề xuất mua/bán cho 5 phút tiếp theo. 11 hộ cung cấp đối tác ảo; giao dịch Token chạy trên smart contract local.' : 'Công tơ và dự báo ảo trao đổi qua MQTT. Token, đặt cọc, uy tín và thứ tự ưu tiên được thực thi trên smart contract local.'}</p></div><div className="sim-run-card"><span>LƯỢT MÔ PHỎNG</span><strong>{snap?.homes?.length || homes}<small> hộ gia đình</small></strong><p>{state?.chain_live ? `MQTT 127.0.0.1:${state.mqtt_port}` : "Kết quả được lưu sau mỗi lượt"}</p><code>{state?.run_id ? state.run_id.slice(0, 16) + "…" : "Chưa bắt đầu"}</code></div></div>
      {(error || state?.error) && <div className="sim-error" role="alert">{error || state.error}</div>}
      <section className="sim-panel sim-controls" aria-label="Điều khiển mô phỏng">
        <label>Kịch bản<select aria-label="Kịch bản" value={scenario} onChange={e => setScenario(e.target.value)} disabled={busy}>{config?.scenarios.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Số hộ<input aria-label="Số hộ" type="number" min="6" max="32" value={homes} onChange={e => setHomes(e.target.value)} disabled={busy || hybrid}/></label>
        <label>Seed<input aria-label="Seed" type="number" value={seed} onChange={e => setSeed(e.target.value)} disabled={busy}/></label>
        {hybrid && <label>Nguồn lệnh Nhà 1<select aria-label="Nguồn lệnh Nhà 1" value={espSource} onChange={e => setEspSource(e.target.value)} disabled={busy}><option value="ai-live">Edge AI từ INA219 thật · 5 giây/mẫu</option><option value="ai-demo">Edge AI mô phỏng nhanh · 5 giây/mẫu</option><option value="ai">Edge AI từ INA219 thật · 5 phút/mẫu</option><option value="telemetry">Số đo gần nhất · Arduino</option></select></label>}
        <button className="sim-primary" onClick={run} disabled={busy || !config}>{busy ? state?.hardware?.phase === "waiting" ? "Đang chờ ESP32…" : "Đang chạy…" : hybrid ? "Chạy 1 ESP32 + 11 hộ" : "Chạy mô phỏng"}</button>
        <p>{selected?.description} Mỗi lượt tạo broker, blockchain và ví thử nghiệm riêng.</p>
      </section>
      {snap && (state?.scenario !== scenario || (hybrid && snap.hardware?.source_mode && snap.hardware.source_mode !== espSource)) && <p className="sim-muted">Kết quả bên dưới thuộc lượt đã lưu: {config?.scenarios.find(s => s.id === state.scenario)?.name || state?.scenario}{snap.hardware?.source_mode && ` · nguồn ${snap.hardware.source_mode}`}. Chạy kịch bản đang chọn để tạo kết quả mới.</p>}
      {hybrid && <section className="sim-panel" aria-label="Kết nối ESP32"><h2>Nhà 1 · {fastSelected ? 'AI mô phỏng nhanh 5s' : liveSelected ? 'INA219 thật 5s + Edge AI' : 'nguồn số đo thật'}</h2><p role="status">{busy && state?.hardware ? state.hardware.message : hardware?.message || 'Đang kiểm tra backend ESP32…'}</p>{hardware?.ready && <p>Phát {number(hardware.solar_power_kw, 6)} kW · tải {number(hardware.load_power_kw, 6)} kW · đề xuất {hardware.action === 'buy' ? 'mua' : hardware.action === 'sell' ? 'bán' : 'giữ nguyên'} {hardware.quantity_wh} Wh · {fastSelected ? 'thời gian mô phỏng' : liveSelected ? 'thời gian logic của model' : 'số đo'} {hardware.timestamp}</p>}{hardware?.model_version && <p>AI {hardware.model_version} · dự báo phát {number(hardware.predicted_solar_kw, 6)} kW · dự báo tải {number(hardware.predicted_load_kw, 6)} kW</p>}<p className="sim-muted">{fastSelected ? 'ESP32 tạo mẫu mô phỏng mỗi 5 giây và chạy AI sau 12 mẫu (~60 giây). Một bước 5 phút của model được chạy trong 5 giây thực. Chờ tối đa 2 phút; dữ liệu này là mô phỏng, không phải số đo INA219 thật.' : liveSelected ? 'ESP32 đọc INA219 thật, lấy trung bình mỗi 5 giây và chạy AI sau 12 mẫu (~60 giây). Mỗi mẫu 5 giây được model coi là một bước 5 phút, nên điện năng của lệnh là quy đổi theo bước 5 phút, không phải điện đo được trong 5 giây. Chờ tối đa 2 phút.' : espSource === 'ai' ? 'Firmware esp32_edge đọc INA219 và chạy model INT8. Cần 12 mẫu 5 phút liên tiếp (~60 phút) để có dự báo đầu tiên. Chờ tối đa 65 phút khi chạy; không tự chuyển sang số đo gần nhất.' : 'Firmware Arduino gửi số đo mỗi 5 phút; dùng ước lượng từ số đo gần nhất, chưa chạy AI.'} Lệnh dùng điện năng ròng {espSource !== 'telemetry' ? 'dự báo' : 'đo được'} ≥ 1 Wh; dưới ngưỡng này Nhà 1 giữ nguyên. 11 hộ dùng mô hình nắng ảo; công tơ giao điện là mô phỏng. {['ai', 'ai-live'].includes(espSource) && 'Model hiện huấn luyện trên dữ liệu tổng hợp PV 4 kW, chưa hiệu chuẩn cho bộ pin 3 W.'}</p>{hybridReport && <p>Bằng chứng nguồn: {state.hardware?.event_id || snap?.hardware?.event_id || 'Chờ bản tin'} · {state.hardware?.sample_timestamp || ''}</p>}</section>}
      <div className="sim-flow" aria-label="Luồng giao dịch">{hybrid ? fastSelected ? 'ESP32 AI mô phỏng 5s + 11 công tơ ảo' : liveSelected ? 'INA219 thật 5s + Edge AI + 11 công tơ ảo' : 'INA219 Nhà 1 + 11 công tơ ảo' : 'Công tơ ảo'} <span>→</span> MQTT <span>→</span> Khóa Token <span>→</span> Khớp lệnh <span>→</span> Xác nhận giao điện <span>→</span> Thanh toán</div>
      <div className="sim-stats"><div><span>PHIÊN GIAO DỊCH</span><strong>{rounds.length}</strong></div><div><span>SLC ĐANG KHÓA</span><strong>{slc(snap?.escrow)}</strong></div><div><span>CHỜ GIAO ĐIỆN</span><strong>{pending}</strong></div><div><span>KỊCH BẢN ĐẠT</span><strong>{passed}<small> / {(state?.checks || []).length}</small></strong></div><div><span>BẢO TOÀN TOKEN</span><strong className={snap?.conserved ? "sim-good" : ""}>{snap ? snap.conserved ? "Đúng" : "Cần kiểm tra" : "—"}</strong></div></div>
      <SimulationEvaluation snapshot={snap} checks={state?.checks || []} checkFilter={checkFilter} setCheckFilter={setCheckFilter} running={busy}/>
      <section className="sim-panel"><div className="sim-section-head"><div><div className="sim-eyebrow">01 / CỘNG ĐỒNG</div><h2>{snap?.homes.length || 0} hộ · {hybridReport ? fastReport ? '1 ESP32 AI mô phỏng 5s + 11 nguồn ảo' : liveReport ? '1 ESP32 INA219 thật 5s + Edge AI + 11 nguồn ảo' : '1 nguồn INA219 thật + 11 nguồn ảo' : 'công tơ ảo'}</h2></div><label>Lọc hộ<select aria-label="Lọc hộ" value={homeFilter} onChange={e => setHomeFilter(e.target.value)}><option value="">Tất cả hộ</option>{snap?.homes.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}</select></label></div>
        <div className="sim-home-grid">{snap?.homes.filter(h => !homeFilter || h.id === homeFilter).map(h => <article className="sim-home" key={h.id}><div className="sim-home-top"><span>{h.id}</span><span className={`sim-badge ${h.verified_category ? "priority" : ""}`}>{categories[h.verified_category]}</span></div><h3>{h.name}</h3><div className="sim-power">{number(h.telemetry?.net_power_kw)} <small>kW ròng</small></div><div className="sim-home-meters"><span>Phát <b>{number(h.telemetry?.solar_power_kw)} kW</b></span><span>Tải <b>{number(h.telemetry?.load_power_kw)} kW</b></span></div><div className="sim-score"><span>Uy tín <b>{h.score}/100</b></span><div><i style={{ width: `${h.score}%` }}/></div></div><dl><dt>Số dư</dt><dd>{number(h.balance_slc, 6)} SLC</dd><dt>Đặt cọc</dt><dd>{number(h.collateral_bps / 100)}%</dd><dt>Đang cam kết</dt><dd>{number(h.active_wh)} Wh</dd><dt>Giới hạn</dt><dd>{number(h.limit_wh)} Wh</dd><dt>Vi phạm / thành công</dt><dd>{h.violations} / {h.successful_trades}</dd></dl><p>{h.prediction ? `${h.prediction.action === "sell" ? "Đề xuất bán" : h.prediction.action === "buy" ? "Đề xuất mua" : "Giữ nguyên"}: ${h.prediction.quantity_wh} Wh` : "Chờ số đo đầu tiên"}</p><small className="sim-muted">{h.source_kind === 'esp32_forecast' ? `${h.prediction?.input?.data_mode === 'simulation' ? 'Mô phỏng 5s trên ESP32' : h.prediction?.input?.time_mode === 'accelerated' ? 'INA219 thật 5s' : 'INA219 thật'} · Edge AI ${h.prediction?.ai_prediction?.model_version || ''}` : h.source_kind === 'esp32_telemetry' ? 'INA219 thật · ước lượng từ số đo gần nhất' : 'Dự báo mô phỏng'} · {h.address.slice(0, 10)}…</small></article>)}</div>
        {!snap && <p className="sim-empty">Chọn kịch bản và chạy mô phỏng để tạo các hộ.</p>}
      </section>
      <section className="sim-panel"><div className="sim-section-head"><div><div className="sim-eyebrow">02 / SỔ LỆNH VÀ GIAO ĐIỆN</div><h2>{round ? `Phiên #${round.round_id}` : "Chờ phiên đầu tiên"}</h2></div><select aria-label="Phiên giao dịch" value={round?.round_id || ""} onChange={e => setRoundId(e.target.value)}>{rounds.map(r => <option key={r.round_id} value={r.round_id}>#{r.round_id} · {r.settled ? "Đã khớp" : "Đang mở"}</option>)}</select></div>
        {round && <><div className="sim-table-wrap"><table><thead><tr><th>Hộ</th><th>Lệnh</th><th>Lượng Wh</th><th>Giá SLC/kWh</th><th>Tiền / cọc đang khóa</th><th>Nguồn lệnh</th><th>Trạng thái</th></tr></thead><tbody>{round.orders.map(o => <tr key={o.index}><td>{householdName(o.home)}</td><td>{o.side === 0 ? "Bán" : "Mua"}</td><td>{number(o.quantity_wh)}</td><td>{number(Number(o.price) / 1000)}</td><td>{slc(BigInt(o.locked) + BigInt(o.collateral))} SLC</td><td>{o.basis === 'esp32_forecast' ? fastReport ? 'Edge AI · mô phỏng 5s' : liveReport ? 'Edge AI · INA219 thật 5s' : 'Edge AI · INA219 thật' : o.basis === 'esp32_telemetry' ? 'Số đo ESP32 thật' : 'Dự báo mô phỏng'}</td><td>{o.cancelled ? "Đã hủy" : round.settled ? `Còn ${o.remaining_wh} Wh` : "Đã ghi nhận"}</td></tr>)}</tbody></table></div><h3>Giao dịch và lượng thực giao</h3><div className="sim-table-wrap"><table><thead><tr><th>Bên bán → bên mua</th><th>Cam kết / giao Wh</th><th>Đã trả SLC</th><th>Trạng thái</th><th>Bằng chứng</th></tr></thead><tbody>{round.trades.map(t => <tr key={t.index}><td>{householdName(t.seller)} → {householdName(t.buyer)}</td><td>{t.quantity_wh} / {t.delivered_wh}</td><td>{slc(t.paid)}</td><td><span className={`sim-badge ${t.status}`}>{tradeNames[t.status]}</span></td><td><code title={t.evidence_hash}>{t.evidence_hash === "0x" + "0".repeat(64) ? "Chưa xác nhận" : t.evidence_hash.slice(0, 14) + "…"}</code></td></tr>)}</tbody></table></div></>}
      </section>
      <div className="sim-bottom-grid"><section className="sim-panel"><div className="sim-section-head"><div><div className="sim-eyebrow">03 / KẾT QUẢ KIỂM CHỨNG</div><h2>Các kịch bản</h2></div>{snap && <a className="sim-download" href="/simulation/report">Tải báo cáo JSON ↓</a>}</div><ol className="sim-checks">{state?.checks.map((c, i) => <li key={i} className={c.passed ? "passed" : "failed"}><span>{c.passed ? "✓" : "!"}</span><div>{c.name}<small>{c.error || `${number(c.duration_ms / 1000, 1)} giây`}</small>{c.evidence && <button className="sim-evidence-button" onClick={() => { setCheckFilter(String(i)); document.querySelector('.sim-evaluation')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>Xem biểu đồ và bằng chứng #{i + 1} ↑</button>}</div></li>)}</ol>{!state?.checks.length && <p className="sim-empty">Kết quả xuất hiện sau mỗi kịch bản. Token được đối chiếu lại ở từng bước.</p>}</section>
        <section className="sim-panel"><div className="sim-eyebrow">04 / NHẬT KÝ MQTT</div><h2>{snap?.mqtt.messages || 0} bản tin đã nhận</h2><p className="sim-muted">Yêu cầu trùng: {snap?.mqtt.duplicate_requests || 0} · Từ chối: {snap?.mqtt.rejected || 0}</p><div className="sim-log">{state?.events.slice(-30).reverse().map((e, i) => <div key={i}><span>{e.home || "gateway"} · {e.action}</span><code>{e.topic || e.error}</code></div>)}</div></section></div>
      <section className="sim-panel"><div className="sim-eyebrow">05 / BIÊN LAI BLOCKCHAIN</div><h2>Giao dịch được ký bởi ví thử nghiệm của từng hộ</h2><div className="sim-table-wrap"><table><thead><tr><th>Hộ / thao tác</th><th>Kết quả</th><th>Transaction hash · bước ký</th></tr></thead><tbody>{snap?.transactions.slice(-30).reverse().map(t => <tr key={t.message_id}><td>{t.home} · {t.action}</td><td>{t.status}</td><td>{t.transactions.map(tx => <details key={tx.hash}><summary><code>{tx.hash.slice(0, 18)}…</code> · {tx.step}</summary><code className="sim-hash">{tx.hash}</code><p>Receipt status {tx.status ?? "chờ"} · Block {tx.block ?? "—"}</p></details>)}</td></tr>)}</tbody></table></div></section>
      <footer>{hybridReport ? fastReport ? 'ESP32 chạy AI trên dữ liệu mô phỏng tăng tốc 5s. Công tơ giao điện là ảo; chưa xác minh truyền điện vật lý.' : liveReport ? 'Nhà 1 dùng số đo INA219 thật lấy mẫu 5 giây và AI chạy trên ESP32; thời gian phiên là thời gian logic tăng tốc. Điện giao giữa các hộ dùng công tơ ảo, chưa xác minh truyền điện vật lý.' : 'Nhà 1 dùng số đo thật. Điện giao giữa các hộ dùng công tơ ảo, chưa xác minh truyền điện vật lý.' : 'Điện và công tơ là dữ liệu mô phỏng.'} Giao dịch Token chạy trên Hardhat local; mỗi lượt dùng triển khai riêng.</footer>
    </main>
  </div>;
}
