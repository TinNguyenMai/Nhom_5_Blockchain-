export const CATEGORIES = { ordinary: 0, hospital: 1, kindergarten: 2, special: 3 };
export function uint(value, field, max = (1n << 64n) - 1n, min = 0n) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) < min || BigInt(value) > max)
    throw new Error(`Invalid ${field}: expected integer string ${min}..${max}`);
  return BigInt(value);
}
export function validateRequest(topic, m, { runId, manifest, config }) {
  if (!m || m.schema_version !== 1 || m.run_id !== runId || m.deployment_id !== manifest.deployment_id ||
      typeof m.message_id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(m.message_id) || !m.payload || typeof m.payload !== "object" || Array.isArray(m.payload))
    throw new Error("Invalid request envelope/run/deployment");
  const house = m.household_id, p = m.payload;
  const registered = Object.hasOwn(manifest.households, house);
  const admin = house === "coordinator";
  const routes = {
    open_round: "solar/market/round/request", settle: "solar/market/round/request",
    expire_trade: "solar/market/delivery/request", set_priority: "solar/market/priority/request",
    place_order: `solar/${house}/order/request`, cancel_order: `solar/${house}/order/request`,
    confirm_trade: `solar/${house}/delivery`
  };
  if (routes[m.action] !== topic || (["open_round", "settle", "set_priority", "expire_trade"].includes(m.action) ? !admin : !registered))
    throw new Error("Unauthorized MQTT action/topic");
  if (m.action !== "open_round" && m.action !== "set_priority") uint(p.round_id, "round_id", undefined, 1n);
  if (m.action === "place_order") {
    const hardwareBasis = config?.hybrid_source === 'telemetry' ? 'esp32_telemetry' : 'esp32_forecast';
    const hardware = config?.hybrid && house === 'home_01' && p.basis === hardwareBasis &&
      p.forecast?.basis === hardwareBasis && p.forecast.device_kind === 'esp32' && !p.override_reason;
    const simulated = p.basis === 'simulated_forecast' && p.forecast?.device_kind === 'simulator' &&
      p.forecast.basis === 'simulated_forecast' && !(config?.hybrid && house === 'home_01');
    if (![0, 1].includes(p.side) || p.forecast?.household_id !== house || p.forecast.run_id !== runId ||
        (!hardware && !simulated)) throw new Error('Invalid forecast/source');
    uint(p.quantity_wh, "quantity_wh", 1_000_000_000n, 1n);
    uint(p.price, "price", 1_000_000_000_000n, 1n);
  }
  if (m.action === "cancel_order") uint(p.order_index, "order_index", 31n);
  if (["confirm_trade", "expire_trade"].includes(m.action)) uint(p.trade_index, "trade_index", 31n);
  if (m.action === "confirm_trade") uint(p.delivered_wh, "delivered_wh");
  if (m.action === "open_round" && (typeof p.key !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(p.key) ||
      !Number.isInteger(p.bidding_seconds) || p.bidding_seconds < 2 || p.bidding_seconds > 3600)) throw new Error("Invalid round settings");
  if (m.action === "set_priority" && (!Object.hasOwn(manifest.households, p.home) || !Object.hasOwn(CATEGORIES, p.category) || !p.verification))
    throw new Error("Invalid priority verification");
  return m;
}
