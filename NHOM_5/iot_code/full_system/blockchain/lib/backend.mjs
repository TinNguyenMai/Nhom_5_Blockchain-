import { id } from "ethers";
import { canonical } from "./files.mjs";
import { loopbackUrl } from "./chain.mjs";

export async function api(base, route) {
  const response = await fetch(`${loopbackUrl(base)}${route}`, { signal: AbortSignal.timeout(8000), redirect: "error" });
  if (!response.ok) throw new Error(`Backend ${route}: HTTP ${response.status}`);
  return response.json();
}
export async function allRecords(base, kind, runId) {
  const items = [];
  for (let offset = 0; offset < 10_000; offset += 500) {
    const page = await api(base, `/api/${kind}?run_id=${runId}&household_id=home_01&limit=500&offset=${offset}`);
    items.push(...page.items);
    if (items.length >= page.total) return items;
    if (!page.items.length) throw new Error("Backend pagination ended unexpectedly");
  }
  throw new Error("Run is too large for this demo (max 10,000 household records)");
}
export function kwhToWh(value) {
  // Phase 2 quantities have <=6 decimal places. Floor, never round energy up.
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1_000_000)
    throw new Error("Invalid energy quantity");
  const str = String(value);
  if (!/^\d+(\.\d{1,6})?$/.test(str)) throw new Error("Energy must use at most 6 decimal places");
  const [whole, fraction = ""] = str.split(".");
  const wh = BigInt(whole) * 1000n + BigInt((fraction + "000").slice(0, 3));
  if (wh === 0n) throw new Error("Energy is below on-chain resolution of 1 Wh");
  return wh;
}
export function makeSource(proposal, prediction, reading, mode) {
  if (!["replay", "live"].includes(mode)) throw new Error("Invalid source mode");
  if (!proposal || !prediction || !reading) throw new Error("Missing linked forecast or input telemetry");
  if (!/^[a-f0-9]{64}$/.test(proposal.id) || !/^[a-f0-9]{32}$/.test(proposal.run_id) ||
      proposal.household_id !== "home_01" || prediction.household_id !== "home_01" || reading.household_id !== "home_01" ||
      proposal.basis !== "esp32_forecast" || !["buy", "sell"].includes(proposal.action) || prediction.late !== false ||
      prediction.id !== proposal.id || prediction.run_id !== proposal.run_id || reading.run_id !== proposal.run_id ||
      prediction.input_event_id !== proposal.input_event_id || reading.event_id !== proposal.input_event_id ||
      reading.timestamp !== prediction.input_timestamp || prediction.target_timestamp !== proposal.target_timestamp ||
      prediction.device_kind !== "esp32" || proposal.device_id !== prediction.device_id ||
      proposal.model_version !== prediction.model_version || prediction.interval_seconds !== 300 ||
      !Number.isFinite(Date.parse(prediction.input_timestamp)) ||
      Date.parse(prediction.target_timestamp) - Date.parse(prediction.input_timestamp) !== 300_000)
    throw new Error("Forecast/proposal/input linkage is invalid or late");
  if (mode === "live" && (proposal.status !== "proposed" || proposal.eligible_for_review !== true))
    throw new Error("Live bridge refuses a stale/observed/stopped/non-eligible proposal");
  const quantityWh = kwhToWh(proposal.quantity_kwh);
  const sourceId = id(`solar-proposal-v1:${proposal.id}`);
  // Same key in replay/live: a proposal cannot become a second round under a new mode.
  const roundKey = id(`solar-round-v1:${proposal.id}`);
  const data = { schema_version: 1, basis: "esp32_forecast", mode,
    proposal: { id: proposal.id, run_id: proposal.run_id, household_id: proposal.household_id,
      action: proposal.action, quantity_kwh: proposal.quantity_kwh, quantity_wh: quantityWh.toString(),
      policy_version: proposal.policy_version, sell_reserve: proposal.sell_reserve, minimum_kwh: proposal.minimum_kwh },
    prediction: { ...prediction }, input: { ...reading } };
  return { sourceId, roundKey, dataHash: id(canonical(data)), data, quantityWh,
    side: proposal.action === "buy" ? 1 : 0, basis: 0, proposalId: proposal.id };
}

export function makeDemoTelemetrySource(reading) {
  if (!reading || reading.household_id !== "home_01" || reading.data_mode !== "simulation" ||
      !["sell", "buy", "hold"].includes(reading.demo_scenario) ||
      !/^[a-f0-9]{32}$/.test(reading.run_id || "") ||
      typeof reading.event_id !== "string" || !reading.event_id.startsWith(`${reading.run_id}:home_01:`) ||
      reading.interval_seconds !== 300 || !Number.isFinite(Date.parse(reading.timestamp)))
    throw new Error("Invalid ESP32 demo telemetry");
  const netKwh = Number(reading.solar_energy_kwh) - Number(reading.load_energy_kwh);
  if (!Number.isFinite(netKwh) || Math.abs(netKwh) < 0.001 || reading.demo_scenario === "hold")
    throw new Error("Demo telemetry is a HOLD case; no market order is created");
  const action = netKwh > 0 ? "sell" : "buy";
  if (action !== reading.demo_scenario) throw new Error("Demo scenario conflicts with measured energy");
  const quantityKwh = Number((action === "sell" ? netKwh * 0.8 : -netKwh).toFixed(6));
  const quantityWh = kwhToWh(quantityKwh);
  const proposalId = id(`esp32-demo-proposal-v1:${reading.event_id}`).slice(2);
  const sourceId = id(`esp32-demo-source-v1:${reading.event_id}`);
  const roundKey = id(`esp32-demo-round-v1:${reading.event_id}`);
  const data = { schema_version: 1, basis: "esp32_demo_telemetry", mode: "live",
    proposal: { id: proposalId, run_id: reading.run_id, household_id: reading.household_id,
      action, quantity_kwh: quantityKwh, quantity_wh: quantityWh.toString(),
      policy_version: "hardware-demo-net-v1", sell_reserve: 0.2, minimum_kwh: 0.001 },
    input: { ...reading } };
  return { sourceId, roundKey, dataHash: id(canonical(data)), data, quantityWh,
    side: action === "buy" ? 1 : 0, basis: 1, proposalId };
}
export async function sourceFor(base, runId, proposal, mode) {
  const [predictions, readings] = await Promise.all([allRecords(base, "predictions", runId), allRecords(base, "telemetry", runId)]);
  return makeSource(proposal, predictions.find(p => p.id === proposal.id),
    readings.find(r => r.event_id === proposal.input_event_id), mode);
}
export async function selectReplay(base, requestedRun, count) {
  const runs = (await api(base, "/api/runs")).items;
  const runId = requestedRun || runs[0]?.run_id;
  if (!/^[0-9a-f]{32}$/.test(runId || "")) throw new Error("No run found; run Phase 2 first");
  const [proposals, predictions, readings] = await Promise.all([
    allRecords(base, "proposals", runId), allRecords(base, "predictions", runId), allRecords(base, "telemetry", runId)]);
  const pred = new Map(predictions.map(p => [p.id, p])), input = new Map(readings.map(p => [p.event_id, p]));
  const sources = [];
  // Stable chronological selection makes reruns idempotent rather than selecting new trades.
  for (const p of proposals.sort((a, b) => a.target_timestamp.localeCompare(b.target_timestamp))) {
    if (p.action === "hold") continue;
    try { sources.push(makeSource(p, pred.get(p.id), input.get(p.input_event_id), "replay")); }
    catch (e) { console.log(`SKIP ${p.id}: ${e.message}`); }
    if (sources.length === count) break;
  }
  if (!sources.length) throw new Error("No linked non-hold, non-late ESP32 proposals in selected run");
  return { runId, sources };
}
