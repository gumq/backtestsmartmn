// ==================================================
// MTF FILTER – WYCKOFF CONTEXT (SAFE VERSION)
// ==================================================

/**
 * Detect Wyckoff phase from price series
 * @param {Array<{time:number, price:number}>} prices
 */
function detectWyckoff(prices) {
  // ===== HARD GUARD =====
  if (!Array.isArray(prices) || prices.length < 60) return null;

  const vals = prices
    .map(p => p?.price)
    .filter(v => typeof v === "number" && isFinite(v));

  if (vals.length < 60) return null;

  const high = Math.max(...vals);
  const low = Math.min(...vals);
  const last = vals.at(-1);

  if (!isFinite(high) || !isFinite(low) || !isFinite(last)) return null;
  if (low <= 0) return null;

  const rangePct = (high - low) / low;

  // ===== RANGE / ACCUMULATION =====
  if (rangePct < 0.01) {
    if (last < low * 0.995) return "Phase C";
    if (last > high * 1.002) return "Phase D";
    return "Phase B";
  }

  // ===== TREND =====
  if (last > high * 0.995) return "Markup";
  if (last < low * 1.005) return "Markdown";

  return "Transition";
}

/**
 * Multi-timeframe Wyckoff filter
 * @param {string} symbol
 * @param {object} state
 * @param {boolean} TEST_MODE
 */
function mtfFilter(symbol, state, TEST_MODE) {
  // ===== INPUT GUARD =====
  if (typeof symbol !== "string") return null;
  if (!state || typeof state !== "object") return null;

  const sym = symbol.toLowerCase();
  const s = state[sym];

  // ===== STATE GUARD =====
  if (
    !s ||
    !Array.isArray(s.prices1m) ||
    !Array.isArray(s.prices15m) 
  ) {
    return null;
  }

  // ===== DETECT WYCKOFF =====
  const p1m = detectWyckoff(s.prices1m);
  const p15m = detectWyckoff(s.prices15m);
  // const p1h = detectWyckoff(s.prices1h);

  if (!p1m || !p15m ) return null;

  // ===== FILTER LOGIC =====
  if (!TEST_MODE) {
    // LIVE MODE – QUỸ KHÓ TÍNH
    if (p15m === "Markdown") return null;
    if (["Markdown", "Phase E"].includes(p15m)) return null;
    if (!["Phase C", "Phase D", "Transition"].includes(p1m)) return null;
  } else {
    // TEST MODE – NỚI LỎNG ĐỂ THẤY NHIỀU CASE
    if (p15m === "Markdown") return null;
    if (["Markdown", "Phase E"].includes(p15m)) return null;
    if (!["Phase B", "Phase C", "Phase D", "Transition"].includes(p1m))
      return null;
  }

  return { p1m, p15m };
}

module.exports = { mtfFilter };
