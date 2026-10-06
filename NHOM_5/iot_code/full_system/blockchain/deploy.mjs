import fs from "node:fs";
import path from "node:path";
import { STATE, acquireLock } from "./lib/files.mjs";
import { localProvider, loadChain, deployContracts, saveDeployment } from "./lib/chain.mjs";

let provider, release;
try {
  release = acquireLock();
  if (fs.existsSync(path.join(STATE, "deployment.json"))) {
    try {
      const existing = await loadChain();
      existing.provider.destroy();
      console.log(`Deployment already active: ${existing.manifest.market}. Reusing it; balances are preserved.`);
      process.exitCode = 0;
    } catch {
      provider = await localProvider();
      const chain = await deployContracts(provider);
      saveDeployment(chain.manifest);
      console.log(JSON.stringify(chain.manifest, null, 2));
    }
  } else {
    provider = await localProvider();
    const chain = await deployContracts(provider);
    saveDeployment(chain.manifest);
    console.log(JSON.stringify(chain.manifest, null, 2));
  }
} catch (e) { console.error(`DEPLOY ERROR: ${e.shortMessage || e.message}`); process.exitCode = 1; }
finally { provider?.destroy(); release?.(); }
