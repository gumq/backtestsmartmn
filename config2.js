module.exports = {
  INTERVAL_MINUTES: 5,

  // ===== ACCUMULATION LOGIC =====
  ACCUM_WINDOW_MIN: 45,        // gom trong 45 phút
  OI_ACCUM_PCT: 0.05,          // +5% OI
  PRICE_RANGE_MAX: 0.003,      // < 0.3%
  VOL_RATIO_MAX: 1.2,          // vol không bùng nổ
  FUNDING_MAX: 0.0006,         // funding trung tính

  SYMBOL_LIMIT: 80,

  STABLE_COINS: [
    "USDT", "BUSD", "USDC", "TUSD", "FDUSD", "USD1"
  ],

  ALERT_COOLDOWN_HOURS: 6
};
