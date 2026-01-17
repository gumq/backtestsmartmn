// ==================================================
// PORTFOLIO / CAPITAL ALLOCATION AI (G)
// ==================================================

const MAX_PORTFOLIO_RISK = 0.03;   // 3% tổng vốn
const MAX_POSITIONS = 3;

// Correlation groups (đơn giản – đủ dùng)
const CORR_GROUPS = {
  BTC: ['BTCUSDT'],
  ETH: ['ETHUSDT'],
  L1: ['SOLUSDT', 'AVAXUSDT', 'ADAUSDT'],
  MEME: ['DOGEUSDT', 'SHIBUSDT']
};

let portfolio = {
  equity: null,
  openPositions: [] // { symbol, riskPct, group }
};

function getGroup(symbol) {
  for (const g in CORR_GROUPS) {
    if (CORR_GROUPS[g].includes(symbol)) return g;
  }
  return 'OTHER';
}

function totalRisk() {
  return portfolio.openPositions.reduce((s, p) => s + p.riskPct, 0);
}

function groupExposure(group) {
  return portfolio.openPositions
    .filter(p => p.group === group)
    .reduce((s, p) => s + p.riskPct, 0);
}

// ===== CORE DECISION =====
function allocateCapital({ symbol, pWin, baseRiskPct }) {
  const group = getGroup(symbol);

  // 1️⃣ Portfolio full
  if (portfolio.openPositions.length >= MAX_POSITIONS) {
    return { allowed: false, reason: 'MAX_POSITIONS' };
  }

  // 2️⃣ Total risk cap
  if (totalRisk() + baseRiskPct > MAX_PORTFOLIO_RISK) {
    return { allowed: false, reason: 'MAX_PORTFOLIO_RISK' };
  }

  // 3️⃣ Correlation cap (không all-in 1 narrative)
  if (groupExposure(group) + baseRiskPct > MAX_PORTFOLIO_RISK / 2) {
    return { allowed: false, reason: 'CORRELATION_LIMIT' };
  }

  // 4️⃣ AI-weighted sizing
  let multiplier = 1;
  if (pWin >= 0.85) multiplier = 1.5;
  else if (pWin < 0.75) multiplier = 0.5;

  return {
    allowed: true,
    sizeMultiplier: multiplier,
    group
  };
}

function registerPosition({ symbol, riskPct, group }) {
  portfolio.openPositions.push({ symbol, riskPct, group });
}

// ===== portfolio.js =====

function closePosition(symbol) {
  const before = portfolio.openPositions.length;
  portfolio.openPositions = portfolio.openPositions.filter(
    p => p.symbol !== symbol
  );

  if (portfolio.openPositions.length < before) {
    console.log(`✅ PORTFOLIO UPDATE: CLOSED ${symbol}`);
  }
}

module.exports = {
  allocateCapital,
  registerPosition,
  closePosition
};
