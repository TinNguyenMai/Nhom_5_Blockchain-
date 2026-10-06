import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { ROOT } from "./lib/files.mjs";
import { SCENARIOS } from "./market-orchestrator.mjs";
import { probeHardwareSource } from './lib/hybrid-market.mjs';
import { readJson } from './lib/files.mjs';

export function simulationServer(controller) {
  const session = randomUUID();
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
    const json = (data, status = 200) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(data)); };
    try {
      const port = server.address().port, hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      const origins = hosts.map(h => `http://${h}`);
      if (!hosts.includes(req.headers.host) || (req.headers.origin && !origins.includes(req.headers.origin))) return json({ error: "Origin/host không được phép" }, 403);
      const route = new URL(req.url, `http://${req.headers.host}`).pathname;
      if (req.method === "GET" && route === "/") { res.writeHead(302, { Location: "/simulation" }); return res.end(); }
      if (req.method === "GET" && route === "/simulation/config") return json({ session, scenarios: SCENARIOS, default_scenario: controller.defaultScenario || 'community', default_esp_source: controller.hybridSource || 'ai-live', default_homes: 12, default_seed: 20261003 });
      if (req.method === 'GET' && route === '/simulation/hardware') {
        try {
          const sourceMode = new URL(req.url, `http://${req.headers.host}`).searchParams.get('source') || controller.hybridSource || 'ai-live';
          const source = await probeHardwareSource(controller.backendUrl || 'http://127.0.0.1:8000', { ask: 2500, bid: 3000 },
            { sourceMode, modelVersion: readJson(path.join(ROOT, 'ai_model/artifacts/metadata.json')).model_version });
          return json({ ready: true, source_mode: sourceMode, message: sourceMode === 'ai-demo' ? 'Đã nhận Edge AI mô phỏng 5s từ ESP32' : sourceMode === 'ai-live' ? 'Đã nhận dự báo Edge AI từ INA219 thật 5s' : sourceMode === 'ai' ? 'Đã nhận dự báo Edge AI từ INA219 thật' : 'Đã nhận telemetry INA219 thật', timestamp: source.input.timestamp,
            received_at: source.received_at, solar_power_kw: source.input.solar_power_kw,
            load_power_kw: source.input.load_power_kw, action: source.action, quantity_wh: source.quantity_wh,
            model_version: source.ai_prediction?.model_version, predicted_solar_kw: source.ai_prediction?.predicted_solar_kw,
            predicted_load_kw: source.ai_prediction?.predicted_load_kw });
        } catch (error) { return json({ ready: false, message: error.message === 'fetch failed' ? 'Chưa kết nối backend ESP32 tại cổng 8000' : error.message }); }
      }
      if (req.method === "GET" && route === "/simulation/state") return json(controller.state);
      if (req.method === "GET" && route === "/simulation/ai-evaluation") {
        const artifacts = path.join(ROOT, 'ai_model', 'artifacts');
        const load = file => fs.existsSync(path.join(artifacts, file)) ? JSON.parse(fs.readFileSync(path.join(artifacts, file), 'utf8')) : null;
        const metrics = load('evaluation.json'), series = load('visualization.json');
        return json({ metrics, series: series?.model_version === metrics?.model_version ? series : null });
      }
      if (req.method === "GET" && route === "/simulation/report") {
        if (!controller.state.snapshot) return json({ error: "Chưa có báo cáo" }, 404);
        res.setHeader("Content-Disposition", `attachment; filename=market-${controller.state.run_id || "latest"}.json`);
        return json(controller.state.snapshot);
      }
      if (req.method === "POST" && route === "/simulation/run") {
        const supplied = Buffer.from(String(req.headers["x-solar-session"] || "")), expected = Buffer.from(session);
        if (!origins.includes(req.headers.origin) || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return json({ error: "Tải lại trang để lấy phiên mới" }, 403);
        if (!req.headers["content-type"]?.startsWith("application/json")) return json({ error: "JSON required" }, 415);
        let raw = "";
        for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 8192) return json({ error: "Request too large" }, 413); }
        const options = JSON.parse(raw);
        if (!SCENARIOS.some(s => s.id === options.scenario) || !Number.isInteger(options.homes) || options.homes < 6 || options.homes > 32 ||
            !Number.isSafeInteger(options.seed)) return json({ error: "Chọn kịch bản, 6–32 hộ và seed nguyên hợp lệ" }, 400);
        if (controller.running) return json({ error: "Lượt mô phỏng đang chạy" }, 409);
        if (options.scenario === 'hybrid' && options.homes !== 12) return json({ error: 'Cần đúng 12 hộ: 1 ESP32 + 11 hộ mô phỏng' }, 400);
        if (options.hybridSource !== undefined && !['ai-live', 'ai-demo', 'ai', 'telemetry'].includes(options.hybridSource)) return json({ error: 'Nguồn ESP32 không hợp lệ' }, 400);
        controller.run({ scenario: options.scenario, homes: options.homes, seed: options.seed, hybridSource: options.hybridSource }).catch(e => console.error(e.message));
        return json({ status: "starting" }, 202);
      }
      if (req.method !== "GET" || route.startsWith("/simulation/")) return json({ error: "Not found" }, 404);
      const dist = path.join(ROOT, "dashboard", "dist"), requested = ["/", "/simulation"].includes(route) ? "index.html" : decodeURIComponent(route).slice(1);
      const file = path.resolve(dist, requested);
      if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json({ error: "Chạy npm.cmd run dashboard:build để tạo giao diện" }, 404);
      const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
      res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" }); fs.createReadStream(file).pipe(res);
    } catch (e) { json({ error: e.message }, 400); }
  });
  server.requestTimeout = 15000;
  return server;
}
