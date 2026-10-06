import { BrowserProvider, Contract, getAddress, formatUnits } from 'ethers';

export const short = a => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—';
export function decimalInteger(value, scale = 3, max = 1000000000n) {
  if (typeof value !== 'string' || !new RegExp(`^(0|[1-9][0-9]*)(\\.[0-9]{1,${scale}})?$`).test(value))
    throw new Error(`Nhập số dương, dùng dấu chấm và tối đa ${scale} chữ số thập phân.`);
  const [whole, frac = ''] = value.split('.');
  const n = BigInt(whole) * 10n ** BigInt(scale) + BigInt(frac.padEnd(scale, '0'));
  if (n < 1n || n > max) throw new Error('Giá trị nằm ngoài giới hạn của hợp đồng.');
  return n;
}
export function errorText(e) {
  if (e.code === 4001 || e.code === 'ACTION_REJECTED') return 'Bạn đã từ chối trong ví. Giao dịch này chưa được gửi.';
  if (e.code === -32002) return 'Ví đang có yêu cầu chờ. Mở MetaMask để xử lý yêu cầu đó.';
  const text = e.shortMessage || e.message || String(e);
  const errors = { TooEarly: 'Phiên chưa tới hạn kết toán theo đồng hồ blockchain. Chờ thêm rồi thử lại.',
    Closed: 'Phiên đã đóng, không thể đặt hoặc hủy lệnh.', Duplicate: 'Ví hoặc đề xuất này đã được sử dụng trong phiên.',
    Unauthorized: 'Tài khoản hiện tại không có quyền thực hiện thao tác này.', AlreadySettled: 'Phiên đã được kết toán.',
    ERC20InsufficientBalance: 'Ví không đủ SLC.', ERC20InsufficientAllowance: 'Chưa cấp đủ quyền sử dụng SLC.' };
  Object.assign(errors, { QuantityLimit: 'Tổng lượng điện đang cam kết vượt giới hạn theo điểm uy tín.',
    AlreadyResolved: 'Giao dịch đã xác nhận hoặc đã hoàn tiền.', ConfirmationExpired: 'Đã quá hạn xác nhận; có thể yêu cầu hoàn tiền.' });
  for (const [name, message] of Object.entries(errors)) if (text.includes(name) || e.revert?.name === name) return message;
  return text;
}
export function discoverWallets(callback) {
  const found = new Map();
  const announce = event => {
    const d = event.detail;
    if (!d?.provider?.request || !d.info?.uuid) return;
    found.set(d.info.uuid, d); callback([...found.values()]);
  };
  window.addEventListener('eip6963:announceProvider', announce);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  const timer = setTimeout(() => {
    if (!found.size && window.ethereum?.request)
      callback([{ info: { uuid: 'legacy', name: 'Ví trình duyệt' }, provider: window.ethereum }]);
  }, 350);
  return () => { clearTimeout(timer); window.removeEventListener('eip6963:announceProvider', announce); };
}

export class WalletSession {
  constructor(onChange = () => {}) { this.onChange = onChange; this.epoch = 0; this.account = ''; this.chainId = ''; }
  emit() { this.onChange({ account: this.account, chainId: this.chainId, epoch: this.epoch }); }
  detach() {
    if (this.raw) for (const [event, cb] of this.listeners || []) this.raw.removeListener?.(event, cb);
    this.provider?.destroy(); this.provider = null;
  }
  async connect(raw) {
    this.detach(); this.raw = raw; this.epoch++; this.account = ''; this.chainId = ''; this.emit();
    const accountChange = accounts => { this.account = accounts[0] ? getAddress(accounts[0]) : ''; this.epoch++; this.emit(); };
    const chainChange = chain => { this.chainId = chain; this.epoch++; this.emit(); };
    const disconnect = () => { this.account = ''; this.chainId = ''; this.epoch++; this.emit(); };
    this.listeners = [['accountsChanged', accountChange], ['chainChanged', chainChange], ['disconnect', disconnect]];
    for (const [event, cb] of this.listeners) raw.on?.(event, cb);
    this.provider = new BrowserProvider(raw, 'any', { cacheTimeout: -1 });
    this.provider.pollingInterval = 300;
    const accounts = await raw.request({ method: 'eth_requestAccounts' });
    this.account = accounts[0] ? getAddress(accounts[0]) : '';
    this.chainId = await raw.request({ method: 'eth_chainId' }); this.epoch++; this.emit();
    return this.account;
  }
  async switchNetwork(manifest) {
    if (!this.raw) throw new Error('Kết nối ví trước.');
    try { await this.raw.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x7a69' }] }); }
    catch (e) {
      if (e.code !== 4902 && e.data?.originalError?.code !== 4902) throw e;
      await this.raw.request({ method: 'wallet_addEthereumChain', params: [{ chainId: '0x7a69',
        chainName: 'Solar Local · Hardhat', rpcUrls: [manifest.rpc], nativeCurrency: { name: 'Test Ether', symbol: 'ETH', decimals: 18 } }] });
      await this.raw.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x7a69' }] });
    }
    this.chainId = await this.raw.request({ method: 'eth_chainId' }); this.epoch++; this.emit();
  }
  capture() {
    if (!this.account || !this.provider) throw new Error('Kết nối MetaMask trước khi ký.');
    return { account: this.account, epoch: this.epoch };
  }
  async guard(expected, manifest, abis) {
    if (!this.raw || this.epoch !== expected.epoch) throw new Error('Tài khoản hoặc mạng đã thay đổi. Kiểm tra lại lệnh rồi thử lại.');
    const [accounts, chain] = await Promise.all([
      this.raw.request({ method: 'eth_accounts' }), this.raw.request({ method: 'eth_chainId' })]);
    if (chain.toLowerCase() !== '0x7a69') throw new Error('Chuyển ví sang Solar Local, chain ID 31337.');
    if (!accounts[0] || getAddress(accounts[0]) !== expected.account || this.epoch !== expected.epoch)
      throw new Error('Tài khoản ví đã thay đổi. Kiểm tra lại lệnh.');
    const market = new Contract(manifest.market, abis.market, this.provider);
    const receipt = await this.provider.getTransactionReceipt(manifest.deployment_tx);
    if (!receipt || receipt.status !== 1 || receipt.blockHash !== manifest.deployment_block_hash ||
        await market.deploymentId() !== manifest.deployment_id ||
        getAddress(await market.token()) !== getAddress(manifest.token))
      throw new Error('RPC trong ví không khớp triển khai hiện tại. Kiểm tra RPC và tải lại trang.');
    if (this.epoch !== expected.epoch) throw new Error('Ví đã thay đổi trong lúc kiểm tra.');
    const signer = await this.provider.getSigner(expected.account);
    return { signer, market: market.connect(signer), token: new Contract(manifest.token, abis.token, signer) };
  }
}

async function waitFor(txPromise, label, notify) {
  notify({ label: `${label}: chờ xác nhận trong ví`, status: 'wallet' });
  const tx = await txPromise();
  notify({ label: `${label}: đã gửi, đang chờ khối`, status: 'pending', hash: tx.hash });
  let receipt;
  try { receipt = await tx.wait(1, 120000); }
  catch (e) {
    e.message = `${errorText(e)} Giao dịch đã gửi: ${tx.hash}. Kiểm tra lịch sử trước khi thử lại.`;
    e.shortMessage = e.message;
    throw e;
  }
  if (!receipt || receipt.status !== 1) throw new Error(`Giao dịch thất bại: ${tx.hash}`);
  notify({ label: `${label}: đã xác nhận`, status: 'confirmed', hash: receipt.hash });
  return receipt;
}

export async function sendOrder({ wallet, manifest, abis, plan, revalidate, notify }) {
  const expected = wallet.capture();
  const quantity = BigInt(plan.quantityWh), price = BigInt(plan.price);
  if (quantity < 1n || quantity > 1000000000n || price < 1n || price > 1000000000000n || ![0, 1].includes(plan.side))
    throw new Error('Lệnh không hợp lệ.');
  const house = Object.entries(manifest.households).find(([, a]) => getAddress(a) === expected.account)?.[0];
  if (!house || (plan.basis === 0 ? house !== 'home_01' : !['home_02', 'home_03'].includes(house)))
    throw new Error('Ví không đúng vai trò của lệnh đã xem xét.');
  const validate = async () => {
    await revalidate();
    const c = await wallet.guard(expected, manifest, abis);
    const round = await c.market.rounds(plan.roundId);
    if (round.key !== plan.roundKey || round.settled) throw new Error('Phiên đã thay đổi hoặc đã đóng.');
    if (await c.market.hasOrder(plan.roundId, expected.account) || await c.market.sourceUsed(expected.account, plan.sourceId))
      throw new Error('Ví hoặc đề xuất này đã được sử dụng. Không gửi lặp.');
    return c;
  };
  let c = await validate();
  const [payment, collateral] = await c.market.quoteOrder(expected.account, plan.side, quantity, price);
  const cost = payment + collateral;
  if (cost > 0n) {
    if (await c.token.balanceOf(expected.account) < cost) throw new Error(`Không đủ SLC: cần ${formatUnits(cost, 6)} SLC.`);
    const allowance = await c.token.allowance(expected.account, manifest.market);
    if (allowance !== cost) {
      if (allowance > 0n) {
        await waitFor(() => c.token.approve(manifest.market, 0n), 'Xóa hạn mức cũ', notify);
        c = await validate();
      }
      await waitFor(() => c.token.approve(manifest.market, cost), 'Cấp quyền đúng số SLC', notify);
    }
  }
  // Especially important: a user can switch accounts, or a live forecast can
  // expire, while the approval dialog is open. Never place using stale context.
  c = await validate();
  return waitFor(() => c.market.placeOrder(plan.roundId, plan.side, quantity, price,
    plan.basis, plan.sourceId, plan.dataHash), 'Đặt lệnh', notify);
}
export async function sendMarketAction({ wallet, manifest, abis, action, args, revalidate, notify }) {
  if (!['openRound', 'cancelOrder', 'settle', 'confirmTrade', 'expireTrade', 'setBuyerCategory'].includes(action)) throw new Error('Unsupported action');
  const expected = wallet.capture();
  await revalidate();
  const c = await wallet.guard(expected, manifest, abis);
  if (['openRound', 'confirmTrade', 'setBuyerCategory'].includes(action) && getAddress(manifest.coordinator) !== expected.account)
    throw new Error('Chuyển sang ví Điều phối để thực hiện thao tác này.');
  return waitFor(() => c.market[action](...args), { openRound: 'Mở phiên', cancelOrder: 'Hủy lệnh', settle: 'Khớp lệnh',
    confirmTrade: 'Xác nhận giao điện', expireTrade: 'Hoàn tiền quá hạn', setBuyerCategory: 'Xác minh nhóm ưu tiên' }[action], notify);
}
