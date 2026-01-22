// ==================================================
// SIGNAL BUILDER – ALPHA ONLY
// ==================================================

require("dotenv").config();

const { mtfFilter } = require("./mtfFilter");
const { detectAbsorption } = require("./detectAbsorption");
const { getVPLevels } = require("./vp");
const { getRisk } = require("./riskk");
const { detectMarketRegime } = require("./marketRegime");

const TEST_MODE = process.env.TEST_MODE === "true";

function buildSignal(symbol, state) {
  if (!symbol || !state) return null;

  const sym = symbol.toLowerCase();
  const s = state[sym];
  if (!s) return null;

  // ================= MTF FILTER =================
  const mtf = mtfFilter(symbol, state, TEST_MODE);
  if (!mtf) return null;

  // ================= ABSORPTION =================
  const absorption = detectAbsorption(sym, state, {
    ABSORPTION_DELTA_USD: TEST_MODE ? 20_000 : 300_000,
  });
  if (!absorption) return null;

  // ================= VOLUME PROFILE =================
  const vp = getVPLevels(sym, state);
  if (!vp) return null;

  // ================= RISK =================
const risk = getRisk(symbol, mtf.p1m, vp, state, TEST_MODE);
if (!risk) return null;


  // ================= CVD =================
  const cvdHist = s.cvdHistory || [];
  const cvdSlope =
    cvdHist.length >= 2
      ? cvdHist.at(-1).cvd - cvdHist[0].cvd
      : 0;

  // ================= PRICE =================
  const lastPrice = s.prices1m.at(-1)?.price;
  if (!lastPrice) return null;

  // ================= REGIME =================
  const regime = detectMarketRegime(s.prices1m);
  const timestamp = Date.now();

  // ================= SIGNAL =================
  return {
    id: `${symbol.toUpperCase()}_${timestamp}`,
    symbol: symbol.toUpperCase(),
    timestamp,

    context: {
      mtf,
      vp,
      absorption,
      cvdSlope,
    },

    risk: {
      entry: lastPrice,
      stop: risk.stop,
      target: risk.target,
      rr: risk.rr,
    },

    meta: {
      strategy: "SM_A_B_C",
      testMode: TEST_MODE,
      regime,
    },
  };
}

module.exports = { buildSignal };
