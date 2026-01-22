// ==================================================
// RISK MODULE – ENTRY / STOP / TARGET / RR
// ==================================================

function getRisk(symbol, phase, vp, state, TEST_MODE) {
  if (!vp) return null;
  const s = state[symbol];
  if (!s || !s.prices1m || s.prices1m.length === 0) return null;

  const last = s.prices1m.at(-1)?.price;
  if (!last) return null;

  let stop;

  // ============================
  // WYCKOFF-BASED STOP
  // ============================
  if (phase === "Phase C") {
    stop = Math.min(...vp.hvn) * 0.995;
  } else if (phase === "Phase D") {
    stop = vp.poc * 0.995;
  } else if (TEST_MODE && phase === "Phase B") {
    // TEST MODE: nới điều kiện
    stop = vp.poc * 0.99;
  } else {
    return null;
  }

  // ============================
  // TARGET
  // ============================
  const target = TEST_MODE
    ? Math.max(...vp.hvn) * 1.005
    : Math.max(...vp.lvn) * 1.01;

  const rr = (target - last) / (last - stop);
  if (!isFinite(rr) || rr <= 0) return null;

  return {
    stop,
    target,
    rr,
  };
}

module.exports = { getRisk };
