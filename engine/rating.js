// rating.js — Glicko-2 (Glickman), the rating system under lichess. Pure.
// One exported update: a player {r, rd, vol} plus a set of results against
// known opponents -> the new {r, rd, vol}. Tested against the worked example
// in Glickman's paper (r 1500/RD 200 vs three opponents -> 1464.06/151.52).
const SCALE = 173.7178;
const TAU = 0.5;

export const freshRating = () => ({ r: 1200, rd: 350, vol: 0.06 });

export function glicko2(player, results) {
  // results: [{r, rd, score}] — score 1 win, 0 loss, .5 draw
  if (!results.length) {
    // inactivity: RD drifts up
    const phi = player.rd / SCALE;
    return { ...player, rd: Math.min(350, Math.sqrt(phi * phi + player.vol * player.vol) * SCALE) };
  }
  const mu = (player.r - 1500) / SCALE;
  const phi = player.rd / SCALE;
  const g = (phiJ) => 1 / Math.sqrt(1 + 3 * phiJ * phiJ / (Math.PI * Math.PI));
  const E = (muJ, phiJ) => 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));

  let vInv = 0, deltaSum = 0;
  for (const o of results) {
    const muJ = (o.r - 1500) / SCALE, phiJ = o.rd / SCALE;
    const gj = g(phiJ), e = E(muJ, phiJ);
    vInv += gj * gj * e * (1 - e);
    deltaSum += gj * (o.score - e);
  }
  const v = 1 / vInv;
  const delta = v * deltaSum;

  // volatility iteration (Illinois algorithm per the paper)
  const a = Math.log(player.vol * player.vol);
  const f = (x) => {
    const ex = Math.exp(x);
    const num = ex * (delta * delta - phi * phi - v - ex);
    const den = 2 * Math.pow(phi * phi + v + ex, 2);
    return num / den - (x - a) / (TAU * TAU);
  };
  let A = a, B;
  if (delta * delta > phi * phi + v) B = Math.log(delta * delta - phi * phi - v);
  else { let k = 1; while (f(a - k * TAU) < 0) k++; B = a - k * TAU; }
  let fA = f(A), fB = f(B);
  for (let i = 0; i < 100 && Math.abs(B - A) > 1e-6; i++) {
    const C = A + (A - B) * fA / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) { A = B; fA = fB; } else fA = fA / 2;
    B = C; fB = fC;
  }
  const volNew = Math.exp(A / 2);
  const phiStar = Math.sqrt(phi * phi + volNew * volNew);
  const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muNew = mu + phiNew * phiNew * deltaSum;
  return {
    r: Math.round((muNew * SCALE + 1500) * 100) / 100,
    rd: Math.round(phiNew * SCALE * 100) / 100,
    vol: volNew,
  };
}

// the ladder's opposition, measured rather than declared: least-squares fit
// to 150 simulated 20-hand matches per pairing (2026-08, strategy iteration
// in play/strategy-hulimit.json), smoothed monotone — the top three rungs
// are genuinely close, the cliff is Lv5 down to Lv2
export const LEVEL_RATING = { 2: 1370, 3: 1420, 4: 1455, 5: 1485, 6: 1490, 7: 1500 };
export const LEVEL_RD = 60;
