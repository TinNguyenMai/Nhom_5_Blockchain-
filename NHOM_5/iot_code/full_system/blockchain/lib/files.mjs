import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const STATE = path.resolve(process.env.SOLAR_PHASE3_DIR || path.join(ROOT, "data", "phase3"));
export function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, (_, v) => typeof v === "bigint" ? v.toString() : v, 2) + "\n");
  fs.renameSync(temp, file);
}
export function artifact(name) { return readJson(path.join(ROOT, "blockchain", "artifacts", `${name}.json`)); }
export function reportDir(id) { return path.join(STATE, "reports", id); }
export function sourceFile(id, key) { return path.join(STATE, "sources", id, `${key}.json`); }
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
// A short-lived writer lock prevents two bridge/deployment processes sharing signers.
// OS-killed processes leave a PID; only a demonstrably dead PID can be reclaimed.
export function acquireLock() {
  fs.mkdirSync(STATE, { recursive: true });
  const file = path.join(STATE, "writer.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx");
      fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd);
      return () => { try { if (fs.readFileSync(file, "utf8") === String(process.pid)) fs.unlinkSync(file); } catch {} };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const pid = Number(fs.readFileSync(file, "utf8"));
      if (!Number.isInteger(pid) || pid < 1) throw new Error(`Invalid lock at ${file}; inspect it before deleting.`);
      try { process.kill(pid, 0); }
      catch (check) { if (check.code === "ESRCH") { fs.unlinkSync(file); continue; } }
      throw new Error(`Another Phase 3 writer is running (PID ${pid}). Stop that command first.`);
    }
  }
  throw new Error("Could not acquire writer lock");
}
