// hunl.js — the abstract game tree for heads-up NO-LIMIT hold'em training.
// The real game is poker.js (which was no-limit all along); this is the
// small world CFR lives in: three bet sizes and a bounded history, chosen
// so the strategy table stays browser-sized. Units follow the house
// convention: SB=1, BB=2, stacks 200 (100bb), everything integer.
//
//   actions: f fold · k check/call · h half-pot · p pot · a all-in
//   raise cap: 2 aggressive actions per street (abstraction only — the
//   referee downstairs enforces the real rules)
import { evaluate } from './poker.js';
import { streetBucket } from './ladder.js';

const STACK = 200;
const RAISE_CAP = 2;

export const HUNL = {
  SB: 1, BB: 2, STACK,

  initial() {
    return {
      street: 0, rounds: ['', '', '', ''],
      contrib: [1, 2],                    // total committed (SB, BB posted)
      streetC: [1, 2],                    // committed this street
      toCall: 1, minRaise: 2, raises: 1,  // the blind counts as the first bet
      actor: 0,                           // button/SB first preflop
      folded: -1, done: false,
    };
  },

  // sizing targets for the actor, in street-commitment terms
  targets(st) {
    const me = st.actor, stack = STACK - st.contrib[me];
    const pot = st.contrib[0] + st.contrib[1];
    const call = Math.min(st.toCall, stack);
    const after = pot + call;
    const all = st.streetC[me] + stack;
    const mk = (mult) => {
      const by = Math.max(st.minRaise, Math.round(after * mult));
      return Math.min(st.streetC[me] + call + by, all);
    };
    return { h: mk(0.5), p: mk(1), a: all, call, stack };
  },

  actions(st) {
    const t = this.targets(st);
    const acts = [];
    const oppAllin = st.contrib[1 - st.actor] >= STACK;
    if (st.toCall > 0) {
      acts.push('k');
      if (!oppAllin && st.raises < RAISE_CAP && t.stack > t.call) {
        if (t.h < t.a) acts.push('h');
        if (t.p < t.a && t.p > t.h) acts.push('p');
        acts.push('a');
      }
      acts.push('f');
    } else {
      acts.push('k');
      if (st.raises < RAISE_CAP && t.stack > 0) {
        if (t.h < t.a) acts.push('h');
        if (t.p < t.a && t.p > t.h) acts.push('p');
        acts.push('a');
      }
    }
    return acts;
  },

  apply(st, a) {
    const s = { ...st, rounds: [...st.rounds], contrib: [...st.contrib], streetC: [...st.streetC] };
    s.rounds[s.street] += a;
    const me = s.actor, other = 1 - me;

    if (a === 'f') { s.folded = me; s.done = true; return s; }

    if (a === 'k') {
      const t = this.targets(s);
      s.contrib[me] += t.call;
      s.streetC[me] += t.call;
      const acted = s.rounds[s.street].length;
      const closes = s.toCall > 0 ? !(s.street === 0 && acted === 1) : acted >= 2;
      s.toCall = 0;
      if (closes) {
        if (s.contrib[other] >= STACK || s.contrib[me] >= STACK) { s.done = true; return s; }
        if (s.street === 3) { s.done = true; return s; }
        s.street++; s.streetC = [0, 0]; s.raises = 0; s.minRaise = this.BB;
        s.actor = 1;                      // postflop: the big blind first
        return s;
      }
      s.actor = other;
      return s;
    }

    // h / p / a — an aggressive action
    const t = this.targets(s);
    const target = a === 'a' ? t.a : a === 'p' ? t.p : t.h;
    const raiseBy = target - (s.streetC[me] + t.call);
    const pay = target - s.streetC[me];
    s.contrib[me] += pay;
    s.streetC[me] = target;
    s.minRaise = Math.max(s.minRaise, raiseBy);
    s.raises++;
    s.toCall = s.streetC[me] - s.streetC[other];
    s.actor = other;
    return s;
  },

  utility(st, holes, board) {            // net for player 0 (the button)
    if (st.folded === 0) return -st.contrib[0];
    if (st.folded === 1) return st.contrib[1];
    const s0 = evaluate([...holes[0], ...board]).score;
    const s1 = evaluate([...holes[1], ...board]).score;
    if (s0 === s1) return 0;
    return s0 > s1 ? st.contrib[1] : -st.contrib[0];
  },

  infoset(st, hole, board) {
    const bucket = streetBucket(st.street, hole, board);
    return 'n' + st.street + '|' + bucket + '|' + st.rounds.slice(0, st.street + 1).join('/');
  },
};
