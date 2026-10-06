import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { chromium, expect } from "@playwright/test";
import { ROOT } from "../../blockchain/lib/files.mjs";
import { runChild } from "../../blockchain/lib/test-node.mjs";
import { SimulationController } from "../../blockchain/lib/simulation-controller.mjs";
import { simulationServer } from "../../blockchain/simulation-server.mjs";

const root = process.env.SOLAR_SIMULATION_UI_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "solar-simulation-ui-"));
const replay = process.env.SOLAR_SIMULATION_UI_REPLAY === '1';
const screenshots = path.join(ROOT, "dashboard", "test-results");
fs.mkdirSync(screenshots, { recursive: true });
const controller = new SimulationController({ root });
const server = simulationServer(controller);
let browser;
try {
  await runChild(process.execPath, ["node_modules/vite/bin/vite.js", "build", "--config", "dashboard/vite.config.mjs"]);
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = await (await fetch(base + "/simulation/config")).json();
  const post = (body, headers = {}) => fetch(base + "/simulation/run", { method: "POST", headers: {
    "Content-Type": "application/json", Origin: base, "X-Solar-Session": config.session, ...headers
  }, body: JSON.stringify(body) });
  const options = { scenario: "full-demo", homes: 12, seed: 20261003 };
  assert.equal((await post(options, { "X-Solar-Session": "wrong" })).status, 403);
  assert.equal((await post(options, { Origin: "http://another-site.invalid" })).status, 403);
  assert.equal((await post({ ...options, homes: 33 })).status, 400);
  assert.equal((await fetch(base + "/simulation/report")).status, replay ? 200 : 404);
  const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
  browser = await chromium.launch({ headless: true,
    ...(process.env.SOLAR_BROWSER_BIN ? { executablePath: process.env.SOLAR_BROWSER_BIN }
      : process.platform === "win32" && fs.existsSync(chrome) ? { executablePath: chrome } : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, locale: "vi-VN" });
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(base + "/simulation");
  if (!replay) {
    await expect(page.getByRole("status")).toHaveText("Sẵn sàng");
    await page.getByLabel("Kịch bản", { exact: true }).selectOption("full-demo");
    await page.getByRole("button", { name: "Chạy mô phỏng", exact: true }).click();
    await expect(page.getByRole("button", { name: "Đang chạy…", exact: true })).toBeDisabled();
    assert.equal((await post(options)).status, 409, "running session rejects a second run");
  }
  await expect(page.getByRole("status")).toHaveText("Đã hoàn tất", { timeout: 240000 });
  const state = await (await fetch(base + "/simulation/state")).json();
  assert.equal(state.status, "completed"); assert.equal(state.snapshot.passed, true);
  assert.equal(state.snapshot.homes.length, 12); assert.equal(state.snapshot.conserved, true);
  assert.equal(state.snapshot.escrow, "0"); assert.equal(state.checks.length, 22);
  assert.ok(state.snapshot.rounds[0].trades.length > 0);
  assert.ok(state.snapshot.rounds[0].trades.every(t => t.status === "confirmed"));
  await expect(page.locator(".sim-home")).toHaveCount(12);
  await expect(page.locator(".sim-checks .passed")).toHaveCount(22);
  await page.getByLabel("Lọc hộ", { exact: true }).selectOption("home_03");
  await expect(page.locator(".sim-home")).toHaveCount(1);
  await expect(page.locator(".sim-home")).toContainText("Bệnh viện");
  await page.getByLabel("Lọc hộ", { exact: true }).selectOption("");
  const receipt = page.locator(".sim-page details:has(summary code)").first();
  await receipt.locator("summary").click();
  await expect(receipt).toContainText("Receipt status 1");
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("link", { name: "Tải báo cáo JSON ↓", exact: true }).click();
  const download = await downloadEvent;
  const report = JSON.parse(fs.readFileSync(await download.path(), "utf8"));
  assert.equal(report.run_id, state.run_id); assert.equal(report.physical_delivery_verified, false);
  assert.equal(report.conserved, true);
  const evaluation = page.getByRole('region', { name: 'Đánh giá bằng biểu đồ' });
  const partialIndex = state.checks.findIndex(c => c.name.startsWith('Giao 40%'));
  await page.getByLabel('Phạm vi đánh giá').selectOption(String(partialIndex));
  await expect(evaluation.locator('.sim-eval-kpis')).toContainText('40%');
  await expect(evaluation.locator('.sim-eval-kpis')).toContainText('0,08 / 0,12');
  await expect(evaluation.locator('.sim-eval-kpis')).toContainText('0,012');
  await expect(evaluation.locator('.sim-eval-note').filter({ hasText: 'Điểm 60' })).toContainText('60 → 40');
  await expect(page.getByRole('img', { name: 'Điện cam kết và đã giao', exact: true })).toBeVisible();
  for (const [buttonName, extension] of [
    ['Tải SVG: Điện cam kết và đã giao', 'svg'], ['Tải PNG: Điện cam kết và đã giao', 'png'],
    ['CSV giao dịch ↓', 'csv'], ['CSV diễn biến ↓', 'csv'], ['Tải CSV chuỗi AI ↓', 'csv'],
  ]) {
    const event = page.waitForEvent('download');
    await page.getByRole('button', { name: buttonName, exact: true }).click();
    const file = await event, bytes = fs.readFileSync(await file.path());
    assert.ok(file.suggestedFilename().endsWith('.' + extension));
    assert.ok(bytes.length > 100);
    if (extension === 'png') assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
    if (extension === 'svg') assert.ok(bytes.toString().includes('Điện cam kết và đã giao'));
    if (buttonName === 'CSV giao dịch ↓') assert.ok(bytes.toString().includes('"100","40","80000","120000","12000"'));
    await file.saveAs(path.join(screenshots, 'evaluation-' + file.suggestedFilename()));
  }
  await evaluation.screenshot({ path: path.join(screenshots, 'simulation-evaluation.png') });
  await page.getByLabel('Đại lượng uy tín').selectOption('collateral_bps');
  const trackedHome = state.snapshot.homes.find(h => h.id === 'home_01').name;
  await expect(page.getByRole('img', { name: `Tỷ lệ đặt cọc · ${trackedHome}`, exact: true })).toBeVisible();
  await page.getByLabel('Đại lượng uy tín').selectOption('limit_wh');
  await expect(page.getByRole('img', { name: `Giới hạn cam kết · ${trackedHome}`, exact: true })).toBeVisible();
  await page.getByLabel('Đại lượng uy tín').selectOption('score');
  await page.getByLabel('Hộ trong giao dịch').selectOption('home_03');
  await expect(evaluation.locator('.sim-eval-kpis')).toContainText('0 / 0');
  await page.getByLabel('Hộ trong giao dịch').selectOption('');
  const priorityIndex = state.checks.findIndex(c => c.name.startsWith('Bệnh viện công'));
  await page.getByLabel('Phạm vi đánh giá').selectOption(String(priorityIndex));
  await expect(page.getByRole('img', { name: 'Yêu cầu mua và lượng được khớp', exact: true })).toContainText('Bệnh viện');
  await page.getByLabel('Đại lượng AI').selectOption('load');
  await page.getByLabel('Chỉ số sai số').selectOption('rmse_kw');
  await expect(page.getByRole('img', { name: 'Sai số tải tiêu thụ', exact: true })).toBeVisible();
  await page.getByLabel('Phạm vi đánh giá').selectOption(String(partialIndex));
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(screenshots, "simulation-desktop.png"), fullPage: true });
  await page.screenshot({ path: path.join(screenshots, "simulation-overview.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
    "390px layout has no page overflow");
  await page.screenshot({ path: path.join(screenshots, "simulation-mobile.png"), fullPage: true });
  await page.screenshot({ path: path.join(screenshots, "simulation-mobile-overview.png") });
  await evaluation.screenshot({ path: path.join(screenshots, 'simulation-evaluation-mobile.png') });
  // A saved report retains the charts after the chain is stopped and the UI reloads.
  await controller.close(); await page.reload();
  await expect(page.getByRole('status')).toHaveText('Đã hoàn tất');
  await page.getByLabel('Phạm vi đánh giá').selectOption(String(partialIndex));
  await expect(page.locator('.sim-eval-kpis')).toContainText('40%');
  // Legacy and empty reports remain readable without invented history.
  const oldSnapshot = { ...state.snapshot }; delete oldSnapshot.evaluation;
  await page.route('**/simulation/state', route => route.fulfill({ json: { ...state, snapshot: oldSnapshot,
    checks: state.checks.map(({ evidence, ...c }) => c) } }));
  await page.reload(); await expect(page.getByLabel('Phạm vi đánh giá')).toHaveValue('all');
  await expect(page.locator('.sim-evaluation')).toContainText('Đang xem báo cáo cũ');
  await expect(page.getByRole('img', { name: 'Điện cam kết và đã giao', exact: true })).toBeVisible();
  await page.unroute('**/simulation/state');
  assert.deepEqual(errors, []);
  console.log("PASS simulation UI: 22 scenarios, delivery/finance/reputation/priority/AI charts, SVG/PNG/CSV/JSON exports, filters, saved/legacy reports, desktop/mobile, HTTP checks; no JS errors.");
} catch (e) { console.error(e.stack || e); process.exitCode = 1; }
finally {
  await browser?.close(); await controller.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
}
