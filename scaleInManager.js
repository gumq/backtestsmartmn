// ==================================================
// SCALE-IN MANAGER – FUND GRADE (A+ ONLY)
// ==================================================
require("dotenv").config();
const { executeLong } = require("./mockExecutor");
const { addEvent, updateSignal } = require("./telegramNotifier");
const TEST_MODE = process.env.TEST_MODE === "true";
// ================= CONFIG =================
const MAX_SCALE_INS = 1;
const MIN_ABSORPTION_SCORE = TEST_MODE ? 2.0 : 4.0;
const MIN_RR_BEFORE_SCALE = 0.8;

// Size scale-in theo grade
const SCALE_IN_SIZE_BY_GRADE = {
  "A+": 0.6,
  "A": 0.4,
};

// ================= HELPER =================
function getSymbolState(signal, state) {
  return state?.[signal.symbol.toLowerCase()];
}

// ================= SHOULD SCALE-IN =================
function shouldScaleIn(activeSignal, price, state) {
  const s = getSymbolState(activeSignal, state);
  if (activeSignal.remainingSize <= 0) return false;
  if (!s) return false;

  // 1️⃣ Max scale-in
  if (s.scaleIns >= MAX_SCALE_INS) return false;

  // 2️⃣ Grade filter
  const grade = activeSignal.score?.grade;
  if (!["A+", "A"].includes(grade)) return false;

  // 3️⃣ Absorption hiện tại
  const absorptionNow = activeSignal.context?.absorption?.score ?? 0;
  if (absorptionNow < MIN_ABSORPTION_SCORE) return false;

  // 4️⃣ Absorption decay check (QUAN TRỌNG)
  const initialAbs = activeSignal.initialAbsorptionScore ?? absorptionNow;
  if (absorptionNow < initialAbs * 0.6) return false;

  // 5️⃣ RR phải đạt theo INITIAL RISK
  const entry = activeSignal.initialEntry ?? activeSignal.risk.entry;
  const stop = activeSignal.risk.stop;

  const initialRisk = Math.abs(entry - stop);
  if (initialRisk <= 0) return false;

  const rrAchieved = (price - entry) / initialRisk;
  if (rrAchieved < MIN_RR_BEFORE_SCALE) return false;

  // 6️⃣ Không phá setup
  if (price <= stop) return false;

  // 7️⃣ Pullback nông
  const pullbackPct = Math.abs(price - entry) / entry;
  if (pullbackPct > 0.003) return false;

  return true;
}

// ================= EXECUTE SCALE-IN =================
async function executeScaleIn(activeSignal, price, state) {
  const s = getSymbolState(activeSignal, state);
  if (!s) return;

  const grade = activeSignal.score?.grade;
  const sizeMultiplier = SCALE_IN_SIZE_BY_GRADE[grade] ?? 0.3;

  console.log(
    `➕ SCALE-IN ${activeSignal.symbol} (${grade}) @ ${price.toFixed(4)}`
  );

  // Executor mock không trả result → cứ execute
  await executeLong({
    symbol: activeSignal.symbol,
    entry: price,
    stop: activeSignal.risk.stop,
    target: activeSignal.risk.target,
    sizeMultiplier,
  });

addEvent(
  activeSignal,
  `➕ Scale-in @ ${price.toFixed(4)}`
);

await updateSignal(activeSignal);

  // ===== UPDATE STATE =====
  s.scaleIns += 1;

  // ===== LOGICAL NOTE =====
  if (s.scaleIns === 1) {
    activeSignal.meta = activeSignal.meta || {};
    activeSignal.meta.scaleInLogic = "RR_PAID + ABSORPTION_STRONG";

    console.log(
      `🧠 SCALE-IN CONFIRMED (logic-based) ${activeSignal.symbol}`
    );
  }
}

module.exports = {
  shouldScaleIn,
  executeScaleIn,
};
