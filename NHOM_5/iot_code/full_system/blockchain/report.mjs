import { loadChain } from "./lib/chain.mjs";
import { snapshotRound } from "./lib/market.mjs";
let chain;
try {
  chain = await loadChain();
  const count = Number(await chain.market.roundCount());
  let trades = 0, pending = 0, pendingDelivery = 0;
  for (let i = 1; i <= count; i++) {
    const r = await snapshotRound(chain, i);
    if (r.orders.some(o => o.basis === "esp32_forecast") && !r.source_hash_verified)
      throw new Error(`Round ${i}: saved forecast evidence is missing or its hash does not match the chain`);
    trades += r.trades.length; if (!r.settled) pending++;
    pendingDelivery += r.pending_trade_count;
    console.log(`ROUND ${i} | ${r.mode} | matched=${r.settled} | orders=${r.orders.length} | trades=${r.trades.length} | pending_delivery=${r.pending_trade_count} | source_hash_ok=${r.source_hash_verified}`);
    if (r.settlement) console.log(`  tx=${r.settlement.transaction_hash} block=${r.settlement.block_number} status=${r.settlement.status}`);
    for (const t of r.trades) console.log(`  ${t.quantity_wh} Wh | ${t.status} | paid=${t.paid_micro_slc} micro-SLC | ${t.seller} -> ${t.buyer}`);
    if (i === count) console.table(r.balances);
  }
  console.log(`TOTAL rounds=${count} trades=${trades} pending_rounds=${pending} pending_delivery=${pendingDelivery}`);
  console.log(`Market escrow: ${await chain.token.balanceOf(chain.manifest.market)} micro-SLC`);
  console.log("Verified against the current local chain. Reports: data/phase3/reports/<deployment_id>/");
} catch (e) { console.error(`REPORT ERROR: ${e.shortMessage || e.message}`); process.exitCode = 1; }
finally { chain?.provider.destroy(); }
