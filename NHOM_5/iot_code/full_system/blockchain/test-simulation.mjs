import path from "node:path";
import { ROOT } from "./lib/files.mjs";
import { compile } from "./compile.mjs";
import { runChild } from "./lib/test-node.mjs";
const python = process.env.SOLAR_TEST_PYTHON || path.join(ROOT, ".venv-backend", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
try {
  await runChild(python, ["-m", "unittest", "tests.test_market_simulation", "-v"]);
  compile();
  await runChild(process.execPath, ["--test", "--test-concurrency=1", "blockchain/tests/simulation.test.mjs"]);
} catch (e) { console.error(e.message); process.exitCode = 1; }
