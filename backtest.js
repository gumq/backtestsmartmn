// ==================================================
// AUTO BACKTEST ENGINE – QUỸ GRADE (E)
// ==================================================

const axios = require('axios');
const fs = require('fs');

const SYMBOL = 'BTCUSDT';
const START = '2024-01-01';
const END = '2024-03-01';

let balance = 10000;
const RISK_PER_TRADE = 0.01;

let trades = [];
let equity = [];

async function fetchKlines(symbol, interval, start, end) {
  const res = await axios.get('https://api.binance.com/api/v3/klines', {
    params: { symbol, interval, startTime: Date.parse(start), endTime: Date.parse(end), limit: 1000 }
  });

  return res.data.map(k => ({
    time: k[6],
    high: +k[2],
    low: +k[3],
    close: +k[4]
  }));
}

function openTrade(entry, stop, target) {
  const risk = Math.abs(entry - stop);
  const size = (balance * RISK_PER_TRADE) / risk;
  return { entry, stop, target, size };
}

function closeTrade(trade, price, time) {
  const pnl = (price - trade.entry) * trade.size;
  balance += pnl;
  trades.push({ ...trade, exit: price, pnl, balance, time });
  equity.push({ time, balance });
}

async function run() {
  const klines = await fetchKlines(SYMBOL, '1m', START, END);
  let trade = null;

  for (let i = 50; i < klines.length; i++) {
    const c = klines[i];

    if (!trade && Math.random() < 0.02) {
      trade = openTrade(c.close, c.close * 0.99, c.close * 1.03);
    }

    if (trade) {
      if (c.low <= trade.stop) {
        closeTrade(trade, trade.stop, c.time);
        trade = null;
      } else if (c.high >= trade.target) {
        closeTrade(trade, trade.target, c.time);
        trade = null;
      }
    }
  }

  fs.writeFileSync('trades_log.json', JSON.stringify(trades, null, 2));
  fs.writeFileSync('equity_curve.json', JSON.stringify(equity, null, 2));
  console.log('✅ BACKTEST DONE | FINAL BALANCE:', balance.toFixed(2));
}

run();
