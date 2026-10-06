import React, { useCallback, useEffect, useRef, useState } from 'react';
import { formatUnits, Interface } from 'ethers';
import { WalletSession, discoverWallets, decimalInteger, errorText, short, sendOrder, sendMarketAction } from './wallet.mjs';

const fmt = (value, digits = 3) => value == null ? '—' : Number(value).toLocaleString('vi-VN', { maximumFractionDigits: digits });
const realReading = row => row?.data_mode === 'real';
const powerUnit = real => real ? 'W' : 'kW';
const powerValue = (kw, real) => fmt(kw == null ? null : kw * (real ? 1000 : 1));
const time = value => value ? new Date(value).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false }) : '—';
const titleHome = value => ({ home_01: 'Nhà 1', home_02: 'Nhà 2', home_03: 'Nhà 3' }[value] || value);
const actionName = value => ({ buy: 'Mua', sell: 'Bán', hold: 'Giữ nguyên' }[value] || value);
const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
async function request(url, options = {}) {
  const res = await fetch(url, options);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || body.detail || `${url}: HTTP ${res.status}`);
  return body;
}
function useData(url, revision = 0, interval = 5000) {
  const [state, set] = useState({ url, data: null, error: '', loading: true });
  useEffect(() => {
    if (!url) { set({ url, data: null, error: '', loading: false }); return; }
    let active = true, busy = false;
    const controller = new AbortController();
    set(s => s.url === url ? { ...s, loading: true } : { url, data: null, error: '', loading: true });
    const load = async () => {
      if (busy) return; busy = true;
      try { const data = await request(url, { signal: controller.signal }); if (active) set({ url, data, error: '', loading: false }); }
      catch (e) { if (active) set(s => ({ ...s, error: e.message, loading: false })); }
      finally { busy = false; }
    };
    load(); const timer = setInterval(load, interval);
    return () => { active = false; clearInterval(timer); controller.abort(); };
  }, [url, revision, interval]);
  return state.url === url ? state : { data: null, error: '', loading: true };
}
function Icon({ name, size = 20 }) {
  const paths = {
    sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></>,
    grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    market: <><path d="M3 7h17l-4-4M21 17H4l4 4M20 7l-4 4M4 17l4-4"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/></>,
    book: <><path d="M12 5v16M3 3h5l4 2 4-2h5v16h-5l-4 2-4-2H3z"/></>,
    wallet: <><rect x="3" y="5" width="18" height="15" rx="3"/><path d="M16 11h5v5h-5zM3 7V4l13-2v3"/></>,
    home: <><path d="M3 10l9-7 9 7M5 9v12h14V9M10 21v-7h4v7"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.sun}</svg>;
}
function Badge({ good, children }) { return <span className={`badge ${good ? 'good' : 'muted'}`}>{children}</span>; }
function Empty({ children }) { return <div className="empty">{children}</div>; }
function HomeCard({ home, featured, balance }) {
  const row = home.telemetry, real = realReading(row), unit = powerUnit(real);
  const label = !row ? 'Chưa có số đo' : real ? 'INA219 · đo thật' : home.has_edge_model ? 'ESP32 · mô phỏng' : 'Số đo mô phỏng';
  return <section className={`home-card ${featured ? 'featured' : ''}`}>
    <div className="card-top"><span className="home-icon"><Icon name="home"/></span><Badge good={real || home.has_edge_model}>{label}</Badge></div>
    <h2>{titleHome(home.household_id)}</h2>
    <div className="power">{powerValue(row?.net_power_kw, real)} <small>{unit}</small></div>
    <p>{real ? 'Dư / thiếu · trung bình 5 phút' : 'Công suất dư / thiếu hiện tại'}</p>
    <div className="home-metrics"><div>Phát điện<strong>{powerValue(row?.solar_power_kw, real)} {unit}</strong></div><div>Tiêu thụ<strong>{powerValue(row?.load_power_kw, real)} {unit}</strong></div></div>
    <div className="card-footer"><span>{!row ? 'Chưa có dữ liệu' : home.stale ? 'Số đo đã lưu' : 'Vừa nhận dữ liệu'}</span><strong>{fmt(balance?.slc)} SLC</strong></div>
  </section>;
}
function Chart({ records }) {
  if (!records?.length) return <Empty>Chưa có số đo trong lượt này.</Empty>;
  const values = [...records].reverse();
  const real = values.every(realReading), unit = powerUnit(real), scale = real ? 1000 : 1;
  const max = Math.max(real ? 0.01 : 1, ...values.flatMap(x => [x.solar_power_kw * scale, x.load_power_kw * scale]));
  const y = (value, key) => 180 - (value[key] || 0) * scale / max * 145;
  const line = key => values.map((v, i) => `${50 + i * 600 / Math.max(1, values.length - 1)},${y(v, key)}`).join(' ');
  return <><svg className="chart" viewBox="0 0 680 220" role="img" aria-label={`Công suất phát và tải ${real ? 'đo thật' : 'mô phỏng'} của Nhà 1 (${unit}), tối đa 36 khoảng đo mới nhất`}>
    {[0, 1, 2, 3].map(i => <g key={i}><line x1="50" y1={180 - i * 145 / 3} x2="650" y2={180 - i * 145 / 3} className="gridline"/><text x="0" y={184 - i * 145 / 3}>{fmt(max * i / 3, real ? 3 : 1)}</text></g>)}
    <polyline points={line('solar_power_kw')} className="solar-line"/><polyline points={line('load_power_kw')} className="load-line"/>
    {values.length === 1 && <><circle cx="50" cy={y(values[0], 'solar_power_kw')} r="4" fill="#288470"/><circle cx="50" cy={y(values[0], 'load_power_kw')} r="4" fill="#bcc17c"/></>}
    <text x="50" y="212">{values[0].timestamp.slice(11, 16)}</text><text x="610" y="212">{values.at(-1).timestamp.slice(11, 16)}</text>
  </svg><div className="legend"><span className="dot solar"/> Phát điện <span className="dot load"/> Tải tiêu thụ <span className="quiet">{unit} · {real ? 'giờ đo thực tế' : 'giờ mô phỏng'} UTC+7</span></div></>;
}

export default function App() {
  const [tab, setTab] = useState('overview');
  const [revision, setRevision] = useState(0);
  const [config, setConfig] = useState(null), [configError, setConfigError] = useState('');
  const [runId, setRunId] = useState(''), [roundId, setRoundId] = useState('');
  const [before, setBefore] = useState('');
  const [wallets, setWallets] = useState([]), [walletChoice, setWalletChoice] = useState('');
  const [walletState, setWalletState] = useState({ account: '', chainId: '', epoch: 0 });
  const wallet = useRef(null); if (!wallet.current) wallet.current = new WalletSession(setWalletState);
  const [busy, setBusy] = useState(false), busyRef = useRef(false);
  const [notice, setNotice] = useState(null), [txProgress, setTxProgress] = useState(null);
  const [prepared, setPrepared] = useState(null), [plan, setPlan] = useState(null);
  const [mode, setMode] = useState('replay'), [proposalId, setProposalId] = useState('');
  const [duration, setDuration] = useState('300');
  const [price, setPrice] = useState('2.000'), [quantity, setQuantity] = useState('0.050'), [side, setSide] = useState('1');
  const [txDetail, setTxDetail] = useState(null), [txError, setTxError] = useState('');
  const [now, setNow] = useState(Date.now()), clockAnchor = useRef(null);
  const priorDeployment = useRef('');
  const refresh = useCallback(() => setRevision(n => n + 1), []);
  const runQuery = runId ? `?run_id=${runId}` : '';
  const overviewState = useData(`/api/overview${runQuery}`, revision);
  const chainState = useData('/ui/status', revision);
  const roundsState = useData(`/ui/rounds${before ? `?before=${before}` : ''}`, revision);
  const detailState = useData(roundId ? `/ui/round/${roundId}` : null, revision);
  const proposalsState = useData(runId ? `/api/proposals?run_id=${runId}&household_id=home_01&limit=500` : null, revision);
  const telemetryState = useData(runId ? `/api/telemetry?run_id=${runId}&household_id=home_01&limit=36` : null, revision);
  const overview = overviewState.data, chain = chainState.data, manifest = chain?.deployment;
  const detail = detailState.data, report = detail?.report, source = detail?.source;
  const chainOk = !!manifest && !chainState.error;
  const role = manifest && (same(walletState.account, manifest.coordinator) ? 'coordinator' :
    Object.entries(manifest.households).find(([, a]) => same(a, walletState.account))?.[0]);
  const walletOk = chainOk && !!walletState.account && walletState.chainId.toLowerCase() === '0x7a69';
  const canAct = walletOk && !busy && !chain?.writer_busy && !!config;
  const chainNow = chain ? (clockAnchor.current?.chain || chain.chain_now) + Math.max(0, (now - (clockAnchor.current?.wall || now)) / 1000) : 0;
  const secondsLeft = report ? Math.max(0, Math.ceil(report.closes_at - chainNow)) : 0;
  const counterRole = ['home_02', 'home_03'].includes(role);
  const used = report?.orders.some(o => same(o.trader, walletState.account));

  useEffect(() => {
    request('/ui/config').then(setConfig).catch(e => setConfigError(e.message));
    const cleanup = discoverWallets(setWallets);
    return () => { cleanup(); wallet.current.detach(); };
  }, []);
  useEffect(() => { if (!walletChoice && wallets.length) setWalletChoice(wallets.find(w => w.info.rdns === 'io.metamask')?.info.uuid || wallets[0].info.uuid); }, [wallets, walletChoice]);
  useEffect(() => { if (!runId && overview?.selected_run_id) setRunId(overview.selected_run_id); }, [overview, runId]);
  useEffect(() => { if (!roundId && roundsState.data?.items[0]) setRoundId(roundsState.data.items[0].id); }, [roundsState.data, roundId]);
  useEffect(() => { if (chain) clockAnchor.current = { chain: chain.chain_now, wall: Date.now() }; }, [chain]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    const current = manifest?.deployment_id;
    if (!current) return;
    if (priorDeployment.current && priorDeployment.current !== current) {
      setPrepared(null); setPlan(null); setRoundId(''); setBefore('');
      setNotice({ text: 'Đã chuyển sang triển khai Hardhat mới. Chọn lại phiên và đề xuất.' });
    }
    priorDeployment.current = current;
  }, [manifest?.deployment_id]);
  useEffect(() => { setPlan(null); }, [walletState.epoch, roundId, price, quantity, side]);
  useEffect(() => { setPrepared(null); setProposalId(''); }, [runId, mode]);
  useEffect(() => {
    if (!source || !role) return;
    const s = role === 'home_01' ? source.side : 1 - source.side;
    setSide(String(s)); setPrice(s === 0 ? '2.000' : '3.000');
    setQuantity(formatUnits(BigInt(source.quantityWh), 3));
  }, [roundId, role, source?.sourceId]);

  const post = (route, data) => request(route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Solar-Session': config.session }, body: JSON.stringify(data) });
  const notify = progress => setTxProgress(progress);
  async function task(fn) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setNotice(null); setTxProgress(null);
    try { await fn(); }
    catch (e) { setNotice({ bad: true, text: errorText(e) }); }
    finally { busyRef.current = false; setBusy(false); refresh(); }
  }
  async function ensureChain() {
    const fresh = await request('/ui/status');
    if (!manifest || fresh.deployment.deployment_id !== manifest.deployment_id) throw new Error('Triển khai đã đổi. Tải lại trang trước khi ký.');
    if (fresh.writer_busy) throw new Error('Dừng market:live / demo:backend trước khi giao dịch bằng ví.');
    return fresh;
  }
  const sourceBody = s => ({ deploymentId: manifest.deployment_id, runId: s.data.proposal.run_id,
    proposalId: s.data.proposal.id, mode: s.data.mode });
  async function revalidateSource(s) {
    await ensureChain();
    const fresh = await post('/ui/revalidate', sourceBody(s));
    if (fresh.dataHash !== s.dataHash) throw new Error('Đề xuất đã thay đổi. Chuẩn bị lại nguồn.');
  }
  async function saveReport(id, download = false) {
    const saved = await post('/ui/report', { deploymentId: manifest.deployment_id, roundId: String(id) });
    if (download) {
      const blob = new Blob([JSON.stringify(saved, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = `phase4-round-${id}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    return saved;
  }
  async function afterTransaction(id, message) {
    setPlan(null);
    try { await saveReport(id); setNotice({ text: message }); }
    catch (e) { setNotice({ text: `${message} Chưa lưu được báo cáo: ${errorText(e)}. Dùng nút Xuất báo cáo để thử lại.` }); }
  }
  async function prepare() {
    if (!proposalId) throw new Error('Chọn một đề xuất có hành động Mua hoặc Bán.');
    const p = await post('/ui/prepare', { deploymentId: manifest.deployment_id, runId, proposalId, mode });
    setPrepared(p);
    if (p.existing_round !== '0') { setRoundId(p.existing_round); setNotice({ text: `Nguồn đã có phiên #${p.existing_round}. Tiếp tục đặt lệnh tại phiên này.` }); }
    else setNotice({ text: 'Đã kiểm tra liên kết số đo → dự báo → đề xuất và lưu bằng chứng. Ví Điều phối có thể mở phiên.' });
  }
  async function openRound() {
    const receipt = await sendMarketAction({ wallet: wallet.current, manifest, abis: config.abis,
      action: 'openRound', args: [prepared.roundKey, Number(duration), mode === 'replay' ? 0 : 1],
      revalidate: () => revalidateSource(prepared), notify });
    const iface = new Interface(config.abis.market);
    const ev = receipt.logs.map(log => { try { return iface.parseLog(log); } catch { return null; } }).find(e => e?.name === 'RoundOpened');
    if (!ev) throw new Error('Đã có receipt nhưng không tìm thấy sự kiện mở phiên. Kiểm tra lịch sử.');
    const id = String(ev.args.roundId); setRoundId(id); setBefore(''); setPrepared(null);
    await afterTransaction(id, `Đã mở phiên #${id}. Chuyển MetaMask sang Nhà 1 để đặt lệnh từ dự báo.`);
  }
  async function reviewOrder() {
    if (!report || report.settled || used) throw new Error('Phiên đã đóng hoặc ví đã dùng lượt đặt lệnh.');
    const p = decimalInteger(price, 3, 1000000000000n).toString();
    let draft;
    if (role === 'home_01') {
      if (!source) throw new Error('Thiếu bằng chứng nguồn của phiên.');
      await revalidateSource(source);
      draft = { ...source, price: p, basis: 0 };
    } else if (counterRole) {
      draft = await post('/ui/counter', { deploymentId: manifest.deployment_id, roundId,
        home: role, side: Number(side), quantityWh: decimalInteger(quantity).toString(), price: p });
    } else throw new Error('Chọn ví Nhà 1, Nhà 2 hoặc Nhà 3 trong MetaMask.');
    const expected = wallet.current.capture();
    const c = await wallet.current.guard(expected, manifest, config.abis);
    const [payment, collateral] = await c.market.quoteOrder(expected.account, draft.side, draft.quantityWh, p);
    setPlan({ ...draft, roundId, roundKey: report.round_key, account: expected.account,
      payment: String(payment), collateral: String(collateral), totalLock: String(payment + collateral) });
  }
  async function placeOrder() {
    await sendOrder({ wallet: wallet.current, manifest, abis: config.abis, plan, notify,
      revalidate: async () => {
        await ensureChain();
        if (plan.basis === 0) await revalidateSource(source);
        else {
          const fresh = await post('/ui/counter', { deploymentId: manifest.deployment_id, roundId: plan.roundId,
            home: role, side: plan.side, quantityWh: plan.quantityWh, price: plan.price });
          if (fresh.dataHash !== plan.dataHash) throw new Error('Lệnh đã đổi. Xem lại trước khi ký.');
        }
      } });
    await afterTransaction(roundId, 'Lệnh đã được ghi trên blockchain. Khi tới hạn, dùng Kết toán để khớp lệnh; SLC chờ xác nhận giao điện.');
  }
  async function action(action, args) {
    await sendMarketAction({ wallet: wallet.current, manifest, abis: config.abis, action, args, revalidate: ensureChain, notify });
    await afterTransaction(roundId, action === 'settle' ? 'Đã khớp lệnh, hoàn SLC dư; tiền giao dịch tiếp tục khóa đến khi xác nhận giao điện.' : 'Đã hủy lệnh và hoàn SLC đã khóa (nếu có). Ví này không thể đặt lại trong cùng phiên.');
  }
  async function showTx(hash) {
    setTxError(''); setTxDetail({ hash, loading: true });
    try { setTxDetail(await request(`/ui/tx/${hash}`)); } catch (e) { setTxError(e.message); }
  }
  const who = address => Object.entries(manifest?.households || {}).find(([, a]) => same(a, address))?.[0];
  const proposals = proposalsState.data?.items || [];
  const selectable = proposals.filter(p => ['buy', 'sell'].includes(p.action) && p.status !== 'late' &&
    (mode === 'replay' || p.eligible_for_review) && p.on_chain !== true);
  const proposalsReady = !!runId && !!proposalsState.data && !proposalsState.loading && !proposalsState.error;
  const latestSelectable = selectable.reduce((latest, p) => !latest ||
    Date.parse(p.target_timestamp) > Date.parse(latest.target_timestamp) ? p : latest, null);
  function chooseProposal(id) { setProposalId(id); setPrepared(null); }
  useEffect(() => {
    if (proposalsState.data && proposalId && !selectable.some(p => p.id === proposalId)) {
      setProposalId(''); setPrepared(null);
    }
  }, [proposalsState.data, mode, proposalId]);
  useEffect(() => {
    if (!txDetail) return;
    const onKey = e => { if (e.key === 'Escape') setTxDetail(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [!!txDetail]);
  const currentProposal = selectable.find(p => p.id === proposalId);
  const prepareReason = !runId ? 'Chọn một lượt dữ liệu ở phía trên để bắt đầu.' :
    proposalsState.error ? 'Chưa tải được đề xuất. Bấm “Thử tải lại” bên dưới.' :
    !proposalsReady ? 'Đang tải đề xuất của lượt đã chọn…' :
    !selectable.length ? 'Chưa có đề xuất phù hợp trong danh sách đã tải.' :
    !currentProposal ? 'Chọn một đề xuất trong danh sách hoặc bấm “Chọn đề xuất mới nhất”.' :
    !chainOk ? 'Chờ Hardhat sẵn sàng để kiểm tra nguồn.' :
    !config ? 'Chưa tải được cấu hình dashboard. Tải lại trang để thử lại.' :
    chain?.writer_busy ? 'Dừng market:live / demo:backend trước khi chuẩn bị nguồn.' :
    busy ? 'Đang xử lý thao tác trước. Vui lòng chờ.' : '';
  const openReason = prepared && (prepareReason || (!walletState.account ? 'Kết nối ví Điều phối để mở phiên.' :
    !walletOk ? 'Chuyển ví sang Solar Local để mở phiên.' :
    role !== 'coordinator' ? 'Chọn ví Điều phối trong MetaMask để mở phiên.' :
    prepared.existing_round !== '0' ? `Đề xuất này đã có phiên #${prepared.existing_round}. Tiếp tục tại phiên bên dưới.` : ''));
  const latestPrediction = overview?.predictions?.items?.[0];
  const homeOne = overview?.homes?.find(home => home.household_id === 'home_01')?.telemetry;
  const real = realReading(homeOne);
  const txHashes = [...new Set((detail?.events || []).map(e => e.transaction_hash))].reverse();
  const runCounts = { telemetry: telemetryState.data?.total, predictions: proposalsState.data?.total };

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#" onClick={e => { e.preventDefault(); setTab('overview'); }}><span className="brand-icon"><Icon name="sun" size={28}/></span><span>SOLAR LAB<small>ENERGY · INTELLIGENCE</small></span></a>
      <div className="nav-caption">KHÔNG GIAN LÀM VIỆC</div>
      <nav aria-label="Điều hướng chính">{[['overview','grid','Tổng quan'], ['market','market','Thị trường'], ['history','clock','Giao dịch'], ['guide','book','Hướng dẫn']].map(([key, icon, name]) => <button key={key} className={tab === key ? 'nav-item active' : 'nav-item'} onClick={() => setTab(key)}><Icon name={icon}/>{name}{tab === key && <span className="nav-indicator"/>}</button>)}</nav>
      <div className="sidebar-bottom"><span className="pill">PHASE 04</span><h3>Điện dự báo.<br/>Lệnh do bạn quyết định.</h3><p>ESP32 → đề xuất → MetaMask → thị trường SLC.</p><div className="small-rule"/><p>Local demo<br/>Chain ID <strong>31337</strong></p></div>
    </aside>
    <div className="workspace">
      <header className="topbar"><div className="breadcrumb">HỆ THỐNG ĐIỆN NGANG HÀNG <span>/</span> <strong>Web3 Dashboard</strong></div><div className="wallet-controls">
        {wallets.length > 1 && <select aria-label="Chọn ví" value={walletChoice} onChange={e => setWalletChoice(e.target.value)} disabled={busy}>{wallets.map(w => <option key={w.info.uuid} value={w.info.uuid}>{w.info.name}</option>)}</select>}
        <button className="wallet-button" disabled={busy || !wallets.length} onClick={() => task(() => wallet.current.connect(wallets.find(w => w.info.uuid === walletChoice)?.provider || wallets[0].provider))}><Icon name="wallet"/>{walletState.account ? `${role === 'coordinator' ? 'Điều phối' : role ? titleHome(role) : 'Ví ngoài danh sách'} · ${short(walletState.account)}` : wallets.length ? 'Kết nối MetaMask' : 'Chưa tìm thấy ví'}</button>
      </div></header>
      <main>
        <div className="page-heading"><div><div className="eyebrow">SOLAR COMMUNITY / 03 HỘ GIA ĐÌNH</div><h1>{{ overview: 'Năng lượng trong tầm tay.', market: 'Từ dự báo đến giao dịch.', history: 'Mỗi giao dịch, một bằng chứng.', guide: 'Bắt đầu lượt giao dịch đầu tiên.' }[tab]}</h1><p>{{ overview: 'Theo dõi số đo điện năng, dự báo trên ESP32 và số dư trên blockchain.', market: 'Xem xét đề xuất, ký lệnh và quyết toán bằng token thử nghiệm SLC.', history: 'Kiểm tra trực tiếp sự kiện và biên nhận trên node Hardhat hiện tại.', guide: 'Dùng dữ liệu đã lưu để thử giao diện trước khi chuyển sang lượt trực tiếp.' }[tab]}</p></div><button className="secondary" onClick={refresh} disabled={busy}>↻ Làm mới</button></div>
        <div className="connection-strip"><span><i className={overview?.mqtt?.connected && !overviewState.error ? 'dot online' : 'dot offline'}/>MQTT {overviewState.error ? 'không rõ' : overview?.mqtt?.connected ? 'đã kết nối' : 'ngoại tuyến'}</span><span><i className={chainOk ? 'dot online' : 'dot offline'}/>Hardhat {chainOk ? `· khối ${chain.block_number}` : 'chưa sẵn sàng'}</span><span><i className={walletOk ? 'dot online' : 'dot offline'}/>{walletOk ? 'Ví đúng mạng local' : 'Chế độ xem'}</span><span className="demo-label">SLC thử nghiệm · chưa xác minh điện giao thực tế</span></div>
        {configError && <div role="alert" className="alert error">{configError} Chạy npm.cmd run compile rồi tải lại.</div>}
        {overviewState.error && <div role="alert" className="alert error">Backend: {overviewState.error}. Kiểm tra terminal backend cổng 8000.</div>}
        {chainState.error && <div role="alert" className="alert error">Blockchain: {chainState.error}</div>}
        {chain?.writer_busy && <div role="alert" className="alert warning">Bridge Phase 3 đang chạy. Dừng terminal market:live bằng Ctrl+C trước khi đặt lệnh bằng MetaMask.</div>}
        {walletState.account && !walletOk && chainOk && <div className="alert warning">Ví cần mạng Solar Local, chain ID 31337. <button onClick={() => task(() => wallet.current.switchNetwork(manifest))} disabled={busy}>Chuyển sang Solar Local</button></div>}
        {walletState.account && walletOk && !role && <div className="alert warning">Ví này chưa thuộc danh sách triển khai. Chọn một ví thử nghiệm được ghi trong mục Hướng dẫn.</div>}
        {notice && <div role="alert" className={`alert ${notice.bad ? 'error' : 'success'}`}>{notice.text}</div>}
        {txProgress && <div className="alert progress" aria-live="polite"><strong>{txProgress.label}</strong>{txProgress.hash && <button className="text-button" onClick={() => showTx(txProgress.hash)}>Xem {short(txProgress.hash)} ↗</button>}</div>}

        {(tab === 'overview' || tab === 'market') && <div className="run-control"><label htmlFor="run">Lượt dữ liệu</label><select id="run" value={runId} onChange={e => setRunId(e.target.value)} disabled={busy}><option value="">Chọn lượt…</option>{overview?.runs?.map(r => <option key={r.run_id} value={r.run_id}>{r.run_id.slice(0, 12)}… · {r.simulator_status || 'không rõ'}</option>)}</select><span className="quiet">Dữ liệu giữ theo từng lượt, không cộng lẫn.</span></div>}

        {tab === 'overview' && <>
          <div className="homes-grid">{(overview?.homes || []).map((home, i) => <HomeCard key={home.household_id} home={home} featured={i === 0} balance={chain?.balances[home.household_id]}/>)}</div>
          {!overview?.homes?.length && <Empty>Chưa có dữ liệu. Chạy backend hoặc chọn một lượt đã lưu.</Empty>}
          <div className="overview-grid"><section className="panel"><div className="section-head"><div><div className="eyebrow">NHÀ 1 · {real ? 'ĐO THẬT INA219 · TRUNG BÌNH 5 PHÚT' : 'SỐ ĐO MÔ PHỎNG'}</div><h2>Phát điện & tiêu thụ</h2></div><Badge>36 khoảng gần nhất</Badge></div><Chart records={telemetryState.data?.items}/></section>
          <section className="panel forecast-panel"><div className="eyebrow">SUY LUẬN TRÊN ESP32</div><h2>Dự báo 5 phút tiếp theo</h2>{latestPrediction ? <><p className="quiet">{time(latestPrediction.target_timestamp)}</p><div className="forecast-values"><span>Phát <strong>{powerValue(latestPrediction.predicted_solar_kw, real)} <small>{powerUnit(real)}</small></strong></span><span>Tải <strong>{powerValue(latestPrediction.predicted_load_kw, real)} <small>{powerUnit(real)}</small></strong></span></div><p>Thời gian suy luận <strong>{fmt(latestPrediction.inference_us, 0)} µs</strong></p><p className="quiet">{latestPrediction.late ? 'Dự báo đến trễ; không dùng mở phiên.' : 'Bản dự báo mới nhất trong lượt đã chọn.'}</p></> : <Empty>{real ? 'Đang gom 12 khoảng đo thật, mỗi khoảng 5 phút, để dự báo trên ESP32.' : 'Chờ dự báo từ Nhà 1.'}</Empty>}<button className="primary" onClick={() => setTab('market')}>Xem đề xuất giao dịch <span>↗</span></button></section></div>
          <div className="summary-grid"><div><span>SỐ ĐO NHÀ 1 TRONG LƯỢT</span><strong>{fmt(runCounts.telemetry, 0)}</strong></div><div><span>DỰ BÁO / ĐỀ XUẤT TRONG LƯỢT</span><strong>{fmt(runCounts.predictions, 0)}</strong></div><div><span>PHIÊN TRÊN CHAIN HIỆN TẠI</span><strong>{fmt(chain?.round_count, 0)}</strong></div><div><span>SLC ĐANG KHÓA TẠI THỊ TRƯỜNG</span><strong>{fmt(chain?.escrow_slc, 6)}</strong></div></div>
        </>}

        {tab === 'market' && <>
          <section className="panel"><div className="section-head"><div><div className="eyebrow">01 / NGUỒN DỮ LIỆU</div><h2>Chuẩn bị phiên từ đề xuất Nhà 1</h2></div><Badge good={mode === 'live'}>{mode === 'replay' ? 'Replay · dữ liệu đã lưu' : 'Live · kiểm tra độ mới'}</Badge></div>
            <ol className="market-steps" aria-label="Các bước mở phiên">
              <li aria-current={!currentProposal ? 'step' : undefined}><span>1</span>Chọn đề xuất</li>
              <li aria-current={currentProposal && !prepared ? 'step' : undefined}><span>2</span>Chuẩn bị nguồn</li>
              <li aria-current={prepared ? 'step' : undefined}><span>3</span>Mở phiên bằng ví</li>
            </ol>
            <div className="form-grid source-form"><label>Chế độ<select aria-label="Chế độ" value={mode} onChange={e => setMode(e.target.value)} disabled={busy}><option value="replay">Replay — kiểm thử bằng lịch sử</option><option value="live">Live — chỉ đề xuất còn hiệu lực</option></select></label><label>Đề xuất Nhà 1<select data-testid="proposal-select" aria-describedby="proposal-help" value={proposalId} onChange={e => chooseProposal(e.target.value)} disabled={busy || !proposalsReady || !selectable.length}><option value="">{!runId ? 'Chọn lượt dữ liệu trước' : proposalsState.error ? 'Chưa tải được đề xuất' : !proposalsReady ? 'Đang tải đề xuất…' : !selectable.length ? 'Chưa có đề xuất phù hợp' : `Chọn trong ${selectable.length} đề xuất…`}</option>{selectable.map(p => <option key={p.id} value={p.id}>{time(p.target_timestamp)} · {actionName(p.action)} {fmt(p.quantity_kwh, 6)} kWh · {p.id.slice(0, 6)}</option>)}</select></label></div>
            <div id="proposal-help" className="proposal-status" data-testid="proposal-status">
              {!runId ? <p>Chọn lượt dữ liệu ở phía trên. Replay dùng được cả lượt đã dừng.</p> :
                proposalsState.error ? <div role="alert" className="alert error"><strong>Không tải được danh sách đề xuất.</strong><p>{proposalsState.error}</p><button disabled={busy} onClick={refresh}>Thử tải lại</button></div> :
                !proposalsReady ? <p role="status">Đang tải đề xuất của lượt đã chọn…</p> :
                <><p role="status">Đã tải <strong>{fmt(proposals.length, 0)}</strong> đề xuất Nhà 1 · <strong>{fmt(selectable.length, 0)}</strong> có thể chọn để kiểm tra nguồn.</p>
                  {Number(proposalsState.data.total) > proposals.length && <p className="quiet">Đang hiển thị {fmt(proposals.length, 0)} đề xuất mới nhất trong tổng số {fmt(proposalsState.data.total, 0)} của lượt.</p>}
                  {selectable.length > 0 ? <div className="proposal-shortcut"><p>{currentProposal ? 'Đã chọn đề xuất. Kiểm tra thông tin rồi bấm “Chuẩn bị nguồn”.' : 'Bắt đầu bằng cách chọn một đề xuất. Nút bên cạnh giúp điền nhanh đề xuất mới nhất phù hợp.'}</p><button className="secondary" disabled={busy} onClick={() => chooseProposal(latestSelectable.id)}>Chọn đề xuất mới nhất</button></div> :
                    <div className="proposal-empty"><strong>{proposals.length ? 'Chưa có đề xuất phù hợp với chế độ này.' : 'Lượt này chưa có đề xuất từ ESP32.'}</strong><p>{!proposals.length ? 'Chọn lượt đã có dự báo Nhà 1, hoặc kiểm tra ESP32 và backend nếu đang chạy dữ liệu mới.' : mode === 'live' ? 'Live cần đề xuất còn hiệu lực. Với dữ liệu đã dừng hoặc đã cũ, chuyển sang Replay.' : 'Danh sách đã loại đề xuất Giữ nguyên, dự báo đến trễ và đề xuất đã ghi nhận trên chain. Chọn lượt khác để tiếp tục.'}</p>{mode === 'live' && proposals.length > 0 && <button className="secondary" disabled={busy} onClick={() => setMode('replay')}>Dùng Replay với dữ liệu đã lưu</button>}</div>}
                </>}
            </div>
            <p className="quiet">{mode === 'replay' ? 'Replay cho phép dùng đề xuất lịch sử. Mỗi đề xuất chỉ tạo được một phiên trong cùng triển khai.' : 'Live kiểm tra lại trước khi mở phiên và trước khi gửi lệnh. Nếu số đo đích đã tới hoặc dữ liệu cũ, lệnh sẽ bị chặn.'}</p>
            {currentProposal && proposalsReady && <div className="proposal-preview"><Badge good>{actionName(currentProposal.action)}</Badge><strong>{fmt(currentProposal.quantity_kwh, 6)} kWh</strong><span>{time(currentProposal.target_timestamp)}</span><span>Trạng thái dữ liệu: {currentProposal.status}</span><span className="quiet">{short(currentProposal.device_id)}</span></div>}
            <p id="prepare-help" className="action-hint" aria-live="polite">{prepareReason || (prepared ? openReason || 'Nguồn đã sẵn sàng. Chọn thời gian đặt lệnh, rồi mở phiên và xác nhận trong MetaMask.' : 'Bước tiếp theo: bấm “Chuẩn bị nguồn”. Bước này chưa gửi giao dịch lên blockchain.')}</p>
            <div className="form-actions"><button className="secondary" aria-describedby="prepare-help" disabled={!!prepareReason} onClick={() => task(prepare)}>Chuẩn bị nguồn</button>{prepared && <><label className="inline-label">Thời gian đặt lệnh<select value={duration} onChange={e => setDuration(e.target.value)} disabled={busy}><option value="120">2 phút</option><option value="300">5 phút</option><option value="600">10 phút</option></select></label><button className="primary" aria-describedby="prepare-help" disabled={!canAct || !!openReason} onClick={() => task(openRound)}>Mở phiên bằng ví Điều phối</button></>}</div>
          </section>
          <RoundPicker rounds={roundsState.data} roundId={roundId} setRoundId={setRoundId} before={before} setBefore={setBefore} busy={busy}/>
          {detailState.error && <div className="alert error">{detailState.error}</div>}
          {report && <><div className="market-grid"><section className="panel order-panel"><div className="section-head"><div><div className="eyebrow">02 / ĐẶT LỆNH</div><h2>Phiên #{roundId}</h2></div><Badge good={report.settled}>{report.settled ? 'Đã kết toán' : secondsLeft > 0 ? `Còn khoảng ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}` : 'Đã tới hạn dự kiến'}</Badge></div>
            <p className="quiet">{report.mode.toUpperCase()} · {role === 'coordinator' ? 'Chuyển sang ví một hộ gia đình để đặt lệnh.' : role ? `Đang thao tác cho ${titleHome(role)}.` : 'Kết nối ví một hộ gia đình để đặt lệnh.'}</p>
            {role === 'home_01' && source && <div className="source-callout">Dự báo ESP32: <strong>{actionName(source.side === 0 ? 'sell' : 'buy')} {fmt(Number(source.quantityWh) / 1000)} kWh</strong><small>Năng lượng giữ theo đề xuất; phần lẻ dưới 1 Wh được bỏ xuống.</small></div>}
            {counterRole && <div className="source-callout">Lệnh mô phỏng nhập tay cho {titleHome(role)}. Nhà này chưa có mô hình dự báo riêng.</div>}
            <div className="form-grid"><label>Chiều lệnh<select aria-label="Chiều lệnh" value={side} onChange={e => setSide(e.target.value)} disabled={!counterRole || busy || used || report.settled}><option value="0">Bán</option><option value="1">Mua</option></select></label><label>Năng lượng (kWh)<input aria-label="Năng lượng (kWh)" inputMode="decimal" value={quantity} onChange={e => setQuantity(e.target.value)} disabled={!counterRole || busy || used || report.settled}/></label><label>Giá (SLC/kWh)<input aria-label="Giá (SLC/kWh)" inputMode="decimal" value={price} onChange={e => setPrice(e.target.value)} disabled={busy || used || report.settled}/></label></div>
            <p className="quiet">Mua: khóa lượng × giá mua và đặt cọc theo uy tín. Bán: đặt cọc theo uy tín. Sau khớp lệnh, tiền chờ xác nhận giao điện; phần dư được hoàn.</p>
            {used && <div className="alert warning">Ví này đã đặt hoặc hủy một lệnh trong phiên. Không thể đặt thêm.</div>}
            <button className="secondary" disabled={!canAct || !['home_01','home_02','home_03'].includes(role) || used || report.settled || secondsLeft === 0} onClick={() => task(reviewOrder)}>Xem lại lệnh</button>
            {plan && <div className="review-box"><div className="eyebrow">KIỂM TRA TRƯỚC KHI KÝ</div><h3>{plan.side === 0 ? 'Bán' : 'Mua'} {fmt(Number(plan.quantityWh) / 1000)} kWh</h3><dl><dt>Giá</dt><dd>{fmt(Number(plan.price) / 1000)} SLC/kWh</dd><dt>{plan.side === 1 ? 'SLC khóa tối đa' : 'SLC nếu khớp hết'}</dt><dd>{fmt(formatUnits(BigInt(plan.quantityWh) * BigInt(plan.price), 6), 6)} SLC</dd><dt>Đặt cọc theo uy tín</dt><dd>{fmt(formatUnits(plan.collateral, 6), 6)} SLC</dd><dt>Tổng SLC cần khóa</dt><dd>{fmt(formatUnits(plan.totalLock, 6), 6)} SLC</dd><dt>Ví</dt><dd>{short(plan.account)}</dd><dt>Nguồn</dt><dd>{plan.basis === 0 ? 'Dự báo ESP32' : 'Lệnh mô phỏng nhập tay'}</dd></dl><button className="primary" disabled={!canAct} onClick={() => task(placeOrder)}>Ký và gửi lệnh</button><small>{BigInt(plan.totalLock) > 0n ? 'MetaMask có thể hỏi cấp quyền SLC trước, rồi mới hỏi gửi lệnh. Chấp thuận từng bước.' : 'MetaMask sẽ hiển thị giao dịch placeOrder để bạn xác nhận.'}</small></div>}
          </section>
          <section className="panel"><div className="section-head"><div><div className="eyebrow">03 / SỔ LỆNH</div><h2>{report.orders.length} lệnh trong phiên</h2></div><Badge>{report.mode}</Badge></div><OrderTable report={report} who={who} account={walletState.account} canCancel={canAct && secondsLeft > 0 && !report.settled} cancel={index => task(() => action('cancelOrder', [roundId, index]))}/>
            <div className="settle-box"><h3>{report.settled ? `Đã khớp ${report.trades.length} giao dịch` : 'Kết toán khi hết thời gian'}</h3><p>Ưu tiên giá mua cao, giá bán thấp; cùng giá mua thì ưu tiên hộ đã xác minh. Sau khớp lệnh, điều phối viên xác nhận giao điện qua market:confirm; quá hạn có thể hoàn tiền qua market:expire.</p><button className="primary" disabled={!canAct || report.settled || secondsLeft > 0} onClick={() => task(() => action('settle', [roundId]))}>Kết toán phiên</button><button className="text-button" disabled={busy || !config || !chainOk} onClick={() => task(async () => { await saveReport(roundId, true); setNotice({ text: 'Đã lưu báo cáo vào data/phase3/reports và tải bản JSON.' }); })}>Xuất báo cáo JSON ↓</button></div>
          </section></div><Trades report={report} who={who}/></>}
          {!roundId && <Empty>Chưa có phiên. Chuẩn bị một đề xuất và dùng ví Điều phối để mở phiên.</Empty>}
        </>}

        {tab === 'history' && <><RoundPicker rounds={roundsState.data} roundId={roundId} setRoundId={setRoundId} before={before} setBefore={setBefore} busy={busy}/>{report ? <>
          <div className="history-banner"><div><div className="eyebrow">PHIÊN #{roundId} · {report.mode.toUpperCase()}</div><h2>{report.settled ? 'Đã kết toán trên chain hiện tại' : 'Chưa kết toán'}</h2><p>Nguồn ESP32: {report.source_hash_verified ? 'hash khớp bản dữ liệu đã lưu' : 'chưa có lệnh nguồn khớp'}</p></div><button className="secondary" disabled={busy || !chainOk} onClick={() => task(() => saveReport(roundId, true))}>Xuất báo cáo JSON ↓</button></div>
          <section className="panel"><div className="section-head"><h2>Biên nhận & sự kiện</h2><Badge>Đọc trực tiếp từ Hardhat</Badge></div><p className="quiet">Chain local không có Etherscan. Bấm mã giao dịch để kiểm tra receipt, khối và sự kiện.</p>{txHashes.length ? <div className="table-wrap"><table><thead><tr><th>Giao dịch</th><th>Sự kiện</th><th>Khối</th><th/></tr></thead><tbody>{txHashes.map(hash => { const events = detail.events.filter(e => e.transaction_hash === hash); return <tr key={hash}><td><button className="hash-link" onClick={() => showTx(hash)}>{short(hash)}</button></td><td>{[...new Set(events.map(e => e.name))].join(', ')}</td><td>{events[0].block_number}</td><td><button className="text-button" onClick={() => showTx(hash)}>Xem ↗</button></td></tr>; })}</tbody></table></div> : <Empty>Chưa có sự kiện.</Empty>}</section><Trades report={report} who={who}/></> : <Empty>Chọn một phiên để xem lịch sử.</Empty>}</>}

        {tab === 'guide' && <section className="panel guide"><div className="section-head"><h2>Một lượt kiểm tra trọn vẹn</h2><Badge>MetaMask · Hardhat local</Badge></div><ol><li><strong>Giữ backend, Hardhat và dashboard đang chạy.</strong> Dừng <code>market:live</code> trước khi thao tác bằng ví. Replay không cần simulator chạy lại.</li><li><strong>Kết nối MetaMask trên trình duyệt máy tính.</strong> Thêm mạng bằng nút “Chuyển sang Solar Local”. Chỉ dùng tài khoản thử nghiệm được Hardhat in ra ở máy bạn.</li><li><strong>Nhập các ví Điều phối, Nhà 1 và Nhà 2 vào MetaMask.</strong> Đối chiếu địa chỉ bên dưới. Không nhập ví đang giữ tài sản thật; không gửi khóa riêng cho người khác. Giao diện này không nhận khóa riêng.</li><li><strong>Chọn Thị trường → Replay → một đề xuất → Chuẩn bị nguồn.</strong> Dùng ví Điều phối mở phiên 5 phút; nếu mới tập thao tác, chọn 10 phút.</li><li><strong>Chuyển MetaMask sang Nhà 1.</strong> Xem lại lệnh từ ESP32 rồi ký. Nếu Mua, chấp thuận cấp quyền SLC và giao dịch đặt lệnh.</li><li><strong>Chuyển sang Nhà 2.</strong> Đặt lệnh đối ứng cùng năng lượng. Nhà 1 Bán giá 2: Nhà 2 Mua giá 3. Nhà 1 Mua giá 3: Nhà 2 Bán giá 2. Các giá đều tính SLC/kWh.</li><li><strong>Chờ bộ đếm về 0 rồi Kết toán phiên.</strong> Kỳ vọng 2 lệnh, 1 giao dịch chờ xác nhận. Tiền tiếp tục khóa cho đến khi điều phối viên xác nhận giao điện hoặc có yêu cầu hoàn tiền sau hạn. Xem receipt và Xuất báo cáo JSON.</li></ol>
          <div className="table-wrap"><table><thead><tr><th>Vai trò</th><th>Địa chỉ triển khai hiện tại</th><th>SLC</th></tr></thead><tbody>{manifest && <tr><td>Điều phối · Hardhat #0</td><td className="mono address">{manifest.coordinator}</td><td>—</td></tr>}{Object.entries(manifest?.households || {}).map(([home, address], i) => <tr key={home}><td>{titleHome(home)} · Hardhat #{i + 1}</td><td className="mono address">{address}</td><td>{fmt(chain?.balances[home]?.slc)}</td></tr>)}</tbody></table></div>
          <div className="guide-notes"><h3>Nếu không thấy ví hoặc sai tài khoản</h3><p>Cài MetaMask từ <a href="https://metamask.io/download/" target="_blank" rel="noreferrer">trang chính thức</a>, mở lại trang rồi kết nối. Đổi tài khoản trong MetaMask; nếu địa chỉ trên trang không đổi, mở phần kết nối của ví để cấp quyền đúng tài khoản. Dùng “Kết nối MetaMask” để đọc lại.</p><h3>Nếu Hardhat vừa khởi động lại</h3><p>Chạy lại <code>npm.cmd run deploy</code>, tải lại dashboard và đối chiếu triển khai mới. Chain local mất lịch sử khi node dừng; file JSON cũ vẫn còn nhưng thuộc lượt triển khai cũ.</p><h3>Giới hạn của bản demo</h3><p>SLC là token thử nghiệm. Nhà 1 có dự báo ESP32; số đo đầu vào vẫn là mô phỏng. Nhà 2/3 đặt lệnh đối ứng nhập tay. Hash xác nhận dữ liệu khớp, không chứng minh nguồn cảm biến đáng tin hoặc điện đã giao thật.</p></div>
        </section>}
        <footer>SOLAR LAB <span>Phase 4 · React / ESP32 / Ethereum local</span><span>Giao dịch chỉ được gửi sau thao tác xác nhận trong ví.</span></footer>
      </main>
    </div>
    {txDetail && <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setTxDetail(null); }}><section className="modal" role="dialog" aria-modal="true" aria-label="Chi tiết giao dịch"><div className="section-head"><h2>Biên nhận giao dịch</h2><button className="secondary" onClick={() => setTxDetail(null)}>Đóng ×</button></div><p className="mono address">{txDetail.hash}</p>{txError ? <div className="alert error">{txError}</div> : txDetail.loading ? <p>Đang kiểm tra node…</p> : <><Badge good={txDetail.status === 1}>{txDetail.status === 1 ? 'Thành công · receipt status 1' : 'Thất bại · receipt status 0'}</Badge><dl className="receipt"><dt>Hàm gọi</dt><dd>{txDetail.method || '—'}</dd><dt>Khối</dt><dd>{txDetail.block}</dd><dt>Gas dùng</dt><dd>{txDetail.gas_used}</dd><dt>Từ ví</dt><dd className="mono address">{txDetail.from}</dd><dt>Đến hợp đồng</dt><dd className="mono address">{txDetail.to}</dd><dt>Chain</dt><dd>31337 · Hardhat local</dd></dl><h3>Sự kiện được giải mã</h3>{txDetail.events.map((ev, i) => <details key={i}><summary>{ev.name}</summary><pre>{ev.args.join('\n')}</pre></details>)}</>}</section></div>}
  </div>;
}

function RoundPicker({ rounds, roundId, setRoundId, before, setBefore, busy }) {
  return <div className="round-picker"><label htmlFor="round">Phiên trên blockchain</label><select id="round" value={roundId} disabled={busy} onChange={e => setRoundId(e.target.value)}><option value="">Chọn phiên…</option>{roundId && !rounds?.items?.some(r => r.id === roundId) && <option value={roundId}>Phiên #{roundId}</option>}{rounds?.items?.map(r => <option key={r.id} value={r.id}>#{r.id} · {r.mode} · {r.settled ? 'Đã kết toán' : 'Chưa kết toán'}</option>)}</select><span className="quiet">{rounds?.total || 0} phiên</span>{before && <button className="text-button" disabled={busy} onClick={() => setBefore('')}>Mới nhất</button>}{rounds?.next_before && <button className="text-button" disabled={busy} onClick={() => setBefore(rounds.next_before)}>Cũ hơn →</button>}</div>;
}
function OrderTable({ report, who, account, canCancel, cancel }) {
  if (!report.orders.length) return <Empty>Chưa có lệnh. Dùng ví Nhà 1 để gửi lệnh từ dự báo trước.</Empty>;
  return <div className="table-wrap"><table><thead><tr><th>Hộ / chiều</th><th>kWh</th><th>SLC/kWh</th><th>Trạng thái</th></tr></thead><tbody>{report.orders.map(o => <tr key={o.index}><td><strong>{titleHome(who(o.trader)) || short(o.trader)}</strong><small className={`side ${o.action}`}>{actionName(o.action)} · {o.basis === 'esp32_forecast' ? 'ESP32' : 'Mô phỏng'}</small></td><td>{fmt(Number(o.quantity_wh) / 1000)}</td><td>{fmt(Number(o.price_micro_slc_per_wh) / 1000)}</td><td>{o.cancelled ? 'Đã hủy' : report.settled ? `Còn ${fmt(Number(o.remaining_wh) / 1000)} kWh` : 'Đã ghi nhận'}{!o.cancelled && same(account, o.trader) && !report.settled && <button className="text-button cancel" disabled={!canCancel} onClick={() => cancel(o.index)}>Hủy lệnh</button>}</td></tr>)}</tbody></table></div>;
}
function Trades({ report, who }) {
  return <section className="panel"><div className="section-head"><div><div className="eyebrow">KHỚP LỆNH VÀ XÁC NHẬN</div><h2>Giao dịch đã khớp</h2></div><Badge good={report.settled}>{report.trades.length} giao dịch</Badge></div>{report.trades.length ? <div className="table-wrap"><table><thead><tr><th>Bên bán</th><th>Bên mua</th><th>Điện (kWh)</th><th>Giá (SLC/kWh)</th><th>Trạng thái</th><th>Đã trả (SLC)</th></tr></thead><tbody>{report.trades.map((t, i) => <tr key={i}><td>{titleHome(who(t.seller)) || short(t.seller)}</td><td>{titleHome(who(t.buyer)) || short(t.buyer)}</td><td>{fmt(Number(t.quantity_wh) / 1000)}</td><td>{fmt(Number(t.price_micro_slc_per_wh) / 1000)}</td><td>{{ pending: 'Chờ xác nhận', confirmed: 'Đã xác nhận', expired: 'Đã hoàn tiền' }[t.status] || t.status}</td><td><strong>{fmt(formatUnits(t.paid_micro_slc || '0', 6), 6)}</strong></td></tr>)}</tbody></table></div> : <Empty>{report.settled ? 'Phiên đã kết toán nhưng không có cặp lệnh phù hợp.' : 'Kết quả sẽ xuất hiện sau khi kết toán phiên.'}</Empty>}</section>;
}
