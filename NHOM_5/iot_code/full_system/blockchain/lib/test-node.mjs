import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { ROOT } from "./files.mjs";
import { delay } from "./market.mjs";

export async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
export async function startNode({ config } = {}) {
  const port = await freePort(), rpc = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(ROOT, "node_modules", "hardhat", "dist", "src", "cli.js"),
    ...(config ? ["--config", config] : []),
    "node", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  let startError;
  child.once("error", error => { startError = error; });
  child.stdout.on("data", d => { log = (log + d).slice(-4000); });
  child.stderr.on("data", d => { log = (log + d).slice(-4000); });
  // Cold native-module loading on Windows can exceed 30 s, especially during
  // the first installation or a concurrent firmware build.
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (startError) throw new Error(`Cannot start local Hardhat: ${startError.message}`);
    if (child.exitCode !== null) throw new Error(`Test Hardhat failed: ${log}`);
    try {
      const r = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), signal: AbortSignal.timeout(1000) });
      if ((await r.json()).result === "0x7a69") return { rpc, child };
    } catch {}
    await delay(250);
  }
  child.kill(); throw new Error(`Test Hardhat startup timeout: ${log}`);
}
export async function runChild(program, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Command failed (${code ?? signal}): ${args.join(" ")}`)));
  });
}
