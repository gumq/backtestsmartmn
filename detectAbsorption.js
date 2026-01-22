// ==================================================
// ABSORPTION DETECTOR
// ==================================================

function calcAbsorptionScore({ deltaUSD, rangePct, durationMs }) {
  const deltaScore = Math.log10(Math.abs(deltaUSD) + 1);
  const rangeScore = 1 / (rangePct + 0.001);
  const timeScore = Math.min(3, 60000 / durationMs);
  return +(deltaScore * rangeScore * timeScore).toFixed(2);
}

function detectAbsorption(symbol, state, config) {
  const s = state[symbol];
  if (!s) return null;

  const { trades, prices1m } = s;
  if (!trades || !prices1m || trades.length < 10 || prices1m.length < 5)
    return null;

  const delta = trades.reduce((sum, t) => {
    const v = t.qty * t.price;
    return t.isBuyerMaker ? sum - v : sum + v;
  }, 0);

  const recent = prices1m.slice(-5);
  const hi = Math.max(...recent.map(p => p.price));
  const lo = Math.min(...recent.map(p => p.price));
  const rangePct = (hi - lo) / lo;

  if (Math.abs(delta) < config.ABSORPTION_DELTA_USD) return null;

  const durationMs = trades.at(-1).time - trades[0].time;

  const score = calcAbsorptionScore({
    deltaUSD: delta,
    rangePct,
    durationMs,
  });

  return {
    deltaUSD: Math.round(delta),
    rangePct: +(rangePct * 100).toFixed(3),
    durationMs,
    score,
  };
}

module.exports = { detectAbsorption };
