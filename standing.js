// standing.js: where a hand stands. The sums behind the hand ladder, with no page code in them,
// so the limit table and the no-limit trainer (and tests) share one copy.
//   ladder(hole, board, lp)       every hand the other player could hold, by rung, and the share you beat
//   byTheRiver(hole, board, L)    chance of winning at showdown with the cards still to come
//   rangeWeights(lp, board, pairs) how likely each possible hand was to play the way the bot has
// lp is the read-only view a page exposes as window.__lp (see app.js and nl-ladder.html).
import { evaluate, rankOf } from './engine/poker.js';
import { HU, streetBucket } from './engine/ladder.js';

// Win chance of each starting hand against a random hand, all-in before the flop
// (Monte Carlo, 40,000 deals each, with this site's own evaluator).
export const PREFLOP = {"22":50.1,"33":53.5,"44":57,"55":60.6,"66":62.9,"77":66.6,"88":69.1,"99":71.7,"AA":85,"AKs":67,"AKo":65.6,"AQs":66.3,"AQo":64.5,"AJs":65.3,"AJo":63.3,"ATs":64.8,"ATo":62.2,"A9s":62.6,"A9o":60.8,"A8s":61.7,"A8o":59.8,"A7s":61.1,"A7o":58.8,"A6s":59.8,"A6o":57.3,"A5s":59.5,"A5o":57.6,"A4s":59,"A4o":56.3,"A3s":58.4,"A3o":55.9,"A2s":57.7,"A2o":54.9,"KK":82.2,"KQs":63.7,"KQo":61.4,"KJs":62.5,"KJo":60.4,"KTs":62,"KTo":59.7,"K9s":60.2,"K9o":57.8,"K8s":58.4,"K8o":55.7,"K7s":56.9,"K7o":55.5,"K6s":56.2,"K6o":54,"K5s":55.4,"K5o":53.4,"K4s":55.3,"K4o":52.4,"K3s":53.7,"K3o":51.7,"K2s":53.5,"K2o":50.5,"QQ":80,"QJs":60.2,"QJo":58,"QTs":59.7,"QTo":57.7,"Q9s":57.4,"Q9o":55.6,"Q8s":55.9,"Q8o":53.3,"Q7s":54.1,"Q7o":51.4,"Q6s":53,"Q6o":51,"Q5s":52.6,"Q5o":50,"Q4s":51.7,"Q4o":48.7,"Q3s":51.1,"Q3o":48.1,"Q2s":50.2,"Q2o":47.4,"JJ":77.5,"JTs":57.8,"JTo":55.3,"J9s":55.7,"J9o":53.1,"J8s":53.9,"J8o":51.7,"J7s":52.2,"J7o":49.3,"J6s":50.1,"J6o":48.1,"J5s":50.2,"J5o":46.9,"J4s":49.6,"J4o":46,"J3s":48.1,"J3o":45,"J2s":47.8,"J2o":43.9,"TT":75.2,"T9s":53.8,"T9o":51.6,"T8s":52.1,"T8o":50,"T7s":50.7,"T7o":48,"T6s":48.8,"T6o":46,"T5s":47.5,"T5o":44.4,"T4s":46.6,"T4o":43.1,"T3s":45.6,"T3o":42.6,"T2s":44.8,"T2o":42.2,"98s":50.4,"98o":48,"97s":49.5,"97o":46.3,"96s":47.2,"96o":44.4,"95s":45.5,"95o":42.7,"94s":43.7,"94o":40.7,"93s":43.9,"93o":40.4,"92s":42.2,"92o":39.1,"87s":48.4,"87o":45,"86s":46.4,"86o":43.5,"85s":44.4,"85o":41.4,"84s":42.7,"84o":39.4,"83s":40.7,"83o":37.7,"82s":40.3,"82o":37.1,"76s":45.4,"76o":42.1,"75s":43.8,"75o":40.3,"74s":41.8,"74o":38.7,"73s":39.7,"73o":36.5,"72s":38.3,"72o":34.3,"65s":43.3,"65o":39.7,"64s":40.8,"64o":37.7,"63s":39.7,"63o":35.9,"62s":37.6,"62o":33.5,"54s":41.3,"54o":38.3,"53s":39.8,"53o":36.4,"52s":37.8,"52o":33.8,"43s":38.9,"43o":35.1,"42s":36.8,"42o":33.2,"32s":36.1,"32o":32.4};

// ---- the rungs --------------------------------------------------------------
// Each hand lands on one rung. Pairs are split by where the pair sits on this board,
// because "a pair" hides the difference between an overpair and bottom pair.
export const RUNGS = ['Straight flush', 'Four of a kind', 'Full house', 'Flush', 'Straight', 'Three of a kind', 'Two pair',
  'Overpair', 'Top pair', 'Middle pair', 'Bottom pair', 'Underpair', 'Ace high', 'No pair'];
export function rungOf(hole, board, ev) {
  if (ev.cat >= 2) return 8 - ev.cat;                       // 8..2 -> rungs 0..6
  const bRanks = [...new Set(board.map(rankOf))].sort((a, b) => b - a);
  const h0 = rankOf(hole[0]), h1 = rankOf(hole[1]);
  if (ev.cat === 1) {
    const pr = ev.kick[0];
    const mine = h0 === pr || h1 === pr;                    // do my cards make the pair?
    if (mine) {
      if (h0 === h1) return pr > bRanks[0] ? 7 : 11;        // pocket pair: over or under the board
      if (pr === bRanks[0]) return 8;
      if (pr === bRanks[bRanks.length - 1]) return 10;
      return 9;
    }
    // the pair is on the board itself: everyone has it, so the hand is its high card
  }
  return Math.max(h0, h1) === 12 ? 12 : 13;
}

// ---- their range ------------------------------------------------------------
// The bot plays a published strategy table: for each (street, hand bucket, betting so far)
// it gives how often to check/call, bet/raise or fold. So for every hand the bot could hold
// we can ask how likely that hand was to play the way the bot actually has, and weigh the
// ladder by it. Exact against the bot (blended with its level's random play); river actions
// use the table as an approximation, since the live river is solved on the spot.
const LEVEL_EPS = { 2: 0.45, 3: 0.3, 4: 0.2, 5: 0.12, 6: 0.06, 7: 0 };
const BOARD_AT = [0, 3, 4, 5];
const bucketCache = new Map();
function bucketFor(street, opp, board) {
  const b = board.slice(0, BOARD_AT[street]);
  const key = street + ':' + opp[0] + ',' + opp[1] + ':' + b.join(',');
  let v = bucketCache.get(key);
  if (v === undefined) { if (bucketCache.size > 20000) bucketCache.clear(); v = streetBucket(street, opp, b); bucketCache.set(key, v); }
  return v;
}
// The bot's decisions so far this hand, replayed through the same betting walker it was trained on.
function botDecisions(lp) {
  const h = lp.hand; if (!h || !lp.table || !Array.isArray(h.log)) return null;
  const botSeat = 1 - lp.heroSeat;
  let st = HU.initial(); const out = [];
  for (const e of h.log) {
    const a = e.ev === 'fold' ? 'f' : (e.ev === 'check' || e.ev === 'call') ? 'k' : (e.ev === 'bet' || e.ev === 'raise') ? 'b' : null;
    if (!a) continue;
    if (st.done) break;
    if ((st.actor === 0) !== (e.seat === h.button)) return null;      // the walker and the hand disagree: do not guess
    const acts = HU.actions(st), idx = acts.indexOf(a);
    if (idx < 0) return null;
    if (e.seat === botSeat) out.push({ street: st.street, hist: st.rounds.slice(0, st.street + 1).join('/'), n: acts.length, idx });
    st = HU.apply(st, a);
  }
  return out;
}
// The same, for a page whose game is its own betting walker (the no-limit trainer): it hands over
// the walker (lp.game), the action letters so far by street (lp.rounds) and the bot's seat in it.
function walkDecisions(lp) {
  const G = lp.game, rounds = lp.rounds; if (!G || !lp.table || !Array.isArray(rounds)) return null;
  let st = G.initial(); const out = [];
  for (let street = 0; street < rounds.length; street++) {
    for (const a of rounds[street]) {
      if (st.done || st.street !== street) return null;              // the walker and the hand disagree: do not guess
      const acts = G.actions(st), idx = acts.indexOf(a);
      if (idx < 0) return null;
      if (st.actor === lp.botSeat) out.push({ street, hist: st.rounds.slice(0, street + 1).join('/'), n: acts.length, idx, call: acts.indexOf('k') });
      st = G.apply(st, a);
    }
  }
  return out;
}
// weight of each possible hand = chance it would have played every one of those decisions that way
export function rangeWeights(lp, board, pairs) {
  const ds = lp.game ? walkDecisions(lp) : botDecisions(lp);
  if (!ds || !ds.length) return null;
  const eps = LEVEL_EPS[lp.level] ?? 0, table = lp.table, pre = lp.prefix || '', callOnly = lp.fallback === 'call';
  const w = new Float64Array(pairs.length); let sum = 0;
  for (let p = 0; p < pairs.length; p++) {
    let x = 1;
    for (const d of ds) {
      const probs = table[pre + d.street + '|' + bucketFor(d.street, pairs[p], board) + '|' + d.hist];
      // a slim brain check/calls wherever its table has no entry
      let pr = probs && probs.length === d.n ? probs[d.idx] : callOnly ? (d.idx === d.call ? 1 : 0) : 1 / d.n;
      pr = (1 - eps) * pr + eps / d.n;
      x *= pr; if (x === 0) break;
    }
    w[p] = x; sum += x;
  }
  return sum > 0 ? { w, sum, decisions: ds.length } : null;
}

// ---- the sums ---------------------------------------------------------------
export function ladder(hole, board, lp) {
  const dead = new Set([...hole, ...board]);
  const rest = []; for (let c = 0; c < 52; c++) if (!dead.has(c)) rest.push(c);
  const pairs = []; for (let i = 0; i < rest.length; i++) for (let j = i + 1; j < rest.length; j++) pairs.push([rest[i], rest[j]]);
  const range = lp ? rangeWeights(lp, board, pairs) : null;
  const mine = evaluate([...hole, ...board]);
  const counts = new Array(RUNGS.length).fill(0), countsR = new Array(RUNGS.length).fill(0);
  let beat = 0, tie = 0, beatR = 0, tieR = 0, nutScore = mine.score;
  for (let p = 0; p < pairs.length; p++) {
    const ev = evaluate([...pairs[p], ...board]), r = rungOf(pairs[p], board, ev), w = range ? range.w[p] : 0;
    counts[r]++; countsR[r] += w;
    if (ev.score < mine.score) { beat++; beatR += w; } else if (ev.score === mine.score) { tie++; tieR += w; }
    if (ev.score > nutScore) nutScore = ev.score;
  }
  const n = pairs.length;
  return { counts, n, now: (beat + tie / 2) / n, myRung: rungOf(hole, board, mine), nuts: mine.score >= nutScore, rest, pairs,
    range: range && { shares: countsR.map((c) => c / range.sum), now: (beatR + tieR / 2) / range.sum, w: range.w, decisions: range.decisions,
      kept: range.sum / n } };
}

// Chance of winning at showdown, counting the cards still to come: against any hand, and
// against their range when there is one (each possible hand counted by its weight).
export function byTheRiver(hole, board, L) {
  const need = 5 - board.length;
  if (need === 0) return null;
  const rest = L.rest, w = L.range ? L.range.w : null;
  const at = new Map(); if (w) L.pairs.forEach((p, i) => at.set(p[0] * 52 + p[1], w[i]));
  let win = 0, n = 0, winR = 0, nR = 0;
  const trial = (a, b, run) => {
    const bd = [...board, ...run];
    const me = evaluate([...hole, ...bd]).score, o = evaluate([a, b, ...bd]).score;
    const r = me > o ? 1 : me === o ? 0.5 : 0;
    win += r; n++;
    if (w) { const x = at.get(Math.min(a, b) * 52 + Math.max(a, b)) || 0; winR += r * x; nR += x; }
  };
  if (need === 1) {                                           // turn: exact
    for (let i = 0; i < rest.length; i++) for (let j = i + 1; j < rest.length; j++) for (let k = 0; k < rest.length; k++) {
      if (k !== i && k !== j) trial(rest[i], rest[j], [rest[k]]);
    }
  } else {                                                    // flop: a fixed sample
    let seed = 20261116; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    const d = rest.slice();
    for (let t = 0; t < 8000; t++) {
      for (let k = 0; k < 4; k++) { const j = k + Math.floor(rnd() * (d.length - k)); const x = d[k]; d[k] = d[j]; d[j] = x; }
      trial(d[0], d[1], [d[2], d[3]]);
    }
  }
  return { any: win / n, range: w && nR > 0 ? winR / nR : null };
}
