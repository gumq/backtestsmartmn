// ==================================================
// MARKET REGIME DETECTION (J)
// ==================================================

const REGIME_LOOKBACK = 200;   // nến 1m
const TREND_THRESHOLD = 0.015;
const CHOP_THRESHOLD = 0.006;

function detectMarketRegime(prices1m) {
  if (!prices1m || prices1m.length < REGIME_LOOKBACK) {
    return 'NEUTRAL';
  }

  const recent = prices1m.slice(-REGIME_LOOKBACK).map(p => p.price);
  const high = Math.max(...recent);
  const low = Math.min(...recent);
  const rangePct = (high - low) / low;

  // simple volatility proxy
  let returns = [];
  for (let i = 1; i < recent.length; i++) {
    returns.push(Math.abs((recent[i] - recent[i - 1]) / recent[i - 1]));
  }
  const avgReturn =
    returns.reduce((a, b) => a + b, 0) / returns.length;

  // ===== REGIME LOGIC =====
  if (rangePct > TREND_THRESHOLD && avgReturn > CHOP_THRESHOLD) {
    return 'RISK_ON';
  }

  if (rangePct < CHOP_THRESHOLD && avgReturn < CHOP_THRESHOLD) {
    return 'RISK_OFF';
  }

  return 'NEUTRAL';
}

module.exports = { detectMarketRegime };
