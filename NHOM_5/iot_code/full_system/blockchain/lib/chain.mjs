import path from "node:path";
import { Contract, ContractFactory, JsonRpcProvider, getAddress, hexlify, randomBytes } from "ethers";
import { STATE, artifact, readJson, writeJson } from "./files.mjs";

export const DEFAULT_RPC = "http://127.0.0.1:8545";
export function loopbackUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new Error("This demo only accepts HTTP loopback URLs, without paths or credentials.");
  return url.origin;
}
export async function localProvider(rpc = process.env.SOLAR_RPC || DEFAULT_RPC) {
  const provider = new JsonRpcProvider(loopbackUrl(rpc), undefined, { cacheTimeout: -1, batchMaxCount: 1 });
  provider.pollingInterval = 100;
  try {
    const chain = await provider.getNetwork();
    const version = await provider.send("web3_clientVersion", []);
    if (chain.chainId !== 31337n || !/hardhat/i.test(version))
      throw new Error("Only a local Hardhat node with chainId 31337 is supported.");
    return provider;
  } catch (e) { provider.destroy(); throw e; }
}
export async function confirmed(txPromise) {
  const receipt = await (await txPromise).wait(1, 30_000);
  if (!receipt || receipt.status !== 1) throw new Error("Transaction did not confirm successfully");
  return receipt;
}
export async function deployContracts(provider, participantCount = 3) {
  const admin = await provider.getSigner(0);
  const homes = [];
  for (let i = 1; i <= participantCount; i++) homes.push(await provider.getSigner(i));
  const deploymentId = hexlify(randomBytes(32));
  const ta = artifact("SolarToken"), ma = artifact("EnergyMarket");
  const token = await new ContractFactory(ta.abi, ta.bytecode, admin).deploy();
  await token.waitForDeployment();
  const addresses = await Promise.all(homes.map(s => s.getAddress()));
  const market = await new ContractFactory(ma.abi, ma.bytecode, admin).deploy(await token.getAddress(), addresses, deploymentId);
  await market.waitForDeployment();
  for (const home of addresses) await confirmed(token.transfer(home, 1_000n * 10n ** 6n));
  const receipt = await provider.getTransactionReceipt(market.deploymentTransaction().hash);
  const manifest = { schema_version: 1, chain_id: 31337, deployment_id: deploymentId,
    rpc: loopbackUrl(provider._getConnection().url), created_at: new Date().toISOString(),
    token: await token.getAddress(), market: await market.getAddress(), token_decimals: 6,
    coordinator: await admin.getAddress(),
    households: Object.fromEntries(addresses.map((a, i) => [`home_${String(i + 1).padStart(2, "0")}`, a])),
    deployment_tx: receipt.hash, deployment_block: receipt.blockNumber, deployment_block_hash: receipt.blockHash,
    purpose: "local_demo_only", price_unit: "micro_SLC_per_Wh" };
  return { provider, admin, homes, token, market, manifest };
}
export async function loadChain() {
  let manifest;
  try { manifest = readJson(path.join(STATE, "deployment.json")); }
  catch { throw new Error("Deployment missing. Run npm run compile, npm run chain, then npm run deploy."); }
  const provider = await localProvider(process.env.SOLAR_RPC || manifest.rpc);
  try {
    const market = new Contract(manifest.market, artifact("EnergyMarket").abi, provider);
    const token = new Contract(manifest.token, artifact("SolarToken").abi, provider);
    const receipt = await provider.getTransactionReceipt(manifest.deployment_tx);
    if (!receipt || receipt.status !== 1 || receipt.blockHash !== manifest.deployment_block_hash ||
        await market.deploymentId() !== manifest.deployment_id ||
        getAddress(await market.token()) !== getAddress(manifest.token))
      throw new Error("Deployment does not match this chain. The node may have restarted; run npm run deploy.");
    if (await market.MARKET_VERSION() !== 2n)
      throw new Error("Market contract version changed; run npm run deploy for a new deployment.");
    const admin = await provider.getSigner(manifest.coordinator);
    const homes = await Promise.all(Object.values(manifest.households).map(a => provider.getSigner(a)));
    return { provider, admin, homes, market, token, manifest };
  } catch (e) { provider.destroy(); throw e; }
}
export function saveDeployment(manifest) {
  writeJson(path.join(STATE, "deployments", `${manifest.deployment_id}.json`), manifest);
  writeJson(path.join(STATE, "deployment.json"), manifest);
}
export async function approveExact(chain, signer, amount) {
  const token = chain.token.connect(signer), market = chain.manifest.market;
  const allowance = await token.allowance(await signer.getAddress(), market);
  if (allowance === amount) return;
  if (allowance > 0n) await confirmed(token.approve(market, 0));
  await confirmed(token.approve(market, amount));
}
