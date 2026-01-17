// ==================================================
// BINANCE FUTURES USER DATA STREAM
// Detect TP / SL / manual close
// ==================================================

require('dotenv').config();
const WebSocket = require('ws');
const axios = require('axios');

const { closePosition } = require('./portfolio');

const BASE = process.env.FUTURES_BASE_URL;
const API_KEY = process.env.BINANCE_API_KEY;

let listenKey = null;

async function getListenKey() {
  const res = await axios.post(
    `${BASE}/fapi/v1/listenKey`,
    {},
    { headers: { 'X-MBX-APIKEY': API_KEY } }
  );
  return res.data.listenKey;
}

async function keepAlive() {
  if (!listenKey) return;
  await axios.put(
    `${BASE}/fapi/v1/listenKey`,
    {},
    { headers: { 'X-MBX-APIKEY': API_KEY } }
  );
}

async function startUserStream() {
  listenKey = await getListenKey();
  console.log('🔑 UserStream listenKey OK');

  const ws = new WebSocket(
    `wss://fstream.binance.com/ws/${listenKey}`
  );

  ws.on('message', msg => {
    const data = JSON.parse(msg);

    // ===== ORDER UPDATE =====
    if (data.e === 'ORDER_TRADE_UPDATE') {
      const o = data.o;

      // Position fully closed
      if (
        o.X === 'FILLED' &&
        o.reduceOnly === true &&
        Number(o.positionAmt) === 0
      ) {
        const symbol = o.s;
        closePosition(symbol);
      }
    }
  });

  // Keep listenKey alive every 30 min
  setInterval(keepAlive, 30 * 60 * 1000);
}

module.exports = { startUserStream };
