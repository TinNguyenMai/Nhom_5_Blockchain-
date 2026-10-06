import { defineConfig } from "hardhat/config";
// A separate local node for the simulator, including enough wallets for 32 homes.
export default defineConfig({
  solidity: "0.8.28",
  networks: { node: { type: "edr-simulated", chainId: 31337,
    accounts: { count: 40 }, allowBlocksWithSameTimestamp: true } }
});
