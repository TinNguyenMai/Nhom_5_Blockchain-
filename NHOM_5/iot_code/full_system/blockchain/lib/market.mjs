import fs from "node:fs";
import path from "node:path";
import { id, formatUnits } from "ethers";
import { canonical, readJson, writeJson, reportDir, sourceFile } from "./files.mjs";
import { approveExact, confirmed } from "./chain.mjs";

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function snapshotRound(chain, roundId, { persist = true } = {}) {
  const { market, provider, manifest } = chain;
  const round = await market.rounds(roundId);
  const orders = await market.getOrders(roundId), trades = await market.getTrades(roundId);
  const events = await market.queryFilter(market.filters.RoundSettled(roundId), manifest.deployment_block);
  const event = events.at(-1);
  const receipt = event ? await provider.getTransactionReceipt(event.transactionHash) : null;
  if (round.settled && (!receipt || receipt.status !== 1 || receipt.blockHash !== event.blockHash))
    throw new Error("Settlement receipt cannot be verified on the current chain");
  const balances = {};
  for (const [home, address] of Object.entries(manifest.households)) balances[home] = {
    address, balance_micro_slc: (await chain.token.balanceOf(address)).toString(),
    balance_slc: formatUnits(await chain.token.balanceOf(address), 6),
    reputation_score: Number((await market.reputations(address)).score),
    active_quantity_wh: (await market.activeQuantityWh(address)).toString(),
    quantity_limit_wh: (await market.quantityLimitWh(address)).toString(),
    collateral_bps: Number(await market.collateralBps(address)),
    buyer_category: Number(await market.buyerCategories(address))
  };
  const file = sourceFile(manifest.deployment_id, round.key);
  const storedSource = fs.existsSync(file) ? readJson(file) : null;
  const expectedSourceBasis = storedSource?.data?.basis === "esp32_demo_telemetry" ? 1n : 0n;
  const sourceValid = storedSource ? orders.some(o => o.sourceId === storedSource.sourceId &&
    o.dataHash === id(canonical(storedSource.data)) && o.basis === expectedSourceBasis &&
    o.trader.toLowerCase() === manifest.households.home_01.toLowerCase()) : false;
  const report = { schema_version: 1, deployment_id: manifest.deployment_id,
    chain_id: 31337, market: manifest.market, token: manifest.token,
    verified_at: new Date().toISOString(), round_id: String(roundId), round_key: round.key,
    mode: round.mode === 0n ? "replay" : "live", closes_at: Number(round.closesAt), settled: round.settled,
    confirmation_deadline: Number(round.confirmationDeadline),
    pending_trade_count: trades.filter(t => t.status === 0n).length,
    run_id: storedSource?.data.proposal.run_id ?? null, proposal_id: storedSource?.data.proposal.id ?? null,
    source_hash_verified: sourceValid,
    orders: orders.map((o, index) => ({ index, trader: o.trader, action: o.side === 0n ? "sell" : "buy",
      basis: o.basis === 0n ? "esp32_forecast" : o.basis === 2n ? "simulated_forecast" :
        (o.trader.toLowerCase() === manifest.households.home_01.toLowerCase() &&
         storedSource?.data?.basis === "esp32_demo_telemetry" ? "esp32_demo_telemetry" : "demo_counterparty"),
      quantity_wh: o.quantityWh.toString(),
      remaining_wh: o.remainingWh.toString(), price_micro_slc_per_wh: o.price.toString(),
      locked_micro_slc: o.locked.toString(), collateral_micro_slc: o.collateral.toString(),
      buyer_category: Number(o.buyerCategory), cancelled: o.cancelled, source_id: o.sourceId, data_hash: o.dataHash })),
    trades: trades.map((t, index) => ({ index, buyer: orders[Number(t.buyIndex)].trader, seller: orders[Number(t.sellIndex)].trader,
      quantity_wh: t.quantityWh.toString(), price_micro_slc_per_wh: t.price.toString(), cost_micro_slc: t.cost.toString(),
      cost_slc: formatUnits(t.cost, 6), status: ["pending", "confirmed", "expired"][Number(t.status)],
      delivered_wh: t.deliveredWh.toString(), evidence_hash: t.evidenceHash,
      paid_micro_slc: (BigInt(t.deliveredWh) * t.price).toString(),
      buyer_collateral_micro_slc: t.buyerCollateral.toString(), seller_collateral_micro_slc: t.sellerCollateral.toString(),
      escrow_micro_slc: (t.status === 0n ? t.cost + t.buyerCollateral + t.sellerCollateral : 0n).toString() })),
    settlement: receipt ? { transaction_hash: receipt.hash, block_number: receipt.blockNumber,
      block_hash: receipt.blockHash, gas_used: receipt.gasUsed.toString(), status: receipt.status } : null,
    balances, market_balance_micro_slc: (await chain.token.balanceOf(manifest.market)).toString(),
    energy_delivery_verified: false, token_purpose: "local_demo_only" };
  if (persist) writeJson(path.join(reportDir(manifest.deployment_id), `${roundId}.json`), report);
  return report;
}
export async function approveOrder(chain, signer, side, quantity, price) {
  const [payment, collateral] = await chain.market.quoteOrder(await signer.getAddress(), side, quantity, price);
  if (payment + collateral > 0n) await approveExact(chain, signer, payment + collateral);
}
export async function settleWhenDue(chain, roundId, advanceTime = false) {
  let round = await chain.market.rounds(roundId);
  if (!round.settled) {
    let block = await chain.provider.getBlock("latest");
    if (advanceTime && BigInt(block.timestamp) < round.closesAt) {
      // Only replay/tests on the guarded local Hardhat chain may accelerate block time.
      await chain.provider.send("evm_setNextBlockTimestamp", [Number(round.closesAt)]);
      await chain.provider.send("evm_mine", []);
    } else {
      // Wait relative to chain time. A prior replay may have advanced the local
      // chain clock; comparing closesAt directly to the PC clock would hang.
      const remaining = Math.max(0, Number(round.closesAt) - block.timestamp);
      if (remaining > 0) await delay(remaining * 1000 + 150);
    }
    await confirmed(chain.market.connect(chain.admin).settle(roundId));
  }
  return snapshotRound(chain, roundId);
}
export async function executeSource(chain, source, { mode = "replay", counterparty = true, biddingSeconds = 30, revalidate } = {}) {
  const { market, manifest, homes } = chain;
  let roundId = await market.roundByKey(source.roundKey);
  const sourcePath = sourceFile(manifest.deployment_id, source.roundKey);
  if (roundId > 0n) {
    const r = await market.rounds(roundId);
    console.log(`REUSE round=${roundId}: no duplicate order will be submitted.`);
    // An interrupted round is settled/refunded, never silently filled with new orders.
    return settleWhenDue(chain, roundId, r.mode === 0n);
  }
  if (mode === "live" && revalidate) await revalidate();
  writeJson(sourcePath, source); // Evidence is durable before sending any order.
  await confirmed(market.connect(chain.admin).openRound(source.roundKey, biddingSeconds, mode === "replay" ? 0 : 1));
  roundId = await market.roundByKey(source.roundKey);
  const price = source.side === 0 ? 2000n : 3000n; // 2 SLC/kWh ask, 3 SLC/kWh bid.
  await approveOrder(chain, homes[0], source.side, source.quantityWh, price);
  // Check freshness again immediately before placing the forecast order.
  if (mode === "live" && revalidate) await revalidate();
  await confirmed(market.connect(homes[0]).placeOrder(roundId, source.side, source.quantityWh, price,
    source.basis ?? 0, source.sourceId, source.dataHash));
  if (counterparty) {
    const quantities = [source.quantityWh / 2n, source.quantityWh - source.quantityWh / 2n];
    for (let i = 0; i < 2; i++) {
      if (quantities[i] === 0n) continue;
      const otherSide = source.side === 0 ? 1 : 0;
      const otherPrice = otherSide === 1 ? [3000n, 2500n][i] : [2000n, 2500n][i];
      const counter = { schema_version: 1, basis: "demo_counterparty", household_id: `home_0${i + 2}`,
        round_key: source.roundKey, quantity_wh: quantities[i].toString(),
        side: otherSide, price_micro_slc_per_wh: otherPrice.toString(),
        note: "Scripted liquidity for local demo; not an AI forecast or a sensor measurement." };
      await approveOrder(chain, homes[i + 1], otherSide, quantities[i], otherPrice);
      await confirmed(market.connect(homes[i + 1]).placeOrder(roundId, otherSide, quantities[i], otherPrice,
        1, id(`demo-counterparty:${source.roundKey}:${i}`), id(canonical(counter))));
      writeJson(sourceFile(manifest.deployment_id, `${source.roundKey}-home_0${i + 2}`), counter);
    }
  }
  const report = await settleWhenDue(chain, roundId, mode === "replay");
  console.log(`MATCHED round=${roundId} mode=${mode} orders=${report.orders.length} trades=${report.trades.length} pending_delivery=${report.pending_trade_count} tx=${report.settlement.transaction_hash}`);
  return report;
}
