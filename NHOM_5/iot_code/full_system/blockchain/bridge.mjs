import { parseArgs } from "node:util";
import { acquireLock } from "./lib/files.mjs";
import { loadChain, loopbackUrl } from "./lib/chain.mjs";
import { api, selectReplay, sourceFor } from "./lib/backend.mjs";
import { delay, executeSource, settleWhenDue } from "./lib/market.mjs";

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  backend: { type: "string", default: "http://127.0.0.1:8000" }, "run-id": { type: "string" },
  count: { type: "string", default: "3" }, "demo-counterparty": { type: "boolean", default: false }
} });
const mode = positionals[0];
let chain, release;
try {
  if (!["replay", "live"].includes(mode)) throw new Error("Use replay or live");
  if (values["run-id"] && !/^[0-9a-f]{32}$/.test(values["run-id"])) throw new Error("Invalid run ID");
  const count = Number(values.count);
  if (!Number.isInteger(count) || count < 1 || count > 30) throw new Error("--count must be 1..30");
  const base = loopbackUrl(values.backend);
  release = acquireLock(); chain = await loadChain();
  if (mode === "replay") {
    const selection = await selectReplay(base, values["run-id"], count);
    console.log(`REPLAY run=${selection.runId}. Historical forecasts; demo counterparties home_02/home_03. LOCAL CREDITS ONLY.`);
    for (const source of selection.sources) await executeSource(chain, source);
    console.log("DONE. Run npm run market:report to verify receipts and balances.");
  } else {
    // Recover open rounds from a previously interrupted invocation before accepting new sources.
    const total = Number(await chain.market.roundCount());
    for (let r = 1; r <= total; r++) if (!(await chain.market.rounds(r)).settled) await settleWhenDue(chain, r);
    console.log(`LIVE: waiting for fresh proposals. Demo counterparties: ${values["demo-counterparty"]}. Ctrl+C to stop.`);
    const done = new Set(); let lastError = "";
    while (true) {
      try {
        const ready = await api(base, "/ready");
        if (!ready.ready) throw new Error("Backend not ready");
        const runs = (await api(base, "/api/runs")).items;
        const runId = values["run-id"] || runs[0]?.run_id;
        if (!runId) { await delay(1000); continue; }
        const page = await api(base, `/api/proposals?run_id=${runId}&household_id=home_01&limit=10`);
        const proposal = page.items.find(p => p.status === "proposed" && p.eligible_for_review && !done.has(p.id));
        if (proposal) {
          const source = await sourceFor(base, runId, proposal, "live");
          const revalidate = async () => {
            const r = await api(base, "/ready");
            const fresh = await api(base, `/api/proposals?run_id=${runId}&household_id=home_01&limit=10`);
            if (!r.ready || !fresh.items.some(p => p.id === proposal.id && p.status === "proposed" && p.eligible_for_review))
              throw new Error("Proposal expired before order submission; round will be refunded by market:settle");
          };
          await executeSource(chain, source, { mode, counterparty: values["demo-counterparty"], biddingSeconds: 8, revalidate });
          done.add(proposal.id);
        }
        lastError = "";
      } catch (e) {
        const message = e.shortMessage || e.message;
        if (message !== lastError) console.error(`LIVE WAIT: ${message}`);
        lastError = message;
      }
      await delay(1000);
    }
  }
} catch (e) { console.error(`BRIDGE ERROR: ${e.shortMessage || e.message}`); process.exitCode = 1; }
finally { chain?.provider.destroy(); release?.(); }
