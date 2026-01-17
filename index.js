// ==================================================
// BINANCE SMART MONEY ENGINE – UPGRADED
// Wyckoff + SOS + Smart Money Inflow + Risk + Auto Evaluation
// ==================================================

const WebSocket = require('ws');
const axios = require('axios');
const fs = require('fs');

// ================= ENV =================
const TELEGRAM_BOT_TOKEN = '8085021873:AAFx286RQXXy-w5QV9OtFoVqh8ldPLtlcMM';
const TELEGRAM_CHAT_ID = '7040574657';

// ================= CONFIG =================
const TRADE_WINDOW = 15 * 60 * 1000;
const PRICE_WINDOW = 12 * 60 * 60 * 1000;
const ALERT_COOLDOWN = 15 * 60 * 1000;

const SIDEWAY_STDDEV = 0.004;
const MIN_INFLOW_USD = 500_000;

const SIGNAL_FILE = './signals.json';

// Win/Loss evaluation
const EVALUATION_HOURS = 12;
const RR_RATIO = 1.5;

// ================= TELEGRAM =================
async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await axios.post(url, { chat_id: TELEGRAM_CHAT_ID, text });
}

// ================= STATE =================
const state = {};

// ================= UTILS =================
function cleanup(symbol) {
  const now = Date.now();
  state[symbol].trades = state[symbol].trades.filter(t => now - t.time <= TRADE_WINDOW);
  state[symbol].prices = state[symbol].prices.filter(p => now - p.time <= PRICE_WINDOW);
}

function netInflowAcceleration(symbol) {
  const trades = state[symbol].trades;
  if (trades.length < 50) return 0;

  const mid = Math.floor(trades.length / 2);

  const calc = arr =>
    arr.reduce((s, t) => {
      const v = t.qty * t.price;
      return t.isBuyerMaker ? s - v : s + v;
    }, 0);

  return calc(trades.slice(mid)) - calc(trades.slice(0, mid));
}

function getRange(symbol) {
  const prices = state[symbol].prices.map(p => p.price);
  return {
    high: Math.max(...prices),
    low: Math.min(...prices)
  };
}

function isSideway(symbol) {
  const prices = state[symbol].prices.map(p => p.price);
  if (prices.length < 360) return false;

  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  const variance =
    prices.reduce((a, p) => a + (p - avg) ** 2, 0) / prices.length;
  const stdDev = Math.sqrt(variance);

  return stdDev / avg < SIDEWAY_STDDEV;
}

// ================= WYCKOFF =================
function detectWyckoffPhase(symbol, inflow) {
  if (!isSideway(symbol)) return 'Phase E';

  const prices = state[symbol].prices.map(p => p.price);
  const last = prices.at(-1);
  const { high, low } = getRange(symbol);

  if (last < low * 0.995 && inflow > MIN_INFLOW_USD) return 'Phase C';
  if (last > high * 1.002 && inflow > MIN_INFLOW_USD * 2) return 'Phase D';

  return 'Phase B';
}

// ================= SOS =================
function detectSOS(symbol, inflow) {
  const prices = state[symbol].prices;
  if (prices.length < 60) return false;

  const last = prices.at(-1).price;
  const prev = prices.at(-2).price;
  const { high } = getRange(symbol);

  const strongClose = (last - prev) / prev > 0.002;
  const volumeSpike = inflow > MIN_INFLOW_USD * 2;

  return last > high * 1.001 && strongClose && volumeSpike;
}

// ================= RISK =================
function getRisk(symbol, phase) {
  const prices = state[symbol].prices.map(p => p.price);
  const last = prices.at(-1);
  const { high, low } = getRange(symbol);

  let stop;
  if (phase === 'Phase C') stop = low * 0.995;
  else if (phase === 'Phase D')
    stop = low + (high - low) * 0.3;
  else return null;

  return {
    stop: Number(stop.toFixed(4)),
    riskPct: Number((((last - stop) / last) * 100).toFixed(2))
  };
}

// ================= SCORE =================
function calcScore(symbol, inflow, phase, sos) {
  let score = 0;

  if (isSideway(symbol)) score += 30;
  score += Math.min(30, inflow / 50_000);

  if (state[symbol].trades.length > 300) score += 10;
  if (phase === 'Phase C') score += 15;
  if (phase === 'Phase D') score += 20;
  if (sos) score += 15;

  return Math.min(Math.round(score), 100);
}

// ================= SIGNAL LOG =================
function saveSignal(signal) {
  let signals = [];
  if (fs.existsSync(SIGNAL_FILE)) {
    signals = JSON.parse(fs.readFileSync(SIGNAL_FILE));
  }

  const risk = signal.price - signal.stop;
  const target = signal.price + risk * RR_RATIO;

  signals.push({
    ...signal,
    target: Number(target.toFixed(4)),
    evaluated: false,
    result: null
  });

  fs.writeFileSync(SIGNAL_FILE, JSON.stringify(signals, null, 2));
}

function tvLink(symbol) {
  return `https://www.tradingview.com/chart/?symbol=BINANCE:${symbol.toUpperCase()}`;
}

// ================= DETECT =================
async function detect(symbol) {
  if (state[symbol].prices.length < 60) return;

  cleanup(symbol);

  const inflow = netInflowAcceleration(symbol);
  const phase = detectWyckoffPhase(symbol, inflow);
  const sos = detectSOS(symbol, inflow);
  const score = calcScore(symbol, inflow, phase, sos);

  const now = Date.now();
  if (score < 75) return;
  if (now - state[symbol].lastAlert < ALERT_COOLDOWN) return;
  if (state[symbol].lastPhase === phase) return;

  state[symbol].lastAlert = now;
  state[symbol].lastPhase = phase;

  const last = state[symbol].prices.at(-1).price;
  const risk = getRisk(symbol, phase);
  if (!risk) return;

  const message =
`🚨 SMART MONEY SETUP

COIN: ${symbol.toUpperCase()}
Phase: ${phase}
SOS: ${sos ? 'YES' : 'NO'}
Score: ${score}/100
Inflow Acceleration: $${inflow.toFixed(0)}

Price: ${last.toFixed(4)}
Stop-loss: ${risk.stop}
Risk: ${risk.riskPct}%

Chart:
${tvLink(symbol)}

Note: Not a buy signal
Time: ${new Date().toLocaleString()}`;

  await sendTelegram(message);

  saveSignal({
    time: new Date().toISOString(),
    symbol,
    phase,
    score,
    inflowUSD: inflow,
    price: last,
    stop: risk.stop,
    riskPct: risk.riskPct
  });
}

// ================= MAIN =================
async function start() {
  console.log('⏳ Fetching top 100 coins by volume...');
  const res = await axios.get('https://api.binance.com/api/v3/ticker/24hr');

  const symbols = res.data
    .filter(c => c.symbol.endsWith('USDT'))
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
    .slice(0, 100)
    .map(c => c.symbol.toLowerCase());

  symbols.forEach(s => {
    state[s] = {
      trades: [],
      prices: [],
      lastAlert: 0,
      lastPhase: null
    };
  });

  const streams = symbols.map(s => `${s}@trade/${s}@kline_1m`).join('/');
  const ws = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);

  ws.on('open', () => console.log('🚀 Binance WebSocket connected'));

  ws.on('message', msg => {
    const payload = JSON.parse(msg);
    const symbol = payload.stream.split('@')[0];
    if (!state[symbol]) return;

    const data = payload.data;

    if (data.e === 'trade') {
      state[symbol].trades.push({
        time: data.T,
        qty: Number(data.q),
        price: Number(data.p),
        isBuyerMaker: data.m
      });
      detect(symbol);
    }

    if (data.e === 'kline') {
      state[symbol].prices.push({
        time: data.k.T,
        price: Number(data.k.c)
      });
    }
  });
}

start();
