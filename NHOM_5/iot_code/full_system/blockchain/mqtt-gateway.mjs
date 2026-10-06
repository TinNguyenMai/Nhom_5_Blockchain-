import path from "node:path";
import { HDNodeWallet, id, formatUnits } from "ethers";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { canonical, writeJson, readJson } from "./lib/files.mjs";
import { TransactionJournal } from "./lib/transaction-journal.mjs";
import { validateRequest, uint, CATEGORIES } from "./lib/mqtt-schema.mjs";
import { validateHardwareForecast } from './lib/hardware-source.mjs';

// Public Hardhat demo mnemonic; never reads the user's wallets or secrets.
const PHRASE = "test test test test test test test test test test test junk";
export class MqttGateway {
  constructor({ chain, mqtt, runId, directory, config, onSnapshot = () => {}, onEvent = () => {}, hooks = {} }) {
    Object.assign(this, { chain, mqtt, runId, directory, config, onSnapshot, onEvent, hooks });
    this.manifest = chain.manifest;
    this.journal = new TransactionJournal(path.join(directory, "transactions.json"), chain.manifest.deployment_id);
    this.journal.beforeBroadcast = (record, step, tx) => this.hooks.beforeBroadcast?.(record, step, tx);
    this.queue = Promise.resolve(); this.closed = false; this.duplicates = 0;
    this.telemetry = {}; this.predictions = {}; this.received = 0; this.rejected = 0;
    const sourceFile = path.join(directory, "mqtt-sources.json");
    if (fs.existsSync(sourceFile)) {
      const sources = readJson(sourceFile);
      this.telemetry = sources.telemetry; this.predictions = sources.predictions;
    }
    this.wallets = new Map();
    const all = [chain.manifest.coordinator, ...Object.values(chain.manifest.households)];
    all.forEach((address, index) => {
      const w = HDNodeWallet.fromPhrase(PHRASE, undefined, `m/44'/60'/0'/0/${index}`).connect(chain.provider);
      if (w.address.toLowerCase() !== address.toLowerCase()) throw new Error("Simulation requires isolated default Hardhat test wallets");
      this.wallets.set(index === 0 ? "coordinator" : Object.keys(chain.manifest.households)[index - 1], w);
    });
    this.listener = e => {
      this.received++;
      const { topic, payload: m } = e;
      if (config.hybrid && m.household_id === 'home_01' &&
          (topic.endsWith('/prediction') || (topic.endsWith('/telemetry') && m.data_mode !== 'real' &&
            !(config.hybrid_source === 'ai-demo' && m.data_mode === 'simulation' && m.time_mode === 'accelerated' && m.sampling_seconds === 5)))) {
        this.rejected++; return;
      }
      this.onEvent({ topic, action: m.action || topic.split("/").at(-1), home: m.household_id, at: new Date().toISOString(), message_id: m.message_id });
      if (topic.endsWith("/telemetry")) this.telemetry[m.household_id] = m;
      if (topic.endsWith("/prediction")) this.predictions[m.household_id] = m;
      if (topic.endsWith('/esp32/source')) {
        try { validateHardwareForecast(m, config); this.predictions[m.household_id] = m; }
        catch (error) { this.rejected++; this.onEvent({ action: 'hardware_rejected', error: error.message }); return; }
      }
      if (topic.endsWith("/telemetry") || topic.endsWith("/prediction") || topic.endsWith('/esp32/source'))
        writeJson(sourceFile, { telemetry: this.telemetry, predictions: this.predictions });
      if (!topic.endsWith("/request") && !topic.endsWith("/delivery")) return;
      if (topic.endsWith("/simulation/request")) return;
      this.queue = this.queue.then(() => this.process(topic, m)).catch(e => this.onEvent({ action: "gateway_error", error: e.message }));
    };
    mqtt.on("message", this.listener);
  }
  envelope(home, fields) { return { schema_version: 1, message_id: randomUUID(), run_id: this.runId,
    deployment_id: this.chain.manifest.deployment_id, household_id: home, ...fields }; }
  async recover() {
    for (const record of Object.values(this.journal.data.requests)) if (["received", "retry"].includes(record.status)) {
      const m = record.request;
      const topic = m.action === "confirm_trade" ? `solar/${m.household_id}/delivery` :
        ["place_order", "cancel_order"].includes(m.action) ? `solar/${m.household_id}/order/request` :
        m.action === "set_priority" ? "solar/market/priority/request" : m.action === "expire_trade" ? "solar/market/delivery/request" : "solar/market/round/request";
      this.queue = this.queue.then(() => this.process(topic, m));
    }
    await this.queue;
  }
  async process(topic, m) {
    if (this.closed) return;
    let record;
    try {
      validateRequest(topic, m, this);
      const accepted = this.journal.accept(m); record = accepted.record;
      if (accepted.duplicate) this.duplicates++;
      if (!record.response) {
        const result = await this.execute(record);
        record.status = "confirmed";
        record.response = this.envelope(m.household_id, { correlation_id: m.correlation_id || m.message_id,
          status: "confirmed", action: m.action, result,
          transactions: Object.entries(record.steps).map(([step, t]) => {
            const { logs, ...summary } = t.receipt;
            return { step, ...summary };
          }) });
        this.journal.save();
        if (this.hooks.afterCommit) await this.hooks.afterCommit(record);
      }
    } catch (e) {
      if (e.simulatedCrash) return;
      this.rejected++;
      let name = e.revert?.name;
      const errorData = e.data || e.info?.error?.data;
      if (!name && typeof errorData === "string") for (const contract of [this.chain.market, this.chain.token]) {
        try { name = contract.interface.parseError(errorData)?.name; } catch {}
        if (name) break;
      }
      const reason = name || e.shortMessage || e.message;
      if (record) {
        const unfinished = Object.values(record.steps).some(t => !t.receipt);
        record.status = unfinished ? "retry" : "rejected";
        record.response = unfinished ? null : this.envelope(m.household_id, { correlation_id: m.correlation_id || m.message_id,
          status: "rejected", action: m.action, error: reason });
        this.journal.save();
      }
      if (!record?.response) await this.reply(m, this.envelope(m.household_id || "coordinator", {
        correlation_id: m.correlation_id || m.message_id, status: record?.status === "retry" ? "retry" : "rejected", action: m.action, error: reason }));
    }
    if (record?.response) await this.reply(m, record.response);
  }
  async reply(m, response) {
    const suffix = ["place_order", "cancel_order"].includes(m.action) ? `solar/${m.household_id}/order/status` :
      m.action === "set_priority" ? "solar/market/priority/status" :
      ["confirm_trade", "expire_trade"].includes(m.action) ? "solar/market/delivery/status" : "solar/market/round/status";
    await this.mqtt.publish(suffix, response);
  }
  async send(record, name, wallet, contract, method, args) {
    const tx = { to: await contract.getAddress(), data: contract.interface.encodeFunctionData(method, args) };
    const receipt = await this.journal.send(record, name, wallet, tx);
    if (this.hooks.afterTransaction) await this.hooks.afterTransaction(record, name);
    return receipt;
  }
  async execute(record) {
    const m = record.request, p = m.payload, { market, token, manifest } = this.chain;
    const home = this.wallets.get(m.household_id), admin = this.wallets.get("coordinator");
    let receipt = record.steps.market?.receipt;
    if (!receipt) {
      // Resume earlier signed approval steps before making new allowance decisions.
      for (const [name, step] of Object.entries(record.steps)) if (name !== "market" && !step.receipt)
        await this.journal.send(record, name, home, {});
      if (m.action === "place_order") {
        const q = uint(p.quantity_wh, "quantity"), price = uint(p.price, "price");
        const forecast = this.predictions[m.household_id];
        if (!forecast || canonical(forecast) !== canonical(p.forecast)) throw new Error("Unknown or changed forecast evidence");
        const hardware = ['esp32_telemetry', 'esp32_forecast'].includes(p.basis);
        if (hardware) validateHardwareForecast(forecast, this.config);
        if (!p.override_reason && (p.quantity_wh !== forecast.quantity_wh || p.price !== forecast.price ||
            p.side !== (forecast.action === "sell" ? 0 : 1))) throw new Error("Order does not match forecast");
        const [payment, collateral] = await market.quoteOrder(home.address, p.side, q, price);
        const total = payment + collateral;
        if (p.approval !== "skip" && total > 0n) {
          const allowance = await token.allowance(home.address, manifest.market);
          if (allowance !== total) {
            if (allowance > 0n) await this.send(record, "reset_allowance", home, token, "approve", [manifest.market, 0]);
            await this.send(record, "approve", home, token, "approve", [manifest.market, total]);
          }
        }
        const sourceId = hardware ? forecast.source_id : id(`mqtt-sim:${this.runId}:${m.message_id}`);
        const hash = hardware ? forecast.data_hash : id(canonical(m));
        writeJson(path.join(this.directory, "evidence", `${m.message_id}.json`), m);
        receipt = await this.send(record, "market", home, market, "placeOrder", [p.round_id, p.side, q, price,
          hardware ? p.basis === 'esp32_forecast' ? 0 : 3 : 2, sourceId, hash]);
      } else if (m.action === "cancel_order") receipt = await this.send(record, "market", home, market, "cancelOrder", [p.round_id, p.order_index]);
      else if (m.action === "open_round") receipt = await this.send(record, "market", admin, market, "openRound", [p.key, p.bidding_seconds, this.config.hybrid ? 1 : 0]);
      else if (m.action === "settle") receipt = await this.send(record, "market", admin, market, "settle", [p.round_id]);
      else if (m.action === "set_priority") receipt = await this.send(record, "market", admin, market, "setBuyerCategory",
        [manifest.households[p.home], CATEGORIES[p.category], id(canonical(m))]);
      else if (m.action === "expire_trade") receipt = await this.send(record, "market", home || admin, market, "expireTrade", [p.round_id, p.trade_index]);
      else if (m.action === "confirm_trade") {
        const orders = await market.getOrders(p.round_id), trades = await market.getTrades(p.round_id);
        const trade = trades[Number(p.trade_index)];
        if (!trade || orders[Number(trade.sellIndex)].trader.toLowerCase() !== home.address.toLowerCase()) throw new Error("Delivery seller mismatch");
        const buyer = Object.entries(manifest.households).find(([, a]) => a.toLowerCase() === orders[Number(trade.buyIndex)].trader.toLowerCase())?.[0];
        const measure = p.measurement, amount = uint(p.delivered_wh, "delivered_wh");
        if (!measure || measure.kind !== "paired_simulated_meters" || measure.seller !== m.household_id || measure.buyer !== buyer || amount > trade.quantityWh)
          throw new Error("Invalid delivery evidence");
        for (const [prefix, trader, direction] of [["seller", m.household_id, "export"], ["buyer", buyer, "import"]]) {
          const start = uint(measure[`${prefix}_start_wh`], "meter_start"), end = uint(measure[`${prefix}_end_wh`], "meter_end");
          const meter = trader + ":" + direction;
          if (measure[`${prefix}_meter_id`] !== meter || end - start !== amount || start < BigInt(this.journal.data.meters[meter] || 0))
            throw new Error("Meter mismatch or replayed reading");
        }
        writeJson(path.join(this.directory, "evidence", `${m.message_id}.json`), m);
        receipt = await this.send(record, "market", admin, market, "confirmTrade", [p.round_id, p.trade_index, amount, id(canonical(m))]);
      }
    }
    if (m.action === "confirm_trade") {
      const measure = p.measurement;
      this.journal.data.meters[measure.seller_meter_id] = measure.seller_end_wh;
      this.journal.data.meters[measure.buyer_meter_id] = measure.buyer_end_wh;
      this.journal.save();
    }
    const result = { round_id: m.action === "open_round" ? String(await market.roundByKey(p.key)) : p.round_id,
      transaction_hash: receipt.hash };
    if (m.action === "place_order") result.order_index = (await market.getOrders(p.round_id)).findIndex(o => o.trader.toLowerCase() === home.address.toLowerCase());
    if (m.action === "set_priority") await this.mqtt.publish(`solar/${p.home}/priority/status`, this.envelope(p.home, {
      action: "priority_verified", category: p.category, verification_hash: id(canonical(m)), transaction_hash: receipt.hash }));
    if (m.action === "settle") {
      const orders = await market.getOrders(p.round_id), trades = await market.getTrades(p.round_id);
      for (let i = 0; i < trades.length; i++) {
        const t = trades[i];
        await this.mqtt.publish(`solar/market/trade/${p.round_id}`, this.envelope("coordinator", {
          action: "trade_matched", round_id: p.round_id, trade_index: i, quantity_wh: String(t.quantityWh),
          buyer: orders[Number(t.buyIndex)].trader, seller: orders[Number(t.sellIndex)].trader, status: "pending" }));
      }
    }
    await this.snapshot({ action: m.action, home: m.household_id, round_id: result.round_id, transaction_hash: receipt.hash });
    return result;
  }
  async snapshot(context = { action: 'snapshot' }) {
    const { market, token, provider, manifest } = this.chain;
    const homes = await Promise.all(this.config.homes.map(async h => {
      const address = manifest.households[h.id];
      const [balance, rep, active, cap, collateral, category] = await Promise.all([
        token.balanceOf(address), market.reputations(address), market.activeQuantityWh(address),
        market.quantityLimitWh(address), market.collateralBps(address), market.buyerCategories(address)]);
      return { ...h, address, balance_micro_slc: String(balance), balance_slc: formatUnits(balance, 6),
        score: Number(rep.score), orders_placed: String(rep.ordersPlaced), cancelled: String(rep.ordersCancelled),
        successful_trades: String(rep.successfulTrades), violations: String(rep.violations), expired: String(rep.expiredTrades),
        delivered_wh: String(rep.deliveredWh), active_wh: String(active), limit_wh: String(cap), collateral_bps: Number(collateral),
        verified_category: Number(category), telemetry: this.telemetry[h.id] || null, prediction: this.predictions[h.id] || null };
    }));
    const count = Number(await market.roundCount()), rounds = [];
    for (let i = 1; i <= count; i++) {
      const [r, orders, trades] = await Promise.all([market.rounds(i), market.getOrders(i), market.getTrades(i)]);
      const household = a => homes.find(h => h.address.toLowerCase() === a.toLowerCase())?.id;
      rounds.push({ round_id: String(i), key: r.key, closes_at: Number(r.closesAt), confirmation_deadline: Number(r.confirmationDeadline), settled: r.settled,
        orders: orders.map((o, index) => ({ index, home: household(o.trader), side: Number(o.side), quantity_wh: String(o.quantityWh),
          remaining_wh: String(o.remainingWh), price: String(o.price), locked: String(o.locked), collateral: String(o.collateral),
          cancelled: o.cancelled, buyer_category: Number(o.buyerCategory), basis: ['esp32_forecast', 'demo_counterparty', 'simulated_forecast', 'esp32_telemetry'][Number(o.basis)], source_id: o.sourceId, data_hash: o.dataHash })),
        trades: trades.map((t, index) => ({ index, buyer: household(orders[Number(t.buyIndex)].trader), seller: household(orders[Number(t.sellIndex)].trader),
          quantity_wh: String(t.quantityWh), delivered_wh: String(t.deliveredWh), cost: String(t.cost), price: String(t.price),
          paid: String(t.deliveredWh * t.price), buyer_collateral: String(t.buyerCollateral), seller_collateral: String(t.sellerCollateral),
          status: ["pending", "confirmed", "expired"][Number(t.status)], evidence_hash: t.evidenceHash })) });
    }
    const escrow = await token.balanceOf(manifest.market), balances = homes.reduce((sum, h) => sum + BigInt(h.balance_micro_slc), 0n);
    const snapshot = { run_id: this.runId, deployment: manifest, homes, rounds, escrow: String(escrow),
      participant_tokens: String(balances), conserved: balances + escrow === BigInt(homes.length * this.config.initial_slc) * 1_000_000n,
      mqtt: { connected: this.mqtt.connected, messages: this.received, duplicate_requests: this.duplicates, rejected: this.rejected },
      chain_time: (await provider.getBlock("latest")).timestamp, updated_at: new Date().toISOString(),
      transactions: Object.values(this.journal.data.requests).map(r => ({ message_id: r.request.message_id, action: r.request.action,
        home: r.request.household_id, status: r.status, transactions: Object.entries(r.steps).map(([step, t]) => ({ step, hash: t.hash, status: t.receipt?.status, block: t.receipt?.block_number })) })) };
    this.onSnapshot(snapshot, context);
    writeJson(path.join(this.directory, "snapshot.json"), snapshot);
    this.publishedReputations ||= {};
    for (const h of homes) {
      const reputation = { score: h.score, collateral_bps: h.collateral_bps, limit_wh: h.limit_wh,
        active_wh: h.active_wh, balance_micro_slc: h.balance_micro_slc, violations: h.violations,
        successful_trades: h.successful_trades, expired: h.expired, verified_category: h.verified_category };
      const fingerprint = canonical(reputation);
      if (this.publishedReputations[h.id] !== fingerprint) {
        await this.mqtt.publish(`solar/${h.id}/reputation`, this.envelope(h.id, { action: "reputation_updated", ...reputation }));
        this.publishedReputations[h.id] = fingerprint;
      }
    }
    await this.mqtt.publish("solar/market/snapshot", this.envelope("coordinator", { summary: { escrow: String(escrow), rounds: count, conserved: snapshot.conserved } }));
    return snapshot;
  }
  async close() { this.mqtt.off("message", this.listener); await this.queue; this.closed = true; }
}
