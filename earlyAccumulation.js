const axios = require("axios");
const fs = require("fs");
const path = require("path");
const cfg = require("./config2");

// ================= ENV =================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BINANCE = "https://fapi.binance.com";

// ================= LOG =================
const LOG_DIR = path.join(__dirname, "logs");
const LOG_FILE = path.join(LOG_DIR, "accumulation.json");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

const lastAlert = {};

// ================= TELEGRAM =================
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    { chat_id: TELEGRAM_CHAT_ID, text }
  );
}

// ================= UTILS =================
function pct(a, b) {
  return b !== 0 ? (a - b) / b : 0;
}
function readLogs() {
  if (!fs.existsSync(LOG_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(LOG_FILE)); }
  catch { return []; }
}
function writeLogs(logs) {
  fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
}

// ================= ACCUMULATION CHECK =================
async function detectAccumulation(symbol) {
  const window = cfg.ACCUM_WINDOW_MIN;

  const [oi, funding, k5m] = await Promise.all([
    axios.get(`${BINANCE}/fapi/v1/openInterestHist`, {
      params: { symbol, period: "5m", limit: window / 5 + 1 }
    }),
    axios.get(`${BINANCE}/fapi/v1/fundingRate`, {
      params: { symbol, limit: 1 }
    }),
    axios.get(`${BINANCE}/fapi/v1/klines`, {
      params: { symbol, interval: "5m", limit: window / 5 }
    })
  ]);

  const oiVals = oi.data.map(x => Number(x.sumOpenInterest));
  if (oiVals.length < 3) return null;

  const oiChange = pct(
    oiVals.at(-1),
    oiVals[0]
  );

  if (oiChange < cfg.OI_ACCUM_PCT) return null;

  const prices = k5m.data.map(k => Number(k[4]));
  const hi = Math.max(...prices);
  const lo = Math.min(...prices);
  const rangePct = (hi - lo) / lo;

  if (rangePct > cfg.PRICE_RANGE_MAX) return null;

  const vols = k5m.data.map(k => Number(k[5]));
  const avgVol = vols.reduce((s,v)=>s+v,0)/vols.length;
  const lastVol = vols.at(-1);
  const volRatio = avgVol > 0 ? lastVol / avgVol : 0;

  if (volRatio > cfg.VOL_RATIO_MAX) return null;

  const fundingRate = Number(funding.data[0]?.fundingRate || 0);
  if (Math.abs(fundingRate) > cfg.FUNDING_MAX) return null;

  return {
    symbol,
    oiChange,
    rangePct,
    volRatio,
    fundingRate,
    lastPrice: prices.at(-1),
    durationMin: window
  };
}

// ================= MAIN =================
async function runScanner() {
  console.log("🟡 EARLY ACCUMULATION SCAN", new Date().toLocaleTimeString());

  const tickers = await axios.get(`${BINANCE}/fapi/v1/ticker/24hr`);
  const symbols = tickers.data
    .filter(c =>
      c.symbol.endsWith("USDT") &&
      !cfg.STABLE_COINS.some(s => c.symbol.includes(s))
    )
    .sort((a,b)=>Number(b.quoteVolume)-Number(a.quoteVolume))
    .slice(0, cfg.SYMBOL_LIMIT)
    .map(c => c.symbol);

  const logs = readLogs();
  const hits = [];

  for (const sym of symbols) {
    try {
      const r = await detectAccumulation(sym);
      if (!r) continue;

      const now = Date.now();
      if (now - (lastAlert[sym] || 0) < cfg.ALERT_COOLDOWN_HOURS * 3600_000)
        continue;

      lastAlert[sym] = now;
      hits.push(r);

      logs.push({
        time: new Date().toISOString(),
        ...r
      });
    } catch {}
  }

  if (!hits.length) return;

  hits.sort((a,b)=>b.oiChange - a.oiChange);

  let msg = `🟡 EARLY ACCUMULATION DETECTED\n\n`;

  for (const h of hits.slice(0,3)) {
    msg +=
`🔹 ${h.symbol}
OI +${(h.oiChange*100).toFixed(2)}%
Range ${(h.rangePct*100).toFixed(2)}%
Vol x${h.volRatio.toFixed(2)}
Funding ${(h.fundingRate*100).toFixed(3)}%
Duration ${h.durationMin}m

`;
  }

  msg += "⚠️ Đây là giai đoạn GOM – KHÔNG FOMO – chờ xác nhận";
  writeLogs(logs);
  await sendTelegram(msg.trim());
}

// ================= SCHEDULER =================
setInterval(runScanner, cfg.INTERVAL_MINUTES * 60 * 1000);
runScanner();
