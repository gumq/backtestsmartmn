// ==================================================
// SMART MONEY ENGINE – QUỸ GRADE (A+B+C+D+F)
// Realtime Decision + Auto Execution (Binance Futures)
// ==================================================

require("dotenv").config();

const WebSocket = require("ws");
const axios = require("axios");
const fs = require("fs");

const { executeLong, onPriceTick } = require("./mockExecutor");

const { allocateCapital, registerPosition } = require("./portfolio");
// const { startUserStream } = require('./userStream');
const { detectMarketRegime } = require("./marketRegime.js");

// ================= ENV =================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TEST_MODE = process.env.TEST_MODE === "true";


// ================= CONFIG =================
const TRADE_WINDOW = 15 * 60 * 1000;
const PRICE_WINDOW = 12 * 60 * 60 * 1000;
const ALERT_COOLDOWN = 15 * 60 * 1000;
  
// ---- ORDER FLOW ----
const ABSORPTION_DELTA_USD = TEST_MODE ? 30_000 : 300_000;
const ABSORPTION_PRICE_RANGE = TEST_MODE ? 0.01 : 0.0015;

const CVD_HISTORY_WINDOW = 5 * 60 * 1000;

// ---- VOLUME PROFILE ----
const VP_BIN_PCT = 0.001;
const VP_LOOKBACK = 6 * 60 * 60 * 1000;

// ---- AI SCORE ----
const AI_MODEL_FILE = "./ai_model.json";

// ================= TELEGRAM =================
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await axios.post(url, { chat_id: TELEGRAM_CHAT_ID, text });
}

// ================= STATE =================
const state = {};

// ================= CLEANUP =================
function cleanup(symbol) {
  const now = Date.now();
  state[symbol].trades = state[symbol].trades.filter(
    (t) => now - t.time <= TRADE_WINDOW
  );
  state[symbol].prices1m = state[symbol].prices1m.filter(
    (p) => now - p.time <= PRICE_WINDOW
  );
  state[symbol].cvdHistory = state[symbol].cvdHistory.filter(
    (d) => now - d.time <= CVD_HISTORY_WINDOW
  );
}

// ================= ORDER FLOW =================
function updateCVD(symbol, trade) {
  const v = trade.qty * trade.price;
  state[symbol].cvd += trade.isBuyerMaker ? -v : v;
  state[symbol].cvdHistory.push({ time: trade.time, cvd: state[symbol].cvd });
}

function detectAbsorption(symbol) {
  const trades = state[symbol].trades;
  const prices = state[symbol].prices1m;
  if (trades.length < 30 || prices.length < 10) return null;

  const delta = trades.reduce((s, t) => {
    const v = t.qty * t.price;
    return t.isBuyerMaker ? s - v : s + v;
  }, 0);

  const recent = prices.slice(-10).map((p) => p.price);
  const movePct =
    (Math.max(...recent) - Math.min(...recent)) / Math.min(...recent);

  if (
    Math.abs(delta) > ABSORPTION_DELTA_USD &&
    movePct < ABSORPTION_PRICE_RANGE
  ) {
    return {
      deltaUSD: Math.round(delta),
      rangePct: +(movePct * 100).toFixed(3),
    };
  }
  return null;
}

// ================= VOLUME PROFILE =================
function buildVolumeProfile(symbol) {
  const now = Date.now();
  const profile = {};
  const trades = state[symbol].trades.filter(
    (t) => now - t.time <= VP_LOOKBACK
  );

  for (const t of trades) {
    const bin = Number(
      (
        Math.round(t.price / (t.price * VP_BIN_PCT)) *
        t.price *
        VP_BIN_PCT
      ).toFixed(4)
    );
    profile[bin] = (profile[bin] || 0) + t.qty * t.price;
  }

  state[symbol].volumeProfile = profile;
}

function getVPLevels(symbol) {
  const vp = state[symbol].volumeProfile;
const MIN_VP_BINS = TEST_MODE ? 3 : 10;

if (!vp || Object.keys(vp).length < MIN_VP_BINS) return null;

  const levels = Object.entries(vp).sort((a, b) => b[1] - a[1]);
  return {
    poc: Number(levels[0][0]),
    hvn: levels.slice(0, 3).map((l) => Number(l[0])),
    lvn: levels.slice(-3).map((l) => Number(l[0])),
  };
}

// ================= WYCKOFF =================
function detectWyckoff(prices) {
  if (!prices || prices.length < 60) return null;

  const vals = prices.map((p) => p.price);
  const high = Math.max(...vals);
  const low = Math.min(...vals);
  const last = vals.at(-1);
  const rangePct = (high - low) / low;

  if (rangePct < 0.01) {
    if (last < low * 0.995) return "Phase C";
    if (last > high * 1.002) return "Phase D";
    return "Phase B";
  }

  if (last > high * 0.995) return "Markup";
  if (last < low * 1.005) return "Markdown";
  return "Transition";
}

function mtfFilter(symbol) {
  const p1m = detectWyckoff(state[symbol].prices1m);
  const p15m = detectWyckoff(state[symbol].prices15m);
  const p1h = detectWyckoff(state[symbol].prices1h);

  if (!p1m || !p15m || !p1h) return null;
if (!TEST_MODE) {
  if (p1h === 'Markdown') return null;
  if (['Markdown', 'Phase E'].includes(p15m)) return null;
  if (!['Phase C', 'Phase D'].includes(p1m)) return null;
} else {
  // TEST MODE: cho phép Phase B ở 1m
  if (p1h === 'Markdown') return null;
  if (['Markdown', 'Phase E'].includes(p15m)) return null;
  if (!['Phase B', 'Phase C', 'Phase D'].includes(p1m)) return null;
}

  return { p1m, p15m, p1h };
}

// ================= AI SCORE =================
function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function predictWinProbability(features) {
  if (!fs.existsSync(AI_MODEL_FILE)) return null;
  const weights = JSON.parse(fs.readFileSync(AI_MODEL_FILE));
  const z = features.reduce((s, x, i) => s + x * weights[i], 0);
  return sigmoid(z);
}

// ================= RISK =================
function getRisk(symbol, phase, vp) {
  if (!vp) return null;
  const last = state[symbol].prices1m.at(-1)?.price;
  if (!last) return null;

  // const vp = getVPLevels(symbol);

  // ============================
  // TEST MODE – FALLBACK RISK
  // ============================
  if (!vp && TEST_MODE) {
    const prices = state[symbol].prices1m.slice(-30).map(p => p.price);
    if (prices.length < 10) return null;

    const low = Math.min(...prices);
    const high = Math.max(...prices);

    const stop = low * 0.995;
    const target = high * 1.005;
    const rr = (target - last) / (last - stop);

    if (!isFinite(rr) || rr <= 0) return null;

    return {
      stop,
      target,
      rr,
      fallback: true
    };
  }

  // ============================
  // LIVE / NORMAL MODE
  // ============================
  if (!vp) return null;

  let stop;

  if (phase === "Phase C") {
    stop = Math.min(...vp.hvn) * 0.995;
  } else if (phase === "Phase D") {
    stop = vp.poc * 0.995;
  }
  // TEST MODE: cho phép Phase B
  else if (TEST_MODE && phase === "Phase B") {
    stop = vp.poc * 0.99;
  } else {
    return null;
  }

  const target = TEST_MODE
    ? Math.max(...vp.hvn) * 1.005   // target gần hơn để dễ RR
    : Math.max(...vp.lvn) * 1.01;

  const rr = (target - last) / (last - stop);

  if (!isFinite(rr) || rr <= 0) return null;

  return {
    stop,
    target,
    rr,
    fallback: false
  };
}

// ================= DETECT (DECISION + EXECUTION) =================
async function detect(symbol) {
  if (TEST_MODE) {
    console.log(
      `[SCAN] ${symbol.toUpperCase()} | 1m=${
        state[symbol].prices1m.length
      } | trades=${state[symbol].trades.length}`
    );
  }

const MIN_1M_BARS = TEST_MODE ? 30 : 120;
if (state[symbol].prices1m.length < MIN_1M_BARS) return;


  // ===== HOUSEKEEPING =====
  cleanup(symbol);
  buildVolumeProfile(symbol);

  // ===== MULTI-TIMEFRAME WYCKOFF (C) =====
  const mtf = mtfFilter(symbol);
  if (!mtf) {
    if (1) console.log(`[SKIP][MTF] ${symbol.toUpperCase()}`);
    return;
  }

  // ===== ORDER FLOW (A) =====
  const absorption = detectAbsorption(symbol);
  if (!absorption) {
    if (1) console.log(`[SKIP][NO ABSORPTION] ${symbol.toUpperCase()}`);
    return;
  }
  // ===== VOLUME PROFILE (B) =====
  const vp = getVPLevels(symbol);
  if (!vp) {
    if (1) console.log(`[SKIP][NO VP] ${symbol.toUpperCase()}`);
    return;
  }

  // ===== RISK / RR CHECK =====
const risk = getRisk(symbol, mtf.p1m, vp);
  // if (!risk || risk.rr < 2) return;
  const minRR = TEST_MODE ? 1 : 2;
 if (!risk) {
  console.log(`[SKIP][NO RISK] ${symbol.toUpperCase()}`);
  return;
}

if (risk.rr < minRR) {
  console.log(
    `[SKIP][RR] ${symbol.toUpperCase()} rr=${risk.rr.toFixed(2)}`
  );
  return;
}

  // ===== CVD SLOPE =====
  const cvdSlope =
    state[symbol].cvdHistory.at(-1)?.cvd - state[symbol].cvdHistory[0]?.cvd;

  const lastPrice = state[symbol].prices1m.at(-1).price;
  const regime = detectMarketRegime(state[symbol].prices1m);
  // ===== AI FEATURES (D) =====
  const features = [
    absorption ? 1 : 0,
    cvdSlope / 100000,
    Math.abs((lastPrice - vp.poc) / lastPrice),
    risk.rr,
    mtf.p1m === "Phase C" ? 1 : 0,
    mtf.p1m === "Phase D" ? 1 : 0,
    mtf.p15m === "Phase B" ? 1 : 0,
    mtf.p1h !== "Markdown" ? 1 : 0,
  ];

  const pWin = predictWinProbability(features);

  // ===== REGIME-BASED FILTER =====
  const minPwin =
    regime === 'RISK_OFF'
      ? Number(process.env.RISK_OFF_MIN_PWIN)
      : 0.75;

  // if (pWin !== null && pWin < minPwin) return;const effectiveMinPwin = TEST_MODE
  //   ? minPwin - 0.15   // hạ 15%
  //   : minPwin;

  // if (pWin !== null && pWin < effectiveMinPwin) return;
  const effectiveMinPwin = TEST_MODE ? minPwin - 0.15 : minPwin;
if (!TEST_MODE) {
 if (pWin !== null && pWin < effectiveMinPwin) {
    if (TEST_MODE) {
      console.log(
        `[SKIP][AI] ${symbol.toUpperCase()} pWin=${pWin.toFixed(
          2
        )} < ${effectiveMinPwin}`
      );
    }
    return;
  }
}


  // ===== REGIME-BASED RISK MULTIPLIER =====
  const regimeMultiplier =
    regime === "RISK_ON"
      ? Number(process.env.RISK_ON_MULTIPLIER)
      : regime === "RISK_OFF"
      ? Number(process.env.RISK_OFF_MULTIPLIER)
      : Number(process.env.NEUTRAL_MULTIPLIER);

  // ===== MARKET REGIME (J) =====

  // ===== ALERT COOLDOWN =====
  const now = Date.now();
  if (now - state[symbol].lastAlert < ALERT_COOLDOWN) return;
  state[symbol].lastAlert = now;

  // ==================================================
  // ===== PORTFOLIO / CAPITAL ALLOCATION AI (G) =====
  // ==================================================

  const baseRiskPct = Number(process.env.MAX_RISK_PER_TRADE);

  const allocation = allocateCapital({
    symbol: symbol.toUpperCase(),
    pWin: pWin ?? 0.8,
    baseRiskPct: baseRiskPct * regimeMultiplier,
  });

  if (!allocation.allowed) {
    console.log(
      `⛔ SKIP ${symbol.toUpperCase()} – PORTFOLIO BLOCK: ${allocation.reason}`
    );
    return;
  }

  // ==================================================
  // ===== AUTO EXECUTION (F) =====
  // ==================================================

  await executeLong({
    symbol: symbol.toUpperCase(),
    entry: lastPrice,
    stop: risk.stop,
    target: risk.target,
    sizeMultiplier: allocation.sizeMultiplier * regimeMultiplier
  });

  // ===== REGISTER POSITION INTO PORTFOLIO (G) =====
  if (!TEST_MODE) {
    registerPosition({
      symbol: symbol.toUpperCase(),
      riskPct: baseRiskPct * allocation.sizeMultiplier,
      group: allocation.group,
    });
  }

  // ==================================================
  // ===== TELEGRAM / LOG =====
  // ==================================================
  const msg = `🚨 AUTO EXECUTED (A+B+C+D+F+G)

COIN: ${symbol.toUpperCase()}
TF: 1H=${mtf.p1h} | 15M=${mtf.p15m} | 1M=${mtf.p1m}

AI P(win): ${pWin ? (pWin * 100).toFixed(1) + "%" : "N/A"}
Portfolio Multiplier: x${allocation.sizeMultiplier}

Entry: ${lastPrice.toFixed(4)}
Stop: ${risk.stop.toFixed(4)}
Target: ${risk.target.toFixed(4)}
RR: ${risk.rr.toFixed(2)}
Market Regime: ${regime}
Risk Multiplier: x${regimeMultiplier}
Absorption: ${
    absorption
      ? `YES | Delta: $${absorption.deltaUSD} | Range: ${absorption.rangePct}%`
      : "NO"
  }
Volume Profile POC: ${vp.poc.toFixed(4)}
Time: ${new Date().toLocaleString()}`;

  await sendTelegram(msg);
}
//YES | Delta: $420k | Range: 0.18%
//Có $420k lệnh market bị “nuốt” trong khi giá chỉ nhúc nhích 0.18% → cá mập đang hành động
// ================= MAIN =================
async function start() {
  const res = await axios.get("https://api.binance.com/api/v3/ticker/24hr");

  const symbols = res.data
    .filter(
      (c) =>
        c.symbol.endsWith("USDT") &&
        !["USDCUSDT", "BUSDUSDT", "TUSDUSDT", "FDUSDUSDT","USD1USDT"].includes(c.symbol)
    )
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
    .slice(0, TEST_MODE ? 80 : 80)
    .map((c) => c.symbol.toLowerCase());

  symbols.forEach((s) => {
    state[s] = {
      trades: [],
      prices1m: [],
      prices15m: [],
      prices1h: [],
      cvd: 0,
      cvdHistory: [],
      volumeProfile: {},
      lastAlert: 0,
    };
  });

  const streams = symbols
    .map((s) => `${s}@trade/${s}@kline_1m/${s}@kline_15m/${s}@kline_1h`)
    .join("/");

  const ws = new WebSocket(
    `wss://stream.binance.com:9443/stream?streams=${streams}`
  );

  ws.on("message", (msg) => {
    const payload = JSON.parse(msg);
    const symbol = payload.stream.split("@")[0];
    if (!state[symbol]) return;

    const d = payload.data;

    if (d.e === "trade") {
      state[symbol].trades.push({
        time: d.T,
        qty: +d.q,
        price: +d.p,
        isBuyerMaker: d.m,
      });
      updateCVD(symbol, d);
      // detect(symbol);
    }

    if (d.e === "kline") {
      const price = +d.k.c;
      const time = d.k.T;
      if (d.k.i === "1m") {
        state[symbol].prices1m.push({ time, price });
        onPriceTick(symbol.toUpperCase(), price);
        detect(symbol);
      }
      if (d.k.i === "15m") {
        state[symbol].prices15m.push({ time, price });
      }
      if (d.k.i === "1h") {
        state[symbol].prices1h.push({ time, price });
      }
    }
  });

  console.log("🚀 SMART MONEY ENGINE RUNNING (A+B+C+D+F)");
  // startUserStream();
}

start();
