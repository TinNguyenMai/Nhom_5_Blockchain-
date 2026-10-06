import { compile } from "./compile.mjs";
import { startNode, runChild } from "./lib/test-node.mjs";
let child;
try {
  compile();
  const node = await startNode(); child = node.child;
  await runChild(process.execPath, ["--test", "--test-concurrency=1", "blockchain/tests/contracts.test.mjs", "blockchain/tests/bridge.test.mjs"], { SOLAR_RPC: node.rpc });
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally { child?.kill(); }
