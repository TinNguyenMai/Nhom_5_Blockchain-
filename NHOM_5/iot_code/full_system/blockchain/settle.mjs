import { acquireLock } from "./lib/files.mjs";
import { loadChain, confirmed } from "./lib/chain.mjs";
import { settleWhenDue, snapshotRound } from "./lib/market.mjs";
let chain, release;
try {
  release = acquireLock(); chain = await loadChain();
  const count = Number(await chain.market.roundCount());
  for (let i = 1; i <= count; i++) {
    const r = await chain.market.rounds(i);
    if (!r.settled) { await settleWhenDue(chain, i, r.mode === 0n); console.log(`Settled/refunded round ${i}`); }
    const block = await chain.provider.getBlock("latest");
    if (BigInt(block.timestamp) >= r.confirmationDeadline) {
      const trades = await chain.market.getTrades(i);
      for (let j = 0; j < trades.length; j++) if (trades[j].status === 0n)
        await confirmed(chain.market.connect(chain.admin).expireTrade(i, j));
      await snapshotRound(chain, i);
    }
  }
} catch (e) { console.error(e.shortMessage || e.message); process.exitCode = 1; }
finally { chain?.provider.destroy(); release?.(); }
