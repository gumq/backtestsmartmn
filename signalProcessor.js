// ==================================================
// SIGNAL PROCESSOR – FUND GRADE (FIXED)
// ==================================================

const { executeLong } = require("./mockExecutor");
const { allocateCapital, registerPosition } = require("./portfolio");
const { logTrade } = require("./tradeLogger");
const { notifyNewSignal } = require("./telegramNotifier");

const TEST_MODE = process.env.TEST_MODE === "true";
const ALERT_COOLDOWN = TEST_MODE ? 60_000 : 15 * 60_000;

// ================= UTILS =================
function clamp(x, min, max) {
  return Math.max(min, Math.min(max, x));
}

// ================= STOP NORMALIZATION =================
function normalizeStop({ risk, context, TEST_MODE }) {
  const entry = risk.entry;
  let stop = risk.stop;

  const absorb = context.absorption.score;
  let mult = 1;
  if (absorb >= 150) mult = 1.8;
  else if (absorb >= 100) mult = 1.5;
  else if (absorb >= 60) mult = 1.3;

  stop = entry - (entry - stop) * mult;

  const atr = context.atr1m || context.atr5m || 0;
  if (atr > 0) stop = Math.min(stop, entry - atr * 1.5);

  const minRisk = TEST_MODE ? 0.01 : 0.012;
  const riskPct = Math.abs(entry - stop) / entry;
  if (riskPct < minRisk) stop = entry * (1 - minRisk);

  return +stop.toFixed(6);
}

// ================= TARGET =================
function adaptiveTarget({ entry, stop, grade, absorptionScore, TEST_MODE }) {
  let rr;
  if (grade === "A+") rr = 2.5;
  else if (grade === "A") rr = 2.2;
  else if (grade === "B") rr = 2.0;
  else return null;

  if (absorptionScore >= 120) rr += 0.3;
  if (absorptionScore >= 180) rr += 0.5;

  return {
    rr: +rr.toFixed(2),
    target: +(entry + (entry - stop) * rr).toFixed(6),
  };
}

// ================= ENTRY CONFIRM =================
function confirmedByTwoCloses(prices, entry) {
  if (!prices || prices.length < 3) return false;
  return prices.slice(-2).every(c => c.price > entry);
}

function reclaimedZone(price, vp, mid) {
  if (vp?.poc && price > vp.poc) return true;
  if (mid && price > mid) return true;
  return false;
}

// ================= MAIN =================
module.exports.processSignal = async function (signal, state) {
  const { symbol, risk, context, meta, score } = signal;
  const sym = symbol.toLowerCase();
  if (!state?.[sym]) return;

  // ===== LIVE MODE FILTER =====
  if (!TEST_MODE && score.grade !== "A+" && score.grade !== "A") return;

  // ===== COOLDOWN =====
  const now = Date.now();
  if (now - state[sym].lastAlert < ALERT_COOLDOWN) return;
  state[sym].lastAlert = now;

  // ===== STOP =====
  risk.stop = normalizeStop({ risk, context, TEST_MODE });

  // ===== TARGET =====
  const adaptive = adaptiveTarget({
    entry: risk.entry,
    stop: risk.stop,
    grade: score.grade,
    absorptionScore: context.absorption.score,
    TEST_MODE,
  });
  if (!adaptive) return;

  risk.target = adaptive.target;
  risk.rr = adaptive.rr;

  // ===== ENTRY CONFIRM =====
  const prices1m = state[sym].prices1m;
  const lastPrice = prices1m?.at(-1)?.price;
  if (!lastPrice) return;

  const pullbackOk =
    lastPrice >= risk.entry * 0.999 &&
    lastPrice <= risk.entry * 1.001;

  const hi = Math.max(...prices1m.map(p => p.price));
  const lo = Math.min(...prices1m.map(p => p.price));
  const mid = (hi + lo) / 2;

  const closeOK = confirmedByTwoCloses(prices1m, risk.entry);
  const reclaimOK = reclaimedZone(lastPrice, context.vp, mid);

  let entryAllowed = false;

  if (score.grade === "A+") entryAllowed = true;
  else if (score.grade === "A")
    entryAllowed = pullbackOk || reclaimOK;
  else if (score.grade === "B")
    entryAllowed = pullbackOk && reclaimOK && closeOK;

  if (!entryAllowed) {
    console.log(`[WAIT] ${symbol} pull=${pullbackOk} reclaim=${reclaimOK} close=${closeOK}`);
    return;
  }

  // ===== SIZE =====
  const baseRisk = Number(process.env.MAX_RISK_PER_TRADE || 0.01);
  let size =
    (score.grade === "A+" ? 1.3 : score.grade === "A" ? 1 : 0.6) *
    (context.absorption.score >= 120 ? 1.2 : 1);

  size = clamp(size, TEST_MODE ? 0.2 : 0.3, 1.3);

  // ===== PORTFOLIO =====
  const alloc = allocateCapital({
    symbol,
    pWin: score.pWin ?? 0.7,
    baseRiskPct: baseRisk * size,
  });
  if (!alloc.allowed) return;

  // ===== EXECUTE =====
  const res = await executeLong({
    symbol,
    entry: risk.entry,
    stop: risk.stop,
    target: risk.target,
    sizeMultiplier: size,
  });
  if (!res?.opened) return;

  // ===== STATE =====
  state[sym].activeSignal = {
    ...signal,
    openedAt: Date.now(),
    initialEntry: risk.entry,
    currentTarget: risk.target,
    timeline: [],
    telegramMessageId: null,
  };

  await notifyNewSignal(state[sym].activeSignal);

  registerPosition({
    symbol,
    riskPct: baseRisk * size,
    group: alloc.group,
  });

  logTrade(signal);
};
