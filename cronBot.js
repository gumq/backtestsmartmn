const axios = require("axios");
const fs = require("fs");
const path = require("path");
const cfg = require("./config");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BINANCE = "https://fapi.binance.com";

const LOG_DIR = path.join(__dirname, "logs");
const LOG_FILE = path.join(LOG_DIR, "alerts.json");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

const lastAlertTime = {};
const ALERT_COOLDOWN_HOURS = 4;

// ================= TELEGRAM =================
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: TELEGRAM_CHAT_ID, text }
    );
  } catch (e) {
    console.log("Telegram error:", e.message);
  }
}

// ================= UTILS =================
function ema(values, period = 50) {
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }
  return e;
}

function normalize(val, min, max) {
  if (val <= min) return 0;
  if (val >= max) return 1;
  return (val - min) / (max - min);
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function readLogs() {
  if (!fs.existsSync(LOG_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(LOG_FILE)); }
  catch { return []; }
}

function writeLogs(logs) {
  fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
}

// ================= TREND FILTER =================
async function detectTrend(symbol) {
  const [k1h, k4h] = await Promise.all([
    axios.get(`${BINANCE}/fapi/v1/klines`, { params: { symbol, interval: "1h", limit: 60 }}),
    axios.get(`${BINANCE}/fapi/v1/klines`, { params: { symbol, interval: "4h", limit: 60 }})
  ]);

  const c1h = k1h.data.map(k => Number(k[4]));
  const c4h = k4h.data.map(k => Number(k[4]));

  const e1h = ema(c1h);
  const e4h = ema(c4h);

  if (c1h.at(-1) > e1h && c4h.at(-1) > e4h) return "LONG";
  if (c1h.at(-1) < e1h && c4h.at(-1) < e4h) return "SHORT";
  return null;
}

// ================= ADVANCED SCORE =================
function calcScoreAdvanced({ bias, oiChange, funding, volRatio, rangePct }) {
  if (!bias) return null;

  const weights = {
    trend: 0.30,
    oi: 0.25,
    volume: 0.20,
    funding: 0.10,
    compression: 0.15,
    absorption: 0.15,
    squeeze: 0.20
  };

  const trendScore = 1;

  const oiScore = normalize(Math.abs(oiChange), 0.02, 0.08);
  const volScore = normalize(volRatio, 1.0, 2.0);
  const fundingScore = normalize(Math.abs(funding), 0.0001, 0.001);
  const compressionScore = 1 - normalize(rangePct, 0.001, 0.01);

  const absorption =
    oiChange >= 0.04 &&
    volRatio >= 1.3 &&
    rangePct <= 0.002;

  const fundingDivergence =
    (bias === "LONG" && funding < 0) ||
    (bias === "SHORT" && funding > 0);

  const crowdExtreme = Math.abs(funding) >= 0.0008;

  const squeeze =
    crowdExtreme &&
    oiChange >= 0.03 &&
    volRatio >= 1.4;

  let total =
    trendScore * weights.trend +
    oiScore * weights.oi +
    volScore * weights.volume +
    fundingScore * weights.funding +
    compressionScore * weights.compression;

  if (absorption) total += weights.absorption;
  if (fundingDivergence) total += 0.1;
  if (squeeze) total += weights.squeeze;

  return {
    total,
    absorption,
    squeeze,
    fundingDivergence
  };
}

// ================= SYMBOL SCAN =================
async function scanSymbol(symbol) {
  try {
    const bias = await detectTrend(symbol);
    if (!bias) return null;

    const [oiHist, fundingRes, k5m, k15m] = await Promise.all([
      axios.get(`${BINANCE}/fapi/v1/openInterestHist`, { params: { symbol, period: "5m", limit: 2 }}),
      axios.get(`${BINANCE}/fapi/v1/fundingRate`, { params: { symbol, limit: 1 }}),
      axios.get(`${BINANCE}/fapi/v1/klines`, { params: { symbol, interval: "5m", limit: 3 }}),
      axios.get(`${BINANCE}/fapi/v1/klines`, { params: { symbol, interval: "15m", limit: 12 }})
    ]);

    const oi0 = Number(oiHist.data[0]?.sumOpenInterest || 0);
    const oi1 = Number(oiHist.data[1]?.sumOpenInterest || 0);
    const oiChange = oi0 ? (oi1 - oi0) / oi0 : 0;

    const funding = Number(fundingRes.data[0]?.fundingRate || 0);

    const vols = k15m.data.map(k => Number(k[5]));
    const avgVol = vols.reduce((s,v)=>s+v,0)/vols.length;
    const curVol = Number(k5m.data.at(-1)[5]);
    const volRatio = avgVol ? curVol / avgVol : 0;

    const prices = k5m.data.map(k => Number(k[4]));
    const hi = Math.max(...prices);
    const lo = Math.min(...prices);
    const rangePct = lo ? (hi - lo) / lo : 0;

    const score = calcScoreAdvanced({ bias, oiChange, funding, volRatio, rangePct });
    if (!score || score.total < cfg.SCORE_THRESHOLD) return null;

    return {
      symbol,
      bias,
      score,
      entryPrice: prices.at(-1)
    };

  } catch {
    return null;
  }
}

// ================= EVALUATE USING HIGH/LOW =================
async function evaluateHitRate() {
  const logs = readLogs();
  let changed = false;

  for (const l of logs) {
    const alertTime = new Date(l.time).getTime();

    for (const h of l.evalHorizons) {
      if (l.evaluated[h]) continue;

      const waitMs = h * 5 * 60_000;
      if (Date.now() - alertTime < waitMs) continue;

      const k = await axios.get(
        `${BINANCE}/fapi/v1/klines`,
        { params: { symbol: l.symbol, interval: "5m", limit: h } }
      );

      const highs = k.data.map(x => Number(x[2]));
      const lows = k.data.map(x => Number(x[3]));

      const bestMove =
        l.bias === "LONG"
          ? (Math.max(...highs) - l.entryPrice) / l.entryPrice
          : (l.entryPrice - Math.min(...lows)) / l.entryPrice;

      l.evaluated[h] = {
        bestMove,
        hit: bestMove >= 0.005
      };

      changed = true;
    }
  }

  if (changed) writeLogs(logs);
}

// ================= MAIN =================
async function runCron() {
  console.log("⏰ RUN", new Date().toLocaleTimeString());

  await evaluateHitRate();

  const tickers = await axios.get(`${BINANCE}/fapi/v1/ticker/24hr`);
  const symbols = tickers.data
    .filter(c => c.symbol.endsWith("USDT") && !cfg.STABLE_COINS.some(s => c.symbol.includes(s)))
    .sort((a,b)=>Number(b.quoteVolume)-Number(a.quoteVolume))
    .slice(0, cfg.SYMBOL_LIMIT)
    .map(c => c.symbol);

  const results = [];

  for (const sym of symbols) {
    const r = await scanSymbol(sym);
    if (!r) continue;

    const now = Date.now();
    if (now - (lastAlertTime[r.symbol] || 0) < ALERT_COOLDOWN_HOURS*3600_000) continue;
    lastAlertTime[r.symbol] = now;

    results.push(r);
  }

  if (!results.length) return;

  results.sort((a,b)=>b.score.total-a.score.total);
  const top = results.slice(0,3);

  let msg = `📡 SMART MONEY RADAR V2\n\n`;

  const logs = readLogs();

  for (const r of top) {
    msg +=
`🔹 ${r.symbol}
Bias: ${r.bias}
Score: ${r.score.total.toFixed(3)}
Absorption: ${r.score.absorption}
Squeeze: ${r.score.squeeze}

`;

    logs.push({
      time: new Date().toISOString(),
      symbol: r.symbol,
      bias: r.bias,
      entryPrice: r.entryPrice,
      evalHorizons: [12,24,48],
      evaluated: {}
    });
  }

  writeLogs(logs);
  await sendTelegram(msg.trim());
}

// ================= SCHEDULER =================
setInterval(runCron, cfg.INTERVAL_MINUTES * 60 * 1000);
runCron();