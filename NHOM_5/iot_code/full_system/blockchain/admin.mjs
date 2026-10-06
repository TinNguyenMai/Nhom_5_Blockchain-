import { parseArgs } from "node:util";
import { id } from "ethers";
import { acquireLock, canonical, readJson, writeJson, reportDir } from "./lib/files.mjs";
import { loadChain, confirmed } from "./lib/chain.mjs";
import { snapshotRound } from "./lib/market.mjs";
import path from "node:path";

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  round: { type: "string" }, trade: { type: "string" }, evidence: { type: "string" },
  home: { type: "string" }, category: { type: "string" }
} });
const integer = (value, name, min = 0n) => {
  if (!/^(0|[1-9][0-9]*)$/.test(value ?? "") || BigInt(value) < min)
    throw new Error(`${name} must be an integer >= ${min}`);
  return BigInt(value);
};
let chain, release;
try {
  const action = positionals[0];
  if (positionals.length !== 1 || !["confirm", "expire", "priority"].includes(action))
    throw new Error("Use confirm, expire or priority; see SMART_CONTRACT_FEATURES.md");
  release = acquireLock(); chain = await loadChain();
  const market = chain.market.connect(chain.admin);
  if (action === "priority") {
    const trader = chain.manifest.households[values.home];
    const categories = { ordinary: 0, hospital: 1, kindergarten: 2, special: 3 };
    if (!trader || categories[values.category] === undefined || !values.evidence)
      throw new Error("priority requires --home, --category and --evidence verification.json");
    const evidence = readJson(values.evidence);
    if (evidence.deployment_id !== chain.manifest.deployment_id || evidence.trader?.toLowerCase() !== trader.toLowerCase() ||
        evidence.category !== values.category || !evidence.verification)
      throw new Error("Verification must identify this deployment, trader, category and verification details");
    const hash = id(canonical(evidence));
    writeJson(path.join(reportDir(chain.manifest.deployment_id), `priority-${hash}.json`), evidence);
    const receipt = await confirmed(market.setBuyerCategory(trader, categories[values.category], hash));
    console.log(`Priority verified: ${values.home} ${values.category}; tx=${receipt.hash}`);
  } else {
    const round = integer(values.round, "--round", 1n), trade = integer(values.trade, "--trade");
    let receipt;
    if (action === "confirm") {
      if (!values.evidence) throw new Error("confirm requires --evidence delivery.json; forecasts are not delivery evidence");
      const evidence = readJson(values.evidence);
      if (evidence.deployment_id !== chain.manifest.deployment_id || String(evidence.round_id) !== String(round) ||
          String(evidence.trade_index) !== String(trade) || !evidence.measurement)
        throw new Error("Delivery evidence must identify this deployment, round, trade and measurement details");
      const delivered = integer(String(evidence.delivered_wh), "delivered_wh");
      const hash = id(canonical(evidence));
      // Keep the exact attested document available for independently checking its hash.
      writeJson(path.join(reportDir(chain.manifest.deployment_id), `delivery-${hash}.json`), evidence);
      receipt = await confirmed(market.confirmTrade(round, trade, delivered, hash));
    } else receipt = await confirmed(market.expireTrade(round, trade));
    const report = await snapshotRound(chain, round);
    console.log(`${action}: round=${round} trade=${trade} pending=${report.pending_trade_count}; tx=${receipt.hash}`);
  }
} catch (e) { console.error(e.shortMessage || e.message); process.exitCode = 1; }
finally { chain?.provider.destroy(); release?.(); }
