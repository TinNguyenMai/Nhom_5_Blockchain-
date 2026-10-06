import { parseArgs } from "node:util";
import { acquireLock } from "./lib/files.mjs";
import { loadChain, loopbackUrl } from "./lib/chain.mjs";
import { api, sourceFor } from "./lib/backend.mjs";
import { delay, executeSource, settleWhenDue } from "./lib/market.mjs";

async function post(base, route, body) {
  const response = await fetch(`${base}${route}`, { method: "POST", redirect: "error",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Actuator API ${route}: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}

async function waitForActuatorAck(base, roundId, action) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const ack = (await api(base, "/health")).mqtt.last_actuator_ack;
    if (ack?.round_id === Number(roundId) && ack.action === action && ack.state === "applied") {
      const expected = action === "sell"
        ? ack.relay1_on === false && ack.relay2_on === true
        : ack.relay1_on === true && ack.relay2_on === true;
      if (!expected) throw new Error("Actuator acknowledgement has incorrect relay state");
      return ack;
    }
    await delay(250);
  }
  throw new Error(`Actuator acknowledgement timeout for round ${roundId}`);
}

const { values } = parseArgs({ options: {
  backend: { type: "string", default: "http://127.0.0.1:8000" },
  "run-id": { type: "string" },
  count: { type: "string", default: "1" },
  timeout: { type: "string", default: "180" }
} });

let chain, release;
try {
  if (values["run-id"] && !/^[0-9a-f]{32}$/.test(values["run-id"])) throw new Error("Invalid run ID");
  const count = Number(values.count), timeoutSeconds = Number(values.timeout);
  if (!Number.isInteger(count) || count < 1 || count > 6) throw new Error("--count must be 1..6");
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 1800)
    throw new Error("--timeout must be 10..1800 seconds");
  const base = loopbackUrl(values.backend);
  release = acquireLock();
  chain = await loadChain();

  // Recover interrupted local-demo rounds before accepting another hardware source.
  const total = Number(await chain.market.roundCount());
  for (let round = 1; round <= total; round++)
    if (!(await chain.market.rounds(round)).settled) await settleWhenDue(chain, round);

  console.log("HARDWARE AI DEMO: waiting for a fresh ESP32 TFLite prediction/proposal. LOCAL CREDITS ONLY.");
  const deadline = Date.now() + timeoutSeconds * 1000;
  const handled = new Set();
  let completed = 0, lastMessage = "";
  while (completed < count && Date.now() < deadline) {
    try {
      const runs = (await api(base, "/api/runs?limit=20")).items;
      const runId = values["run-id"] || runs[0]?.run_id;
      if (!runId) throw new Error("No ESP32 telemetry run is available");
      const page = await api(base, `/api/proposals?run_id=${runId}&household_id=home_01&limit=30`);
      const proposal = page.items.find(item => item.basis === "esp32_forecast" &&
        ["buy", "sell"].includes(item.action) && item.status === "proposed" &&
        item.eligible_for_review === true && !handled.has(item.id) &&
        Date.now() - Date.parse(item.created_at) <= 30_000);
      if (!proposal)
        throw new Error(`Run ${runId} has no fresh actionable ESP32 AI proposal; wait for 12 telemetry samples`);
      const source = await sourceFor(base, runId, proposal, "live");
      if (source.data.input.data_mode !== "simulation")
        throw new Error("Hardware demo only accepts AI predictions linked to simulation telemetry");
      if (await chain.market.roundByKey(source.roundKey) > 0n) {
        handled.add(proposal.id);
        continue;
      }
      const report = await executeSource(chain, source,
        { mode: "live", counterparty: true, biddingSeconds: 8 });
      handled.add(proposal.id);
      if (!report.source_hash_verified || report.settlement?.status !== 1 || report.trades.length === 0)
        throw new Error("Actuator blocked: settlement/source verification failed");
      await post(base, "/api/demo/actuator", {
        deployment_id: report.deployment_id,
        transaction_hash: report.settlement.transaction_hash,
        round_id: Number(report.round_id), action: proposal.action,
        source_hash_verified: report.source_hash_verified,
        settlement_status: report.settlement.status, duration_seconds: 15
      });
      const ack = await waitForActuatorAck(base, report.round_id, proposal.action);
      completed++;
      console.log(`HARDWARE AI CONFIRMED ${completed}/${count}: action=${proposal.action} ` +
        `model=${proposal.model_version} proposal=${proposal.id.slice(0, 12)} ` +
        `round=${report.round_id} trades=${report.trades.length} source_hash_ok=${report.source_hash_verified} ` +
        `relay1=${ack.relay1_on ? "ON" : "OFF"} relay2=${ack.relay2_on ? "ON" : "OFF"}`);
      lastMessage = "";
    } catch (error) {
      const message = error.shortMessage || error.message;
      if (message.startsWith("Actuator") || message.includes("actuator")) throw error;
      if (message !== lastMessage) console.log(`HARDWARE WAIT: ${message}`);
      lastMessage = message;
    }
    if (completed < count) await delay(1000);
  }
  if (completed < count) throw new Error(`Timed out after ${timeoutSeconds}s (${completed}/${count} rounds confirmed)`);
  console.log("DONE. Run npm run market:report to verify receipts and token balances.");
} catch (error) {
  console.error(`HARDWARE DEMO ERROR: ${error.shortMessage || error.message}`);
  process.exitCode = 1;
} finally {
  chain?.provider.destroy();
  release?.();
}
