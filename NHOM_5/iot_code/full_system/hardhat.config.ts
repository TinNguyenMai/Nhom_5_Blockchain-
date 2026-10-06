import { defineConfig } from "hardhat/config";

// Compile with the pinned solc-js package via npm run compile.
// This keeps compilation independent of Solidity binary download servers.
export default defineConfig({
  solidity: "0.8.28",
  networks: {
    default: { type: "edr-simulated", chainId: 31337, allowBlocksWithSameTimestamp: true },
    localhost: { type: "http", url: "http://127.0.0.1:8545", chainId: 31337 }
  }
});
