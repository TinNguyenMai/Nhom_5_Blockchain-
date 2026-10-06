import React, { useEffect, useRef, useState } from 'react';
import { csvText, evaluationSummary, tradeAccounting } from '../../blockchain/lib/simulation-evaluation.mjs';

const fmt = (n, digits = 3) => Number(n).toLocaleString('vi-VN', { maximumFractionDigits: digits });
const slc = n => Number(n) / 1e6;
const colors = ['#237b63', '#bc8b26', '#667bb2', '#b35643'];
const categories = ['Hộ thường', 'Bệnh viện', 'Mầm non', 'Hộ đặc biệt'];
const actions = { snapshot: 'Đối chiếu', check_start: 'Bắt đầu kịch bản', check_end: 'Kết thúc kịch bản',
  check_failed: 'Kịch bản lỗi', open_round: 'Mở phiên', place_order: 'Đặt lệnh', cancel_order: 'Hủy lệnh',
  settle: 'Khớp lệnh', confirm_trade: 'Xác nhận giao điện', expire_trade: 'Hoàn tiền quá hạn', set_priority: 'Xác minh ưu tiên' };

function download(blob, name) {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function saveCsv(rows, name) { download(new Blob([csvText(rows)], { type: 'text/csv;charset=utf-8' }), name); }

function Chart({ title, subtitle, height = 290, children, legend = [], filename, empty }) {
  const ref = useRef(null), [error, setError] = useState('');
  async function exportImage(png) {
    setError('');
    try {
      const source = ref.current.cloneNode(true);
      source.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      source.setAttribute('width', '800'); source.setAttribute('height', String(height));
      const xml = new XMLSerializer().serializeToString(source);
      const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
      if (!png) return download(blob, filename + '.svg');
      const data = await new Promise((resolve, reject) => { const reader = new FileReader();
        reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob); });
      const img = new Image();
      await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = data; });
      const canvas = document.createElement('canvas'); canvas.width = 1600; canvas.height = height * 2;
      const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const raster = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!raster) throw new Error('Không tạo được ảnh PNG');
      download(raster, filename + '.png');
    } catch { setError('Không xuất được ảnh. Hãy thử tải SVG.'); }
  }
  return <article className="sim-chart-card">
    <div className="sim-chart-head"><h3>{title}</h3>{!empty && <div className="sim-export-actions">
      <button aria-label={`Tải SVG: ${title}`} onClick={() => exportImage(false)}>SVG ↓</button>
      <button aria-label={`Tải PNG: ${title}`} onClick={() => exportImage(true)}>PNG ↓</button>
    </div>}</div>
    {empty ? <p className="sim-chart-empty">{empty}</p> : <>
      <div className="sim-chart-viewport"><svg ref={ref} viewBox={`0 0 800 ${height}`} role="img" aria-label={title} style={{ width: '100%', height: 'auto', maxWidth: 800 }}>
        <title>{title}</title><desc>{subtitle}</desc>
        <rect width="800" height={height} fill="#fffef8"/>
        <g fontFamily="Segoe UI, Arial, sans-serif" fontSize="11" fill="#52675e">
          <text x="20" y="23" fontSize="16" fontWeight="700" fill="#183a36">{title}</text>
          <text x="20" y="43" fontSize="10">{subtitle?.slice(0, 125)}</text>
          {children}
          {legend.map((item, i) => <g key={item.label} transform={`translate(${24 + i * 187},${height - 18})`}>
            <rect y="-9" width="11" height="11" rx="2" fill={item.color || colors[i]}/>
            <text x="17">{item.label}</text>
          </g>)}
        </g>
      </svg></div>
      <p className="sim-chart-scroll-hint">Vuốt ngang để xem toàn bộ biểu đồ.</p>
      <p className="sim-chart-hint">{subtitle} · Trỏ vào điểm/cột để xem giá trị.</p>
    </>}
    {error && <p role="alert" className="sim-export-error">{error}</p>}
  </article>;
}

function Bars({ rows, series, title, subtitle, unit, filename, empty }) {
  const max = Math.max(0, ...rows.flatMap(r => series.map(s => Number(r[s.key])))) || 1;
  const height = Math.max(240, 120 + rows.length * 51), left = 190, width = 560;
  return <Chart {...{ title, subtitle, filename, height }} empty={!rows.length && (empty || 'Chưa có giao dịch trong phạm vi này.')} legend={series}>
    {[0, .25, .5, .75, 1].map(f => <g key={f}>
      <line x1={left + f * width} y1="60" x2={left + f * width} y2={height - 63} stroke="#e2e7da"/>
      <text x={left + f * width} y={height - 46} textAnchor="middle">{fmt(max * f)} {f === 1 ? unit : ''}</text>
    </g>)}
    {rows.map((r, i) => <g key={r.id || i} transform={`translate(0,${74 + i * 51})`}>
      <text x={left - 12} y="10" textAnchor="end"><title>{r.label}</title>{r.label.length > 26 ? r.label.slice(0, 25) + '…' : r.label}</text>
      {series.map((s, j) => <rect key={s.key} x={left} y={j * 12 - 6} height="9" rx="2"
        width={Math.max(0, Number(r[s.key]) / max * width)} fill={s.color || colors[j]}>
        <title>{r.label}: {s.label} {fmt(r[s.key], 6)} {unit}{r.detail ? '\n' + r.detail : ''}</title>
      </rect>)}
    </g>)}
  </Chart>;
}

function Lines({ points, series, title, subtitle, unit, filename, domain, xLabel = 'Bước xử lý', empty }) {
  const left = 70, top = 66, width = 680, bottom = 230;
  const values = points.flatMap(p => series.map(s => Number(s.value(p))));
  const low = domain?.[0] ?? Math.min(0, ...values), high = domain?.[1] ?? (Math.max(0, ...values) || (low < 0 ? 0 : 1));
  const y = v => bottom - (Number(v) - low) / (high - low || 1) * (bottom - top);
  const x = i => left + i / Math.max(1, points.length - 1) * width;
  return <Chart {...{ title, subtitle, filename }} height={320} legend={series} empty={!points.length && (empty || 'Lượt cũ chưa lưu lịch sử. Chạy mô phỏng mới để có biểu đồ diễn biến.')}>
    {[0, .25, .5, .75, 1].map(f => <g key={f}>
      <line x1={left} y1={y(low + f * (high - low))} x2={left + width} y2={y(low + f * (high - low))} stroke="#e2e7da"/>
      <text x={left - 9} y={y(low + f * (high - low)) + 4} textAnchor="end">{fmt(low + f * (high - low), 4)}</text>
    </g>)}
    <text x={left} y="59">{unit}</text>
    {low < 0 && high >= 0 && <line x1={left} y1={y(0)} x2={left + width} y2={y(0)} stroke="#7b8b80" strokeDasharray="5 4"/>}
    {[...new Set([0, .25, .5, .75, 1].map(f => Math.floor((points.length - 1) * f)))].filter(i => i >= 0).map(i =>
      <text key={i} x={x(i)} y="250" textAnchor="middle">{points[i]?.axis ?? points[i]?.index ?? i}</text>)}
    <text x="410" y="275" textAnchor="middle" fontSize="10">{xLabel}</text>
    {series.map((s, j) => <g key={s.label}>
      <polyline fill="none" stroke={s.color || colors[j]} strokeWidth="2"
        points={points.map((p, i) => `${x(i)},${y(s.value(p))}`).join(' ')}/>
      {points.map((p, i) => <circle key={i} cx={x(i)} cy={y(s.value(p))} r={points.length > 100 ? 2 : 3} fill={s.color || colors[j]}>
        <title>{p.timestamp || `Bước ${p.index}: ${actions[p.action] || p.action || ''}`}\n{s.label}: {fmt(s.value(p), 6)} {unit}{p.round_id ? `\nPhiên #${p.round_id}` : ''}</title>
      </circle>)}
    </g>)}
  </Chart>;
}

function AiEvaluation() {
  const [data, setData] = useState(null), [error, setError] = useState('');
  const [period, setPeriod] = useState('all'), [field, setField] = useState('solar'), [metric, setMetric] = useState('mae_kw');
  const [day, setDay] = useState('');
  const [windowMode, setWindowMode] = useState('detail'), [zoom, setZoom] = useState(true);
  useEffect(() => { let active = true;
    fetch('/simulation/ai-evaluation').then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then(v => { if (active) setData(v); }).catch(() => { if (active) setError('Chưa tải được dữ liệu đánh giá AI.'); });
    return () => { active = false; };
  }, []);
  const metrics = data?.metrics?.test?.[period];
  const all = data?.series?.points || [], days = [...new Set(all.map(p => p.timestamp.slice(0, 10)))];
  const chosenDay = days.includes(day) ? day : days[0];
  const dayPoints = all.filter(p => p.timestamp.startsWith(chosenDay));
  const windowLength = Math.min(12, dayPoints.length);
  let windowStart = 0, largestChange = -1;
  for (let i = 0; i <= dayPoints.length - windowLength && windowLength > 0; i++) {
    const values = dayPoints.slice(i, i + windowLength).map(p => p[field].actual);
    const change = Math.max(...values) - Math.min(...values);
    if (change > largestChange) { largestChange = change; windowStart = i; }
  }
  const points = (windowMode === 'detail' ? dayPoints.slice(windowStart, windowStart + windowLength) : dayPoints)
    .map(p => ({ ...p, axis: p.timestamp.slice(11, 16) }));
  const models = ['persistence', 'fp32', 'int8'];
  const rows = models.filter(m => metrics?.[m]?.[field]).map(m => ({ id: m, label: m === 'persistence' ? 'Persistence' : m.toUpperCase(), value: metrics[m][field][metric] }));
  const fieldName = field === 'solar' ? 'Điện phát' : 'Tải tiêu thụ';
  const series = [{ key: 'actual', label: 'Giá trị mô phỏng', color: '#183a36' },
    { key: 'int8', label: 'Dự báo INT8', color: colors[0] }, { key: 'persistence', label: 'Persistence', color: colors[1] },
    ...(points[0]?.[field]?.fp32 !== undefined ? [{ key: 'fp32', label: 'Dự báo FP32', color: colors[2] }] : [])];
  const plotted = points.flatMap(p => series.map(s => p[field][s.key]));
  const min = Math.min(...plotted), max = Math.max(...plotted), padding = Math.max(.005, (max - min) * .12);
  const powerDomain = plotted.length && zoom ? [Math.max(0, min - padding), max + padding] : undefined;
  const traceScope = `${chosenDay || ''} ${points[0]?.axis || ''}–${points.at(-1)?.axis || ''}`;
  const exportRows = () => saveCsv([['target_timestamp', 'field', ...series.map(s => s.key)],
    ...points.map(p => [p.timestamp, field, ...series.map(s => p[field][s.key])])], `ai-${chosenDay}-${field}.csv`);
  return <details className="sim-ai-section" open>
    <summary>Đánh giá AI Nhà 1 · dữ liệu tham khảo đã lưu</summary>
    <p className="sim-muted">Biểu đồ sai số dùng tập test 5 ngày, 1.440 mẫu theo thời gian; so sánh persistence, FP32 và INT8 trên dữ liệu tổng hợp. Các biểu đồ AI tham khảo này dùng dữ liệu đã lưu. Nguồn dự báo của lượt thị trường được ghi riêng trên từng hộ và lệnh.</p>
    {error && <p role="alert">{error}</p>}
    <div className="sim-eval-controls">
      <label>Đại lượng AI<select value={field} onChange={e => setField(e.target.value)}><option value="solar">Điện phát</option><option value="load">Tải tiêu thụ</option></select></label>
      <label>Khoảng đánh giá AI<select value={period} onChange={e => setPeriod(e.target.value)}><option value="all">Toàn bộ tập test</option><option value="daylight">Ban ngày</option><option value="night">Ban đêm</option></select></label>
      <label>Chỉ số sai số<select value={metric} onChange={e => setMetric(e.target.value)}><option value="mae_kw">MAE</option><option value="rmse_kw">RMSE</option></select></label>
      {days.length > 0 && <label>Ngày của chuỗi AI<select value={chosenDay} onChange={e => setDay(e.target.value)}>{days.map(d => <option key={d}>{d}</option>)}</select></label>}
      <label>Vùng xem chuỗi AI<select value={windowMode} onChange={e => setWindowMode(e.target.value)}><option value="detail">1 giờ biến động mạnh nhất</option><option value="day">Cả ngày</option></select></label>
      <label className="sim-checkbox"><input type="checkbox" checked={zoom} onChange={e => setZoom(e.target.checked)}/>Phóng đại trục công suất</label>
    </div>
    <div className="sim-eval-grid">
      <Bars rows={rows} series={[{ key: 'value', label: metric === 'mae_kw' ? 'MAE' : 'RMSE' }]} unit="kW"
        title={`Sai số ${fieldName.toLowerCase()}`} subtitle={`${period} · ${metrics?.samples || 0} mẫu test · ${data?.metrics?.model_version || ''}`}
        filename={`ai-${field}-${metric}-${period}`} empty="Chưa có file đánh giá AI."/>
      <Lines points={points} series={series.map(s => ({ ...s, value: p => p[field][s.key] }))} unit="kW" domain={powerDomain}
        title={`${fieldName}: dự báo và giá trị mô phỏng`} xLabel="Giờ mục tiêu (UTC+7)"
        subtitle={`${traceScope} · ${zoom ? 'Trục Y phóng đại' : 'Trục Y từ 0'} · ${data?.series?.source_kind === 'held_out_test' ? 'Tập test độc lập' : 'Phiên ESP32 đã lưu'}`}
        filename={`ai-${chosenDay}-${field}`} empty="Chưa có chuỗi dự báo đã ghép với giá trị mục tiêu."/>
      <Lines points={points} series={series.filter(s => s.key !== 'actual').map(s => ({ ...s, value: p => p[field][s.key] - p[field].actual }))}
        title={`Sai lệch dự báo ${fieldName.toLowerCase()} theo thời gian`} unit="kW" xLabel="Giờ mục tiêu (UTC+7)"
        subtitle={`${traceScope} · dự báo − giá trị mô phỏng; trên 0: dự báo cao, dưới 0: dự báo thấp`}
        filename={`ai-${chosenDay}-${field}-errors`} empty="Chưa có chuỗi để đối chiếu sai lệch."/>
    </div>
    {data?.series && <p className="sim-eval-note">{data.series.notes} {points.length} mẫu trong ngày đang chọn.
      <button className="sim-export-button" onClick={exportRows} disabled={!points.length}>Tải CSV chuỗi AI ↓</button>
    </p>}
    <p className="sim-muted">MAE: sai lệch tuyệt đối trung bình. RMSE: căn sai số bình phương trung bình. Giá trị thấp hơn biểu thị sai số nhỏ hơn trên tập dữ liệu được chọn.</p>
  </details>;
}

export default function SimulationEvaluation({ snapshot: snap, checks = [], checkFilter, setCheckFilter, running }) {
  const [home, setHome] = useState('home_01'), [repMetric, setRepMetric] = useState('score'), [tradeHome, setTradeHome] = useState('');
  const [compare, setCompare] = useState(true);
  useEffect(() => { setHome('home_01'); setTradeHome(''); }, [snap?.run_id]);
  const history = snap?.evaluation?.history || [];
  const activeIndex = history.at(-1)?.check_index;
  const index = checkFilter === 'latest' ? (running && activeIndex !== undefined ? activeIndex : checks.length - 1) : Number(checkFilter);
  const allScope = checkFilter === 'all';
  const check = checks[index], activeName = running && activeIndex === index ? snap?.evaluation?.active_check : null;
  const scope = allScope ? 'Toàn bộ lượt' : check?.name || activeName || 'Chờ kịch bản';
  const points = allScope ? history : history.filter(p => p.check_index === index);
  const knownIds = check?.evidence?.round_ids;
  const currentIds = [...new Set(points.map(p => p.round_id).filter(Boolean))];
  const ids = knownIds || currentIds;
  // Old reports have no scenario mapping; expose only their full-run data.
  const rounds = (snap?.rounds || []).filter(r => allScope || ids.includes(r.round_id));
  const trades = rounds.flatMap(r => r.trades.map(t => ({ ...t, round_id: r.round_id, accounting: tradeAccounting(t) })))
    .filter(t => !tradeHome || t.seller === tradeHome || t.buyer === tradeHome);
  const filteredRounds = rounds.map(r => ({ ...r, trades: r.trades.filter(t => !tradeHome || t.seller === tradeHome || t.buyer === tradeHome) }));
  const stats = evaluationSummary(filteredRounds);
  const name = id => snap?.homes?.find(h => h.id === id)?.name || id;
  const descriptor = `Lượt ${snap?.run_id?.slice(0, 8) || '—'} · ${allScope ? 'Toàn bộ lượt' : `Kịch bản ${index + 1}`} · ${tradeHome ? name(tradeHome) : 'Tất cả hộ'}`;
  const file = `${snap?.run_id || 'simulation'}-${allScope ? 'all' : index + 1}`;
  const rep = { score: ['Điểm uy tín', 'điểm', [0, 100]], collateral_bps: ['Tỷ lệ đặt cọc', '%'], limit_wh: ['Giới hạn cam kết', 'kWh'] }[repMetric];
  const firstHome = points[0]?.homes.find(h => h.id === home), lastHome = points.at(-1)?.homes.find(h => h.id === home);
  const initial = snap?.evaluation?.initial_tokens;
  const errors = points.filter(p => initial !== undefined && BigInt(p.total_tokens) !== BigInt(initial));
  const allocation = rounds.flatMap(r => r.orders.filter(o => o.side === 1 && !o.cancelled && (!tradeHome || o.home === tradeHome)).map(o => ({
    id: `${r.round_id}-${o.index}`, label: `#${r.round_id} ${name(o.home)}`,
    requested: Number(o.quantity_wh) / 1000,
    matched: Number(r.trades.filter(t => t.buyer === o.home).reduce((n, t) => n + BigInt(t.quantity_wh), 0n)) / 1000,
    detail: `Giá ${fmt(Number(o.price) / 1000)} SLC/kWh · thứ tự ${o.index + 1} · ${categories[o.buyer_category] || 'Chưa lưu nhóm'}`,
  })));
  const energyRows = trades.map(t => ({ id: `${t.round_id}-${t.index}`, label: `#${t.round_id}.${t.index + 1} ${name(t.seller)} → ${name(t.buyer)}`,
    committed: Number(t.quantity_wh) / 1000, delivered: Number(t.delivered_wh) / 1000, detail: t.status }));
  const roundTimeline = filteredRounds.map(r => {
    const summary = evaluationSummary([r]);
    return { index: Number(r.round_id), timestamp: r.target_timestamp, axis: r.target_timestamp?.slice(11, 16) || `#${r.round_id}`,
      sample_timestamp: r.sample_timestamp,
      committed: Number(summary.committed_wh) / 1000, delivered: Number(summary.delivered_wh) / 1000,
      demand: r.orders.filter(o => o.side === 1 && !o.cancelled && (!tradeHome || o.home === tradeHome)).reduce((n, o) => n + Number(o.quantity_wh) / 1000, 0),
      total_solar_kw: r.total_solar_kw, total_load_kw: r.total_load_kw };
  });
  // Aggregate by household using the order records, rather than their per-round indices.
  const homeAllocation = [...new Set(rounds.flatMap(r => r.orders.filter(o => o.side === 1 && !o.cancelled && (!tradeHome || o.home === tradeHome)).map(o => o.home)))].map(id => ({
    id, label: name(id), requested: rounds.reduce((n, r) => n + r.orders.filter(o => o.home === id && o.side === 1 && !o.cancelled).reduce((v, o) => v + Number(o.quantity_wh) / 1000, 0), 0),
    matched: trades.filter(t => t.buyer === id).reduce((n, t) => n + Number(t.quantity_wh) / 1000, 0),
    detail: `Tổng các phiên trong phạm vi · ${id}`,
  }));
  const variations = (snap?.homes || []).map(h => {
    const values = points.map(p => Number(p.homes.find(x => x.id === h.id)?.[repMetric] || 0));
    return { id: h.id, range: values.length ? Math.max(...values) - Math.min(...values) : 0 };
  }).sort((a, b) => b.range - a.range);
  const comparisonHomes = compare ? [home, ...variations.filter(h => h.id !== home && h.range > 0).slice(0, 3).map(h => h.id)] : [home];
  const repSeries = comparisonHomes.map(id => ({ label: name(id), value: p => Number(p.homes.find(h => h.id === id)?.[repMetric] || 0) /
    (repMetric === 'collateral_bps' ? 100 : repMetric === 'limit_wh' ? 1000 : 1) }));
  const exportTrades = () => saveCsv([['run_id', 'round_id', 'trade_index', 'seller', 'buyer', 'status', 'committed_wh', 'delivered_wh', 'paid_micro_slc', 'refund_micro_slc', 'penalty_micro_slc', 'pending_micro_slc', 'evidence_hash'],
    ...trades.map(t => [snap.run_id, t.round_id, t.index, t.seller, t.buyer, t.status, t.quantity_wh, t.delivered_wh, t.accounting.paid, t.accounting.refund, t.accounting.penalty, t.accounting.pending, t.evidence_hash])], `${file}-trades.csv`);
  const exportHistory = () => saveCsv([['run_id', 'step', 'check', 'action', 'round_id', 'recorded_at', 'chain_time', 'escrow_micro_slc', 'wallets_micro_slc', 'total_micro_slc', 'conservation_error_micro_slc', 'home', 'score', 'collateral_bps', 'limit_wh'],
    ...points.map(p => { const h = p.homes.find(h => h.id === home); return [snap.run_id, p.index, p.check_name || '', p.action, p.round_id || '', p.at, p.chain_time, p.escrow, p.participant_tokens, p.total_tokens, String(BigInt(p.total_tokens) - BigInt(initial)), home, h?.score, h?.collateral_bps, h?.limit_wh]; })], `${file}-${home}-history.csv`);
  return <section className="sim-panel sim-evaluation" aria-label="Đánh giá bằng biểu đồ">
    <div className="sim-section-head"><div><div className="sim-eyebrow">ĐÁNH GIÁ ĐỊNH LƯỢNG</div><h2>Kết quả mô phỏng và bằng chứng</h2></div>
      <div className="sim-export-actions"><button onClick={exportTrades} disabled={!trades.length}>CSV giao dịch ↓</button><button onClick={exportHistory} disabled={!points.length}>CSV diễn biến ↓</button></div>
    </div>
    <div className="sim-eval-controls">
      <label>Phạm vi đánh giá<select value={checkFilter} onChange={e => setCheckFilter(e.target.value)}>
        <option value="latest">Kịch bản mới nhất (tự cập nhật)</option><option value="all">Toàn bộ lượt mô phỏng</option>
        {checks.map((c, i) => <option key={i} value={String(i)}>{i + 1}. {c.name}</option>)}
      </select></label>
      <label>Hộ trong giao dịch<select value={tradeHome} onChange={e => setTradeHome(e.target.value)}><option value="">Tất cả hộ</option>{snap?.homes.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}</select></label>
    </div>
    <p className="sim-eval-scope"><strong>{scope}</strong>{check && !allScope && <span className={`sim-badge ${check.passed ? 'confirmed' : 'expired'}`}>{check.passed ? 'Đạt kiểm chứng' : 'Có lỗi'}</span>}</p>
    {check?.error && !allScope && <p className="sim-export-error">{check.error}</p>}
    {!snap && <p className="sim-chart-empty">Biểu đồ sẽ xuất hiện và cập nhật theo từng bước khi mô phỏng chạy.</p>}
    {snap && <>
      {!snap.evaluation && <p className="sim-eval-note">Đang xem báo cáo cũ. Chọn “Toàn bộ lượt mô phỏng” để xem lượng điện; chạy lượt mới để có lịch sử và bằng chứng theo kịch bản.</p>}
      <div className="sim-eval-kpis">
        <div><span>ĐIỆN CAM KẾT / ĐÃ GIAO</span><strong>{fmt(Number(stats.committed_wh) / 1000)} / {fmt(Number(stats.delivered_wh) / 1000)} <small>kWh</small></strong></div>
        <div><span>TỶ LỆ GIAO / CAM KẾT</span><strong>{BigInt(stats.committed_wh) > 0n ? `${fmt(Number(stats.delivered_wh) / Number(stats.committed_wh) * 100, 1)}%` : '—'}</strong></div>
        <div><span>THANH TOÁN / HOÀN TIỀN ĐIỆN</span><strong>{fmt(slc(stats.paid), 6)} / {fmt(slc(stats.refund), 6)} <small>SLC</small></strong></div>
        <div><span>CỌC BÊN BÁN BỊ PHẠT</span><strong>{fmt(slc(stats.penalty), 6)} <small>SLC</small></strong></div>
      </div>
      <p className="sim-eval-note">{stats.confirmed} giao dịch đã xác nhận · {stats.expired} quá hạn · {stats.pending} đang chờ. Lượng giao lấy từ công tơ ảo. Tiền hoàn ở đây là phần tiền điện đã khớp; cọc hoàn và tiền lệnh chưa khớp được đối chiếu trong số dư. Giao dịch chờ/quá hạn chưa có xác nhận lượng giao.</p>
      {snap.scenario === 'community' && <p className="sim-eval-note">12 phiên liên tiếp × 5 phút = một giờ mô phỏng. Thời tiết và lịch phụ tải là các tình huống tổng hợp có chủ đích; lượng khớp, thanh toán và uy tín được lấy từ smart contract. Chọn toàn bộ lượt để thấy chuỗi biến động.</p>}
      {rounds.some(r => r.event) && <div className="sim-weather-events">{rounds.filter(r => r.event).map(r => <button key={r.round_id} className={`weather-${r.weather}`} onClick={() => {
        const i = checks.findIndex(c => c.evidence?.round_ids.includes(r.round_id)); if (i >= 0) setCheckFilter(String(i));
      }}>{r.target_timestamp?.slice(11, 16)} · {r.event}</button>)}</div>}
      <div className="sim-eval-grid">
        {allScope && rounds.length > 1 ? <Lines title="Điện cam kết và đã giao" points={roundTimeline} series={[
          { label: 'Yêu cầu mua', color: colors[2], value: p => p.demand }, { label: 'Cam kết', color: colors[0], value: p => p.committed },
          { label: 'Đã giao (công tơ ảo)', color: colors[1], value: p => p.delivered }]}
          unit="kWh / phiên" xLabel="Thời gian đích (UTC+7) / phiên" subtitle={descriptor} filename={`${file}-delivery`}/>
          : <Bars title="Điện cam kết và đã giao" rows={energyRows} series={[{ key: 'committed', label: 'Cam kết' }, { key: 'delivered', label: 'Đã giao (công tơ ảo)', color: colors[1] }]}
            unit="kWh" subtitle={descriptor} filename={`${file}-delivery`}/>}
        <div>
          <Lines title="Tiền đang khóa theo bước" points={points} series={[{ label: 'Escrow', value: p => slc(p.escrow) }]}
            unit="SLC" subtitle={`${descriptor} · toàn bộ ví của lượt`} filename={`${file}-escrow`}/>
          <p className="sim-conservation">Bảo toàn Token trong phạm vi: <strong>{points.length ? `${points.length - errors.length}/${points.length} bước đúng` : 'Chưa có lịch sử'}</strong>
            {initial !== undefined && <> · Tổng ban đầu {fmt(slc(initial))} SLC · Sai lệch cuối {fmt(slc(BigInt(points.at(-1)?.total_tokens || initial) - BigInt(initial)), 6)} SLC</>}
          </p>
        </div>
        <div>
          <div className="sim-eval-controls sim-rep-controls"><label>Hộ theo dõi uy tín<select value={home} onChange={e => setHome(e.target.value)}>{snap.homes.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}</select></label>
            <label>Đại lượng uy tín<select value={repMetric} onChange={e => setRepMetric(e.target.value)}><option value="score">Điểm uy tín</option><option value="collateral_bps">Tỷ lệ đặt cọc</option><option value="limit_wh">Giới hạn cam kết</option></select></label></div>
          <div className="sim-rep-options"><label className="sim-checkbox"><input type="checkbox" checked={compare} onChange={e => setCompare(e.target.checked)}/>So sánh hộ có biến động</label>
            <button className="sim-export-button" onClick={() => { if (variations[0]) setHome(variations[0].id); }}>Chọn hộ biến động nhất</button></div>
          <Lines title={`${rep[0]} · ${name(home)}`} points={points} series={repSeries} unit={rep[1]} domain={rep[2]}
            subtitle={`${descriptor} · hộ theo dõi ${home}`} filename={`${file}-${home}-${repMetric}`}/>
          {firstHome && lastHome && <p className="sim-eval-note">Điểm {firstHome.score} → {lastHome.score} · Cọc {fmt(firstHome.collateral_bps / 100)}% → {fmt(lastHome.collateral_bps / 100)}% · Giới hạn {fmt(Number(firstHome.limit_wh) / 1000)} → {fmt(Number(lastHome.limit_wh) / 1000)} kWh.</p>}
          {variations.find(h => h.id === home)?.range === 0 && <p className="sim-eval-note">Hộ đang chọn không thay đổi {rep[0].toLowerCase()} trong phạm vi này. Chọn toàn bộ lượt hoặc hộ có biến động để xem tác động của giao thiếu và phục hồi.</p>}
        </div>
        <Bars title="Yêu cầu mua và lượng được khớp" rows={allScope ? homeAllocation : allocation} series={[{ key: 'requested', label: 'Yêu cầu mua' }, { key: 'matched', label: 'Được khớp', color: colors[1] }]}
          unit="kWh" subtitle={`${descriptor} · giá, nhóm, thứ tự trong chú thích cột`} filename={`${file}-allocation`} empty="Chưa có lệnh mua còn hiệu lực trong phạm vi này."/>
        {roundTimeline.some(p => p.total_solar_kw !== undefined) && <Lines title="Điện phát và phụ tải cộng đồng" points={roundTimeline.filter(p => p.total_solar_kw !== undefined)
          .map(p => ({ ...p, timestamp: p.sample_timestamp, axis: p.sample_timestamp?.slice(11, 16) || p.axis }))}
          series={[{ label: 'Tổng phát', value: p => p.total_solar_kw }, { label: 'Tổng tải', color: colors[1], value: p => p.total_load_kw }]}
          unit="kW" xLabel={['ai-demo', 'ai-live'].includes(snap.hardware?.source_mode) ? 'Thời gian logic của model (5 phút logic / 5 giây thực)' : 'Thời gian lấy mẫu (UTC+7)'} subtitle={`${descriptor} · số đo đầu vào của toàn bộ hộ`} filename={`${file}-power`}/>}
      </div>
      <p className="sim-eval-note">Khớp lệnh ưu tiên giá mua cao và giá bán thấp; cùng giá mua, nhóm đã xác minh được ưu tiên trước hộ thường; ngang mức ưu tiên dùng thứ tự đặt lệnh. Các kịch bản cố tình tạo lỗi/giao thiếu nên tỷ lệ giao thấp vẫn có thể đạt kiểm chứng.</p>
      <TradeMatrix trades={trades} name={name} descriptor={descriptor} filename={`${file}-matrix`}/>
      <details className="sim-evidence-details"><summary>Bằng chứng số liệu và biên lai ({trades.length} giao dịch)</summary>
        <div className="sim-table-wrap"><table><thead><tr><th>Phiên / giao dịch</th><th>Bán → mua</th><th>Cam kết / giao Wh</th><th>Trả / hoàn / phạt SLC</th><th>Hash công tơ ảo</th></tr></thead><tbody>{trades.map(t => <tr key={`${t.round_id}-${t.index}`}>
          <td>#{t.round_id}.{t.index + 1} · {t.status}</td><td>{name(t.seller)} → {name(t.buyer)}</td><td>{t.quantity_wh} / {t.delivered_wh}</td>
          <td>{fmt(slc(t.accounting.paid), 6)} / {fmt(slc(t.accounting.refund), 6)} / {fmt(slc(t.accounting.penalty), 6)}</td><td><code>{t.evidence_hash}</code></td>
        </tr>)}</tbody></table></div>
        <h3>Biên lai các bước trong phạm vi</h3>
        {points.filter(p => p.transaction_hash).map(p => <details key={p.index} className="sim-eval-receipt"><summary>Bước {p.index} · {actions[p.action] || p.action} · {p.home} · phiên #{p.round_id || '—'}</summary><code className="sim-hash">{p.transaction_hash}</code></details>)}
        {!points.some(p => p.transaction_hash) && <p className="sim-muted">Chưa có biên lai gắn với các bước trong phạm vi.</p>}
      </details>
    </>}
    <AiEvaluation/>
  </section>;
}

function TradeMatrix({ trades, name, descriptor, filename }) {
  const sellers = [...new Set(trades.map(t => t.seller))], buyers = [...new Set(trades.map(t => t.buyer))];
  const cells = sellers.flatMap(s => buyers.map(b => ({ s, b, value: trades.filter(t => t.seller === s && t.buyer === b)
    .reduce((n, t) => n + Number(t.quantity_wh) / 1000, 0) })));
  const max = Math.max(1e-6, ...cells.map(c => c.value));
  const cellWidth = Math.min(92, 580 / Math.max(1, buyers.length)), cellHeight = 35;
  const height = Math.max(220, 125 + sellers.length * cellHeight);
  return <Chart title="Luồng điện đã khớp giữa các hộ" subtitle={`${descriptor} · hàng: bên bán; cột: bên mua; đơn vị kWh`}
    filename={filename} height={height} empty={!trades.length && 'Chưa có giao dịch để tạo ma trận.'} legend={[{ label: 'Màu đậm: khớp nhiều hơn' }]}>
    {buyers.map((b, i) => <text key={b} x={180 + i * cellWidth + cellWidth / 2} y="73" textAnchor="middle" fontSize="9"><title>{name(b)}</title>{b.replace('home_', 'H')}</text>)}
    {sellers.map((s, i) => <text key={s} x="165" y={98 + i * cellHeight} textAnchor="end"><title>{name(s)}</title>{name(s).slice(0, 23)}</text>)}
    {cells.map(c => { const i = sellers.indexOf(c.s), j = buyers.indexOf(c.b); return <g key={`${c.s}-${c.b}`}>
      <rect x={180 + j * cellWidth} y={80 + i * cellHeight} width={cellWidth - 3} height={cellHeight - 3} rx="3"
        fill={c.value ? colors[0] : '#e9eee2'} fillOpacity={c.value ? .2 + .8 * c.value / max : 1}><title>{name(c.s)} → {name(c.b)}: {fmt(c.value)} kWh đã khớp</title></rect>
      {buyers.length <= 12 && <text x={180 + j * cellWidth + (cellWidth - 3) / 2} y={100 + i * cellHeight} textAnchor="middle" fontSize="10" fill={c.value / max > .6 ? '#ffffff' : '#183a36'}>{fmt(c.value)}</text>}
    </g>; })}
  </Chart>;
}
