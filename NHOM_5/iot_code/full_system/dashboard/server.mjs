/** Local UI gateway. Never requests accounts, signs, or submits transactions.
 * POSTs only prepare evidence / save reports. Every market write uses the user's
 * EIP-1193 wallet in the browser. No generic JSON-RPC forwarding is exposed.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Contract, id, getAddress, formatUnits } from 'ethers';
import { ROOT, STATE, artifact, readJson, writeJson, sourceFile, canonical, acquireLock } from '../blockchain/lib/files.mjs';
import { localProvider, loopbackUrl } from '../blockchain/lib/chain.mjs';
import { api, allRecords, sourceFor } from '../blockchain/lib/backend.mjs';
import { snapshotRound } from '../blockchain/lib/market.mjs';

const hex32 = /^0x[0-9a-fA-F]{64}$/;
const runPattern = /^[a-f0-9]{32}$/;
const proposalPattern = /^[a-f0-9]{64}$/;
const number = (v, max) => typeof v === 'string' && /^[1-9][0-9]*$/.test(v) && BigInt(v) <= max;
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
export function writerBusy() {
  try {
    const pid = Number(fs.readFileSync(path.join(STATE, 'writer.lock'), 'utf8'));
    if (!Number.isInteger(pid) || pid < 1) return true;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
  } catch (e) { return e.code !== 'ENOENT'; }
}
async function withChain(fn) {
  let manifest;
  try { manifest = readJson(path.join(STATE, 'deployment.json')); }
  catch { fail('Chưa có triển khai. Chạy npm.cmd run deploy.', 503); }
  const provider = await localProvider(manifest.rpc);
  try {
    const market = new Contract(manifest.market, artifact('EnergyMarket').abi, provider);
    const token = new Contract(manifest.token, artifact('SolarToken').abi, provider);
    const receipt = await provider.getTransactionReceipt(manifest.deployment_tx);
    if (manifest.chain_id !== 31337 || !receipt || receipt.status !== 1 ||
        receipt.blockHash !== manifest.deployment_block_hash ||
        await market.deploymentId() !== manifest.deployment_id ||
        getAddress(await market.token()) !== getAddress(manifest.token))
      fail('Hardhat đã đổi phiên. Chạy npm.cmd run deploy, rồi tải lại trang.', 409);
    return await fn({ provider, market, token, manifest });
  } finally { provider.destroy(); }
}
function expectDeployment(chain, body) {
  if (body.deploymentId !== chain.manifest.deployment_id) fail('Triển khai đã thay đổi. Tải lại trang.', 409);
}
function durable(file, value) {
  if (fs.existsSync(file)) {
    if (canonical(readJson(file)) !== canonical(JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? String(v) : v))))
      fail('Bằng chứng đã lưu khác nội dung này. Không ghi đè nguồn của phiên.', 409);
  } else writeJson(file, value);
}
async function linkedSource(backend, body) {
  if (!runPattern.test(body.runId ?? '') || !proposalPattern.test(body.proposalId ?? '') ||
      !['replay', 'live'].includes(body.mode)) fail('Lượt, đề xuất hoặc chế độ không hợp lệ.');
  const proposals = await allRecords(backend, 'proposals', body.runId);
  const proposal = proposals.find(p => p.id === body.proposalId);
  if (!proposal) fail('Không tìm thấy đề xuất.', 404);
  if (body.mode === 'live' && !(await api(backend, '/ready')).ready) fail('Backend chưa sẵn sàng cho Live.', 409);
  return sourceFor(backend, body.runId, proposal, body.mode);
}
function roundId(value) {
  if (!number(value, 10000000n)) fail('Mã phiên không hợp lệ.');
  return BigInt(value);
}

export function createDashboard({ backend = process.env.SOLAR_BACKEND || 'http://127.0.0.1:8000' } = {}) {
  backend = loopbackUrl(backend);
  const csrf = randomUUID();
  // Clock estimate only. The contract is the final authority for bidding deadlines.
  const clocks = new Map();
  function clockFor(manifest, block) {
    const now = Date.now() / 1000;
    let anchor = clocks.get(manifest.deployment_id);
    if (!anchor || anchor.hash !== block.hash) {
      anchor = { hash: block.hash, chain: block.timestamp, wall: now };
      clocks.set(manifest.deployment_id, anchor);
    }
    return Math.floor(Math.max(block.timestamp, anchor.chain + now - anchor.wall));
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const json = (value, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v));
    };
    try {
      const port = server.address().port;
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!hosts.includes(req.headers.host)) fail('Host không được phép.', 403);
      const origins = hosts.map(h => `http://${h}`);
      if (req.headers.origin && !origins.includes(req.headers.origin)) fail('Origin không được phép.', 403);
      const url = new URL(req.url, `http://${req.headers.host}`), route = url.pathname;
      if (!['GET', 'POST'].includes(req.method)) fail('Method not allowed.', 405);
      let body;
      if (req.method === 'POST') {
        const supplied = Buffer.from(String(req.headers['x-solar-session'] || ''));
        const expected = Buffer.from(csrf);
        if (!origins.includes(req.headers.origin) || supplied.length !== expected.length ||
            !timingSafeEqual(supplied, expected)) fail('Phiên trình duyệt đã hết hạn. Tải lại trang.', 403);
        if (!req.headers['content-type']?.startsWith('application/json')) fail('JSON required.', 415);
        let raw = '';
        for await (const chunk of req) {
          raw += chunk;
          if (Buffer.byteLength(raw) > 8192) fail('Request too large.', 413);
        }
        try { body = JSON.parse(raw); } catch { fail('Invalid JSON.'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Invalid JSON object.');
      }
      if (req.method === 'GET' && route === '/ui/config') {
        return json({ version: '4.0.0', session: csrf, backend,
          abis: { market: artifact('EnergyMarket').abi, token: artifact('SolarToken').abi } });
      }
      if (req.method === 'GET' && route === '/ui/status') {
        return json(await withChain(async c => {
          const [count, block, escrow] = await Promise.all([
            c.market.roundCount(), c.provider.getBlock('latest'), c.token.balanceOf(c.manifest.market)]);
          const balances = {};
          await Promise.all(Object.entries(c.manifest.households).map(async ([home, address]) => {
            const [slc, eth] = await Promise.all([c.token.balanceOf(address), c.provider.getBalance(address)]);
            balances[home] = { address, slc: formatUnits(slc, 6), eth: formatUnits(eth, 18) };
          }));
          return { connected: true, deployment: c.manifest, round_count: String(count), balances,
            escrow_slc: formatUnits(escrow, 6), chain_now: clockFor(c.manifest, block),
            block_number: block.number, writer_busy: writerBusy() };
        }));
      }
      if (req.method === 'GET' && route === '/ui/rounds') {
        return json(await withChain(async c => {
          const total = await c.market.roundCount();
          let before = url.searchParams.get('before');
          let start = before ? roundId(before) - 1n : total;
          if (start > total) start = total;
          const ids = []; for (let i = start; i > 0n && ids.length < 20; i--) ids.push(i);
          const items = await Promise.all(ids.map(async n => {
            const r = await c.market.rounds(n);
            return { id: String(n), key: r.key, closes_at: Number(r.closesAt), settled: r.settled,
              mode: r.mode === 0n ? 'replay' : 'live' };
          }));
          return { total: String(total), items, next_before: ids.at(-1) > 1n ? String(ids.at(-1)) : null };
        }));
      }
      if (req.method === 'GET' && /^\/ui\/round\/[0-9]+$/.test(route)) {
        return json(await withChain(async c => {
          const n = roundId(route.split('/').at(-1));
          if (n > await c.market.roundCount()) fail('Chưa có phiên này.', 404);
          const report = await snapshotRound(c, n, { persist: false });
          const file = sourceFile(c.manifest.deployment_id, report.round_key);
          const source = fs.existsSync(file) ? readJson(file) : null;
          const logs = await c.provider.getLogs({ address: c.manifest.market,
            fromBlock: c.manifest.deployment_block, topics: [null, '0x' + n.toString(16).padStart(64, '0')] });
          const events = logs.map(log => ({ name: c.market.interface.parseLog(log)?.name,
            transaction_hash: log.transactionHash, block_number: log.blockNumber, index: log.index }));
          return { report, source, events };
        }));
      }
      if (req.method === 'GET' && /^\/ui\/tx\/0x[0-9a-fA-F]{64}$/.test(route)) {
        return json(await withChain(async c => {
          const hash = route.split('/').at(-1);
          const receipt = await c.provider.getTransactionReceipt(hash);
          if (!receipt) fail('Giao dịch chưa được ghi vào khối trên node hiện tại.', 404);
          if (![c.manifest.token, c.manifest.market].some(a => a.toLowerCase() === receipt.to?.toLowerCase()))
            fail('Giao dịch không thuộc hợp đồng hiện tại.', 404);
          const tx = await c.provider.getTransaction(hash);
          const iface = receipt.to.toLowerCase() === c.manifest.market.toLowerCase() ? c.market.interface : c.token.interface;
          let method = null; try { method = iface.parseTransaction({ data: tx.data, value: tx.value })?.name; } catch {}
          return { hash, status: receipt.status, from: receipt.from, to: receipt.to, block: receipt.blockNumber,
            block_hash: receipt.blockHash, gas_used: String(receipt.gasUsed), method,
            chain_id: 31337, deployment_id: c.manifest.deployment_id,
            events: receipt.logs.flatMap(log => {
              const addr = log.address.toLowerCase();
              const decoder = addr === c.manifest.market.toLowerCase() ? c.market.interface : addr === c.manifest.token.toLowerCase() ? c.token.interface : null;
              if (!decoder) return [];
              try { const ev = decoder.parseLog(log); return ev ? [{ name: ev.name, args: ev.args.toArray().map(String) }] : []; } catch { return []; }
            }) };
        }));
      }
      if (req.method === 'POST' && ['/ui/prepare', '/ui/revalidate', '/ui/counter', '/ui/report'].includes(route)) {
        if (writerBusy()) fail('Hãy dừng market:live / demo:backend trước khi thao tác trên giao diện.', 409);
        const release = acquireLock();
        try {
          return json(await withChain(async c => {
            expectDeployment(c, body);
            if (route === '/ui/report') {
              const n = roundId(body.roundId);
              if (n > await c.market.roundCount()) fail('Không tìm thấy phiên.', 404);
              return snapshotRound(c, n);
            }
            if (route === '/ui/counter') {
              const n = roundId(body.roundId), home = body.home;
              if (!['home_02', 'home_03'].includes(home) || ![0, 1].includes(body.side) ||
                  !number(body.quantityWh, 1000000000n) || !number(body.price, 1000000000000n)) fail('Thông số lệnh không hợp lệ.');
              const round = await c.market.rounds(n);
              if (round.key === '0x' + '0'.repeat(64) || round.settled) fail('Phiên không tồn tại hoặc đã kết toán.', 409);
              const block = await c.provider.getBlock('latest');
              if (Number(round.closesAt) <= clockFor(c.manifest, block)) fail('Phiên đã hết thời gian đặt lệnh.', 409);
              if (await c.market.hasOrder(n, c.manifest.households[home])) fail('Ví này đã dùng lượt đặt lệnh trong phiên.', 409);
              const data = { schema_version: 1, basis: 'demo_counterparty', household_id: home,
                round_key: round.key, quantity_wh: body.quantityWh, side: body.side,
                price_micro_slc_per_wh: body.price,
                note: 'Manual MetaMask order for local demo; not an AI forecast or a sensor measurement.' };
              const sourceId = id(`manual-counterparty-v1:${c.manifest.deployment_id}:${round.key}:${home}`);
              // Save each reviewed draft by its hash. An unsigned/rejected draft can be revised.
              const dataHash = id(canonical(data));
              durable(sourceFile(c.manifest.deployment_id, `${round.key}-${home}-${dataHash}`), data);
              return { data, dataHash, sourceId, quantityWh: body.quantityWh, side: body.side, price: body.price, basis: 1 };
            }
            const source = await linkedSource(backend, body);
            const existing = await c.market.roundByKey(source.roundKey);
            if (existing > 0n) {
              const r = await c.market.rounds(existing);
              if ((r.mode === 0n ? 'replay' : 'live') !== body.mode) fail('Nguồn đã có phiên ở chế độ khác.', 409);
              if (r.settled || await c.market.sourceUsed(c.manifest.households.home_01, source.sourceId))
                fail('Đề xuất này đã được sử dụng. Chọn một đề xuất khác.', 409);
            }
            if (route === '/ui/prepare') durable(sourceFile(c.manifest.deployment_id, source.roundKey), source);
            else {
              const file = sourceFile(c.manifest.deployment_id, source.roundKey);
              if (!fs.existsSync(file) || readJson(file).dataHash !== source.dataHash) fail('Nguồn chưa được chuẩn bị hoặc đã thay đổi.', 409);
            }
            return { ...source, existing_round: String(existing), mode: body.mode };
          }));
        } finally { release(); }
      }
      // Deliberately allow only the Phase 2 read API. Never proxy arbitrary paths or RPC.
      if (req.method === 'GET' && /^\/(health|ready|api\/(runs|homes|telemetry|predictions|proposals|overview))$/.test(route)) {
        const upstream = await fetch(backend + route + url.search, { signal: AbortSignal.timeout(10000), redirect: 'error' });
        return json(await upstream.json(), upstream.status);
      }
      if (req.method !== 'GET' || route.startsWith('/ui/') || route.startsWith('/api/')) fail('Not found.', 404);
      const dist = path.join(ROOT, 'dashboard', 'dist');
      const requested = route === '/' ? 'index.html' : decodeURIComponent(route).slice(1);
      const file = path.resolve(dist, requested);
      if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile())
        fail('Chưa có giao diện đã build. Chạy npm.cmd run dashboard:build.', 404);
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      const message = e.shortMessage || e.message || 'Lỗi không xác định';
      json({ error: message }, e.status || 503);
    }
  });
  server.requestTimeout = 15000;
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.SOLAR_UI_PORT || 5173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SOLAR_UI_PORT');
  const server = createDashboard();
  server.on('error', e => { console.error(`Dashboard: ${e.message}`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`SOLAR LAB Phase 4: http://127.0.0.1:${port}\nGiữ terminal này mở. Giao dịch được ký trong ví trình duyệt.`));
}
