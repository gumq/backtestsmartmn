// ==================================================
// SMART MONEY ENGINE – QUỸ GRADE (A+B+C+D+F)
// Realtime Decision + Auto Execution (Binance Futures)
// ==================================================

require("dotenv").config();

const WebSocket = require("ws");
const axios = require("axios");
const fs = require("fs");
const { shouldPartialTP, executePartialTP } = require("./partialTPManager");

const { addEvent, updateSignal } = require("./telegramNotifier");

const {
  executeLong,
  onPriceTick,
  onPositionClosed,
} = require("./mockExecutor");
const { shouldTrailTarget, trailTarget } = require("./absorptionTrailing");

const { shouldScaleIn, executeScaleIn } = require("./scaleInManager.js");

const { allocateCapital, registerPosition } = require("./portfolio.js");
// const { startUserStream } = require('./userStream');
const { detectMarketRegime } = require("./marketRegime.js");
const { buildSignal } = require("./signalBuilder.js");
const { processSignal } = require("./signalProcessor.js");
const { validateSignal } = require("./signalValidator.js");

// ================= ENV =================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TEST_MODE = process.env.TEST_MODE === "true";

// ================= CONFIG =================
const TRADE_WINDOW = 15 * 60 * 1000;
const PRICE_WINDOW = 12 * 60 * 60 * 1000;
const ALERT_COOLDOWN = TEST_MODE ? 60 * 1000 : 15 * 60 * 1000;

// ---- ORDER FLOW ----
const ABSORPTION_DELTA_USD = TEST_MODE ? 80_000 : 300_000;
const ABSORPTION_PRICE_RANGE = TEST_MODE ? 0.005 : 0.0015;

const CVD_HISTORY_WINDOW = 5 * 60 * 1000;

// ---- VOLUME PROFILE ----
const VP_BIN_PCT = 0.001;
const VP_LOOKBACK = 6 * 60 * 60 * 1000;

// ---- AI SCORE ----
const AI_MODEL_FILE = "./ai_model.json";

// ================= TELEGRAM =================
// async function sendTelegram(text) {
//   if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
//   const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
//   await axios.post(url, { chat_id: TELEGRAM_CHAT_ID, text });
// }

// ================= STATE =================
const state = {};

onPositionClosed((symbol, info) => {
  const sym = symbol.toLowerCase();
  const s = state[sym];
  if (!s || !s.activeSignal) return;

  const activeSignal = s.activeSignal;

  // ===== TIMELINE END =====
  addEvent(
    activeSignal,
    `❌ Exit @ ${info.exitPrice} | ${info.reason} | PnL ${info.pnl.toFixed(2)}`,
  );

  updateSignal(activeSignal);

  // ===== RESET STATE =====
  s.activeSignal = null;
  s.scaleIns = 0;

  console.log(`♻️ TRADE CLOSED & STATE RESET: ${symbol}`);
});

// ================= CLEANUP =================
function cleanup(symbol) {
  const now = Date.now();
  state[symbol].trades = state[symbol].trades.filter(
    (t) => now - t.time <= TRADE_WINDOW,
  );
  state[symbol].prices1m = state[symbol].prices1m.filter(
    (p) => now - p.time <= PRICE_WINDOW,
  );
  state[symbol].cvdHistory = state[symbol].cvdHistory.filter(
    (d) => now - d.time <= CVD_HISTORY_WINDOW,
  );
}

// ================= ORDER FLOW =================
function updateCVD(symbol, trade) {
  const v = trade.qty * trade.price;
  state[symbol].cvd += trade.isBuyerMaker ? -v : v;
  state[symbol].cvdHistory.push({ time: trade.time, cvd: state[symbol].cvd });
}
function calcAbsorptionScore({ deltaUSD, rangePct, durationMs }) {
  const deltaScore = Math.log10(Math.abs(deltaUSD) + 1);
  const rangeScore = 1 / (rangePct + 0.001);
  const timeScore = Math.min(3, 60000 / durationMs);

  return +(deltaScore * rangeScore * timeScore).toFixed(2);
}
function getAbsorptionDeltaThreshold(symbol) {
  const s = state[symbol];
  if (!s) return TEST_MODE ? 80_000 : 120_000;

  const base = TEST_MODE ? 80_000 : 100_000;
  const v = s.volume24h || 0;

  const liquidityMultiplier =
    v > 2_000_000_000
      ? 4
      : v > 1_000_000_000
        ? 3
        : v > 800_000_000
          ? 2.5
          : v > 500_000_000
            ? 2
            : v > 100_000_000
              ? 1.5
              : 1;

  return base * liquidityMultiplier;
}

function detectAbsorption(symbol) {
  const s = state[symbol];
  if (!s || !s.trades || !s.prices1m) return null;
  const trades = state[symbol].trades;
  const prices = state[symbol].prices1m;
  if (trades.length < 30 || prices.length < 10) return null;

  const delta = trades.reduce((s, t) => {
    const v = t.qty * t.price;
    return t.isBuyerMaker ? s - v : s + v;
  }, 0);

  const recent = prices.slice(-10);
  const hi = Math.max(...recent.map((p) => p.price));
  const lo = Math.min(...recent.map((p) => p.price));
  const rangePct = (hi - lo) / lo;

  // if (Math.abs(delta) < ABSORPTION_DELTA_USD) return null;
  const threshold = getAbsorptionDeltaThreshold(symbol);

  if (Math.abs(delta) < threshold) return null;

  if (1) {
    console.log(
      `[ABSORB] ${symbol.toUpperCase()} delta=${Math.round(delta)} need=${threshold}`,
    );
  }

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

// ================= VOLUME PROFILE =================
function buildVolumeProfile(symbol) {
  const now = Date.now();
  const profile = {};
  const trades = state[symbol].trades.filter(
    (t) => now - t.time <= VP_LOOKBACK,
  );

  for (const t of trades) {
    const bin = Number(
      (
        Math.round(t.price / (t.price * VP_BIN_PCT)) *
        t.price *
        VP_BIN_PCT
      ).toFixed(4),
    );
    profile[bin] = (profile[bin] || 0) + t.qty * t.price;
  }

  state[symbol].volumeProfile = profile;
}

async function detect(symbol) {
  const s = state[symbol];
  if (!s) return;

  const now = Date.now();

  // ===== HEARTBEAT =====
  if (!s._lastHeartbeat || now - s._lastHeartbeat > 60_000) {
    console.log(
      `[HEARTBEAT] ${symbol.toUpperCase()} | 1m=${s.prices1m.length} | trades=${s.trades.length}`,
    );
    s._lastHeartbeat = now;
  }

  const MIN_1M_BARS = TEST_MODE ? 20 : 45;
  if (s.prices1m.length < MIN_1M_BARS) return;

  cleanup(symbol);
  buildVolumeProfile(symbol);

  const signal = buildSignal(symbol, state);
  if (!signal) {
    if (TEST_MODE) console.log(`[SKIP][BUILD] ${symbol.toUpperCase()}`);
    return;
  }

  if (!validateSignal(signal, state)) {
    if (TEST_MODE)
      console.log(
        `[SKIP][VALIDATE] ${symbol.toUpperCase()} | grade=${signal.score?.grade}`,
      );
    return;
  }

  await processSignal(signal, state);

  s.lastAlert = now; // ✅ cooldown đặt đúng chỗ
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
        !["USDCUSDT", "BUSDUSDT", "TUSDUSDT", "FDUSDUSDT", "USD1USDT"].includes(
          c.symbol,
        ),
    )
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
    .slice(0, TEST_MODE ? 80 : 80)
    .map((c) => c.symbol.toLowerCase());

  // const symbols = res.data
  //   .filter((c) => c.symbol.endsWith("USDT"))
  //   .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
  //   .slice(0, 80)
  //   .map((c) => c.symbol.toLowerCase());

  symbols.forEach((s) => {
    const ticker = res.data.find((c) => c.symbol.toLowerCase() === s);

    state[s] = {
      trades: [],
      prices1m: [],
      prices15m: [],
      prices1h: [],
      cvd: 0,
      cvdHistory: [],
      volumeProfile: {},
      volume24h: Number(ticker?.quoteVolume || 0),
      lastAlert: 0,
      activeSignal: null,
      scaleIns: 0,
    };
  });

  const streams = symbols
    .map((s) => `${s}@trade/${s}@kline_1m/${s}@kline_15m/${s}@kline_1h`)
    .join("/");

  const ws = new WebSocket(
    `wss://stream.binance.com:9443/stream?streams=${streams}`,
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

        const sym = symbol.toLowerCase();
        const activeSignal = state[sym]?.activeSignal;

        if (activeSignal) {
          const latestAbsorption = detectAbsorption(sym);

          // =========================================
          // 1️⃣ PARTIAL TP – RISK REDUCTION FIRST
          // =========================================
          const tpLevel = shouldPartialTP(activeSignal, price);
          if (tpLevel) {
            executePartialTP(activeSignal, tpLevel, price, state).catch((err) =>
              console.error("Partial TP error", err),
            );
          }

          // =========================================
          // 2️⃣ TRAILING TARGET – PROFIT PROTECTION
          // =========================================
          if (
            latestAbsorption &&
            shouldTrailTarget(activeSignal, price, latestAbsorption.score)
          ) {
            trailTarget(activeSignal, price);
          }

          // =========================================
          // 3️⃣ SCALE-IN – ONLY AFTER SAFETY
          // =========================================
          if (latestAbsorption && shouldScaleIn(activeSignal, price, state)) {
            executeScaleIn(activeSignal, price, state).catch((err) =>
              console.error("Scale-in error", err),
            );
          }
        }

        // =========================================
        // 4️⃣ HARD TP / SL (BROKER LEVEL)
        // =========================================
        onPriceTick(symbol.toUpperCase(), price);

        // =========================================
        // 5️⃣ DETECT NEW SIGNAL
        // =========================================
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
