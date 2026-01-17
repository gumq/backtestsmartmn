require('dotenv').config();
const Binance = require('./binance');

let tradesToday = 0;
let peakEquity = null;
let tradingHalted = false;

// ===== SAFETY =====
function checkKillSwitch(equity) {
  if (peakEquity === null) peakEquity = equity;
  peakEquity = Math.max(peakEquity, equity);

  const dd = (peakEquity - equity) / peakEquity;
  if (dd >= Number(process.env.MAX_DRAWDOWN_PCT)) {
    tradingHalted = true;
    console.log('🛑 KILL SWITCH: MAX DRAWDOWN HIT');
  }
}

async function getUSDTBalance() {
  const balances = await Binance.getBalance();
  const usdt = balances.find(b => b.asset === 'USDT');
  return Number(usdt.balance);
}

// ===== POSITION SIZING =====
function calcPositionSize({ balance, entry, stop, leverage, sizeMultiplier }) {
  const riskPct = Number(process.env.MAX_RISK_PER_TRADE);
  const riskUSDT = balance * riskPct * sizeMultiplier;
  const riskPerUnit = Math.abs(entry - stop);
  const qty = (riskUSDT / riskPerUnit) * leverage;
  return Number(qty.toFixed(3));
}


// ===== EXECUTE TRADE =====
async function executeLong({ symbol, entry, stop, target, sizeMultiplier = 1 }) {
  if (tradingHalted) return;

  const leverage = Number(process.env.DEFAULT_LEVERAGE);
  await Binance.setLeverage(symbol, leverage);

  const balance = await getUSDTBalance();
  checkKillSwitch(balance);

  const qty = calcPositionSize({
    balance,
    entry,
    stop,
    leverage,
    sizeMultiplier
  });

  await Binance.marketBuy(symbol, qty);
  await Binance.placeStop(symbol, 'SELL', stop, qty);
  await Binance.placeTP(symbol, 'SELL', target, qty);
}


module.exports = { executeLong };
