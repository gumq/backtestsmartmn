// ==================================================
// VOLUME PROFILE MODULE
// ==================================================

function getVPLevels(symbol, state, TEST_MODE) {
  const s = state[symbol];
  if (!s || !s.volumeProfile) return null;

  const vp = s.volumeProfile;
  const MIN_VP_BINS = TEST_MODE ? 3 : 10;

  if (Object.keys(vp).length < MIN_VP_BINS) return null;

  const levels = Object.entries(vp).sort((a, b) => b[1] - a[1]);

  return {
    poc: Number(levels[0][0]),
    hvn: levels.slice(0, 3).map(l => Number(l[0])),
    lvn: levels.slice(-3).map(l => Number(l[0])),
  };
}

module.exports = { getVPLevels };
