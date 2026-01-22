// ==================================================
// TELEGRAM NOTIFIER – SIGNAL TIMELINE (SAFE MODE)
// One Signal = One Message (Edited Over Time)
// NO MARKDOWN (ANTI 400 ERROR)
// ==================================================

const axios = require("axios");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.warn("⚠️ Telegram env not set");
}

// ================= CORE SEND =================
async function sendMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return null;

  try {
    const res = await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: TELEGRAM_CHAT_ID,
        text: String(text),
      }
    );
    return res.data?.result?.message_id;
  } catch (err) {
    console.error(
      "❌ TELEGRAM SEND ERROR:",
      err?.response?.data || err.message
    );
    return null;
  }
}

async function editMessage(messageId, text) {
  if (!messageId) return;

  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`,
      {
        chat_id: TELEGRAM_CHAT_ID,
        message_id: messageId,
        text: String(text),
      }
    );
  } catch (err) {
    console.error(
      "❌ TELEGRAM EDIT ERROR:",
      err?.response?.data || err.message
    );
  }
}

// ================= FORMATTERS =================
function formatHeader(signal) {
  return (
`🟢 ${signal.symbol} | SIGNAL ${signal.score?.grade ?? "N/A"}
Strategy: ${signal.meta?.strategy ?? "N/A"}

Entry: ${signal.risk.entry}
Stop: ${signal.risk.stop}
Target: ${signal.currentTarget ?? signal.risk.target}
RR: ${signal.risk.rr.toFixed(2)}

Absorption score: ${signal.context.absorption.score}
Regime: ${signal.meta?.regime ?? "N/A"}

----------------------------------------`
  );
}

function formatTimeline(events = []) {
  if (!events.length) return "- no updates yet";
  return events.map(e => `- ${e}`).join("\n");
}

// ================= MAIN API =================
async function notifyNewSignal(activeSignal) {
  activeSignal.timeline = activeSignal.timeline || [];

  const text =
    formatHeader(activeSignal) +
    `\nTimeline:\n` +
    formatTimeline(activeSignal.timeline);

  const msgId = await sendMessage(text);
  activeSignal.telegramMessageId = msgId;
}

async function updateSignal(activeSignal) {
  if (!activeSignal.telegramMessageId) return;

  const text =
    formatHeader(activeSignal) +
    `\nTimeline:\n` +
    formatTimeline(activeSignal.timeline);

  await editMessage(activeSignal.telegramMessageId, text);
}

// ================= EVENT HELPER =================
function addEvent(activeSignal, text) {
  if (!activeSignal.timeline) activeSignal.timeline = [];

  activeSignal.timeline.push(
    `${new Date().toLocaleTimeString()} | ${text}`
  );
}

// ================= EXPORT =================
module.exports = {
  notifyNewSignal,
  updateSignal,
  addEvent,
};
