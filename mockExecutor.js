// ==================================================
// MOCK EXECUTOR – PAPER TRADING (NO API KEY)
// Fund-grade Risk Controlled
// ==================================================

const fs = require("fs");

// ================= CONFIG =================
const START_BALANCE = 10;

// 🧪 TEST MODE DEFAULTS (sẽ tuning sau)
const RISK_PER_TRADE = 0.05;          // 5% balance / trade
const MAX_RISK_USDT = 0.5;            // max $0.5 loss / trade
const MAX_POSITION_VALUE_PCT = 0.3;   // max 30% balance
const MIN_STOP_PCT = 0.004;           // min 0.4% stop
const MAX_DRAWDOWN_PCT = 30;          // kill switch

// ================= STATE =================
let balance = START_BALANCE;
let peakBalance = START_BALANCE;
let openPositions = {}; // symbol -> position

// ================= CALLBACK =================
let onPositionClosedCallback = null;
function onPositionClosed(cb) {
  onPositionClosedCallback = cb;
}

// ================= LOGGING =================
const LOG_FILE = "./mock_trades.json";

function logTrade(data) {
  let logs = [];
  if (fs.existsSync(LOG_FILE)) {
    try {
      logs = JSON.parse(fs.readFileSync(LOG_FILE));
    } catch {
      logs = [];
    }
  }
  logs.push(data);
  fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
}
function executePartialClose(symbol, closePct, price) {
  const reason = "PARTIAL_TP"
  const pos = openPositions[symbol];
  if (!pos) return null;

  const closeQty = pos.qty * closePct;
  const pnl = (price - pos.entry) * closeQty;

  pos.qty -= closeQty;
  balance += pnl;
  peakBalance = Math.max(peakBalance, balance);

  console.log(
    `🧪 MOCK PARTIAL CLOSE ${symbol} | ${reason} | qty=${closeQty.toFixed(
      4
    )} | PnL=${pnl.toFixed(2)}`
  );

  logTrade({
    type: "PARTIAL_CLOSE",
    symbol,
    entry: pos.entry,
    exit: price,
    qty: closeQty,
    pnl,
    balance,
    reason,
    time: new Date().toISOString(),
  });

  // Nếu đóng gần hết → đóng luôn
  if (pos.qty <= pos.qty * 0.05) {
    closePosition(symbol, price, "FINAL_AFTER_PARTIAL");
  }

  return {
    closedQty: closeQty,
    remainingQty: pos.qty,
    pnl,
    balance,
  };
}

// ================= POSITION SIZING =================
function calcPositionSize({ entry, stop, sizeMultiplier }) {
  const stopDistance = Math.abs(entry - stop);
  if (stopDistance <= 0) return 0;

  const stopPct = stopDistance / entry;
  if (stopPct < MIN_STOP_PCT) {
    console.log(
      `⚠️ SKIP – STOP TOO TIGHT (${(stopPct * 100).toFixed(2)}%)`
    );
    return 0;
  }

  // Risk capped by % and absolute $
  const riskUSDT = Math.min(
    balance * RISK_PER_TRADE * sizeMultiplier,
    MAX_RISK_USDT
  );

  let qty = riskUSDT / stopDistance;

  // Cap max position value
  const maxPositionValue = balance * MAX_POSITION_VALUE_PCT;
  if (qty * entry > maxPositionValue) {
    qty = maxPositionValue / entry;
  }

  return Number(qty.toFixed(4));
}

// ==================================================
// OPEN POSITION
// ==================================================
async function executeLong({
  symbol,
  entry,
  stop,
  target,
  sizeMultiplier = 1,
}) {
  if (openPositions[symbol]) return { opened: false };

  const qty = calcPositionSize({ entry, stop, sizeMultiplier });
  if (qty <= 0) return { opened: false };

  openPositions[symbol] = {
    symbol,
    entry,
    stop,
    target,
    qty,
    openedAt: Date.now(),
  };

  console.log(
    `🧪 MOCK OPEN ${symbol} | entry=${entry.toFixed(4)} qty=${qty}`
  );

  logTrade({
    type: "OPEN",
    symbol,
    entry,
    stop,
    target,
    qty,
    balance,
    time: new Date().toISOString(),
  });

  return { opened: true, position: openPositions[symbol] };
}

// ==================================================
// PRICE UPDATE (CALL EACH TICK)
// ==================================================
function onPriceTick(symbol, price) {
  const pos = openPositions[symbol];
  if (!pos) return;

  if (price <= pos.stop) {
    closePosition(symbol, pos.stop, "STOP");
    return;
  }

  if (price >= pos.target) {
    closePosition(symbol, pos.target, "TARGET");
    return;
  }
}

// ==================================================
// CLOSE POSITION
// ==================================================
function closePosition(symbol, exitPrice, reason) {
  const pos = openPositions[symbol];
  if (!pos) return;

  const pnl = (exitPrice - pos.entry) * pos.qty;
  balance += pnl;
  peakBalance = Math.max(peakBalance, balance);

  const drawdownPct =
    peakBalance > 0
      ? ((peakBalance - balance) / peakBalance) * 100
      : 0;

  console.log(
    `🧪 MOCK CLOSE ${symbol} | ${reason} | PnL=${pnl.toFixed(
      2
    )} | Balance=${balance.toFixed(2)} | DD=${drawdownPct.toFixed(2)}%`
  );

  logTrade({
    type: "CLOSE",
    symbol,
    entry: pos.entry,
    exit: exitPrice,
    qty: pos.qty,
    pnl,
    balance,
    drawdownPct: Number(drawdownPct.toFixed(2)),
    reason,
    time: new Date().toISOString(),
  });

  delete openPositions[symbol];

  // ===== CALLBACK =====
  if (typeof onPositionClosedCallback === "function") {
    onPositionClosedCallback(symbol, {
      exitPrice,
      pnl,
      reason,
      balance,
      drawdownPct,
    });
  }

  // ===== KILL SWITCH =====
  if (drawdownPct >= MAX_DRAWDOWN_PCT) {
    console.error("⛔ MAX DRAWDOWN HIT – STOP TRADING");
    process.exit(1);
  }
}

// ==================================================
// EXPORTS
// ==================================================
module.exports = {
  executeLong,
  onPriceTick,
  onPositionClosed,
  executePartialClose
};
