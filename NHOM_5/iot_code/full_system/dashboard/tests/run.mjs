/** Real FastAPI/SQLite + real Hardhat + Chromium UI.
 * Browser wallet is an injected EIP-1193 TEST adapter to Hardhat's unlocked
 * test accounts. No MetaMask extension or physical ESP32 is simulated as real.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { JsonRpcProvider } from 'ethers';
import { ROOT, readJson } from '../../blockchain/lib/files.mjs';
import { startNode, freePort, runChild } from '../../blockchain/lib/test-node.mjs';
import { delay } from '../../blockchain/lib/market.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'solar-ui-test-'));
const screenshots = process.env.SOLAR_SCREENSHOTS || path.join(ROOT, 'dashboard', 'test-results');
fs.mkdirSync(screenshots, { recursive: true });
let node, backend, dashboard, browser, provider;
const python = process.env.SOLAR_TEST_PYTHON || path.join(ROOT, '.venv-backend', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
async function waitServer(url, child, log) {
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${log()}`);
    try { if ((await fetch(url)).ok) return; } catch {}
    await delay(250);
  }
  throw new Error(`Server unavailable: ${log()}`);
}
try {
  await runChild(process.execPath, ['--test', 'dashboard/tests/wallet.test.mjs']);
  await runChild(process.execPath, ['blockchain/compile.mjs']);
  await runChild(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'dashboard/vite.config.mjs']);
  node = await startNode();
  provider = new JsonRpcProvider(node.rpc, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
  const backendPort = await freePort(), uiPort = await freePort();
  const backendUrl = `http://127.0.0.1:${backendPort}`, ui = `http://127.0.0.1:${uiPort}`;
  const env = { ...process.env, SOLAR_RPC: node.rpc, SOLAR_PHASE3_DIR: path.join(temp, 'phase3'), SOLAR_BACKEND: backendUrl, SOLAR_UI_PORT: String(uiPort) };
  let backendLog = '', dashboardLog = '';
  backend = spawn(python, ['dashboard/tests/backend_fixture.py', '--db', path.join(temp, 'db.sqlite3'), '--port', String(backendPort)], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  backend.on('error', e => { backendLog += e.message; });
  backend.stdout.on('data', d => { backendLog += d; }); backend.stderr.on('data', d => { backendLog += d; });
  await waitServer(backendUrl + '/health', backend, () => backendLog);
  await runChild(process.execPath, ['blockchain/deploy.mjs'], env);
  const manifest = readJson(path.join(env.SOLAR_PHASE3_DIR, 'deployment.json'));
  dashboard = spawn(process.execPath, ['dashboard/server.mjs'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  dashboard.stdout.on('data', d => { dashboardLog += d; }); dashboard.stderr.on('data', d => { dashboardLog += d; });
  await waitServer(ui + '/ui/config', dashboard, () => dashboardLog);
  const get = async route => { const r = await fetch(ui + route); assert.equal(r.status, 200); return r.json(); };
  const config = await get('/ui/config');
  const post = (route, body, headers = {}) => fetch(ui + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ui, 'X-Solar-Session': config.session, ...headers }, body: JSON.stringify(body) });
  assert.equal((await get('/ui/status')).connected, true);
  assert.equal((await post('/ui/prepare', {}, { Origin: 'https://foreign.example' })).status, 403);
  assert.equal((await post('/ui/prepare', {}, { 'X-Solar-Session': 'wrong' })).status, 403);
  assert.equal((await post('/rpc', {})).status, 404);
  assert.equal((await fetch(ui + '/ui/status', { headers: { Origin: 'https://foreign.example' } })).status, 403);
  const proposals = (await get('/api/proposals?run_id=' + 'a'.repeat(32))).items;
  const sell = proposals.find(p => p.action === 'sell'), buy = proposals.find(p => p.action === 'buy');
  assert.ok(sell && buy);
  const body = p => ({ deploymentId: manifest.deployment_id, runId: p.run_id, proposalId: p.id, mode: 'replay' });
  assert.equal((await post('/ui/prepare', { ...body(sell), mode: 'live' })).status, 503, 'stopped fixture refuses live');
  assert.equal((await post('/ui/prepare', { ...body(sell), deploymentId: '0x' + '0'.repeat(64) })).status, 409);
  console.log('PASS gateway: backend proxy, current-chain check, CSRF/origin, no RPC proxy, live-stale rejection.');

  let launch = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (process.env.SOLAR_BROWSER_BIN) launch.executablePath = process.env.SOLAR_BROWSER_BIN;
  if (process.env.SOLAR_BROWSER_ARGS) launch.args.push(...JSON.parse(process.env.SOLAR_BROWSER_ARGS));
  browser = await chromium.launch(launch);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'vi-VN' });
  const accounts = await provider.send('eth_accounts', []);
  // The bridge below is test-only and not reachable from shipped dashboard code.
  await context.exposeBinding('__testRpc', async (_, { method, params = [] }) => provider.send(method, params));
  await context.addInitScript(({ accounts }) => {
    const listeners = {};
    window.__testWallet = { index: 0, chain: '0x7a69', rejectNext: false, sent: [],
      use(index) { this.index = index; (listeners.accountsChanged || []).forEach(fn => fn([accounts[index]])); },
      wrongChain() { this.chain = '0x1'; (listeners.chainChanged || []).forEach(fn => fn(this.chain)); } };
    const wallet = { on(event, fn) { (listeners[event] ||= []).push(fn); }, removeListener(event, fn) { listeners[event] = (listeners[event] || []).filter(x => x !== fn); },
      async request({ method, params = [] }) {
        const s = window.__testWallet;
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [accounts[s.index]];
        if (method === 'eth_chainId') return s.chain;
        if (method === 'wallet_switchEthereumChain') { s.chain = params[0].chainId; (listeners.chainChanged || []).forEach(fn => fn(s.chain)); return null; }
        if (method === 'wallet_addEthereumChain') return null;
        if (method === 'eth_sendTransaction') {
          if (s.rejectNext) { s.rejectNext = false; throw Object.assign(new Error('User rejected'), { code: 4001 }); }
          if (params[0].from.toLowerCase() !== accounts[s.index].toLowerCase()) throw new Error('Wrong test account');
          s.sent.push(params[0]);
        }
        return window.__testRpc({ method, params });
      } };
    window.ethereum = wallet;
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: 'test-wallet', name: 'EIP-1193 TEST WALLET', rdns: 'test.solar' }, provider: wallet } })));
  }, { accounts });
  const page = await context.newPage();
  const pageErrors = []; page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(ui);
  await page.getByRole('button', { name: 'Kết nối MetaMask', exact: true }).click();
  await page.getByRole('button', { name: /Điều phối ·/ }).waitFor();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(screenshots, 'phase4-overview.png'), fullPage: true });
  await page.getByRole('button', { name: 'Thị trường', exact: true }).click();
  // Regression: a valid list with no selection must explain the disabled action.
  const prepareButton = page.getByRole('button', { name: 'Chuẩn bị nguồn', exact: true });
  const latestButton = page.getByRole('button', { name: 'Chọn đề xuất mới nhất', exact: true });
  const proposalStatus = page.getByTestId('proposal-status');
  await expect(latestButton).toBeVisible();
  await expect(prepareButton).toBeDisabled();
  await expect(proposalStatus).toContainText('Đã tải 3 đề xuất');
  await expect(page.locator('#prepare-help')).toContainText('Chọn một đề xuất');
  await page.screenshot({ path: path.join(screenshots, 'phase4-market-selection.png'), fullPage: true, animations: 'disabled' });
  await latestButton.click();
  const latestProposal = proposals.reduce((a, b) => Date.parse(a.target_timestamp) > Date.parse(b.target_timestamp) ? a : b);
  await expect(page.getByTestId('proposal-select')).toHaveValue(latestProposal.id);
  await expect(prepareButton).toBeEnabled();
  assert.equal(await page.evaluate(() => window.__testWallet.sent.length), 0, 'choosing a proposal sends no transaction');
  assert.equal((await get('/ui/status')).round_count, '0');

  // API outage must not present cached proposals as actionable; retry recovers.
  let proposalResponse = 'error', releaseLoading;
  const loadingGate = new Promise(resolve => { releaseLoading = resolve; });
  await page.route('**/api/proposals?**', async route => {
    if (proposalResponse === 'normal') return route.continue();
    if (proposalResponse === 'loading') {
      await loadingGate;
      return route.continue();
    }
    if (proposalResponse === 'error') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Mat ket noi backend (test)' }) });
    const items = proposalResponse === 'empty' ? [] : proposals.map((p, i) => ({ ...p,
      action: i === 0 ? 'hold' : p.action, status: i === 1 ? 'late' : p.status, on_chain: i === 2 }));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items, total: items.length }) });
  });
  await page.getByRole('button', { name: '↻ Làm mới' }).click();
  await expect(proposalStatus.getByRole('alert')).toContainText('Không tải được danh sách đề xuất');
  await expect(prepareButton).toBeDisabled();
  await expect(page.getByTestId('proposal-select')).toBeDisabled();
  proposalResponse = 'normal';
  await page.getByRole('button', { name: 'Thử tải lại', exact: true }).click();
  await expect(prepareButton).toBeEnabled();

  proposalResponse = 'loading';
  await page.getByRole('button', { name: '↻ Làm mới' }).click();
  await expect(proposalStatus).toContainText('Đang tải đề xuất');
  await expect(prepareButton).toBeDisabled();
  await expect(proposalStatus).not.toContainText('Chưa có đề xuất');
  releaseLoading(); proposalResponse = 'normal';
  await expect(prepareButton).toBeEnabled();

  proposalResponse = 'empty';
  await page.getByRole('button', { name: '↻ Làm mới' }).click();
  await expect(proposalStatus).toContainText('Lượt này chưa có đề xuất từ ESP32');
  await expect(page.getByTestId('proposal-select')).toHaveValue('');
  await expect(prepareButton).toBeDisabled();
  await expect(latestButton).toHaveCount(0);
  proposalResponse = 'excluded';
  await page.getByRole('button', { name: '↻ Làm mới' }).click();
  await expect(proposalStatus).toContainText('Giữ nguyên, dự báo đến trễ');
  await expect(page.getByTestId('proposal-select')).toBeDisabled();
  proposalResponse = 'normal';
  await page.getByRole('button', { name: '↻ Làm mới' }).click();
  await expect(latestButton).toBeVisible();
  await page.getByLabel('Chế độ', { exact: true }).selectOption('live');
  await expect(page.getByRole('button', { name: 'Dùng Replay với dữ liệu đã lưu', exact: true })).toBeVisible();
  await expect(prepareButton).toBeDisabled();
  await page.getByRole('button', { name: 'Dùng Replay với dữ liệu đã lưu', exact: true }).click();
  await expect(latestButton).toBeVisible();
  await expect(page.getByTestId('proposal-select')).toHaveValue('');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'market selection has no mobile overflow');
  assert.equal(await page.locator('.source-form').evaluate(form => {
    const right = form.getBoundingClientRect().right;
    return [...form.querySelectorAll('select')].every(select => select.getBoundingClientRect().right <= right + 1);
  }), true, 'mobile dropdowns stay inside the source panel');
  await page.screenshot({ path: path.join(screenshots, 'phase4-market-selection-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1100 });
  assert.equal(await page.evaluate(() => window.__testWallet.sent.length), 0);
  await page.unroute('**/api/proposals?**');
  console.log('PASS market selection: next step, latest choice, loading/error/retry/empty/excluded/live states, no automatic transaction, mobile overflow.');
  await page.getByTestId('proposal-select').selectOption(sell.id);
  await page.getByRole('button', { name: 'Chuẩn bị nguồn', exact: true }).click();
  await page.getByRole('button', { name: 'Mở phiên bằng ví Điều phối', exact: true }).click();
  await page.getByRole('heading', { name: 'Phiên #1', exact: true }).waitFor({ timeout: 20000 });
  await page.evaluate(() => window.__testWallet.use(1));
  await page.getByRole('button', { name: /Nhà 1 ·/ }).waitFor();
  await page.getByRole('button', { name: 'Xem lại lệnh', exact: true }).click();
  // Rejected transaction must leave chain empty and let the user review again.
  await page.evaluate(() => { window.__testWallet.rejectNext = true; });
  await page.getByRole('button', { name: 'Ký và gửi lệnh', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'từ chối' }).waitFor();
  assert.equal((await get('/ui/round/1')).report.orders.length, 0);
  await page.getByRole('button', { name: 'Ký và gửi lệnh', exact: true }).click();
  await page.getByRole('heading', { name: '1 lệnh trong phiên', exact: true }).waitFor({ timeout: 20000 });
  await page.evaluate(() => window.__testWallet.use(2));
  await page.getByRole('button', { name: /Nhà 2 ·/ }).waitFor();
  await page.getByRole('button', { name: 'Xem lại lệnh', exact: true }).click();
  await page.getByRole('button', { name: 'Ký và gửi lệnh', exact: true }).click();
  await page.getByRole('heading', { name: '2 lệnh trong phiên', exact: true }).waitFor({ timeout: 20000 });
  let round = (await get('/ui/round/1')).report;
  assert.equal(round.source_hash_verified, true);
  assert.ok(BigInt(round.orders[1].locked_micro_slc) > 0n);
  await provider.send('evm_setNextBlockTimestamp', [round.closes_at]); await provider.send('evm_mine', []);
  await page.getByRole('button', { name: '↻ Làm mới' }).click();
  await page.getByRole('button', { name: 'Kết toán phiên', exact: true }).click({ timeout: 20000 });
  await page.getByRole('heading', { name: 'Đã khớp 1 giao dịch', exact: true }).waitFor({ timeout: 20000 });
  round = (await get('/ui/round/1')).report;
  assert.equal(round.settled, true); assert.equal(round.trades.length, 1);
  assert.ok(BigInt(round.market_balance_micro_slc) > 0n); assert.equal(round.source_hash_verified, true);
  assert.equal(round.trades[0].status, 'pending'); assert.equal(round.trades[0].paid_micro_slc, '0');
  const totals = Object.values(round.balances).reduce((sum, b) => sum + BigInt(b.balance_micro_slc), 0n);
  assert.equal(totals + BigInt(round.market_balance_micro_slc), 3000000000n);
  const receipt = await get(`/ui/tx/${round.settlement.transaction_hash}`);
  assert.equal(receipt.status, 1); assert.equal(receipt.method, 'settle');
  assert.ok(receipt.events.some(e => e.name === 'TradeExecuted'));
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Xuất báo cáo JSON ↓', exact: true }).click();
  const download = await downloadEvent; assert.equal(download.suggestedFilename(), 'phase4-round-1.json');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(screenshots, 'phase4-market-settled.png'), fullPage: true });
  assert.equal((await post('/ui/prepare', body(sell))).status, 409, 'consumed source cannot open another round');
  console.log('PASS browser E2E: connect, prepare, open, reject/retry, orders, matching, pending delivery escrow, receipt/events, export, token conservation.');

  // Cancellation: a buy locks SLC, cancellation refunds it, no second order in round.
  await page.evaluate(() => window.__testWallet.use(0));
  await page.getByTestId('proposal-select').selectOption(buy.id);
  await page.getByRole('button', { name: 'Chuẩn bị nguồn', exact: true }).click();
  await page.getByRole('button', { name: 'Mở phiên bằng ví Điều phối', exact: true }).click();
  await page.getByRole('heading', { name: 'Phiên #2', exact: true }).waitFor({ timeout: 20000 });
  await page.evaluate(() => window.__testWallet.use(1));
  await page.getByRole('button', { name: 'Xem lại lệnh', exact: true }).click();
  await page.getByRole('button', { name: 'Ký và gửi lệnh', exact: true }).click();
  await page.getByRole('heading', { name: '1 lệnh trong phiên', exact: true }).waitFor({ timeout: 20000 });
  assert.ok(BigInt((await get('/ui/round/2')).report.orders[0].locked_micro_slc) > 0n);
  await page.getByRole('button', { name: 'Hủy lệnh', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Đã hủy lệnh' }).waitFor({ timeout: 20000 });
  round = (await get('/ui/round/2')).report;
  assert.equal(round.orders[0].cancelled, true); assert.equal(round.orders[0].locked_micro_slc, '0');
  assert.equal(await page.getByRole('button', { name: 'Xem lại lệnh', exact: true }).isDisabled(), true);
  await page.evaluate(() => window.__testWallet.wrongChain());
  await page.getByRole('button', { name: 'Chuyển sang Solar Local', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Chuyển sang Solar Local', exact: true }).click();
  await page.getByRole('button', { name: 'Giao dịch', exact: true }).click();
  await page.locator('#round').selectOption('1');
  await page.getByRole('button', { name: 'Xem ↗', exact: true }).first().click();
  await page.getByText('Thành công · receipt status 1', { exact: true }).waitFor();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(screenshots, 'phase4-receipt.png'), fullPage: true });
  await page.getByRole('button', { name: 'Đóng ×', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Tổng quan', exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(screenshots, 'phase4-mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'mobile has no page overflow');
  assert.deepEqual(pageErrors, []);
  await runChild(process.execPath, ['blockchain/report.mjs'], env);
  const annotated = (await get('/api/proposals?run_id=' + 'a'.repeat(32))).items.find(p => p.id === sell.id);
  assert.equal(annotated.on_chain, true, 'Phase 2 API sees browser settlement');
  // Loss of node identity must disable writes rather than treating old JSON as active.
  await provider.send('hardhat_setCode', [manifest.market, '0x']);
  assert.equal((await fetch(ui + '/ui/status')).status, 503);
  console.log('PASS browser: buy cancellation/refund, consumed wallet disabled, wrong-network recovery, decoded receipt, mobile 390px, no JS runtime errors, changed deployment rejected.');
  console.log('PHASE 4 PASS. Automated wallet adapter and forecast fixtures only; real MetaMask/ESP32 remain the Windows acceptance check.');
} catch (e) { console.error(e.stack || e); process.exitCode = 1; }
finally {
  if (browser) await browser.close(); provider?.destroy();
  for (const child of [dashboard, backend, node?.child]) if (child && child.exitCode === null)
    await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
  fs.rmSync(temp, { recursive: true, force: true });
}
