import fs from "node:fs";
import path from "node:path";
import solc from "solc";
import { ROOT, writeJson } from "./lib/files.mjs";

export function compile() {
  const sources = Object.fromEntries(["SolarToken", "EnergyMarket"].map(name =>
    [`contracts/${name}.sol`, { content: fs.readFileSync(path.join(ROOT, "contracts", `${name}.sol`), "utf8") }]));
  const output = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources,
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode"] } } }
  }), { import: file => {
    try { return { contents: fs.readFileSync(path.join(ROOT, "node_modules", file), "utf8") }; }
    catch { return { error: `Missing import ${file}; run npm ci.` }; }
  } }));
  for (const error of output.errors ?? []) console.error(error.formattedMessage);
  if (output.errors?.some(e => e.severity === "error")) throw new Error("Solidity compilation failed");
  for (const name of ["SolarToken", "EnergyMarket"]) {
    const c = output.contracts[`contracts/${name}.sol`][name];
    writeJson(path.join(ROOT, "blockchain", "artifacts", `${name}.json`), {
      contractName: name, compiler: solc.version(), abi: c.abi,
      bytecode: `0x${c.evm.bytecode.object}`, deployedBytecode: `0x${c.evm.deployedBytecode.object}`
    });
    console.log(`Compiled ${name}: ${c.evm.deployedBytecode.object.length / 2} deployed bytes`);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.join(ROOT, "blockchain", "compile.mjs")) compile();
