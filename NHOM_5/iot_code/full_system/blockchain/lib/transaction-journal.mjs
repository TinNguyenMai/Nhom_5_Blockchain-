import fs from "node:fs";
import { keccak256 } from "ethers";
import { writeJson, readJson, canonical } from "./files.mjs";

export class TransactionJournal {
  constructor(file, deploymentId) {
    this.file = file;
    this.data = fs.existsSync(file) ? readJson(file) : { deployment_id: deploymentId, requests: {}, meters: {} };
    if (this.data.deployment_id !== deploymentId) throw new Error("Journal belongs to another deployment");
    this.save();
  }
  save() { writeJson(this.file, this.data); }
  accept(request) {
    const old = this.data.requests[request.message_id];
    if (old) {
      if (canonical(old.request) !== canonical(request)) throw new Error("Conflicting message_id");
      return { record: old, duplicate: true };
    }
    const record = { request, status: "received", steps: {}, received_at: new Date().toISOString() };
    this.data.requests[request.message_id] = record; this.save();
    return { record, duplicate: false };
  }
  async send(record, stepName, signer, tx) {
    let step = record.steps[stepName];
    if (!step) {
      const populated = await signer.populateTransaction(tx);
      const raw = await signer.signTransaction(populated);
      step = record.steps[stepName] = { raw, hash: keccak256(raw), signer: signer.address, nonce: populated.nonce };
      // Persist the signed transaction BEFORE broadcast. Recovery never signs a second nonce.
      this.save();
    }
    if (step.receipt) {
      if (step.receipt.status !== 1) throw new Error(`Transaction reverted: ${step.hash}`);
      return step.receipt;
    }
    const provider = signer.provider;
    let receipt = await provider.getTransactionReceipt(step.hash);
    if (!receipt) {
      if (!(await provider.getTransaction(step.hash))) {
        await this.beforeBroadcast?.(record, stepName, step);
        try { await provider.broadcastTransaction(step.raw); }
        catch (e) { if (!(await provider.getTransaction(step.hash))) throw e; }
      }
      receipt = await provider.waitForTransaction(step.hash, 1, 30000);
    }
    if (!receipt) throw new Error(`Transaction still pending: ${step.hash}`);
    step.receipt = { hash: receipt.hash, status: receipt.status, block_number: receipt.blockNumber,
      block_hash: receipt.blockHash, gas_used: String(receipt.gasUsed), logs: receipt.logs.map(l => ({ address: l.address, topics: [...l.topics], data: l.data })) };
    this.save();
    if (receipt.status !== 1) throw new Error(`Transaction reverted: ${step.hash}`);
    return step.receipt;
  }
}
