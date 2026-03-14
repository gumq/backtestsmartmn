// ==================================================
// TELEGRAM NOTIFIER – TV BOX SAFE (NO POLLING)
// Fire & Forget + Backoff + Anti-Die
// ==================================================

const axios = require("axios");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ===== INTERNAL STATE =====
let telegramDisabled = false;
let retryAfter = 0;

// ===== CONFIG =====
const REQUEST_TIMEOUT = 8_000;        // 8s là đủ
const BACKOFF_TIME = 10 * 60 * 1000;  // 10 phút nghỉ khi lỗi

// ================= UTILS =================
function canSend() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
  if (telegramDisabled) return false;
  if (Date.now() < retryAfter) return false;
  return true;
}

function markTelegramError() {
  retryAfter = Date.now() + BACKOFF_TIME;
}

// ================= CORE SEND =================
async function safeSend(payload) {
  if (!canSend()) return null;

  try {
    const res = await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      payload,
      { timeout: REQUEST_TIMEOUT }
    );
    return res.data?.result;
  } catch (err) {
    // ❌ KHÔNG SPAM LOG
    markTelegramError();
    return null;
  }
}

// ================= EDIT MESSAGE =================
async function safeEdit(payload) {
  if (!canSend()) return;

  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`,
      payload,
      { timeout: REQUEST_TIMEOUT }
    );
  } catch (err) {
    markTelegramError();
  }
}

// ================= FORMAT =================
function formatHeader(signal) {
  return `
🟢 *${signal.symbol} | SIGNAL ${signal.score.grade}*
Strategy: ${signal.meta?.strategy || "N/A"}

Entry: ${signal.risk.entry}
Stop: ${signal.risk.stop}
Target: ${signal.currentTarget || signal.risk.target}
RR: ${signal.risk.rr}

Absorption: ${signal.context?.absorption?.score}
Regime: ${signal.context?.regime || signal.meta?.regime}

━━━━━━━━━━━━━━━━━━
`.trim();
}

function formatTimeline(timeline) {
  if (!timeline || !timeline.length) return "_(no updates yet)_";
  return timeline.map(e => `• ${e}`).join("\n");
}

// ================= PUBLIC API =================
async function notifyNewSignal(activeSignal) {
  const text =
    formatHeader(activeSignal) +
    `\n\n📌 *Timeline*\n` +
    formatTimeline(activeSignal.timeline);

  const result = await safeSend({
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });

  if (result?.message_id) {
    activeSignal.telegramMessageId = result.message_id;
  }
}

async function updateSignal(activeSignal) {
  if (!activeSignal.telegramMessageId) return;

  const text =
    formatHeader(activeSignal) +
    `\n\n📌 *Timeline*\n` +
    formatTimeline(activeSignal.timeline);

  await safeEdit({
    chat_id: TELEGRAM_CHAT_ID,
    message_id: activeSignal.telegramMessageId,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });
}

function addEvent(activeSignal, text) {
  if (!activeSignal.timeline) activeSignal.timeline = [];
  activeSignal.timeline.push(
    `${new Date().toLocaleTimeString()} – ${text}`
  );
}

// ================= EXPORT =================
module.exports = {
  notifyNewSignal,
  updateSignal,
  addEvent,
};
