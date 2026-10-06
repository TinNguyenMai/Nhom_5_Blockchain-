import { test } from "node:test";
import assert from "node:assert/strict";
import { id } from "ethers";
import { kwhToWh, makeSource, makeDemoTelemetrySource } from "../lib/backend.mjs";
import { canonical } from "../lib/files.mjs";
import { loopbackUrl } from "../lib/chain.mjs";

export function fixture() {
  const run = "a".repeat(32), pid = "b".repeat(64), event = `${run}:home_01:11`;
  const reading = { household_id: "home_01", run_id: run, timestamp: "2026-10-01T10:55:00+07:00", event_id: event };
  const p = { id: pid, household_id: "home_01", run_id: run, input_event_id: event, basis: "esp32_forecast",
    device_id: "esp32-000000000001", model_version: "test-fixture", target_timestamp: "2026-10-01T11:00:00+07:00",
    action: "sell", quantity_kwh: .133333, status: "proposed", eligible_for_review: true };
  const prediction = { ...p, device_kind: "esp32", input_timestamp: reading.timestamp, interval_seconds: 300, late: false };
  return { p, prediction, reading };
}
test("energy conversion floors without binary float rounding or overselling", () => {
  assert.equal(kwhToWh(.133333), 133n); assert.equal(kwhToWh(.029), 29n);
  assert.equal(kwhToWh(.001), 1n); assert.equal(kwhToWh(1.999999), 1999n);
  for (const v of [NaN, Infinity, -1, 0, .000999, 1.2345678]) assert.throws(() => kwhToWh(v));
});
test("hashes are deterministic and any altered evidence changes the hash", () => {
  const { p, prediction, reading } = fixture();
  const s = makeSource(p, prediction, reading, "live");
  assert.equal(s.dataHash, id(canonical(s.data)));
  assert.notEqual(s.dataHash, makeSource({ ...p, quantity_kwh: .14 }, prediction, reading, "live").dataHash);
  assert.equal(s.roundKey, makeSource(p, prediction, reading, "replay").roundKey);
});
test("live refuses expired/hold/late sources and unrelated readings", () => {
  const { p, prediction, reading } = fixture();
  for (const status of ["late", "stopped", "observed", "archived", "stale", "disconnected"])
    assert.throws(() => makeSource({ ...p, status }, prediction, reading, "live"));
  assert.throws(() => makeSource({ ...p, action: "hold" }, prediction, reading, "replay"));
  assert.throws(() => makeSource(p, { ...prediction, late: true }, reading, "replay"));
  assert.throws(() => makeSource(p, prediction, { ...reading, household_id: "home_02" }, "replay"));
  assert.throws(() => makeSource(p, { ...prediction, interval_seconds: 5 }, reading, "replay"));
});
test("hardware demo source is explicit, linked, and uses demo basis", () => {
  const run = "a".repeat(32);
  const reading = { schema_version: 1, household_id: "home_01", run_id: run,
    event_id: `${run}:home_01:12`, timestamp: "2026-10-01T11:00:00+07:00",
    interval_seconds: 300, data_mode: "simulation", demo_scenario: "sell",
    solar_energy_kwh: 0.25, load_energy_kwh: 0.05 };
  const source = makeDemoTelemetrySource(reading);
  assert.equal(source.basis, 1);
  assert.equal(source.side, 0);
  assert.equal(source.quantityWh, 160n);
  assert.equal(source.data.basis, "esp32_demo_telemetry");
  assert.equal(source.data.input.event_id, reading.event_id);
  assert.throws(() => makeDemoTelemetrySource({ ...reading, demo_scenario: "hold" }));
});
test("replay deliberately accepts valid observed history while retaining replay label", () => {
  const { p, prediction, reading } = fixture();
  assert.equal(makeSource({ ...p, status: "observed", eligible_for_review: false }, prediction, reading, "replay").data.mode, "replay");
});
test("network guard refuses remote RPC/backend and credential-bearing URLs", () => {
  assert.equal(loopbackUrl("http://127.0.0.1:8545"), "http://127.0.0.1:8545");
  for (const u of ["https://mainnet.example", "http://192.168.1.17:8545", "http://user:pass@localhost:8545", "http://127.0.0.1:8545/path"])
    assert.throws(() => loopbackUrl(u));
});
