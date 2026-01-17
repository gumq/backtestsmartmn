// ==================================================
// MOCK EXECUTOR – PAPER TRADING (NO API KEY)
// ==================================================

const fs = require('fs');

const START_BALANCE = 10;
const RISK_PER_TRADE = 0.2; // 20% of balance

let balance = START_BALANCE;
let peakBalance = START_BALANCE;
let openPositions = {}; // symbol -> position

const LOG_FILE = './mock_trades.json';

function logTrade(data) {
  let logs = [];
  if (fs.existsSync(LOG_FILE)) {
    logs = JSON.parse(fs.readFileSync(LOG_FILE));
  }
  logs.push(data);
  fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
}

// ===== POSITION SIZING =====
function calcPositionSize({ entry, stop, sizeMultiplier }) {
  const riskUSDT = balance * RISK_PER_TRADE * sizeMultiplier;
  const riskPerUnit = Math.abs(entry - stop);
  return Number((riskUSDT / riskPerUnit).toFixed(4));
}

// ===== OPEN POSITION =====
async function executeLong({ symbol, entry, stop, target, sizeMultiplier = 1 }) {
  if (openPositions[symbol]) return;

  const qty = calcPositionSize({ entry, stop, sizeMultiplier });

  openPositions[symbol] = {
    symbol,
    entry,
    stop,
    target,
    qty,
    openedAt: Date.now()
  };

  console.log(
    `🧪 MOCK OPEN ${symbol} | entry=${entry.toFixed(4)} qty=${qty}`
  );

  logTrade({
    type: 'OPEN',
    symbol,
    entry,
    stop,
    target,
    qty,
    balance,
    time: new Date().toISOString()
  });
}

// ===== PRICE UPDATE (CALL EACH TICK) =====
function onPriceTick(symbol, price) {
  const pos = openPositions[symbol];
  if (!pos) return;

  // Stop loss
  if (price <= pos.stop) {
    closePosition(symbol, pos.stop, 'STOP');
  }

  // Take profit
  if (price >= pos.target) {
    closePosition(symbol, pos.target, 'TARGET');
  }
}

// ===== CLOSE POSITION =====
function closePosition(symbol, exitPrice, reason) {
  const pos = openPositions[symbol];
  if (!pos) return;

  const pnl = (exitPrice - pos.entry) * pos.qty;
  balance += pnl;
  peakBalance = Math.max(peakBalance, balance);

  const dd = ((peakBalance - balance) / peakBalance) * 100;

  console.log(
    `🧪 MOCK CLOSE ${symbol} | ${reason} | PnL=${pnl.toFixed(2)} | Balance=${balance.toFixed(2)}`
  );

  logTrade({
    type: 'CLOSE',
    symbol,
    entry: pos.entry,
    exit: exitPrice,
    qty: pos.qty,
    pnl,
    balance,
    drawdownPct: Number(dd.toFixed(2)),
    reason,
    time: new Date().toISOString()
  });

  delete openPositions[symbol];
}

module.exports = {
  executeLong,
  onPriceTick
};
