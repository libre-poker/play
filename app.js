// app.js — the room. Schema-native by construction: every finished hand
// becomes a Libre Poker Hand document (libre-poker/schema), and the
// scorecard, the transcript, and both copy buttons are pure views over
// those documents. The live table is the one view that reads the engine
// directly — everything after the settle reads only the record.
import {
  cardName, rankOf, suitOf, RANKS, newHand, legal, act, handName, rngFromSeed, STREETS,
} from './engine/poker.js';
import { ladderDecide, tableMix, setEquityEdges } from './engine/ladder.js';
import { riverMix, riverEvs } from './engine/river-solver.js';
import { glicko2, freshRating, LEVEL_RATING, LEVEL_RD } from './engine/rating.js';

const $ = (q) => document.querySelector(q);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256hex = async (s) => {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
};

// ---------------------------------------------------------------- state
const HERO = 0, BOT = 1;
const SB = 10, BB = 20, STACK = 2000;
const RATED_HANDS = 40;
const LEVEL_EPS = { 2: .45, 3: .3, 4: .2, 5: .12, 6: .06, 7: 0 };
let level = Math.min(7, Math.max(2, +(localStorage.getItem('lp.level') || 5)));
let rated = localStorage.getItem('lp.rated') === '1';
let soundOn = localStorage.getItem('lp.sound') !== '0';
let leakLive = localStorage.getItem('lp.leak') === '1';
let coachMode = localStorage.getItem('lp.coach') === '1';
let rating = freshRating();
try { rating = Object.assign(freshRating(), JSON.parse(localStorage.getItem('lp.rating') || '{}')); } catch { /* fresh */ }

let table = null;                 // the champion strategy
let h = null;                     // live engine hand
let handNo = 0;                   // 1-based, this session/match
let heroResolve = null;
let sessionSeed = '';
let docs = [];                    // finished hands as Hand documents
let net = 0;                      // hero chips won this match/session
let matchOpen = true;             // false between rated matches

// ---------------------------------------------------------------- sound
let ac = null, master = null;
function audio() {
  if (ac) return;
  try {
    ac = new (window.AudioContext || window.webkitAudioContext)();
    master = ac.createGain(); master.gain.value = .5; master.connect(ac.destination);
  } catch { /* no audio */ }
}
const ready = () => soundOn && ac && ac.state === 'running' && !document.hidden;
function blip(freq, dur = .06, gain = .05, type = 'triangle') {
  if (!ready()) return;
  try {
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(.0001, ac.currentTime);
    g.gain.linearRampToValueAtTime(gain * 2.2, ac.currentTime + .003);
    g.gain.exponentialRampToValueAtTime(.0001, ac.currentTime + dur);
    o.connect(g); g.connect(master);
    o.start(); o.stop(ac.currentTime + dur);
  } catch { /* shrug */ }
}
const seq = (notes, gap, dur, gain, type = 'sine') =>
  notes.forEach((f, i) => setTimeout(() => blip(f, dur, gain, type), i * gap));
function sGrade(word) {
  if (word === 'book') seq([659, 988], 85, .11, .038);
  else if (word === 'mix') blip(659, .09, .028, 'sine');
  else if (word === 'inaccuracy') blip(233, .11, .03, 'sine');
  else seq([220, 165], 110, .12, .034);
}
const sCard = () => blip(1180, .04, .02);
const sChip = () => blip(720, .05, .03);

// ---------------------------------------------------------------- cards
const ascii = (c) => RANKS[rankOf(c)] + 'cdhs'[suitOf(c)];
const isRed = (a) => a[1] === 'd' || a[1] === 'h';
const GLYPH = { c: '♣', d: '♦', h: '♥', s: '♠' };
function cardEl(a) {
  const d = document.createElement('div');
  d.className = 'card flipin' + (isRed(a) ? ' red' : '');
  d.innerHTML = `<div class="r">${a[0] === 'T' ? '10' : a[0]}</div><div class="s">${GLYPH[a[1]]}</div>`;
  return d;
}
function backEl() { const d = document.createElement('div'); d.className = 'card back'; return d; }
const prettyA = (a) => `<b style="color:${isRed(a) ? 'var(--red)' : 'inherit'}">${a[0] === 'T' ? '10' : a[0]}${GLYPH[a[1]]}</b>`;
const prettyCards = (arr) => arr.map(prettyA).join(' ');

// ---------------------------------------------------------------- render
const seats = [
  { root: $('#seat-0'), nm: $('#seat-0 .nm'), st: $('#seat-0 .st'), cards: $('#seat-0 .cards'), said: $('#seat-0 .said') },
  { root: $('#seat-1'), nm: $('#seat-1 .nm'), st: $('#seat-1 .st'), cards: $('#seat-1 .cards'), said: $('#seat-1 .said') },
];
function renderTop() {
  $('#b-level').textContent = `Lv ${level}`;
  $('#b-rating').textContent = `⚡ ${Math.round(rating.r)}`;
  $('#b-rated').textContent = rated ? `🏅 rated ${Math.min(handNo, RATED_HANDS)}/${RATED_HANDS}` : '☕ casual';
  $('#b-rated').classList.toggle('on', rated);
  $('#b-sound').textContent = soundOn ? '🔊' : '🔇';
  $('#b-leak').classList.toggle('on', leakLive);
  renderLeak();
}
function leakOf(ds) {
  let loss = 0, hands = ds.length;
  for (const d of ds) for (const an of d.annotations ?? []) if (an.evLossBb != null) loss += an.evLossBb;
  return hands ? loss / hands * 100 : 0;
}
function renderLeak() {
  const b = $('#b-leak');
  if (!leakLive) { b.textContent = '🎯'; b.classList.remove('leak-ok', 'leak-bad'); return; }
  const lk = leakOf(docs);
  b.textContent = `🎯 ${lk.toFixed(1)} bb/100`;
  b.classList.toggle('leak-ok', lk < 5);
  b.classList.toggle('leak-bad', lk >= 5);
}
function renderHand(reveal = false) {
  if (!h) return;
  const pot = h.seats.reduce((a, s) => a + s.handCommit, 0);
  $('#pot').textContent = pot > 0 ? `pot ${pot}` : '';
  const boardEl = $('#board');
  if (boardEl.children.length > h.board.length) boardEl.innerHTML = '';
  for (let bi = boardEl.children.length; bi < h.board.length; bi++) {
    boardEl.appendChild(cardEl(ascii(h.board[bi])));
    sCard();
  }
  for (const i of [HERO, BOT]) {
    const s = h.seats[i], el = seats[i];
    el.nm.textContent = i === HERO ? 'You' : 'Level ' + level;
    el.st.textContent = s.stack;
    el.root.classList.toggle('active', h.phase === 'act' && h.toAct === i);
    let db = el.root.querySelector('.dbtn');
    if (h.button === i) {
      if (!db) { db = document.createElement('div'); db.className = 'dbtn'; db.textContent = 'D'; el.root.appendChild(db); }
    } else if (db) db.remove();
    const show = i === HERO || reveal;
    const sig = s.hole ? (show ? s.hole.map(ascii).join('') : 'back' + s.hole.length) : '';
    if (el.cards.dataset.sig !== sig) {
      el.cards.dataset.sig = sig;
      el.cards.innerHTML = '';
      if (s.hole) for (const c of s.hole) el.cards.appendChild(show ? cardEl(ascii(c)) : backEl());
    }
    if (s.folded) say(i, 'folded');
    const bp = $('#bet-' + i);
    bp.classList.toggle('show', s.streetCommit > 0 && h.phase === 'act');
    bp.querySelector('span').textContent = s.streetCommit;
  }
}
const SAY_COL = { fold: '#e08a85', folded: '#e08a85', check: '#8fd0a0', call: '#8fd0a0', bet: '#e2c06a', raise: '#e2c06a' };
const say = (i, txt) => {
  const el = seats[i].said;
  el.textContent = txt;
  el.style.color = SAY_COL[txt.split(' ')[0]] ?? '#b9c4b4';
};
const caption = (html) => { $('#caption').innerHTML = html; };

// ---------------------------------------------------------------- mixes
function teachMix(L) {
  if (h.street === 3) {
    const rm = riverMix(h, HERO, table, {});
    if (rm) return { acts: rm.acts, probs: rm.probs, known: true, solved: true };
  }
  return tableMix(h, HERO, L, table);
}
function mixNames(mix, L) {
  return mix.acts.map((ac) => ac === 'k' ? (L.callAmount > 0 ? 'call' : 'check')
    : ac === 'b' ? (L.actions.includes('bet') ? 'bet' : 'raise') : 'fold');
}
function mixOnButtons(mix, L) {
  const target = { k: $('#b-call'), b: $('#b-raise'), f: $('#b-fold') };
  mix.acts.forEach((ac, i) => {
    const btn = target[ac];
    if (!btn) return;
    let p = btn.querySelector('.pct');
    if (!p) { p = document.createElement('span'); p.className = 'pct'; btn.appendChild(p); }
    const v = Math.round(mix.probs[i] * 100);
    p.textContent = v + '%';
    p.classList.toggle('zero', v === 0);
  });
}
const gradeWord = (pChosen, pMax) =>
  pChosen >= pMax - 1e-9 ? 'book' : pChosen >= 0.2 ? 'mix' : pChosen >= 0.05 ? 'inaccuracy' : 'off the chart';

// ---------------------------------------------------------------- hero turn
function heroTurn(L) {
  const bar = $('#actions');
  bar.innerHTML = '';
  caption('');
  let hinted = false;
  const assist = !rated && table;
  let coachMix = null;
  if (assist && coachMode) { const m = teachMix(L); if (m.known) { hinted = true; coachMix = m; } }
  if (assist && !coachMode) {
    const bh = document.createElement('button'); bh.className = 'qbtn'; bh.textContent = '💡';
    bh.title = 'Show the reference mix (flagged in the scorecard)';
    bh.addEventListener('click', () => {
      const m = teachMix(L);
      if (!m.known) { caption('no line for this spot'); return; }
      hinted = true; mixOnButtons(m, L); bh.disabled = true;
      if (m.solved) caption('🧭 exact river solve');
    });
    bar.appendChild(bh);
  }
  const bF = document.createElement('button'); bF.id = 'b-fold'; bF.textContent = 'FOLD';
  const bC = document.createElement('button'); bC.id = 'b-call';
  bC.textContent = L.callAmount === 0 ? 'CHECK' : `CALL ${L.callAmount}`;
  bar.append(bF, bC);
  let bR = null;
  if (L.actions.includes('bet') || L.actions.includes('raise')) {
    bR = document.createElement('button'); bR.id = 'b-raise';
    bR.textContent = (L.actions.includes('bet') ? 'BET ' : 'RAISE TO ') + L.minRaiseTo;
    bar.appendChild(bR);
  }
  if (coachMix) mixOnButtons(coachMix, L);
  return new Promise((resolve) => {
    heroResolve = (a) => { bar.innerHTML = ''; heroResolve = null; resolve({ ...a, hinted }); };
    bF.addEventListener('click', () => heroResolve({ seat: HERO, action: 'fold' }));
    bC.addEventListener('click', () => heroResolve({ seat: HERO, action: L.callAmount === 0 ? 'check' : 'call' }));
    if (bR) bR.addEventListener('click', () => heroResolve({ seat: HERO, action: L.actions.includes('bet') ? 'bet' : 'raise', amount: L.minRaiseTo }));
  });
}
document.addEventListener('keydown', (e) => {
  audio();
  if (e.key === '4') { if (!rated) { coachMode = !coachMode; localStorage.setItem('lp.coach', coachMode ? '1' : '0'); caption(coachMode ? '🎓 coach on' : ''); } return; }
  if (e.key === '5') { leakLive = !leakLive; localStorage.setItem('lp.leak', leakLive ? '1' : '0'); renderTop(); return; }
  if (!heroResolve) return;
  if (e.key === '1' || e.key === 'f') $('#b-fold')?.click();
  if (e.key === '2' || e.key === 'c' || e.key === ' ') { e.preventDefault(); $('#b-call')?.click(); }
  if (e.key === '3' || e.key === 'r') $('#b-raise')?.click();
});

// ---------------------------------------------------------------- the doc
// A finished engine hand, rewritten as a Libre Poker Hand v0 document.
function buildDoc(hh, seed, gradeList) {
  const actions = [];
  for (const e of hh.log) {
    if (e.ev === 'street') { actions.push({ street: e.street }); continue; }
    if (!['fold', 'check', 'call', 'bet', 'raise'].includes(e.ev)) continue;
    const a = { seat: e.seat, act: e.ev };
    if (e.ev === 'bet' || e.ev === 'raise') a.to = e.to;
    else if (e.ev === 'call' && e.amount != null) a.amount = e.amount;
    actions.push(a);
  }
  const used = new Set();
  const annotations = [];
  let sn = 'preflop';
  actions.forEach((a, idx) => {
    if (a.street) { sn = a.street; return; }
    if (a.seat !== HERO) return;
    const g = gradeList.find((x, gi) => !used.has(gi) && x.street === sn && used.add(gi));
    if (!g) return;
    const an = { action: idx };
    if (g.mix) an.mix = g.mix;
    if (g.evLossBb != null) { an.evLossBb = +g.evLossBb.toFixed(4); an.exact = true; }
    if (g.hinted) an.hinted = true;
    if (an.mix || an.evLossBb != null) annotations.push(an);
  });
  const doc = {
    '@context': 'https://librepoker.org/context.jsonld',
    type: 'Hand', v: 0, variant: 'holdem-limit',
    seed, sb: hh.sb, bb: hh.bb, ante: hh.ante, button: hh.button,
    seats: hh.seats.map((s, i) => ({
      name: i === HERO ? 'You' : `Level ${level}`,
      startStack: s.startStack,
      hole: s.hole ? s.hole.map(ascii) : null,
      ...(i === BOT ? { agent: `librepoker-ladder-${level}` } : {}),
    })),
    board: hh.board.map(ascii),
    actions,
    result: {
      showdown: hh.result.showdown,
      pot: hh.result.pots.reduce((a, p) => a + p.amount, 0),
      winners: hh.result.winners.map((w) => ({ seat: w.seat, amount: w.amount })),
    },
  };
  if (annotations.length) doc.annotations = annotations;
  return doc;
}

// ---------------------------------------------------------------- views
// Pure functions over Hand documents — the schema pays its first rent.
function transcriptHTML(doc) {
  const who = (i) => doc.seats[i].name;
  const bCount = { flop: 3, turn: 4, river: 5 };
  const anns = new Map((doc.annotations ?? []).map((a) => [a.action, a]));
  const lines = [];
  lines.push(`<div style="color:var(--ink-soft);font-size:13.5px">${doc.variant} · blinds ${doc.sb}/${doc.bb} · button ${who(doc.button)}</div>`);
  lines.push(doc.seats.map((s) => `${s.name}: ${s.hole ? prettyCards(s.hole) : '—'}`).join(' &nbsp;·&nbsp; '));
  lines.push(`<div style="color:var(--gold);font-weight:700;font-family:system-ui,sans-serif;font-size:12px;letter-spacing:.12em;margin-top:8px">PREFLOP</div>`);
  doc.actions.forEach((a, i) => {
    if (a.street) {
      lines.push(`<div style="color:var(--gold);font-weight:700;font-family:system-ui,sans-serif;font-size:12px;letter-spacing:.12em;margin-top:8px">${a.street.toUpperCase()} &nbsp;${prettyCards(doc.board.slice(0, bCount[a.street]))}</div>`);
      return;
    }
    const me = a.seat === HERO;
    const col = a.act === 'fold' ? 'var(--red)' : (a.act === 'bet' || a.act === 'raise') ? 'var(--gold)' : 'var(--green)';
    const verb = a.act === 'raise' ? `raise${me ? '' : 's'} to ${a.to}` : a.act === 'bet' ? `bet${me ? '' : 's'} ${a.to}`
      : a.act === 'call' ? `call${me ? '' : 's'}${a.amount != null ? ' ' + a.amount : ''}` : `${a.act}${me ? '' : 's'}`;
    let line = `${who(a.seat)} <b style="color:${col}">${verb}</b>`;
    const an = anns.get(i);
    if (an) {
      const mix = an.mix ? Object.entries(an.mix).map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join(' · ') : '';
      const cost = an.evLossBb != null ? ` <b style="color:${an.evLossBb < 0.05 ? 'var(--green)' : an.evLossBb < 0.5 ? 'var(--gold)' : 'var(--red)'}">−${an.evLossBb.toFixed(2)}bb</b>` : '';
      line += ` <span style="color:var(--ink-soft);font-size:13px">${mix ? '— ' + mix : ''}</span>${cost}${an.hinted ? ' 🔍' : ''}`;
    }
    lines.push(`<div>${line}</div>`);
  });
  lines.push(`<div style="margin-top:8px;border-top:1px solid var(--line);padding-top:6px">${doc.result.winners.map((w) => `${who(w.seat)} ${w.seat === HERO ? 'win' : 'wins'} ${w.amount}`).join(' · ')}${doc.result.showdown ? '' : ' <span style="color:var(--ink-soft)">(no showdown)</span>'}</div>`);
  return lines.map((l) => l.startsWith('<div') ? l : `<div>${l}</div>`).join('');
}
function transcriptText(doc) {
  const who = (i) => doc.seats[i].name;
  const bCount = { flop: 3, turn: 4, river: 5 };
  const anns = new Map((doc.annotations ?? []).map((a) => [a.action, a]));
  const out = [`Libre Poker — ${doc.variant}, blinds ${doc.sb}/${doc.bb}`];
  out.push(doc.seats.map((s) => `${s.name}: ${s.hole ? s.hole.join(' ') : '—'}`).join('  ·  '), '', 'PREFLOP');
  doc.actions.forEach((a, i) => {
    if (a.street) { out.push('', `${a.street.toUpperCase()}  ${doc.board.slice(0, bCount[a.street]).join(' ')}`); return; }
    const verb = a.act === 'raise' ? `raises to ${a.to}` : a.act === 'bet' ? `bets ${a.to}`
      : a.act === 'call' ? `calls${a.amount != null ? ' ' + a.amount : ''}` : a.act + 's';
    let line = `${who(a.seat)} ${verb}`;
    const an = anns.get(i);
    if (an) line += `   [${an.mix ? 'reference: ' + Object.entries(an.mix).map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join(' · ') : ''}${an.evLossBb != null ? ` | EV loss: ${an.evLossBb.toFixed(2)} bb (exact)` : ''}${an.hinted ? ' | hinted' : ''}]`;
    out.push(line);
  });
  out.push('', doc.result.winners.map((w) => `${who(w.seat)} wins ${w.amount}`).join(' · ') + (doc.result.showdown ? ' at showdown' : ' (no showdown)'));
  out.push('', 'Reference mixes are near-equilibrium (trained CFR, solved preflop, exact river solves). Schema: https://github.com/libre-poker/schema');
  return out.join('\n');
}
let openDocIdx = -1;
function openHandModal(i) {
  const doc = docs[i];
  if (!doc) return;
  openDocIdx = i;
  $('#hand-title').childNodes[0].textContent = `Hand #${i + 1} `;
  $('#hand-body').innerHTML = transcriptHTML(doc);
  $('#m-hand').classList.add('open');
}
function renderScorecard() {
  const lk = leakOf(docs);
  $('#score-leak').innerHTML = `<b style="color:${lk < 5 ? 'var(--green)' : 'var(--red)'}">🎯 ${lk.toFixed(1)} bb/100</b>`;
  $('#score-note').textContent = docs.length
    ? `${docs.length} hands · net ${net >= 0 ? '+' : ''}${net} chips · click a hand for the transcript`
    : 'No hands yet — the cards are waiting.';
  $('#score-list').innerHTML = docs.map((d, i) => {
    let loss = null;
    for (const an of d.annotations ?? []) if (an.evLossBb != null) loss = (loss ?? 0) + an.evLossBb;
    const col = loss == null ? 'var(--ink-soft)' : loss < 0.05 ? 'var(--green)' : loss < 0.5 ? 'var(--gold)' : 'var(--red)';
    const hero = d.seats[HERO].hole ? prettyCards(d.seats[HERO].hole) : '—';
    const flop = d.board.length >= 3 ? prettyCards(d.board.slice(0, 3)) : '<span style="opacity:.4">—</span>';
    const lossTxt = loss == null ? '·' : loss < 0.005 ? '0.00' : '−' + loss.toFixed(2) + 'bb';
    return `<div class="score-row" data-i="${i}"><div style="display:flex;gap:12px;align-items:baseline;pointer-events:none">
      <span style="width:36px;color:var(--ink-soft)">#${i + 1}</span>
      <span style="width:70px">${hero}</span>
      <span style="flex:1;color:var(--ink-soft)">${flop}</span>
      <b style="color:${col};min-width:64px;text-align:right">${lossTxt}</b></div></div>`;
  }).join('');
}

// ---------------------------------------------------------------- the loop
async function playHand() {
  handNo++;
  const seed = await sha256hex(`${sessionSeed}|hand|${handNo}`);
  h = newHand({
    seats: [{ name: 'You', stack: STACK }, { name: `Level ${level}`, stack: STACK }],
    button: handNo % 2, sb: SB, bb: BB, seedHex: seed, limit: true,
  });
  const rng = rngFromSeed(await sha256hex(`${seed}|bot`));
  const cache = {};
  const handGrades = [];
  seats.forEach((s) => { s.said.textContent = ''; });
  $('#verdict').textContent = '';
  renderHand(); sCard();
  caption(rated ? `hand ${handNo} of ${RATED_HANDS}` : '');
  await sleep(400);

  let guard = 0;
  while (h.phase === 'act' && guard++ < 200) {
    renderHand();
    const L = legal(h);
    if (L.seat === HERO) {
      const a = await heroTurn(L);
      // grade before acting: the mix belongs to the decision point
      let g = null;
      if (table) {
        const mix = teachMix(L);
        if (mix.known) {
          const names = mixNames(mix, L);
          const chosen = a.action === 'fold' ? 'f' : (a.action === 'bet' || a.action === 'raise') ? 'b' : 'k';
          const ci = mix.acts.indexOf(chosen);
          const pChosen = ci >= 0 ? mix.probs[ci] : 0;
          let evLossBb = null;
          if (mix.solved) {
            const ev = riverEvs(h, HERO, table, cache);
            const ei = ev ? ev.acts.indexOf(chosen) : -1;
            if (ei >= 0) evLossBb = (Math.max(...ev.evs) - ev.evs[ei]) / h.bb;
          }
          g = {
            street: STREETS[h.street], hinted: a.hinted,
            mix: Object.fromEntries(mix.acts.map((ac, i2) => [names[i2], +mix.probs[i2].toFixed(4)])),
            evLossBb,
          };
          handGrades.push(g);
        }
      }
      act(h, { seat: a.seat, action: a.action, amount: a.amount });
      say(HERO, a.action + (a.amount ? ' ' + a.amount : ''));
      if (g && !rated) {
        const pC = g.mix[mixKeyOf(a)] ?? 0;
        const pM = Math.max(...Object.values(g.mix));
        sGrade(gradeWord(pC, pM));
      }
      sChip();
    } else {
      await sleep(420 + rng() * 500);
      let a = null;
      if (h.street === 3) {
        const mix = riverMix(h, BOT, table, cache);
        if (mix) {
          const eps = LEVEL_EPS[level] ?? 0;
          const probs = mix.probs.map((p) => (1 - eps) * p + eps / mix.probs.length);
          let x = rng(), pick = 0;
          for (let k = 0; k < probs.length; k++) { x -= probs[k]; if (x <= 0) { pick = k; break; } }
          const ch = mix.acts[Math.min(pick, mix.acts.length - 1)];
          if (ch === 'f' && L.callAmount > 0) a = { seat: BOT, action: 'fold' };
          else if (ch === 'b' && (L.actions.includes('bet') || L.actions.includes('raise'))) {
            a = { seat: BOT, action: L.actions.includes('bet') ? 'bet' : 'raise', amount: L.minRaiseTo };
          } else a = { seat: BOT, action: L.callAmount > 0 ? 'call' : 'check' };
        }
      }
      if (!a) a = ladderDecide(h, BOT, L, table, LEVEL_EPS[level] ?? 0, rng);
      act(h, a);
      say(BOT, a.action + (a.amount ? ' ' + a.amount : ''));
      sChip();
    }
  }

  // settle
  const r = h.result;
  renderHand(r.showdown);
  if (r.showdown) {
    const names = Object.entries(r.evals ?? {}).map(([i, e]) => `${+i === HERO ? 'you' : 'it'}: ${handName(e)}`).join(' · ');
    $('#verdict').textContent = names;
  }
  const heroDelta = h.seats[HERO].stack - STACK;
  net += heroDelta;
  const w = r.winners.map((x) => `${x.seat === HERO ? 'You win' : 'Level ' + level + ' wins'} ${x.amount}`).join(' · ');
  caption(`${w}${heroDelta !== 0 ? ` · net ${net >= 0 ? '+' : ''}${net}` : ''}`);
  docs.push(buildDoc(h, seed, handGrades));
  renderTop();
  await sleep(r.showdown ? 2000 : 1200);
}
// helper: which mix key did the hero's action land on
function mixKeyOf(a) {
  return a.action === 'fold' ? 'fold' : a.action === 'check' ? 'check' : a.action === 'call' ? 'call'
    : a.action === 'bet' ? 'bet' : 'raise';
}

async function matchEnd() {
  const won = net > 0 ? 1 : net < 0 ? 0 : 0.5;
  const before = Math.round(rating.r);
  rating = glicko2(rating, [{ r: LEVEL_RATING[level], rd: LEVEL_RD, score: won }]);
  localStorage.setItem('lp.rating', JSON.stringify(rating));
  const after = Math.round(rating.r);
  renderTop();
  renderScorecard();
  $('#score-note').textContent =
    `Rated match vs level ${level}: ${net >= 0 ? '+' : ''}${net} chips over ${RATED_HANDS} hands — ` +
    `rating ${before} → ${after} (${after - before >= 0 ? '+' : ''}${after - before}). Click a hand for the transcript.`;
  $('#m-score').classList.add('open');
  matchOpen = false;
  caption(`match over — <a href="#" id="again">deal the next match</a>`);
  $('#again').addEventListener('click', (e) => { e.preventDefault(); newMatch(); });
}
async function newMatch() {
  docs = []; net = 0; handNo = 0;
  sessionSeed = await sha256hex(`lp|${Date.now()}|${Math.random()}`);
  matchOpen = true;
  renderTop();
  run();
}
let running = false;
async function run() {
  if (running) return;
  running = true;
  while (matchOpen) {
    await playHand();
    if (rated && handNo >= RATED_HANDS) { await matchEnd(); break; }
  }
  running = false;
}

// ---------------------------------------------------------------- wiring
$('#b-level').addEventListener('click', () => {
  if (rated && handNo > 0 && matchOpen) { caption('level locks during a rated match'); return; }
  level = level >= 7 ? 2 : level + 1;
  localStorage.setItem('lp.level', level);
  renderTop(); renderHand();
});
$('#b-rated').addEventListener('click', () => {
  rated = !rated;
  localStorage.setItem('lp.rated', rated ? '1' : '0');
  newMatch();
});
$('#b-sound').addEventListener('click', () => {
  audio(); soundOn = !soundOn;
  localStorage.setItem('lp.sound', soundOn ? '1' : '0');
  renderTop();
});
$('#b-leak').addEventListener('click', () => {
  leakLive = !leakLive;
  localStorage.setItem('lp.leak', leakLive ? '1' : '0');
  renderTop();
});
$('#b-score').addEventListener('click', () => {
  if (rated && matchOpen && handNo > 0) { caption('the scorecard opens when the rated match ends'); return; }
  renderScorecard();
  $('#m-score').classList.add('open');
});
$('#score-list').addEventListener('click', (e) => {
  const row = e.target.closest('[data-i]');
  if (row) openHandModal(+row.dataset.i);
});
$('#b-copyjson').addEventListener('click', async (e) => {
  const doc = docs[openDocIdx];
  if (!doc) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(doc, null, 2));
    e.target.textContent = '✓'; setTimeout(() => { e.target.textContent = '{ } json'; }, 1200);
  } catch { caption('clipboard blocked'); }
});
$('#b-copytext').addEventListener('click', async (e) => {
  const doc = docs[openDocIdx];
  if (!doc) return;
  try {
    await navigator.clipboard.writeText(transcriptText(doc));
    e.target.textContent = '✓'; setTimeout(() => { e.target.textContent = '📋 text'; }, 1200);
  } catch { caption('clipboard blocked'); }
});
$('#b-help').addEventListener('click', () => $('#m-help').classList.add('open'));
document.querySelectorAll('.wrap .x').forEach((x) => x.addEventListener('click', () => x.closest('.wrap').classList.remove('open')));
document.querySelectorAll('.wrap').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) m.classList.remove('open'); }));
document.addEventListener('pointerdown', audio, { once: true });

// ---------------------------------------------------------------- boot
(async () => {
  renderTop();
  caption('fetching the strategy…');
  try {
    const r = await fetch('strategy-hulimit.json');
    const j = await r.json();
    table = j.table;
    if (j.edges) setEquityEdges(j.edges);
    caption('');
  } catch {
    caption('strategy failed to load — refresh to retry');
    return;
  }
  newMatch();
})();
