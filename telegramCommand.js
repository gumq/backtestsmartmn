const axios = require("axios");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

let lastUpdateId = 0;
let polling = false;
let lastDailyReport = 0;

// ================= START =================
function startTelegramCommand(state) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("⚠️ Telegram command disabled (env missing)");
    return;
  }

  // ===== COMMAND LISTENER (SMARTMN CHECK) =====
  setInterval(async () => {
    if (polling) return;
    polling = true;

    try {
      const res = await axios.get(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates`,
        {
          params: {
            offset: lastUpdateId + 1,
            timeout: 10,
          },
        }
      );

      const updates = res.data?.result || [];

      for (const update of updates) {
        lastUpdateId = update.update_id;

        const msg = update.message;
        if (!msg) continue;
        if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) continue;

        const text = msg.text?.toLowerCase().trim();
        if (text === "smartmn check") {
          await sendStatus(state, "📣 Manual check");
        }
      }
    } catch (err) {
      console.error("Telegram command error:", err.message);
    } finally {
      polling = false;
    }
  }, 10_000); // 10s là đủ, nhẹ hơn 5s

  // ===== DAILY STATUS REPORT (1 LẦN / NGÀY) =====
  setInterval(async () => {
    const now = Date.now();

    if (now - lastDailyReport < 24 * 60 * 60 * 1000) return;

    lastDailyReport = now;
    await sendStatus(state, "🕒 Daily report");
  }, 60 * 60 * 1000); // check mỗi 1h
}

// ================= STATUS FORMAT =================
async function sendStatus(state, reason = "") {
  const now = Date.now();

  const symbols = Object.keys(state).filter(
    k => typeof state[k] === "object"
  );

  const active = symbols.filter(
    s => state[s]?.activeSignal
  );

  const lastWs =
    state._lastWsTick
      ? `${Math.floor((now - state._lastWsTick) / 1000)}s ago`
      : "N/A";

  const lastDetect =
    state._lastDetectGlobal
      ? `${Math.floor((now - state._lastDetectGlobal) / 1000)}s ago`
      : "N/A";

  const text = `
🤖 SMART MONEY BOT STATUS
${reason ? `(${reason})` : ""}

🟢 Alive: YES
📡 WS tick: ${lastWs}
🔍 Symbols scanned: ${symbols.length}
📊 Active positions: ${active.length}

⏱ Last detect: ${lastDetect}
🕒 Time: ${new Date().toLocaleString()}
`.trim();

  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: TELEGRAM_CHAT_ID,
        text,
      }
    );
  } catch (err) {
    console.error("Telegram send status error:", err.message);
  }
}

module.exports = { startTelegramCommand };
