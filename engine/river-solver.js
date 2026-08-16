// river-solver.js — exact river play. When a ladder hand reaches the river,
// the abstraction retires: we track both players' ranges through the hand
// (using the trained table as the model of play), then solve the actual
// river subgame — real board, real ranges, tiny fixed-limit betting tree —
// with range-vs-range vector CFR. Showdown values use strength-sorted prefix
// sums with per-card blocker corrections, so a full solve is milliseconds.
// This is standard "unsafe endgame solving": exact within the subgame, under
// the assumption that earlier streets followed the table.
import { evaluate } from './poker.js';
import { streetBucket, historyRounds } from './ladder.js';

// One-call play-time entry: the mix for `seat`'s current river decision.
// Solves once per hand per seat (pass a per-hand cache object); returns
// {acts, probs} in k/b/f form, or null to fall back to the table.
export function riverMix(h, seat, table, cache = {}) {
  if (h.street !== 3) return null;
  try {
    const key = 'rs' + seat;
    if (!cache[key]) {
      const opp = h.seats.findIndex((s, i) => i !== seat && !s.out);
      const potIn = h.seats.reduce((a, s) => a + s.handCommit - s.streetCommit, 0);
      const firstSeat = h.headsUp ? h.seats.findIndex((s, i) => i !== h.button && !s.out) : -1;
      cache[key] = solveRiver({
        board: h.board,
        myHole: h.seats[seat].hole,
        oppDead: h.seats[seat].hole,
        myRange: rangeThrough(h, seat, table),
        oppRange: rangeThrough(h, opp, table),
        potIn, bb: h.bb,
        iAmFirst: seat === firstSeat,
        iters: 160,
      });
    }
    const node = historyRounds(h)[3];
    return cache[key].mixAt(node);
  } catch { return null; }
}

// Play-time EV entry for the leak meter: per-action EVs for `seat`'s current
// river decision, in chips. null off-river or when the solve can't answer.
export function riverEvs(h, seat, table, cache = {}) {
  if (h.street !== 3) return null;
  try {
    riverMix(h, seat, table, cache);          // ensure the solve is cached
    const solved = cache['rs' + seat];
    if (!solved) return null;
    return solved.evsAt(historyRounds(h)[3]);
  } catch { return null; }
}

// ---------------------------------------------------------------- the tree
// River betting, fixed limit: bet = 2×bb, cap 4 bets. k=check/call, b, f.
function buildTree(bb) {
  const bet = 2 * bb;
  const nodes = new Map();  // str -> node
  function walk(str, actor, bets, toCall, s0, s1) {
    const node = { str, actor, bets, toCall, s0, s1, terminal: null, acts: null, kids: {} };
    nodes.set(str, node);
    if (str.endsWith('f')) { node.terminal = 'fold'; node.folder = 1 - actor; return node; }
    const acted = str.length;
    if (toCall === 0 && acted >= 2) { node.terminal = 'showdown'; return node; }
    if (toCall > 0 && acted >= 2 && str.endsWith('k')) { node.terminal = 'showdown'; return node; }
    const acts = [];
    acts.push('k');
    if (bets < 4) acts.push('b');
    if (toCall > 0) acts.push('f');
    node.acts = acts;
    for (const a of acts) {
      let nb = bets, ntc = toCall, n0 = s0, n1 = s1;
      if (a === 'k') { if (actor === 0) n0 += toCall; else n1 += toCall; ntc = 0; }
      if (a === 'b') {
        if (actor === 0) n0 += toCall + bet; else n1 += toCall + bet;
        ntc = bet; nb = bets + 1;
      }
      node.kids[a] = walk(str + a, 1 - actor, nb, ntc, n0, n1);
    }
    return node;
  }
  // after a call the street ends: fix the "call closes" rule — a call of a
  // bet is terminal regardless of count
  const root = walk('', 0, 0, 0, 0, 0);
  for (const n of nodes.values()) {
    if (!n.terminal && n.str.length >= 2 && n.str.endsWith('k')) {
      const prev = n.str[n.str.length - 2];
      if (prev === 'b') { n.terminal = 'showdown'; n.acts = null; n.kids = {}; }
    }
  }
  return { root, nodes };
}

// ---------------------------------------------------------------- ranges
// Bayesian filter: weight every candidate pair by the table's probability of
// the actions this seat actually took on streets 0..2.
export function rangeThrough(h, seat, table) {
  const board = h.board;
  const dead = new Set(board);
  const cards = [];
  for (let c = 0; c < 52; c++) if (!dead.has(c)) cards.push(c);
  const pairs = [];
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) pairs.push([cards[i], cards[j]]);
  }
  const w = new Float64Array(pairs.length).fill(1);

  // replay the log, tracking street + per-street history
  let street = 0;
  const rounds = ['', '', '', ''];
  for (const e of h.log) {
    if (e.ev === 'street') { street = ['preflop', 'flop', 'turn', 'river'].indexOf(e.street); continue; }
    const isAct = e.ev === 'fold' || e.ev === 'check' || e.ev === 'call' || e.ev === 'bet' || e.ev === 'raise';
    if (!isAct) continue;
    const sym = e.ev === 'fold' ? 'f' : (e.ev === 'bet' || e.ev === 'raise') ? 'b' : 'k';
    if (street < 3 && e.seat === seat) {
      const histKey = rounds.slice(0, street + 1).join('/');
      for (let p = 0; p < pairs.length; p++) {
        if (w[p] === 0) continue;
        const b = streetBucket(street, pairs[p], board);
        const probs = table[street + '|' + b + '|' + histKey];
        if (!probs) continue;                       // unknown spot: no update
        // act order at that node: [k, b?] or [k, b?, f] — mirror ladder.js
        // (we cannot recover toCall exactly per candidate; the table rows
        //  themselves encode the shape, so map by row length)
        let pr;
        if (probs.length === 3) pr = sym === 'k' ? probs[0] : sym === 'b' ? probs[1] : probs[2];
        else if (probs.length === 2) pr = sym === 'k' ? probs[0] : sym === 'b' ? probs[1] : 0;
        else pr = 1;
        w[p] *= Math.max(pr, 0.001);                // floor: never zero a hand on model faith alone
      }
    }
    rounds[street] += sym;
  }
  return { pairs, weights: w };
}

// ---------------------------------------------------------------- the solve
export function solveRiver({ board, myHole, oppDead, myRange, oppRange, potIn, bb, iAmFirst, iters = 200 }) {
  // shared candidate list over the 47 non-board cards
  const { pairs } = myRange;
  const N = pairs.length;
  const strengths = new Float64Array(N);
  for (let p = 0; p < N; p++) strengths[p] = evaluate([...pairs[p], ...board]).score;

  // per-player weight vectors (normalized, floored)
  const prep = (rw, deadCards) => {
    const v = Float64Array.from(rw.weights);
    if (deadCards) {
      for (let p = 0; p < N; p++) {
        if (deadCards.includes(pairs[p][0]) || deadCards.includes(pairs[p][1])) v[p] = 0;
      }
    }
    let s = 0; for (let p = 0; p < N; p++) s += v[p];
    if (s <= 0) { v.fill(1 / N); return v; }
    for (let p = 0; p < N; p++) v[p] = v[p] / s * 0.98 + 0.02 / N;
    return v;
  };
  // roles: P0 acts first on the river
  const w0 = prep(iAmFirst ? myRange : oppRange, iAmFirst ? null : oppDead);
  const w1 = prep(iAmFirst ? oppRange : myRange, iAmFirst ? oppDead : null);

  const { root, nodes } = buildTree(bb);
  const half = potIn / 2;

  // sorted order + card index for prefix machinery
  const order = Array.from({ length: N }, (_, i) => i).sort((a, b) => strengths[a] - strengths[b]);
  const cardOf = new Map();
  {
    let k = 0;
    for (const c of new Set(pairs.flat())) cardOf.set(c, k++);
  }
  const NC = cardOf.size;
  const c1 = new Int16Array(N), c2 = new Int16Array(N);
  for (let p = 0; p < N; p++) { c1[p] = cardOf.get(pairs[p][0]); c2[p] = cardOf.get(pairs[p][1]); }

  // showdown vector: u[i] = M * (weightBeaten_i - weightBeating_i), blockers removed
  function showdownUtil(reachOpp, M, out) {
    const below = new Float64Array(N);
    const belowCard = new Float64Array(NC);
    const aboveCard = new Float64Array(NC);
    let total = 0, totalAbove = 0;
    const cardTotal = new Float64Array(NC);
    for (let p = 0; p < N; p++) { total += reachOpp[p]; cardTotal[c1[p]] += reachOpp[p]; cardTotal[c2[p]] += reachOpp[p]; }
    // ascending sweep with tie groups
    let i = 0;
    let cum = 0; const cumCard = new Float64Array(NC);
    while (i < N) {
      let j = i;
      while (j < N && strengths[order[j]] === strengths[order[i]]) j++;
      for (let k = i; k < j; k++) {
        const p = order[k];
        below[p] = cum - cumCard[c1[p]] - cumCard[c2[p]];
      }
      for (let k = i; k < j; k++) {
        const p = order[k];
        cum += reachOpp[p]; cumCard[c1[p]] += reachOpp[p]; cumCard[c2[p]] += reachOpp[p];
      }
      i = j;
    }
    for (let p = 0; p < N; p++) {
      const overlap = cardTotal[c1[p]] + cardTotal[c2[p]] - reachOpp[p];
      const feasible = total - overlap;             // opp hands not blocked by mine
      const beaten = below[p];
      // above = feasible - beaten - tied; tied contributes 0 either way
      // compute tied: hands with equal strength not blocked — derive via
      // (feasible - beaten - above); we get above from a mirrored sweep-free
      // identity: above = feasible - beaten - tied. We need beaten - above:
      //   beaten - above = 2*beaten + tied - feasible
      // tied needs its own pass; cheaper: recompute via descending cum is
      // symmetric — do it directly:
      out[p] = 0; // filled below
      below[p] = beaten; aboveCard[0] = aboveCard[0]; // keep linter quiet
      out[p] = M * beaten; // temp: store beaten; finish after descending sweep
      belowCard[0] = belowCard[0];
    }
    // descending sweep for "beating me"
    const above = new Float64Array(N);
    let cum2 = 0; const cumCard2 = new Float64Array(NC);
    i = N - 1;
    while (i >= 0) {
      let j = i;
      while (j >= 0 && strengths[order[j]] === strengths[order[i]]) j--;
      for (let k = i; k > j; k--) {
        const p = order[k];
        above[p] = cum2 - cumCard2[c1[p]] - cumCard2[c2[p]];
      }
      for (let k = i; k > j; k--) {
        const p = order[k];
        cum2 += reachOpp[p]; cumCard2[c1[p]] += reachOpp[p]; cumCard2[c2[p]] += reachOpp[p];
      }
      i = j;
    }
    for (let p = 0; p < N; p++) out[p] = M * (below[p] - above[p]);
  }

  // fold-terminal vector: winner takes M against opp's feasible reach
  function foldUtil(reachOpp, M, out) {
    let total = 0;
    const cardTotal = new Float64Array(NC);
    for (let p = 0; p < N; p++) { total += reachOpp[p]; cardTotal[c1[p]] += reachOpp[p]; cardTotal[c2[p]] += reachOpp[p]; }
    for (let p = 0; p < N; p++) {
      out[p] = M * (total - (cardTotal[c1[p]] + cardTotal[c2[p]] - reachOpp[p]));
    }
  }

  // regret / strategy-sum stores per decision node
  const R = new Map(), S = new Map();
  const store = (m, node) => {
    let v = m.get(node.str);
    if (!v) { v = new Float64Array(N * node.acts.length); m.set(node.str, v); }
    return v;
  };
  function strategyAt(node, out) {
    const r = store(R, node);
    const A = node.acts.length;
    for (let p = 0; p < N; p++) {
      let sum = 0;
      for (let a = 0; a < A; a++) { const x = r[p * A + a]; if (x > 0) sum += x; }
      for (let a = 0; a < A; a++) {
        out[p * A + a] = sum > 0 ? Math.max(0, r[p * A + a]) / sum : 1 / A;
      }
    }
  }

  const scratch = () => new Float64Array(N);
  let itW = 1;                                       // linear averaging weight
  function pass(node, r0, r1) {
    if (node.terminal === 'showdown') {
      const u0 = scratch(), u1 = scratch();
      const M = half + node.s0;                      // commits equal at showdown
      showdownUtil(r1, M, u0);
      showdownUtil(r0, M, u1);
      for (let p = 0; p < N; p++) u1[p] = u1[p];     // symmetric sign handled by caller roles
      return [u0, u1];
    }
    if (node.terminal === 'fold') {
      const u0 = scratch(), u1 = scratch();
      if (node.folder === 1) {                       // P1 folded: P0 wins half + s1
        foldUtil(r1, half + node.s1, u0);
        foldUtil(r0, -(half + node.s1), u1);
      } else {
        foldUtil(r1, -(half + node.s0), u0);
        foldUtil(r0, half + node.s0, u1);
      }
      return [u0, u1];
    }
    const A = node.acts.length;
    const strat = new Float64Array(N * A);
    strategyAt(node, strat);
    const u0 = scratch(), u1 = scratch();
    const childU0 = [], childU1 = [];
    for (let a = 0; a < A; a++) {
      let cr0 = r0, cr1 = r1;
      if (node.actor === 0) {
        cr0 = scratch();
        for (let p = 0; p < N; p++) cr0[p] = r0[p] * strat[p * A + a];
      } else {
        cr1 = scratch();
        for (let p = 0; p < N; p++) cr1[p] = r1[p] * strat[p * A + a];
      }
      const [a0, a1] = pass(node.kids[node.acts[a]], cr0, cr1);
      childU0.push(a0); childU1.push(a1);
    }
    if (node.actor === 0) {
      for (let p = 0; p < N; p++) {
        let v = 0;
        for (let a = 0; a < A; a++) v += strat[p * A + a] * childU0[a][p];
        u0[p] = v;
      }
      for (let p = 0; p < N; p++) { let v = 0; for (let a = 0; a < A; a++) v += childU1[a][p]; u1[p] = v; }
      const r = store(R, node), ss = store(S, node);
      for (let p = 0; p < N; p++) {
        for (let a = 0; a < A; a++) {
          r[p * A + a] = Math.max(0, r[p * A + a] + childU0[a][p] - u0[p]);
          ss[p * A + a] += itW * r0[p] * strat[p * A + a];
        }
      }
    } else {
      for (let p = 0; p < N; p++) { let v = 0; for (let a = 0; a < A; a++) v += childU0[a][p]; u0[p] = v; }
      for (let p = 0; p < N; p++) {
        let v = 0;
        for (let a = 0; a < A; a++) v += strat[p * A + a] * childU1[a][p];
        u1[p] = v;
      }
      const r = store(R, node), ss = store(S, node);
      for (let p = 0; p < N; p++) {
        for (let a = 0; a < A; a++) {
          r[p * A + a] = Math.max(0, r[p * A + a] + childU1[a][p] - u1[p]);
          ss[p * A + a] += itW * r1[p] * strat[p * A + a];
        }
      }
    }
    return [u0, u1];
  }

  for (let it = 0; it < iters; it++) { itW = it + 1; pass(root, w0, w1); }

  // my hand's index in the candidate list
  const myIdx = pairs.findIndex((pp) =>
    (pp[0] === myHole[0] && pp[1] === myHole[1]) || (pp[0] === myHole[1] && pp[1] === myHole[0]));

  // ---------------------------------------------------------- EV report
  // One expectimax pass under the AVERAGE strategies: forward reaches per
  // node, backward utilities with the per-action vectors kept at every
  // decision node. From these, evsAt() answers "what was each action worth
  // for my actual hand" — the exact per-decision currency of the leak meter.
  let evCache = null;
  function buildEvReport() {
    const avgStrat = new Map();
    for (const [str, node] of nodes) {
      if (!node.acts) continue;
      const ss = S.get(str);
      const A = node.acts.length;
      const st = new Float64Array(N * A);
      for (let p = 0; p < N; p++) {
        let sum = 0;
        if (ss) for (let a = 0; a < A; a++) sum += ss[p * A + a];
        for (let a = 0; a < A; a++) st[p * A + a] = sum > 0 ? ss[p * A + a] / sum : 1 / A;
      }
      avgStrat.set(str, st);
    }
    const reach = new Map([['', [w0, w1]]]);
    const byDepth = [...nodes.values()].sort((a, b) => a.str.length - b.str.length);
    for (const node of byDepth) {
      if (!node.acts) continue;
      const [r0, r1] = reach.get(node.str);
      const st = avgStrat.get(node.str);
      const A = node.acts.length;
      for (let a = 0; a < A; a++) {
        let cr0 = r0, cr1 = r1;
        if (node.actor === 0) {
          cr0 = new Float64Array(N);
          for (let p = 0; p < N; p++) cr0[p] = r0[p] * st[p * A + a];
        } else {
          cr1 = new Float64Array(N);
          for (let p = 0; p < N; p++) cr1[p] = r1[p] * st[p * A + a];
        }
        reach.set(node.kids[node.acts[a]].str, [cr0, cr1]);
      }
    }
    const perAction = new Map();          // str -> per-action utils for the node's actor
    function evPass(node) {
      const [r0, r1] = reach.get(node.str);
      if (node.terminal === 'showdown') {
        const u0 = new Float64Array(N), u1 = new Float64Array(N);
        const M = half + node.s0;
        showdownUtil(r1, M, u0);
        showdownUtil(r0, M, u1);
        return [u0, u1];
      }
      if (node.terminal === 'fold') {
        const u0 = new Float64Array(N), u1 = new Float64Array(N);
        if (node.folder === 1) {
          foldUtil(r1, half + node.s1, u0);
          foldUtil(r0, -(half + node.s1), u1);
        } else {
          foldUtil(r1, -(half + node.s0), u0);
          foldUtil(r0, half + node.s0, u1);
        }
        return [u0, u1];
      }
      const st = avgStrat.get(node.str);
      const A = node.acts.length;
      const kidsU = node.acts.map((a) => evPass(node.kids[a]));
      const u0 = new Float64Array(N), u1 = new Float64Array(N);
      if (node.actor === 0) {
        for (let p = 0; p < N; p++) {
          let v = 0, w = 0;
          for (let a = 0; a < A; a++) { v += st[p * A + a] * kidsU[a][0][p]; w += kidsU[a][1][p]; }
          u0[p] = v; u1[p] = w;
        }
        perAction.set(node.str, kidsU.map((k) => k[0]));
      } else {
        for (let p = 0; p < N; p++) {
          let v = 0, w = 0;
          for (let a = 0; a < A; a++) { v += kidsU[a][0][p]; w += st[p * A + a] * kidsU[a][1][p]; }
          u0[p] = v; u1[p] = w;
        }
        perAction.set(node.str, kidsU.map((k) => k[1]));
      }
      return [u0, u1];
    }
    evPass(nodes.get(''));
    return { reach, perAction };
  }

  return {
    // per-action EVs (chips, pot-centered) for my actual hand at my node —
    // null when it isn't my turn there. Differences are exact EV losses.
    evsAt(nodeStr) {
      const node = nodes.get(nodeStr);
      if (!node || !node.acts) return null;
      const myRole = iAmFirst ? 0 : 1;
      if (node.actor !== myRole || myIdx < 0) return null;
      if (!evCache) evCache = buildEvReport();
      const pa = evCache.perAction.get(nodeStr);
      const rr = evCache.reach.get(nodeStr);
      if (!pa || !rr) return null;
      const rOpp = myRole === 0 ? rr[1] : rr[0];
      let total = 0;
      const cardTotal = new Float64Array(NC);
      for (let p = 0; p < N; p++) { total += rOpp[p]; cardTotal[c1[p]] += rOpp[p]; cardTotal[c2[p]] += rOpp[p]; }
      const feas = total - (cardTotal[c1[myIdx]] + cardTotal[c2[myIdx]] - rOpp[myIdx]);
      if (feas <= 1e-12) return null;
      return { acts: node.acts, evs: pa.map((u) => u[myIdx] / feas) };
    },
    // average mix for my actual hand at a river node ('' = first decision)
    mixAt(nodeStr) {
      const node = nodes.get(nodeStr);
      if (!node || !node.acts) return null;
      const myTurn = node.actor === (iAmFirst ? 0 : 1);
      if (!myTurn || myIdx < 0) return null;
      const ss = S.get(nodeStr);
      if (!ss) return null;
      const A = node.acts.length;
      let sum = 0;
      const probs = [];
      for (let a = 0; a < A; a++) { const x = ss[myIdx * A + a]; probs.push(x); sum += x; }
      if (sum <= 0) return { acts: node.acts, probs: node.acts.map(() => 1 / A) };
      return { acts: node.acts, probs: probs.map((x) => x / sum) };
    },
  };
}
