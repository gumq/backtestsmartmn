// ==================================================
// SIGNAL VALIDATOR – FUND GRADE
// AI + RR + SIGNAL GRADING (A / B / C)
// ==================================================

const fs = require("fs");
require("dotenv").config();

const TEST_MODE = process.env.TEST_MODE === "true";
const AI_MODEL_FILE = "./ai_model.json";

// ================= AI CORE =================
function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function predictWinProbability(features) {
  if (!fs.existsSync(AI_MODEL_FILE)) return null;

  try {
    const raw = fs.readFileSync(AI_MODEL_FILE, "utf8").trim();
    if (!raw) return null; // file rỗng

    const weights = JSON.parse(raw);
    if (!Array.isArray(weights)) return null;

    const z = features.reduce(
      (s, x, i) => s + x * (weights[i] ?? 0),
      0
    );
    return sigmoid(z);
  } catch (err) {
    console.error("[AI] Model parse error → fallback", err.message);
    return null;
  }
}


// ================= GRADE LOGIC =================
function gradeSignal({ pWin, rr, absorptionScore }) {
  // ===== LIVE MODE (NGHIÊM) =====
  if (!TEST_MODE) {
if (rr >= 2.2 && pWin >= 0.78 && absorptionScore >= 7) return "A+";
if (rr >= 1.8 && pWin >= 0.70 && absorptionScore >= 4) return "A";
if (rr >= 1.4 && absorptionScore >= 3) return "B";
    return null;
  }

  // ===== TEST MODE (NỚI) =====
  if (rr >= 1.8 && absorptionScore >= 6) return "A";
  if (rr >= 1.2 && absorptionScore >= 2) return "B";
  if (rr >= 0.7) return "C";
  if (rr < 0.4) return "D";
  return null;
}

// ================= MAIN VALIDATOR =================
function validateSignal(signal, state) {
  const { risk, context, meta } = signal;

  if (!risk || !context || !meta) return false;

  // ================= RR FILTER =================
  const minRR = TEST_MODE ? 0.1 : 1.5;
  if (risk.rr < minRR) return false;

  // ================= BUILD AI FEATURES =================
  const features = [
    (context.absorption?.score ?? 0) / 10,
    (context.cvdSlope ?? 0) / 100000,
    Math.abs((risk.entry - context.vp.poc) / risk.entry),
    risk.rr,
    context.mtf.p1m === "Phase C" ? 1 : 0,
    context.mtf.p1m === "Phase D" ? 1 : 0,
    context.mtf.p15m === "Phase B" ? 1 : 0,
    meta.regime !== "RISK_OFF" ? 1 : 0,
  ];

  const pWin = predictWinProbability(features);

  // ================= AI FILTER =================
  if (!TEST_MODE && pWin !== null) {
    const minPwin =
      meta.regime === "RISK_OFF"
        ? Number(process.env.RISK_OFF_MIN_PWIN || 0.78)
        : Number(process.env.BASE_MIN_PWIN || 0.72);

    if (pWin < minPwin) return false;
  }

  // ================= GRADE =================
  let grade = gradeSignal({
    pWin: pWin ?? 0.65,
    rr: risk.rr,
    absorptionScore: context.absorption.score,
  });

  // ===== TEST MODE FALLBACK =====
  if (!grade && TEST_MODE) {
    grade = "C";
  }

  if (!grade) return false;

  // ================= ENRICH SIGNAL =================
  signal.score = {
    pWin: pWin ?? 0.65,
    grade,
    expectancy:
      pWin !== null
        ? +(pWin * risk.rr - (1 - pWin)).toFixed(3)
        : null,
  };

  signal.filters = {
    passedRR: true,
    passedAI: TEST_MODE ? "SKIPPED" : true,
    grade,
  };

  return true;
}

module.exports = { validateSignal };
