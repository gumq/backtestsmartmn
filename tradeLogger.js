const fs = require("fs");

module.exports.logTrade = function (signal) {
  const log = {
    id: `${signal.symbol}_${signal.timestamp}`,
    time: new Date().toISOString(),
    symbol: signal.symbol,

    features: {
      absorptionScore: signal.context.absorption.score,
      rr: signal.risk.rr,
      regime: signal.context.regime,
      mtf: signal.context.mtf,
    },

    decision: {
      entry: signal.risk.entry,
      stop: signal.risk.stop,
      target: signal.risk.target,
      pWin: signal.score.pWin,
    },

    outcome: null,
  };

  fs.appendFileSync("trade_log.jsonl", JSON.stringify(log) + "\n");
};
