import test from 'node:test';
import assert from 'node:assert/strict';
import { decimalInteger, sendOrder, errorText } from '../src/wallet.mjs';

test('units reject negative, exponent, comma, zero, overprecision and oversized values', () => {
  assert.equal(decimalInteger('0.001'), 1n);
  assert.equal(decimalInteger('2.500', 3, 1000000000000n), 2500n);
  for (const value of ['0', '-1', '1e3', '1,5', '0.0001', 'Infinity', '1000000.001', '', ' 2 ', '00.2'])
    assert.throws(() => decimalInteger(value));
});
const account = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
function setup({ allowance = 0n, approveHook, duplicate = false, reject = false, collateral = 0n } = {}) {
  const sent = [], hash = '0x' + '1'.repeat(64);
  const tx = async () => ({ hash, wait: async () => ({ hash, status: 1 }) });
  const token = { balanceOf: async () => 1000000000n, allowance: async () => allowance,
    approve: async (_, n) => {
      if (reject) throw Object.assign(new Error('rejected'), { code: 4001 });
      sent.push(['approve', n]); await approveHook?.(); return tx();
    } };
  const market = { rounds: async () => ({ key: hash, settled: false }),
    quoteOrder: async (_, side, q, p) => [side === 1 ? q * p : 0n, collateral],
    hasOrder: async () => duplicate, sourceUsed: async () => false,
    placeOrder: async (...args) => { sent.push(['place', ...args]); return tx(); } };
  const wallet = { capture: () => ({ account, epoch: 1 }), guard: async () => ({ token, market }) };
  const args = { wallet, manifest: { market: account, households: { home_01: account } }, abis: {},
    plan: { roundId: '1', roundKey: hash, side: 1, basis: 0, quantityWh: '100', price: '3000', sourceId: hash, dataHash: hash },
    revalidate: async () => {}, notify: () => {} };
  return { sent, args, wallet };
}
test('buy uses exact allowance and never requests unlimited spending', async () => {
  const s = setup({ allowance: 20n }); await sendOrder(s.args);
  assert.deepEqual(s.sent.filter(x => x[0] === 'approve'), [['approve', 0n], ['approve', 300000n]]);
  assert.equal(s.sent.at(-1)[0], 'place');
});
test('sell never requests ERC20 approval', async () => {
  const s = setup(); s.args.plan.side = 0; await sendOrder(s.args);
  assert.deepEqual(s.sent.map(x => x[0]), ['place']);
});
test('both sides approve quoted reputation collateral in addition to buyer payment', async () => {
  for (const side of [0, 1]) {
    const s = setup({ collateral: 30000n }); s.args.plan.side = side; await sendOrder(s.args);
    assert.deepEqual(s.sent[0], ['approve', side === 1 ? 330000n : 30000n]);
  }
});
test('user rejection never submits order', async () => {
  const s = setup({ reject: true }); await assert.rejects(() => sendOrder(s.args));
  assert.equal(s.sent.length, 0);
});
test('account change while approving prevents a second transaction', async () => {
  let changed = false;
  const s = setup({ approveHook: async () => { changed = true; } });
  const guard = s.wallet.guard;
  s.wallet.guard = async () => { if (changed) throw new Error('account changed'); return guard(); };
  await assert.rejects(() => sendOrder(s.args), /account changed/);
  assert.deepEqual(s.sent.map(x => x[0]), ['approve']);
});
test('forecast expiring after approval prevents stale order', async () => {
  let expired = false;
  const s = setup({ approveHook: async () => { expired = true; } });
  s.args.revalidate = async () => { if (expired) throw new Error('forecast expired'); };
  await assert.rejects(() => sendOrder(s.args), /expired/);
  assert.deepEqual(s.sent.map(x => x[0]), ['approve']);
});
test('duplicate source is rejected before spending approval', async () => {
  const s = setup({ duplicate: true }); await assert.rejects(() => sendOrder(s.args), /Không gửi lặp/);
  assert.equal(s.sent.length, 0);
});
test('wrong household cannot sign forecast order', async () => {
  const s = setup(); s.args.manifest.households = { home_02: account };
  await assert.rejects(() => sendOrder(s.args), /vai trò/); assert.equal(s.sent.length, 0);
});
test('wallet errors have useful explanations', () => {
  assert.match(errorText({ code: 4001 }), /từ chối/);
  assert.match(errorText({ message: 'execution reverted: TooEarly()' }), /chưa tới hạn/);
});
