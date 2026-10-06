import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { ROOT } from '../../blockchain/lib/files.mjs';
import { simulationServer } from '../../blockchain/simulation-server.mjs';

const location = JSON.parse(fs.readFileSync(path.join(ROOT, 'build/hybrid-fixture-test/report-location.json')));
const report = JSON.parse(fs.readFileSync(path.join(location.directory, 'report.json')));
const controller = { defaultScenario: 'hybrid', backendUrl: 'http://127.0.0.1:1', running: false,
  state: { status: 'completed', scenario: 'hybrid', run_id: report.run_id, snapshot: report, checks: report.checks,
    hardware: report.hardware, events: [] } };
const server = simulationServer(controller);
let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'vi-VN' });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/simulation`);
  await expect(page.getByLabel('Kịch bản', { exact: true })).toHaveValue('hybrid');
  await expect(page.getByLabel('Số hộ', { exact: true })).toHaveValue('12');
  await expect(page.getByLabel('Số hộ', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Nguồn lệnh Nhà 1', { exact: true })).toHaveValue('ai-live');
  await expect(page.getByRole('region', { name: 'Kết nối ESP32' })).toContainText('Chưa kết nối backend ESP32');
  await expect(page.getByRole('button', { name: 'Chạy 1 ESP32 + 11 hộ', exact: true })).toBeEnabled();
  await expect(page.locator('.sim-home')).toHaveCount(12);
  await expect(page.locator('.sim-home').first()).toContainText('INA219 thật 5s');
  await expect(page.locator('.sim-home').first()).toContainText('Edge AI');
  await expect(page.locator('.sim-home').first()).toContainText('Đề xuất mua: 10 Wh');
  await expect(page.locator('footer')).toContainText('chưa xác minh truyền điện vật lý');
  await expect(page.getByRole('cell', { name: 'Edge AI · INA219 thật 5s', exact: true })).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Kết nối ESP32' })).toContainText('12 mẫu (~60 giây)');
  await expect(page.getByRole('img', { name: 'Tiền đang khóa theo bước', exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(ROOT, 'dashboard/test-results/hybrid-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(ROOT, 'dashboard/test-results/hybrid-mobile.png'), fullPage: true });
  await page.getByLabel('Nguồn lệnh Nhà 1', { exact: true }).selectOption('telemetry');
  await expect(page.getByRole('region', { name: 'Kết nối ESP32' })).toContainText('dùng ước lượng từ số đo gần nhất');
  await page.getByLabel('Kịch bản', { exact: true }).selectOption('community');
  await expect(page.getByLabel('Số hộ', { exact: true })).toBeEnabled();
  assert.deepEqual(errors, []);
  console.log('PASS hybrid UI: exact 12 homes, measured/virtual provenance, zero-PV buy, offline message, charts, desktop and mobile.');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
