import { test, after } from "node:test";
import assert from "node:assert/strict";
import { id, ZeroHash, ContractFactory, Interface } from "ethers";
import { artifact } from "../lib/files.mjs";
import { localProvider, deployContracts, confirmed, approveExact } from "../lib/chain.mjs";

const provider = await localProvider();
after(() => provider.destroy());
let seq = 0;
const key = () => id(`contract-test-${++seq}`);
async function setup() { return deployContracts(provider); }
async function open(c, seconds = 100) {
  const k = key(); await confirmed(c.market.openRound(k, seconds, 0)); return c.market.roundByKey(k);
}
async function order(c, r, home, side, q, p, source = key()) {
  const [payment, collateral] = await c.market.quoteOrder(await c.homes[home].getAddress(), side, q, p);
  if (payment + collateral > 0n) await approveExact(c, c.homes[home], payment + collateral);
  return confirmed(c.market.connect(c.homes[home]).placeOrder(r, side, q, p, 0, source, key()));
}
async function close(c, r, confirm = true) {
  const round = await c.market.rounds(r), block = await provider.getBlock("latest");
  if (BigInt(block.timestamp) < round.closesAt) {
    await provider.send("evm_setNextBlockTimestamp", [Number(round.closesAt)]);
    await provider.send("evm_mine", []);
  }
  await confirmed(c.market.connect(c.homes[2]).settle(r));
  if (confirm) {
    const trades = await c.market.getTrades(r);
    for (let i = 0; i < trades.length; i++)
      await confirmed(c.market.confirmTrade(r, i, trades[i].quantityWh, key()));
  }
}
function revertData(e) {
  const d = e.data || e.info?.error?.data;
  return typeof d === "string" ? d : d?.data;
}
async function rejects(promise, name, abi = artifact("EnergyMarket").abi) {
  const iface = new Interface(abi);
  await assert.rejects(promise, e => {
    const data = revertData(e);
    try { assert.equal(iface.parseError(data).name, name); return true; }
    catch { assert.fail(`Expected ${name}; got ${e.shortMessage || e.message} data=${data}`); }
  });
}

test("token has six decimals and fixed supply; participants start with 1000 SLC", async () => {
  const c = await setup();
  assert.equal(await c.token.decimals(), 6n);
  assert.equal(await c.token.totalSupply(), 1_000_000n * 1_000_000n);
  assert.equal(await c.token.balanceOf(await c.homes[0].getAddress()), 1_000_000_000n);
});
test("escrow is funded; two trades pay sellers at ask and refund buyer price improvement", async () => {
  const c = await setup(), r = await open(c);
  await order(c, r, 0, 0, 100, 2000);
  await order(c, r, 1, 1, 60, 3000);
  await order(c, r, 2, 1, 40, 2500);
  assert.equal(await c.token.balanceOf(c.manifest.market), 280000n);
  await close(c, r);
  assert.equal((await c.market.getTrades(r)).length, 2);
  assert.equal(await c.token.balanceOf(c.manifest.households.home_01), 1_000_200_000n);
  assert.equal(await c.token.balanceOf(c.manifest.households.home_02), 999_880_000n);
  assert.equal(await c.token.balanceOf(c.manifest.households.home_03), 999_920_000n);
  assert.equal(await c.token.balanceOf(c.manifest.market), 0n);
  assert.ok((await c.market.getOrders(r)).every(o => o.locked === 0n && o.remainingWh === 0n));
});
test("lowest ask first; equal ask uses earliest order; partial fills leave unmatched energy", async () => {
  const c = await setup(), r = await open(c);
  await order(c, r, 0, 1, 60, 3000);
  await order(c, r, 1, 0, 50, 2000);
  await order(c, r, 2, 0, 50, 2000);
  await close(c, r);
  const trades = await c.market.getTrades(r);
  assert.equal(trades[0].sellIndex, 1n); assert.equal(trades[0].quantityWh, 50n);
  assert.equal(trades[1].sellIndex, 2n); assert.equal(trades[1].quantityWh, 10n);
  assert.equal((await c.market.getOrders(r))[2].remainingWh, 40n);
  assert.equal(await c.token.balanceOf(c.manifest.market), 0n);
});
test("highest bid wins scarce supply even if that bid arrives later", async () => {
  const c = await setup(), r = await open(c);
  await order(c, r, 0, 0, 60, 2000);
  await order(c, r, 1, 1, 60, 2500);
  await order(c, r, 2, 1, 60, 3000);
  await close(c, r);
  const trades = await c.market.getTrades(r);
  assert.equal(trades.length, 1); assert.equal(trades[0].buyIndex, 2n);
  assert.equal(await c.token.balanceOf(c.manifest.households.home_02), 1_000_000_000n);
});
test("noncrossing prices produce no trades and full buyer refund", async () => {
  const c = await setup(), r = await open(c);
  await order(c, r, 0, 0, 100, 3000); await order(c, r, 1, 1, 100, 2000);
  await close(c, r);
  assert.equal((await c.market.getTrades(r)).length, 0);
  assert.equal(await c.token.balanceOf(c.manifest.households.home_02), 1_000_000_000n);
  assert.equal(await c.token.balanceOf(c.manifest.market), 0n);
});
test("owner can cancel before deadline, refund is exact and cannot be withdrawn twice", async () => {
  const c = await setup(), r = await open(c);
  await order(c, r, 0, 1, 101, 2345);
  await rejects(c.market.connect(c.homes[1]).cancelOrder.staticCall(r, 0), "Unauthorized");
  await confirmed(c.market.connect(c.homes[0]).cancelOrder(r, 0));
  assert.equal(await c.token.balanceOf(c.manifest.households.home_01), 1_000_000_000n);
  await rejects(c.market.connect(c.homes[0]).cancelOrder.staticCall(r, 0), "Duplicate");
  await close(c, r); assert.equal((await c.market.getTrades(r)).length, 0);
});
test("only coordinator opens rounds; unregistered wallets cannot place an order", async () => {
  const c = await setup();
  await rejects(c.market.connect(c.homes[0]).openRound.staticCall(key(), 30, 0), "Unauthorized");
  const r = await open(c);
  await rejects(c.market.placeOrder.staticCall(r, 0, 1, 1, 0, key(), key()), "Unauthorized");
});
test("deadline enforced, early settlement forbidden, permissionless settlement cannot repeat", async () => {
  const c = await setup(), r = await open(c);
  await rejects(c.market.settle.staticCall(r), "TooEarly");
  await close(c, r);
  await rejects(c.market.settle.staticCall(r), "AlreadySettled");
  await rejects(c.market.connect(c.homes[0]).placeOrder.staticCall(r, 0, 10, 1, 0, key(), key()), "Closed");
});
test("no duplicate round, no two sides from same wallet, no source reuse across rounds", async () => {
  const c = await setup(), r = await open(c), source = key();
  await rejects(c.market.openRound.staticCall((await c.market.rounds(r)).key, 30, 0), "Duplicate");
  await order(c, r, 0, 0, 10, 2000, source);
  await rejects(c.market.connect(c.homes[0]).placeOrder.staticCall(r, 1, 10, 3000, 0, key(), key()), "Duplicate");
  await confirmed(c.market.connect(c.homes[0]).cancelOrder(r, 0));
  const r2 = await open(c);
  await rejects(c.market.connect(c.homes[0]).placeOrder.staticCall(r2, 0, 10, 2000, 0, source, key()), "Duplicate");
});
test("zero/oversize quantity, zero price, zero hash and unknown round rejected", async () => {
  const c = await setup(), r = await open(c), m = c.market.connect(c.homes[0]);
  for (const [q, p, src] of [[0, 1, key()], [1_000_000_001, 1, key()], [1, 0, key()], [1, 1, ZeroHash]])
    await rejects(m.placeOrder.staticCall(r, 0, q, p, 0, src, key()), "InvalidInput");
  await rejects(m.placeOrder.staticCall(999, 0, 1, 1, 0, key(), key()), "UnknownRound");
});
test("failed escrow transfer is atomic: no used source or phantom order", async () => {
  const c = await setup(), r = await open(c), src = key();
  await assert.rejects(c.market.connect(c.homes[0]).placeOrder(r, 1, 100, 2000, 0, src, key()));
  assert.equal((await c.market.getOrders(r)).length, 0);
  assert.equal(await c.market.sourceUsed(c.manifest.households.home_01, src), false);
  assert.equal(await c.market.hasOrder(r, c.manifest.households.home_01), false);
  // Oversized budget with allowance but insufficient token balance also rolls back.
  await approveExact(c, c.homes[0], 2_000_000_000n);
  await assert.rejects(c.market.connect(c.homes[0]).placeOrder(r, 1, 1_000_000, 2000, 0, src, key()));
  assert.equal((await c.market.getOrders(r)).length, 0);
});
test("escrows from overlapping rounds remain isolated", async () => {
  const c = await setup(), r1 = await open(c), r2 = await open(c);
  await order(c, r1, 0, 1, 100, 3000); await order(c, r2, 1, 1, 100, 2000);
  await close(c, r1); assert.equal(await c.token.balanceOf(c.manifest.market), 200000n);
  await close(c, r2); assert.equal(await c.token.balanceOf(c.manifest.market), 0n);
});

test("matching retains payment until an authorized evidence-backed confirmation", async () => {
  const c = await setup(), r = await open(c);
  await order(c, r, 0, 0, 100, 2000); await order(c, r, 1, 1, 100, 3000);
  await close(c, r, false);
  assert.equal(await c.token.balanceOf(c.manifest.market), 200000n);
  assert.equal(await c.token.balanceOf(c.manifest.households.home_01), 1_000_000_000n);
  assert.equal(await c.market.activeQuantityWh(c.manifest.households.home_02), 100n);
  await rejects(c.market.connect(c.homes[1]).confirmTrade.staticCall(r, 0, 100, key()), "Unauthorized");
  await rejects(c.market.confirmTrade.staticCall(r, 0, 100, ZeroHash), "InvalidInput");
  await rejects(c.market.confirmTrade.staticCall(r, 0, 101, key()), "InvalidInput");
  await rejects(c.market.confirmTrade.staticCall(r, 1, 100, key()), "InvalidInput");
  const evidence = key(); await confirmed(c.market.confirmTrade(r, 0, 100, evidence));
  const t = (await c.market.getTrades(r))[0];
  assert.equal(t.status, 1n); assert.equal(t.evidenceHash, evidence); assert.equal(t.deliveredWh, 100n);
  assert.equal(await c.token.balanceOf(c.manifest.market), 0n);
  assert.equal(await c.market.activeQuantityWh(c.manifest.households.home_01), 0n);
  assert.equal((await c.market.reputations(c.manifest.households.home_01)).successfulTrades, 1n);
  await rejects(c.market.confirmTrade.staticCall(r, 0, 100, key()), "AlreadyResolved");
  await rejects(c.market.expireTrade.staticCall(r, 0), "AlreadyResolved");
  const r2 = await open(c);
  await order(c, r2, 0, 0, 10, 2000); await order(c, r2, 1, 1, 10, 3000);
  await close(c, r2, false);
  await rejects(c.market.confirmTrade.staticCall(r2, 0, 10, evidence), "Duplicate");
});

async function failSeller(c, delivered = 0) {
  const r = await open(c);
  await order(c, r, 0, 0, 100, 2000); await order(c, r, 1, 1, 100, 3000);
  await close(c, r, false);
  await confirmed(c.market.confirmTrade(r, 0, delivered, key()));
  return r;
}

test("verified short delivery changes seller score, requires collateral, compensates buyer and allows recovery", async () => {
  const c = await setup(), seller = c.manifest.households.home_01, buyer = c.manifest.households.home_02;
  await failSeller(c); await failSeller(c);
  assert.equal((await c.market.reputations(seller)).score, 60n);
  assert.equal((await c.market.reputations(seller)).violations, 2n);
  assert.equal((await c.market.reputations(buyer)).score, 100n);
  assert.equal(await c.market.quantityLimitWh(seller), 500_000_000n);
  assert.equal(await c.market.collateralBps(seller), 1000n);
  assert.deepEqual(Array.from(await c.market.quoteOrder(seller, 0, 1, 1)), [0n, 1n]);
  assert.deepEqual(Array.from(await c.market.quoteOrder(seller, 1, 100, 2000)), [200000n, 20000n]);
  const r = await failSeller(c, 40);
  const t = (await c.market.getTrades(r))[0];
  assert.equal(t.sellerCollateral, 20000n);
  assert.equal(await c.token.balanceOf(seller), 1_000_068_000n); // 80k delivered less 12k penalty
  assert.equal(await c.token.balanceOf(buyer), 999_932_000n);
  assert.equal(await c.token.balanceOf(c.manifest.market), 0n);
  assert.equal((await c.market.reputations(seller)).score, 40n);
  assert.equal(await c.market.quantityLimitWh(seller), 100_000_000n);
  assert.equal(await c.market.collateralBps(seller), 2500n);
  assert.equal((await c.market.reputations(seller)).deliveredWh, 40n);
  const recovery = await open(c);
  await order(c, recovery, 0, 0, 100, 2000); await order(c, recovery, 1, 1, 100, 3000);
  await close(c, recovery);
  assert.equal((await c.market.reputations(seller)).score, 42n);
  assert.equal(await c.token.balanceOf(c.manifest.market), 0n);
  await failSeller(c); await failSeller(c); await failSeller(c);
  assert.equal((await c.market.reputations(seller)).score, 0n); // Saturates without underflow.
});

test("quantity cap counts both sides and overlapping pending trades, with release on cancel/unmatched/confirm", async () => {
  const c = await setup(), a = c.manifest.households.home_01;
  await failSeller(c); await failSeller(c);
  const r1 = await open(c), r2 = await open(c);
  await order(c, r1, 0, 0, 400_000_000, 1);
  await rejects(c.market.connect(c.homes[0]).placeOrder.staticCall(r2, 1, 100_000_001, 1, 0, key(), key()), "QuantityLimit");
  await order(c, r2, 0, 1, 100_000_000, 1);
  assert.equal(await c.market.activeQuantityWh(a), 500_000_000n);
  await confirmed(c.market.connect(c.homes[0]).cancelOrder(r1, 0));
  assert.equal(await c.market.activeQuantityWh(a), 100_000_000n);
  assert.equal((await c.market.reputations(a)).score, 60n); // A permitted cancellation is not misconduct.
  await order(c, r2, 1, 0, 40_000_000, 1);
  await close(c, r2, false);
  assert.equal(await c.market.activeQuantityWh(a), 40_000_000n);
  await confirmed(c.market.confirmTrade(r2, 0, 40_000_000, key()));
  assert.equal(await c.market.activeQuantityWh(a), 0n);
  assert.equal(await c.token.balanceOf(c.manifest.market), 0n);
});

test("low-score seller cannot bypass collateral; failed transfer rolls back commitment/history", async () => {
  const c = await setup(), a = c.manifest.households.home_01;
  await failSeller(c); await failSeller(c);
  const r = await open(c), src = key(), before = await c.market.reputations(a);
  await assert.rejects(c.market.connect(c.homes[0]).placeOrder(r, 0, 100, 2000, 0, src, key()));
  assert.equal(await c.market.activeQuantityWh(a), 0n);
  assert.equal(await c.market.sourceUsed(a, src), false);
  assert.equal((await c.market.reputations(a)).ordersPlaced, before.ordersPlaced);
  await order(c, r, 0, 0, 100, 2000);
  assert.equal(await c.token.balanceOf(c.manifest.market), 20000n);
  await confirmed(c.market.connect(c.homes[0]).cancelOrder(r, 0));
  assert.equal(await c.token.balanceOf(c.manifest.market), 0n);
});

test("timeout is permissionless, refunds both collateral and payment, and does not invent a violation", async () => {
  const c = await setup(); await failSeller(c); await failSeller(c);
  const seller = c.manifest.households.home_01, before = await c.token.balanceOf(seller), r = await open(c);
  await order(c, r, 0, 0, 100, 2000); await order(c, r, 1, 1, 100, 3000);
  await close(c, r, false);
  await rejects(c.market.expireTrade.staticCall(r, 0), "TooEarly");
  await provider.send("evm_setNextBlockTimestamp", [Number((await c.market.rounds(r)).confirmationDeadline)]);
  await provider.send("evm_mine", []);
  await rejects(c.market.confirmTrade.staticCall(r, 0, 100, key()), "ConfirmationExpired");
  await confirmed(c.market.connect(c.homes[2]).expireTrade(r, 0));
  assert.equal((await c.market.getTrades(r))[0].status, 2n);
  assert.equal(await c.token.balanceOf(seller), before);
  assert.equal(await c.token.balanceOf(c.manifest.households.home_02), 1_000_000_000n);
  assert.equal(await c.token.balanceOf(c.manifest.market), 0n);
  assert.equal(await c.market.activeQuantityWh(seller), 0n);
  const rep = await c.market.reputations(seller);
  assert.equal(rep.score, 60n); assert.equal(rep.violations, 2n); assert.equal(rep.expiredTrades, 1n);
  await rejects(c.market.expireTrade.staticCall(r, 0), "AlreadyResolved");
});

test("pending escrows are isolated from matching/confirmation in other rounds", async () => {
  const c = await setup(), r1 = await open(c), r2 = await open(c);
  for (const r of [r1, r2]) {
    await order(c, r, 0, 0, 100, 2000); await order(c, r, 1, 1, 100, 3000);
  }
  await close(c, r1, false); await close(c, r2, false);
  assert.equal(await c.token.balanceOf(c.manifest.market), 400000n);
  await confirmed(c.market.confirmTrade(r2, 0, 100, key()));
  assert.equal(await c.token.balanceOf(c.manifest.market), 200000n);
  assert.equal(await c.market.activeQuantityWh(c.manifest.households.home_01), 100n);
  await confirmed(c.market.confirmTrade(r1, 0, 100, key()));
  assert.equal(await c.token.balanceOf(c.manifest.market), 0n);
});

test("all verified categories beat earlier ordinary buyers at equal bids", async () => {
  for (const category of [1, 2, 3]) {
    const c = await setup(), a = c.manifest.households.home_03;
    await confirmed(c.market.setBuyerCategory(a, category, key()));
    const r = await open(c);
    await order(c, r, 0, 0, 60, 2000);
    await order(c, r, 1, 1, 60, 3000); await order(c, r, 2, 1, 60, 3000);
    await close(c, r);
    assert.equal((await c.market.getTrades(r))[0].buyIndex, 2n);
  }
});

test("priority cannot beat a higher bid; equal priority uses insertion order", async () => {
  const c = await setup();
  await confirmed(c.market.setBuyerCategory(c.manifest.households.home_02, 1, key()));
  let r = await open(c);
  await order(c, r, 0, 0, 60, 2000);
  await order(c, r, 1, 1, 60, 2500); await order(c, r, 2, 1, 60, 3000);
  await close(c, r); assert.equal((await c.market.getTrades(r))[0].buyIndex, 2n);
  await confirmed(c.market.setBuyerCategory(c.manifest.households.home_03, 2, key()));
  r = await open(c);
  await order(c, r, 0, 0, 60, 2000);
  await order(c, r, 1, 1, 60, 3000); await order(c, r, 2, 1, 60, 3000);
  await close(c, r); assert.equal((await c.market.getTrades(r))[0].buyIndex, 1n);
});

test("category verification is authorized and snapshotted when placing an order", async () => {
  const c = await setup(), a = c.manifest.households.home_03;
  await rejects(c.market.connect(c.homes[2]).setBuyerCategory.staticCall(a, 1, key()), "Unauthorized");
  await rejects(c.market.setBuyerCategory.staticCall(a, 1, ZeroHash), "InvalidInput");
  await rejects(c.market.setBuyerCategory.staticCall(c.manifest.coordinator, 1, key()), "InvalidInput");
  const r = await open(c);
  await order(c, r, 0, 0, 60, 2000);
  await order(c, r, 1, 1, 60, 3000); await order(c, r, 2, 1, 60, 3000);
  await confirmed(c.market.setBuyerCategory(a, 1, key()));
  await close(c, r); assert.equal((await c.market.getTrades(r))[0].buyIndex, 1n);
});
