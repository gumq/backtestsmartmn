const axios = require('axios');
const crypto = require('crypto');

const BASE = process.env.FUTURES_BASE_URL;

function sign(query, secret) {
  return crypto.createHmac('sha256', secret).update(query).digest('hex');
}

async function signedRequest(method, path, params = {}) {
  const apiKey = process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_API_SECRET;

  const ts = Date.now();
  const query = new URLSearchParams({ ...params, timestamp: ts }).toString();
  const signature = sign(query, secret);

  const url = `${BASE}${path}?${query}&signature=${signature}`;
  const res = await axios({
    method,
    url,
    headers: { 'X-MBX-APIKEY': apiKey }
  });
  return res.data;
}

module.exports = {
  setLeverage: (symbol, leverage) =>
    signedRequest('POST', '/fapi/v1/leverage', { symbol, leverage }),

  getBalance: () =>
    signedRequest('GET', '/fapi/v2/balance'),

  marketBuy: (symbol, qty) =>
    signedRequest('POST', '/fapi/v1/order', {
      symbol,
      side: 'BUY',
      type: 'MARKET',
      quantity: qty
    }),

  marketSell: (symbol, qty) =>
    signedRequest('POST', '/fapi/v1/order', {
      symbol,
      side: 'SELL',
      type: 'MARKET',
      quantity: qty
    }),

  placeStop: (symbol, side, stopPrice, qty) =>
    signedRequest('POST', '/fapi/v1/order', {
      symbol,
      side,
      type: 'STOP_MARKET',
      stopPrice,
      closePosition: true,
      quantity: qty
    }),

  placeTP: (symbol, side, price, qty) =>
    signedRequest('POST', '/fapi/v1/order', {
      symbol,
      side,
      type: 'TAKE_PROFIT_MARKET',
      stopPrice: price,
      closePosition: true,
      quantity: qty
    })
};
