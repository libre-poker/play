// equity-buckets.js — the research-standard card abstraction: hands bucketed
// by percentiles of E[HS²] (expected squared hand strength over runouts —
// the Alberta metric that rates made hands AND draws on one scale).
// Everything is deterministic: (hole, board) is suit-canonicalized, and the
// estimator's rng is seeded from the canonical key, so the same class maps
// to the same bucket forever — in the trainer and in the browser alike.
import { evaluate, rankOf, suitOf } from './poker.js';

// ---------------------------------------------------------------- canon
// smallest encoding over all 24 suit relabelings; board order-insensitive
const PERMS = [];
{
  const ss = [0, 1, 2, 3];
  const perm = (arr, k = 0) => {
    if (k === arr.length) { PERMS.push([...arr]); return; }
    for (let i = k; i < arr.length; i++) {
      [arr[k], arr[i]] = [arr[i], arr[k]];
      perm(arr, k + 1);
      [arr[k], arr[i]] = [arr[i], arr[k]];
    }
  };
  perm(ss);
}
export function canonKey(hole, board) {
  let best = null;
  for (const p of PERMS) {
    const m = (c) => p[suitOf(c)] * 13 + rankOf(c);
    const h = hole.map(m).sort((a, b) => a - b);
    const b = board.map(m).sort((a, b) => a - b);
    const s = String.fromCharCode(...h, 58, ...b);
    if (best === null || s < best) best = s;
  }
  return best;
}

// FNV-1a over the key -> xorshift128 seed: cheap, stable, good enough
function rngFromKey(key) {
  let h1 = 0x811c9dc5, h2 = 0x01000193, h3 = 0xdeadbeef, h4 = 0xcafebabe;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
    h3 = Math.imul(h3 ^ (c << 8), 0xc2b2ae35) >>> 0;
    h4 = (h4 + Math.imul(c, 0x27d4eb2f)) >>> 0;
  }
  let a = h1 || 1, b = h2 || 2, c2 = h3 || 3, d = h4 || 4;
  return () => {
    const t = a ^ (a << 11);
    a = b; b = c2; c2 = d;
    d = ((d ^ (d >>> 19)) ^ (t ^ (t >>> 8))) >>> 0;
    return d / 4294967296;
  };
}

// ---------------------------------------------------------------- E[HS²]
// deterministic sampled estimate: runouts × opponents per runout
export function ehs2(hole, board, runouts, oppsPer) {
  const key = canonKey(hole, board);
  const rng = rngFromKey(key);
  const dead = new Set([...hole, ...board]);
  const pool = [];
  for (let c = 0; c < 52; c++) if (!dead.has(c)) pool.push(c);
  const need = 5 - board.length;
  let acc = 0;
  for (let r = 0; r < runouts; r++) {
    const p = [...pool];
    for (let i = 0; i < need + 2 * oppsPer; i++) {
      const j = i + ((rng() * (p.length - i)) | 0);
      [p[i], p[j]] = [p[j], p[i]];
    }
    const full = [...board];
    for (let i = 0; i < need; i++) full.push(p[i]);
    const mine = evaluate([...hole, ...full]).score;
    let wins = 0;
    for (let o = 0; o < oppsPer; o++) {
      const theirs = evaluate([p[need + 2 * o], p[need + 2 * o + 1], ...full]).score;
      if (mine > theirs) wins += 1;
      else if (mine === theirs) wins += 0.5;
    }
    const hs = wins / oppsPer;
    acc += hs * hs;
  }
  return acc / runouts;
}

// street-tuned sample sizes: flop sees two cards of future, turn one
export const SAMPLES = { 1: [20, 15], 2: [14, 15] };

// ---------------------------------------------------------------- buckets
// armed with quantile edges (from build-buckets.js); cached per canon class
let EDGES = null;                 // {1: Float64Array, 2: Float64Array}
let ENABLED = true;               // per-decision gate: lets one process host an
const cache = new Map();          // equity table and a legacy table side by side
export function setEquityEdges(edges) {
  EDGES = edges ? { 1: Float64Array.from(edges.flop), 2: Float64Array.from(edges.turn) } : null;
  cache.clear();
}
export function setEquityEnabled(on) { ENABLED = !!on; }
export const equityArmed = () => EDGES !== null && ENABLED;

export function eqBucket(street, hole, board) {
  const key = street + canonKey(hole, board);
  let b = cache.get(key);
  if (b !== undefined) return b;
  const [runouts, opps] = SAMPLES[street];
  const v = ehs2(hole, board.slice(0, street === 1 ? 3 : 4), runouts, opps);
  const edges = EDGES[street];
  // binary search: bucket = count of edges <= v
  let lo = 0, hi = edges.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (edges[mid] <= v) lo = mid + 1; else hi = mid; }
  b = lo;
  if (cache.size < 25_000_000) cache.set(key, b);
  return b;
}
