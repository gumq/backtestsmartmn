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
const ABSORPTION_DELTA_USD = TEST_MODE ? 10_000 : 100_000;
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
// function cleanup(symbol) {
//   const now = Date.now();
//   state[symbol].trades = state[symbol].trades.filter(
//     (t) => now - t.time <= TRADE_WINDOW,
//   );
//   state[symbol].prices1m = state[symbol].prices1m.filter(
//     (p) => now - p.time <= PRICE_WINDOW,
//   );
//   state[symbol].cvdHistory = state[symbol].cvdHistory.filter(
//     (d) => now - d.time <= CVD_HISTORY_WINDOW,
//   );
// }
function cleanup(symbol) {
  const s = state[symbol];
  if (!s) return;

  const now = Date.now();

  // ===== HARD LIMIT (quan trọng nhất) =====
  if (s.trades.length > 1500) {
    s.trades.splice(0, s.trades.length - 1500);
  }

  if (s.prices1m.length > 1500) {
    s.prices1m.splice(0, s.prices1m.length - 1500);
  }

  if (s.prices15m.length > 500) {
    s.prices15m.splice(0, s.prices15m.length - 500);
  }

  if (s.cvdHistory.length > 1000) {
    s.cvdHistory.splice(0, s.cvdHistory.length - 1000);
  }

  // ===== TIME WINDOW (phòng hờ) =====
  s.trades = s.trades.filter((t) => now - t.time <= TRADE_WINDOW);
  s.prices1m = s.prices1m.filter((p) => now - p.time <= PRICE_WINDOW);
  s.cvdHistory = s.cvdHistory.filter((d) => now - d.time <= CVD_HISTORY_WINDOW);

  // ===== ABSORPTION BUFFER (nếu có) =====
  if (s.absorptionBuffer) {
    s.absorptionBuffer = s.absorptionBuffer.filter(
      (x) => now - x.time <= 10 * 60 * 1000,
    );
    if (s.absorptionBuffer.length > 300) {
      s.absorptionBuffer.splice(0, s.absorptionBuffer.length - 300);
    }
  }
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
  if (!s) return TEST_MODE ? 1_000 : 50_000;

  const base = TEST_MODE ? 1_000 : 50_000;
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

  // ===== BUFFER =====
  s.absorptionBuffer = s.absorptionBuffer || [];

  s.absorptionBuffer.push({
    time: Date.now(),
    delta,
    rangePct,
  });

  s.absorptionBuffer = s.absorptionBuffer.filter(
    (x) => Date.now() - x.time < 10 * 60 * 1000,
  );

  // ===== RESET IF PRICE MOVED =====
  if (rangePct > 0.8 / 100) {
    s.absorptionBuffer = [];
    return null;
  }

  // ===== CHECK =====
  const totalDelta = s.absorptionBuffer.reduce((sum, x) => sum + x.delta, 0);

  const singleShot = Math.abs(delta) >= threshold;
  const accumulation = Math.abs(totalDelta) >= threshold;

  if (!singleShot && !accumulation) return null;

  if (TEST_MODE) {
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
function shouldDetect(s) {
  const now = Date.now();
  if (!s._lastDetect) {
    s._lastDetect = now;
    return true;
  }
  if (now - s._lastDetect > 15_000) {
    s._lastDetect = now;
    return true;
  }
  return false;
}

function shouldBuildVP(s) {
  const now = Date.now();
  if (!s._lastVP) {
    s._lastVP = now;
    return true;
  }
  if (now - s._lastVP > 100_000) {
    s._lastVP = now;
    return true;
  }
  return false;
}

async function detect(symbol) {
  const s = state[symbol];
  if (!s) return;
  if (!shouldDetect(s)) return;

  const now = Date.now();

  // ===== HEARTBEAT =====
  if (!s._lastHeartbeat || now - s._lastHeartbeat > 60_000) {
    console.log(
      `[HEARTBEAT] ${symbol.toUpperCase()} | 1m=${s.prices1m.length} | trades=${s.trades.length}`,
    );
    s._lastHeartbeat = now;
  }

  const MIN_1M_BARS = TEST_MODE ? 3 : 30;
  if (s.prices1m.length < MIN_1M_BARS) return;

  cleanup(symbol);
  buildVolumeProfile(symbol);
  cleanup(symbol);

  if (shouldBuildVP(s)) {
    buildVolumeProfile(symbol);
  }
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
    .slice(0, TEST_MODE ? 80 : 10)
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
    .map((s) => `${s}@trade/${s}@kline_1m/${s}@kline_15m`)
    .join("/");

  const ws = new WebSocket(
    `wss://stream.binance.com:9443/stream?streams=${streams}`,
  );

  ws.on("message", (msg) => {
    let payload;
    try {
      payload = JSON.parse(msg);
    } catch {
      return;
    }

    const symbol = payload.stream.split("@")[0];
    const s = state[symbol];
    if (!s) return;

    const d = payload.data;

    // ================= TRADE =================
    if (d.e === "trade") {
      s.trades.push({
        time: d.T,
        qty: +d.q,
        price: +d.p,
        isBuyerMaker: d.m,
      });

      // HARD CAP NGAY TẠI ĐÂY
      if (s.trades.length > 1500) {
        s.trades.shift();
      }

      updateCVD(symbol, d);
      return;
    }

    // ================= KLINE =================
    if (d.e !== "kline") return;

    const price = +d.k.c;
    const time = d.k.T;

    // ---------- 1M ----------
    if (d.k.i === "1m") {
      s.prices1m.push({ time, price });
      if (s.prices1m.length > 1500) {
        s.prices1m.shift();
      }
      cleanup(symbol);
      // 🔥 CLEANUP BẮT BUỘC MỖI 1M
      cleanup(symbol);

      const activeSignal = s.activeSignal;

      if (activeSignal) {
        const latestAbsorption = detectAbsorption(symbol);

        // PARTIAL TP
        const tpLevel = shouldPartialTP(activeSignal, price);
        if (tpLevel) {
          executePartialTP(activeSignal, tpLevel, price, state).catch((err) =>
            console.error("Partial TP error", err),
          );
        }

        // TRAIL TARGET
        if (
          latestAbsorption &&
          shouldTrailTarget(activeSignal, price, latestAbsorption.score)
        ) {
          trailTarget(activeSignal, price);
        }

        // SCALE-IN
        if (latestAbsorption && shouldScaleIn(activeSignal, price, state)) {
          executeScaleIn(activeSignal, price, state).catch((err) =>
            console.error("Scale-in error", err),
          );
        }
      }

      // HARD SL / TP
      onPriceTick(symbol.toUpperCase(), price);

      // SIGNAL DETECTION
      detect(symbol);
    }

    // ---------- 15M ----------
    if (d.k.i === "15m") {
      s.prices15m.push({ time, price });
      if (s.prices15m.length > 500) {
        s.prices15m.shift();
      }
    }

    // ❌ 1H: KHUYÊN BỎ TRÊN TV BOX
  });

  console.log("🚀 SMART MONEY ENGINE RUNNING (A+B+C+D+F)");
  // startUserStream();
}

start();
