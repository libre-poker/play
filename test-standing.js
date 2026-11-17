// test-standing.js: checks standing.js against the no-limit trainer's own rules.
//   node test-standing.js
// Plays hands the way nl.html does (the bot samples from the strategy table), and after every
// bot decision asks standing.js how likely the bot's real hand was to play that way. It must
// equal the product of the probabilities the bot actually used. Also checks the plain
// "share of hands you beat" figure against a direct count.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { evaluate, shuffledDeck } from './engine/poker.js';
import { setEquityEdges } from './engine/ladder.js';
import { HUNL } from './engine/hunl.js';
import { ladder, rangeWeights } from './standing.js';

const T = JSON.parse(fs.readFileSync(new URL('./strategy-nl.json', import.meta.url)));
if (T.edges) setEquityEdges(T.edges);
const BOARD_N = [0, 3, 4, 5];
let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const hex = () => Array.from({ length: 64 }, () => Math.floor(rnd() * 16).toString(16)).join('');

let checks = 0, hands = 0;
for (const fallback of ['call', undefined]) {
  for (let n = 0; n < 150; n++) {
    const deck = shuffledDeck(hex()), holes = [[deck[0], deck[1]], [deck[2], deck[3]]], board = deck.slice(4, 9);
    const heroAbs = n % 2, botAbs = 1 - heroAbs;
    let st = HUNL.initial(), prod = 1; hands++;
    while (!st.done) {
      const acts = HUNL.actions(st);
      let a;
      if (st.actor === heroAbs) {                       // hero: anything legal, folding rarely
        const live = acts.filter((x) => x !== 'f' || rnd() < 0.1);
        a = live[Math.floor(rnd() * live.length)];
      } else {                                          // bot: exactly nl.html's botAct
        const row = T.table[HUNL.infoset(st, holes[botAbs], board.slice(0, BOARD_N[st.street]))];
        let probs = row && row.length === acts.length ? row : null, pick;
        if (!probs && fallback === 'call') { pick = acts.indexOf('k'); }
        else {
          if (!probs) probs = acts.map(() => 1 / acts.length);
          let x = rnd(); pick = acts.length - 1;
          for (let i = 0; i < acts.length; i++) { x -= probs[i]; if (x <= 0) { pick = i; break; } }
          prod *= probs[pick];
        }
        a = acts[pick];
      }
      st = HUNL.apply(st, a);
      if (st.street === 0 || a === 'f' || prod === 0) continue;
      const shown = board.slice(0, BOARD_N[st.street]);
      const dead = new Set([...holes[heroAbs], ...shown]);
      const rest = []; for (let c = 0; c < 52; c++) if (!dead.has(c)) rest.push(c);
      const pairs = []; for (let i = 0; i < rest.length; i++) for (let j = i + 1; j < rest.length; j++) pairs.push([rest[i], rest[j]]);
      const lp = { prefix: 'n', game: HUNL, rounds: st.rounds, botSeat: botAbs, table: T.table, fallback };
      const rw = rangeWeights(lp, shown, pairs);
      if (!st.rounds.join('').length || !rw) { assert.ok(rw || prod === 1, 'no range although the bot has acted'); continue; }
      const [b0, b1] = holes[botAbs].slice().sort((x, y) => x - y);
      const at = pairs.findIndex((p) => p[0] === b0 && p[1] === b1);
      assert.ok(Math.abs(rw.w[at] - prod) < 1e-12, `weight ${rw.w[at]} != ${prod} at ${st.rounds.join('/')}`);
      checks++;

      const L = ladder(holes[heroAbs], shown, null), mine = evaluate([...holes[heroAbs], ...shown]).score;
      let beat = 0; for (const p of pairs) { const s = evaluate([...p, ...shown]).score; beat += s < mine ? 1 : s === mine ? 0.5 : 0; }
      assert.ok(Math.abs(L.now - beat / pairs.length) < 1e-12);
    }
  }
}
console.log(`ok: ${checks} range checks over ${hands} hands`);
