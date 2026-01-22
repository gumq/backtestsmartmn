// ==================================================
// TRAILING TARGET MANAGER – FUND GRADE
// Absorption Decay Based
// ==================================================

const { addEvent, updateSignal } = require("./telegramNotifier");

// ===== CONFIG =====
const MIN_TIME_BETWEEN_TRAILS = 60 * 1000; // 1 phút
const MIN_ABSORPTION_DROP = 2;             // decay bao nhiêu thì trail
const TRAIL_RR_STEP = 0.6;                 // mỗi lần trail thêm 0.6R

// ================= HELPER =================
function getRR(entry, stop, price) {
  return (price - entry) / (entry - stop);
}

// ================= SHOULD TRAIL =================
function shouldTrailTarget(activeSignal, price, currentAbsorptionScore) {
  const now = Date.now();

  // 1️⃣ Cooldown
  if (now - activeSignal.lastTrailTime < MIN_TIME_BETWEEN_TRAILS) {
    return false;
  }

  // 2️⃣ Absorption decay
  const decay =
    activeSignal.initialAbsorptionScore - currentAbsorptionScore;

  if (decay < MIN_ABSORPTION_DROP) return false;

  // 3️⃣ Giá phải đang chạy có lợi
  const rrNow = getRR(
    activeSignal.initialEntry,
    activeSignal.risk.stop,
    price
  );

  if (rrNow < 1.2) return false;

  return true;
}

// ================= EXECUTE TRAIL =================
function trailTarget(activeSignal, price) {
  const entry = activeSignal.initialEntry;
  const stop = activeSignal.risk.stop;

  const currentRR = getRR(entry, stop, activeSignal.currentTarget);
  const newRR = currentRR + TRAIL_RR_STEP;

  const newTarget =
    entry + (entry - stop) * newRR;

  // ===== UPDATE =====
  activeSignal.currentTarget = +newTarget.toFixed(4);
  activeSignal.lastTrailTime = Date.now();

  addEvent(
    activeSignal,
    `🎯 Trail target → ${activeSignal.currentTarget} (RR ${newRR.toFixed(2)})`
  );

  updateSignal(activeSignal);
}

module.exports = {
  shouldTrailTarget,
  trailTarget,
};
