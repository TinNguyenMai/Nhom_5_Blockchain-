// Exact integer accounting is shared by the report and the dashboard.
export function evaluationPoint(snapshot, context = {}) {
  return {
    at: snapshot.updated_at, chain_time: snapshot.chain_time, ...context,
    escrow: snapshot.escrow, participant_tokens: snapshot.participant_tokens,
    conserved: snapshot.conserved,
    total_tokens: String(BigInt(snapshot.escrow) + BigInt(snapshot.participant_tokens)),
    homes: snapshot.homes.map(h => ({ id: h.id, score: h.score, collateral_bps: h.collateral_bps,
      limit_wh: h.limit_wh, active_wh: h.active_wh, balance_micro_slc: h.balance_micro_slc,
      verified_category: h.verified_category,
      ...(h.telemetry ? { telemetry: { timestamp: h.telemetry.timestamp, solar_power_kw: h.telemetry.solar_power_kw,
        load_power_kw: h.telemetry.load_power_kw, cloud_cover: h.telemetry.cloud_cover,
        irradiance_w_m2: h.telemetry.irradiance_w_m2 } } : {}) })),
  };
}

export function tradeAccounting(trade) {
  const quantity = BigInt(trade.quantity_wh), delivered = BigInt(trade.delivered_wh);
  const cost = BigInt(trade.cost), resolved = trade.status !== 'pending';
  const paid = trade.status === 'confirmed' ? delivered * BigInt(trade.price) : 0n;
  const penalty = trade.status === 'confirmed' && quantity > 0n
    ? BigInt(trade.seller_collateral) * (quantity - delivered) / quantity : 0n;
  return { paid: String(paid), refund: String(resolved ? cost - paid : 0n),
    penalty: String(penalty), pending: String(resolved ? 0n : cost) };
}

export function evaluationSummary(rounds) {
  const trades = rounds.flatMap(r => r.trades);
  const sum = getter => String(trades.reduce((n, t) => n + BigInt(getter(t)), 0n));
  return { trades: trades.length, confirmed: trades.filter(t => t.status === 'confirmed').length,
    expired: trades.filter(t => t.status === 'expired').length,
    pending: trades.filter(t => t.status === 'pending').length,
    committed_wh: sum(t => t.quantity_wh), delivered_wh: sum(t => t.delivered_wh),
    paid: sum(t => tradeAccounting(t).paid), refund: sum(t => tradeAccounting(t).refund),
    penalty: sum(t => tradeAccounting(t).penalty) };
}

export function csvText(rows) {
  const cell = value => {
    // Text from configuration must not turn into a spreadsheet formula.
    const raw = typeof value === 'string' && /^[=+@\-\t\r]/.test(value) ? "'" + value : String(value ?? '');
    return '"' + raw.replaceAll('"', '""') + '"';
  };
  return '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n');
}
