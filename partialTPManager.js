// ==================================================
// PARTIAL TAKE PROFIT MANAGER – FUND GRADE (A+)
// ==================================================

const { executePartialClose } = require("./mockExecutor");

const { addEvent, updateSignal } = require("./telegramNotifier");

// ===== CONFIG =====
const PARTIAL_LEVELS = [
  { rr: 1.0, closePct: 0.35 },
  { rr: 1.5, closePct: 0.25 },
];

// ================= HELPER =================
function getRR(entry, stop, price) {
  return (price - entry) / (entry - stop);
}

// ================= SHOULD PARTIAL TP =================
function shouldPartialTP(activeSignal, price) {
  const { risk, partialTPs = [], remainingSize = 1 } = activeSignal;
  if (remainingSize <= 0) return null;

  const rrNow = getRR(risk.entry, risk.stop, price);

  for (const lvl of PARTIAL_LEVELS) {
    if (rrNow >= lvl.rr && !partialTPs.includes(lvl.rr)) {
      return lvl;
    }
  }

  return null;
}

// ================= EXECUTE PARTIAL TP =================
async function executePartialTP(activeSignal, level, price, state) {
  if (!Array.isArray(activeSignal.partialTPs)) {
    activeSignal.partialTPs = [];
  }

  if (typeof activeSignal.remainingSize !== "number") {
    activeSignal.remainingSize = 1.0;
  }

  const sym = activeSignal.symbol.toLowerCase();
  const s = state[sym];
  if (!s) return;

  if (activeSignal.remainingSize <= 0) return;

  // ===== SAFE CLOSE SIZE =====
  const closePct = Math.min(
    level.closePct,
    activeSignal.remainingSize
  );

  console.log(
    `💰 PARTIAL TP ${activeSignal.symbol} @ ${price.toFixed(4)} | RR=${level.rr} | Close ${(closePct * 100).toFixed(0)}%`
  );

  // ===== PAPER TRADE CLOSE =====
  await executePartialClose({
    symbol: activeSignal.symbol,
    closePct,
    price,
    
    
  });

addEvent(
  activeSignal,
  `💰 Partial TP ${(closePct * 100).toFixed(0)}% @ ${price.toFixed(4)}`
);

await updateSignal(activeSignal);

  // ===== UPDATE STATE =====
  activeSignal.partialTPs.push(level.rr);
  activeSignal.remainingSize -= closePct;
  activeSignal.remainingSize = Math.max(
    0,
    +activeSignal.remainingSize.toFixed(2)
  );

  // ===== MOVE STOP AFTER TP1 =====
  if (level.rr === 1.0) {
    activeSignal.risk.stop = activeSignal.risk.entry;
    console.log(
      `🛡️ MOVE STOP TO BE ${activeSignal.symbol}`
    );
  }
}

module.exports = {
  shouldPartialTP,
  executePartialTP,
};
