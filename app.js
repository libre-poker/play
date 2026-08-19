// app.js — the room. Schema-native by construction: every finished hand
// becomes a Libre Poker Hand document (libre-poker/schema), and the
// scorecard, the transcript, and both copy buttons are pure views over
// those documents. The live table is the one view that reads the engine
// directly — everything after the settle reads only the record.
import {
  cardName, rankOf, suitOf, RANKS, newHand, legal, act, handName, rngFromSeed, STREETS, bestFive, evaluate,
} from './engine/poker.js';
import { ladderDecide, tableMix, setEquityEdges } from './engine/ladder.js';
import { riverMix, riverEvs } from './engine/river-solver.js';
import { glicko2, freshRating, LEVEL_RATING, LEVEL_RD } from './engine/rating.js';
import { verifyReveal } from './croupier-verify.js';

const $ = (q) => document.querySelector(q);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256hex = async (s) => {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
};

// ---------------------------------------------------------------- state
const HERO = 0, BOT = 1;
let HERO_SEAT = 0;                 // engine seat of the human at this keyboard
const SB = 10, BB = 20, STACK = 2000;
const RATED_HANDS = 20;
const LEVEL_EPS = { 2: .45, 3: .3, 4: .2, 5: .12, 6: .06, 7: 0 };
let level = Math.min(7, Math.max(2, +(localStorage.getItem('lp.level') || 7)));
let rated = localStorage.getItem('lp.rated') === '1';
let soundOn = localStorage.getItem('lp.sound') !== '0';
let leakLive = localStorage.getItem('lp.leak') === '1';
let turbo = localStorage.getItem('lp.turbo') === '1';
let matchT0 = 0;                  // first decision of the match — the drill clock
// premove: one queued intent, armed by double-press while it's not your
// turn, scoped to the hand — fires at your next turn or dies at settle
let premove = null;
let preKey = { k: null, t: 0 };
const PRE_LABEL = { fold: 'FOLD', call: 'CHECK / CALL', raise: 'BET / RAISE' };
function renderPremove() {
  const bar = $('#actions');
  if (heroResolve) return;                       // real buttons own the bar
  if (premove) bar.innerHTML = `<span style="color:var(--gold);font-size:13px;font-weight:800;letter-spacing:.06em;opacity:.85">⏭ ${PRE_LABEL[premove]} armed — same key clears</span>`;
  else if (bar.firstElementChild?.tagName === 'SPAN') bar.innerHTML = '';
}
function realizePremove(intent, L) {
  if (intent === 'fold') return { seat: HERO, action: L.callAmount > 0 ? 'fold' : 'check' };
  if (intent === 'call') return { seat: HERO, action: L.callAmount > 0 ? 'call' : 'check' };
  if (L.actions.includes('bet')) return { seat: HERO, action: 'bet', amount: L.minRaiseTo };
  if (L.actions.includes('raise')) return { seat: HERO, action: 'raise', amount: L.minRaiseTo };
  return null;                                   // raise impossible: discard, play it live
}
let bank = +(localStorage.getItem('lp.bank') ?? 0) || 0;
// lifetime river ledger: every exactly-graded river decision, by action —
// the number a student of calls is trying to zero
let rivers = { hands: 0, cats: {} };
try { rivers = Object.assign(rivers, JSON.parse(localStorage.getItem('lp.rivers') || '{}')) } catch { /* fresh */ }
function riversAdd(grades) {
  rivers.hands++;
  for (const g of grades) {
    if (g.evLossBb == null) continue;
    const cat = g.action === 'raise' ? 'bet' : (g.action || 'other');
    const c = rivers.cats[cat] || (rivers.cats[cat] = { loss: 0, n: 0 });
    c.loss += g.evLossBb; c.n++;
  }
  localStorage.setItem('lp.rivers', JSON.stringify(rivers));
}
function riversLine() {
  if (!rivers.hands) return '';
  const parts = ['call', 'fold', 'bet', 'check'].filter((k) => rivers.cats[k]).map((k) => {
    const c = rivers.cats[k];
    const per100 = c.loss / rivers.hands * 100;
    return `${k}s <b style="color:${per100 < 0.5 ? 'var(--green)' : per100 < 2 ? 'var(--gold)' : 'var(--red)'}">${per100.toFixed(1)}</b> (${c.n})`;
  });
  return parts.length ? `river leak by action, lifetime over ${rivers.hands.toLocaleString()} hands · bb/100 (decisions): ${parts.join(' · ')}` : '';
}
function bankAdd(delta) {
  bank += delta;
  localStorage.setItem('lp.bank', String(bank));
}
let coachMode = localStorage.getItem('lp.coach') === '1';
let fourColor = localStorage.getItem('lp.fourc') !== '0';   // default on: a trainer reads suits fast
let commit8 = '';                 // sha256(seed) prefix — the shuffle's promise
let rating = freshRating();
try { rating = Object.assign(freshRating(), JSON.parse(localStorage.getItem('lp.rating') || '{}')); } catch { /* fresh */ }
// one-time migration to the 2500-centered scale (a pure translation:
// every gap, and therefore every prediction, is unchanged)
if (rating.r < 2000 && !rating.era2500) { rating.r += 1000; rating.era2500 = true; localStorage.setItem('lp.rating', JSON.stringify(rating)); }

let table = null;                 // the champion strategy
let h = null;                     // live engine hand
let handNo = 0;                   // 1-based, this session/match
let heroResolve = null;
let liveL = null, liveMark = null;   // the decision currently on the buttons
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
function posSignal(isButton) {
  const bar = $('#actions');
  bar.classList.toggle('pos-btn', isButton);
  bar.classList.toggle('pos-bb', !isButton);
  sPos(isButton);
}
function sGrade(word) {
  if (word === 'book') seq([659, 988], 85, .11, .038);
  else if (word === 'mix') blip(659, .09, .028, 'sine');
  else if (word === 'inaccuracy') blip(233, .11, .03, 'sine');
  else seq([220, 165], 110, .12, .034);
}
const sCard = () => blip(1180, .04, .02);
const sPos = (btn) => btn ? seq([1320, 1760], 55, .05, .032) : blip(196, .12, .045, 'sine');
const sChip = () => blip(720, .05, .03);

// ---------------------------------------------------------------- cards
const ascii = (c) => RANKS[rankOf(c)] + 'cdhs'[suitOf(c)];
const isRed = (a) => a[1] === 'd' || a[1] === 'h';
const GLYPH = { c: '♣', d: '♦', h: '♥', s: '♠' };
function cardEl(a) {
  const d = document.createElement('div');
  d.className = 'card flipin s-' + a[1] + (isRed(a) ? ' red' : '');
  d.innerHTML = `<div class="cr">${a[0] === 'T' ? '10' : a[0]}<b>${GLYPH[a[1]]}</b></div><div class="cp">${GLYPH[a[1]]}</div>`;
  return d;
}
function backEl() { const d = document.createElement('div'); d.className = 'card back'; return d; }
const prettyA = (a) => `<b style="color:${isRed(a) ? 'var(--red)' : 'inherit'}">${a[0] === 'T' ? '10' : a[0]}${GLYPH[a[1]]}</b>`;
const prettyCards = (arr) => arr.map(prettyA).join(' ');

// ---------------------------------------------------------------- chips
// denominated CSS chip stacks: 5 red, 25 green, 100 black, 500 purple
const DENOMS = [[500, 'd500'], [100, 'd100'], [25, 'd25'], [5, 'd5']];
function chipStackInto(el, amount) {
  el.innerHTML = '';
  let rest = Math.max(0, Math.round(amount / 5) * 5);
  for (const [v, cls] of DENOMS) {
    let n = Math.floor(rest / v);
    rest -= n * v;
    while (n > 0) {
      const col = document.createElement('span');
      col.className = 'col ' + cls;
      const inCol = Math.min(4, n);
      for (let k = 0; k < inCol; k++) col.appendChild(document.createElement('i'));
      el.appendChild(col);
      n -= inCol;
    }
  }
  if (!el.children.length && amount > 0) {
    const col = document.createElement('span');
    col.className = 'col d5';
    col.appendChild(document.createElement('i'));
    el.appendChild(col);
  }
}

// ---------------------------------------------------------------- flight
// clone a node, fly it to a target, resolve when it lands
function fly(fromEl, toEl, ms = 420) {
  if (turbo) ms = 90;
  return new Promise((resolve) => {
    const fx = $('#fx');
    if (!fx || !fromEl || !toEl) return resolve();
    const a = fromEl.getBoundingClientRect(), b = toEl.getBoundingClientRect(), f = fx.getBoundingClientRect();
    const c = fromEl.cloneNode(true);
    c.className = (c.className || '') + ' flych';
    c.classList.add('flych');
    c.style.left = (a.left - f.left) + 'px';
    c.style.top = (a.top - f.top) + 'px';
    fx.appendChild(c);
    requestAnimationFrame(() => {
      c.style.transform = `translate(${b.left - a.left + (b.width - a.width) / 2}px, ${b.top - a.top}px)`;
      c.style.opacity = '0.15';
    });
    setTimeout(() => { c.remove(); resolve(); }, ms);
  });
}

// street end: the live bets fly to the pot
async function sweepBets(preCommits) {
  const jobs = [];
  for (const i of [0, 1]) {
    if (!preCommits[i]) continue;
    const bp = $('#bet-' + i);
    if (bp.classList.contains('show')) jobs.push(fly(bp, $('#potrow'), 400));
  }
  if (jobs.length) { sChip(); await Promise.all(jobs); }
}

// ---------------------------------------------------------------- log
const logLines = [];
function logLine(html, cls = '') {
  logLines.push({ html, cls });
  if (logLines.length > 400) logLines.shift();
  const body = $('#logbody');
  if (body) {
    const d = document.createElement('div');
    if (cls) d.className = cls;
    d.innerHTML = html;
    body.appendChild(d);
    while (body.children.length > 400) body.firstChild.remove();
    body.scrollTop = body.scrollHeight;
  }
}

// ---------------------------------------------------------------- render
const seats = [0, 1].map((i) => ({
  root: $('#seat-' + i), nm: $(`#seat-${i} .nm`), stk: $(`#seat-${i} .stk`),
  bb: $(`#seat-${i} .bbline`), pos: $(`#seat-${i} .pos`),
  cards: $('#cards-' + i), said: $(`#seat-${i} .said`),
  tbar: $(`#seat-${i} .tbar i`),
}));
function renderTop() {
  $('#tmeta').textContent = `limit hold'em · ${SB}/${BB} · heads-up${handNo ? ` · hand #${handNo}` : ''}`;
  $('#b-level').textContent = `Lv ${level}`;
  $('#b-rating').textContent = `⚡ ${Math.round(rating.r)}${rating.rd > 110 ? '?' : ''}`;
  const bk = $('#b-bank');
  bk.textContent = `🏦 ${bank >= 0 ? '+' : ''}${bank.toLocaleString()}`;
  bk.classList.toggle('leak-ok', bank > 0);
  bk.classList.toggle('leak-bad', bank < 0);
  const effRated = NET.on ? !!NET.rated : rated;
  $('#b-rated').textContent = effRated ? `🏅 rated ${Math.min(handNo, RATED_HANDS)}/${RATED_HANDS}` : '☕ casual';
  $('#b-rated').classList.toggle('on', effRated);
  $('#b-sound').textContent = soundOn ? '🔊' : '🔇';
  $('#b-leak').classList.toggle('on', leakLive);
  $('#b-turbo').classList.toggle('on', turbo);
  renderLeak();
}
function leakOf(ds) {
  let loss = 0, hands = ds.length;
  for (const d of ds) for (const an of d.annotations ?? []) if (an.evLossBb != null) loss += an.evLossBb;
  return hands ? loss / hands * 100 : 0;
}
function renderLeak() {
  const b = $('#b-leak');
  const lk = leakOf(docs);
  b.textContent = leakLive ? `leak ${lk.toFixed(1)} bb/100` : `leak ${lk.toFixed(1)}`;
  b.classList.toggle('leak-ok', lk < 5);
  b.classList.toggle('leak-bad', lk >= 5);
}
function renderHand(reveal = false) {
  if (!h) return;
  // the frame's arithmetic must not lie: the pot pill shows collected chips
  // only — live street bets sit on the felt as chip stacks
  const collected = h.seats.reduce((a, s) => a + s.handCommit - s.streetCommit, 0);
  const potEl = $('#pot');
  if (!potEl.classList.contains('winline')) {
    potEl.textContent = collected > 0 ? `Pot ${collected.toLocaleString()}` : '';
    chipStackInto($('#potchips'), collected);
  }
  $('#tmeta').textContent = `limit hold'em · ${SB}/${BB} · heads-up${handNo ? ` · hand #${handNo}` : ''}${h.phase === 'act' ? ' · ' + STREETS[h.street] : ' · showdown'}${commit8 ? ` · ${commit8}` : ''}`;
  const boardEl = $('#board');
  $('#table').classList.toggle('boardout', h.board.length > 0);
  if (boardEl.children.length > h.board.length) boardEl.innerHTML = '';
  for (let bi = boardEl.children.length; bi < h.board.length; bi++) {
    boardEl.appendChild(cardEl(ascii(h.board[bi])));
    sCard();
  }
  for (const i of [HERO, BOT]) {
    const s = h.seats[i], el = seats[i];
    el.nm.textContent = i === HERO ? 'You' : 'Bot';
    el.stk.textContent = s.stack.toLocaleString();
    el.bb.textContent = `${Math.round(s.stack / BB)} BB`;
    el.pos.textContent = h.button === i ? 'SB' : 'BB';
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
    el.root.classList.toggle('folded', s.folded);
    if (s.folded) say(i, 'folded');
    const bp = $('#bet-' + i);
    bp.classList.toggle('show', s.streetCommit > 0 && h.phase === 'act');
    bp.querySelector('.amt').textContent = s.streetCommit;
    chipStackInto(bp.querySelector('.cstack'), s.streetCommit);
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
    const rm = riverMix(h, HERO_SEAT, table, {});
    if (rm) return { acts: rm.acts, probs: rm.probs, known: true, solved: true };
  }
  return tableMix(h, HERO_SEAT, L, table);
}
function mixNames(mix, L) {
  return mix.acts.map((ac) => ac === 'k' ? (L.callAmount > 0 ? 'call' : 'check')
    : ac === 'b' ? (L.actions.includes('bet') ? 'bet' : 'raise') : 'fold');
}
function mixOnButtons(mix, L) {
  const target = { k: $('#b-call'), b: $('#b-raise'), f: $('#b-fold') };
  const pMax = Math.max(...mix.probs);
  mix.acts.forEach((ac, i) => {
    const btn = target[ac];
    if (!btn) return;
    let p = btn.querySelector('.sub');
    if (!p) { p = document.createElement('span'); p.className = 'sub'; btn.appendChild(p); }
    const v = Math.round(mix.probs[i] * 100);
    p.textContent = v + '%';
    p.classList.toggle('hot', mix.probs[i] >= pMax - 1e-9);
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
  liveL = L;
  if (premove) {
    const intent = premove;
    premove = null;
    const a = realizePremove(intent, L);
    if (a) { if (!matchT0) matchT0 = Date.now(); return Promise.resolve({ ...a, hinted: false }); }
  }
  liveMark = () => { hinted = true; };
  const tb = seats[HERO].tbar;
  tb.classList.remove('drain'); tb.style.width = '100%';
  requestAnimationFrame(() => requestAnimationFrame(() => tb.classList.add('drain')));
  const assist = !rated && table;
  let coachMix = null;
  if (assist && coachMode) { const m = teachMix(L); if (m.known) { hinted = true; coachMix = m; } }
  if (assist && !coachMode) {
    const bh = document.createElement('button'); bh.className = 'qbtn'; bh.textContent = '💡';
    bh.title = 'Show the reference mix (flagged in the scorecard)';
    bh.addEventListener('click', () => {
      const m = teachMix(L);
      if (!m.known) { caption('no line for this spot'); return; }
      hinted = true; mixOnButtons(m, L); bh.classList.add('on'); bh.disabled = true;
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
    heroResolve = (a) => {
      if (!matchT0) matchT0 = Date.now();
      bar.innerHTML = ''; heroResolve = null; liveL = null; liveMark = null;
      tb.classList.remove('drain'); tb.style.width = '100%';
      resolve({ ...a, hinted });
    };
    bF.addEventListener('click', () => heroResolve({ seat: HERO, action: 'fold' }));
    bC.addEventListener('click', () => heroResolve({ seat: HERO, action: L.callAmount === 0 ? 'check' : 'call' }));
    if (bR) bR.addEventListener('click', () => heroResolve({ seat: HERO, action: L.actions.includes('bet') ? 'bet' : 'raise', amount: L.minRaiseTo }));
  });
}
document.addEventListener('keydown', (e) => {
  audio();
  if (e.key === 'Escape') {
    // close the topmost open modal — the hand transcript stacks above
    // the scorecard, so it goes first
    const order = ['#m-hand', '#m-score', '#m-help', '#m-online'];
    for (const sel of order) {
      const m = $(sel);
      if (m?.classList.contains('open')) { m.classList.remove('open'); return; }
    }
    return;
  }
  const INTENTS = { 1: 'fold', f: 'fold', 2: 'call', c: 'call', 3: 'raise', r: 'raise' };
  if (!heroResolve && h && h.phase === 'act' && INTENTS[e.key]) {
    const intent = INTENTS[e.key];
    const now = Date.now();
    if (premove === intent && preKey.k === e.key && now - preKey.t < 3000) {
      premove = null;                            // same key again: disarm
    } else if (preKey.k === e.key && now - preKey.t < 450) {
      premove = intent;                          // double-press: arm
    }
    preKey = { k: e.key, t: now };
    renderPremove();
    return;
  }
  if (e.key === '4') {
    if (rated) return;
    coachMode = !coachMode;
    localStorage.setItem('lp.coach', coachMode ? '1' : '0');
    caption(coachMode ? '🎓 coach on' : '🎓 coach off');
    setTimeout(() => { if ($('#caption').textContent.startsWith('🎓')) caption(''); }, 1000);
    if (coachMode && heroResolve && liveL && table) {
      const m = teachMix(liveL);
      if (m.known) { mixOnButtons(m, liveL); liveMark?.(); document.querySelector('#actions .qbtn')?.classList.add('on'); }
    } else if (!coachMode) {
      document.querySelectorAll('#actions .sub').forEach((el) => el.remove());
      document.querySelector('#actions .qbtn')?.classList.remove('on');
    }
    return;
  }
  if (e.key === '5') { leakLive = !leakLive; localStorage.setItem('lp.leak', leakLive ? '1' : '0'); renderTop(); return; }
  if (e.key === '6') { turbo = !turbo; localStorage.setItem('lp.turbo', turbo ? '1' : '0'); caption(turbo ? '⏩ turbo on' : '⏩ turbo off'); setTimeout(() => { if ($('#caption').textContent.startsWith('⏩')) caption(''); }, 900); renderTop(); return; }
  if (!heroResolve) {
    // no live turn: keys drive the settle and between-match buttons
    if (e.key === '1' || e.key === 'f' || e.key === 'Enter') $('#b-next')?.click();
    if ((e.key === '2' || e.key === 'c') && !$('#b-fold')) $('#b-call')?.click();
    return;
  }
  if (e.key === '1' || e.key === 'f') $('#b-fold')?.click();
  if (e.key === '2' || e.key === 'c' || e.key === ' ') { e.preventDefault(); $('#b-call')?.click(); }
  if (e.key === '3' || e.key === 'r') $('#b-raise')?.click();
  if (e.key === 'Enter') $('#b-next')?.click();
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
    if (a.seat !== HERO_SEAT) return;
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
    hero: HERO_SEAT,
    seats: hh.seats.map((s, i) => ({
      name: i === HERO_SEAT ? 'You' : (NET.on ? (NET.oppName || 'Guest') : `Level ${level}`),
      startStack: s.startStack,
      hole: s.hole ? s.hole.map(ascii) : null,
      ...(!NET.on && i === BOT ? { agent: `librepoker-ladder-${level}` } : {}),
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
    const me = a.seat === (doc.hero ?? 0);
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
  $('#score-leak').innerHTML = `<b style="color:${lk < 5 ? 'var(--green)' : 'var(--red)'}">🎯 ${lk.toFixed(1)} bb/100</b>`
    + (riversLine() ? `<div style="font-size:12.5px;color:var(--ink-soft);margin-top:4px">${riversLine()}</div>` : '');
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
  commit8 = (await sha256hex(seed)).slice(0, 8);
  $('#tmeta').title = `shuffle committed before the deal: sha256(seed) = ${await sha256hex(seed)} — the seed travels in the hand's document`;
  const cache = {};
  const handGrades = [];
  premove = null;
  seats.forEach((s2) => { s2.said.textContent = ''; });
  $('#verdict').textContent = '';
  logLine(`Hand #${handNo} — blinds ${SB}/${BB}`, 'lh2');
  logLine(`<span class="lm">shuffle committed: ${commit8}…</span>`);
  renderHand(); sCard();
  posSignal(h.button === HERO);
  caption(rated ? `hand ${handNo} of ${RATED_HANDS}` : '');
  await sleep(turbo ? 60 : 400);

  let guard = 0;
  let lastStreet = 0;
  while (h.phase === 'act' && guard++ < 200) {
    if (h.street !== lastStreet) {
      lastStreet = h.street;
      logLine(`<span class="lm">${STREETS[h.street].toUpperCase()}  ${h.board.map((c) => ascii(c)).join(' ')}</span>`);
    }
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
            street: STREETS[h.street], hinted: a.hinted, action: a.action,
            mix: Object.fromEntries(mix.acts.map((ac, i2) => [names[i2], +mix.probs[i2].toFixed(4)])),
            evLossBb,
          };
          handGrades.push(g);
        }
      }
      const preCommits = h.seats.map((x) => x.streetCommit);
      act(h, { seat: a.seat, action: a.action, amount: a.amount });
      say(HERO, a.action + (a.amount ? ' ' + a.amount : ''));
      logLine(`You ${a.action}${a.amount ? ' ' + a.amount : ''}`);
      if (h.street !== lastStreet || h.phase !== 'act') await sweepBets(preCommits);
      if (g && !rated) {
        const pC = g.mix[mixKeyOf(a)] ?? 0;
        const pM = Math.max(...Object.values(g.mix));
        sGrade(gradeWord(pC, pM));
      }
      sChip();
    } else {
      await sleep(turbo ? 50 : 420 + rng() * 500);
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
      const preCommits = h.seats.map((x) => x.streetCommit);
      act(h, a);
      say(BOT, a.action + (a.amount ? ' ' + a.amount : ''));
      logLine(`Bot ${a.action}${a.amount ? ' ' + a.amount : ''}`);
      if (h.street !== lastStreet || h.phase !== 'act') await sweepBets(preCommits);
      sChip();
    }
  }

  // settle: the payoff scene
  const r = h.result;
  seats.forEach((s2) => { s2.said.textContent = ''; });
  renderHand(r.showdown);
  const winSeats = new Set(r.winners.map((x) => x.seat));
  for (const i of [HERO, BOT]) seats[i].root.classList.toggle('winner', winSeats.has(i));
  if (r.showdown) {
    const winCards = new Set();
    for (const w2 of winSeats) for (const c of bestFive([...h.seats[w2].hole, ...h.board])) winCards.add(c);
    [...$('#board').children].forEach((el, bi) => el.classList.add(winCards.has(h.board[bi]) ? 'win' : 'dead'));
    for (const i of [HERO, BOT]) {
      const won = winSeats.has(i);
      [...seats[i].cards.children].forEach((el, ci) => {
        el.classList.add(won && winCards.has(h.seats[i].hole[ci]) ? 'win' : 'dead');
      });
    }
  }
  if (r.showdown) {
    const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
    $('#verdict').innerHTML = Object.entries(r.evals ?? {}).map(([i, e]) =>
      `<span class="vtag ${winSeats.has(+i) ? 'vw' : 'vl'}">${+i === HERO ? 'You' : 'Bot'}: ${cap(handName(e))}</span>`).join('');
  }
  if (r.showdown) for (const [i2, e2] of Object.entries(r.evals ?? {})) logLine(`${+i2 === HERO ? 'You' : 'Bot'} shows ${h.seats[+i2].hole.map(ascii).join(' ')} — ${handName(e2)}`);
  const heroDelta = h.seats[HERO].stack - STACK;
  net += heroDelta;
  bankAdd(heroDelta);
  for (const w2 of r.winners) logLine(`<span class="lw">${w2.seat === HERO ? 'You win' : 'Bot wins'} ${w2.amount.toLocaleString()}</span>`);
  const potEl = $('#pot');
  const winSeat = r.winners[0]?.seat;
  if (winSeat != null && $('#potchips').children.length) await fly($('#potchips'), seats[winSeat].root, 450);
  potEl.classList.add('winline');
  potEl.textContent = r.winners.map((x) => `${x.seat === HERO ? 'You win' : 'Bot wins'} ${x.amount.toLocaleString()}`).join(' · ');
  caption(net !== 0 ? `net ${net >= 0 ? '+' : ''}${net}` : '');
  riversAdd(handGrades);
  docs.push(buildDoc(h, seed, handGrades));
  renderTop();
  // a visible way onward, always — click or let it auto-deal
  await new Promise((resolve) => {
    const bar = $('#actions');
    bar.innerHTML = '';
    const bn = document.createElement('button');
    bn.id = 'b-next'; bn.textContent = 'NEXT HAND';
    bn.addEventListener('click', () => resolve());
    bar.appendChild(bn);
    setTimeout(resolve, turbo ? (r.showdown ? 700 : 300) : (r.showdown ? 2600 : 1500));
  });
  $('#actions').innerHTML = '';
  $('#pot').classList.remove('winline');
  for (const i of [HERO, BOT]) seats[i].root.classList.remove('winner');
}
// helper: which mix key did the hero's action land on
function mixKeyOf(a) {
  return a.action === 'fold' ? 'fold' : a.action === 'check' ? 'check' : a.action === 'call' ? 'call'
    : a.action === 'bet' ? 'bet' : 'raise';
}

async function matchEnd() {
  // margin scoring: the chip margin carries skill signal a binary result
  // discards. ±1.7bb/hand over the match maps to a full win/loss — chosen
  // so its expectation matches the win rates the anchors were fitted to
  const cap = 1.7 * BB * RATED_HANDS;
  const score = Math.max(0, Math.min(1, 0.5 + net / (2 * cap)));
  const elapsed = matchT0 ? Date.now() - matchT0 : 0;
  const clock = elapsed
    ? ` — ⏱ ${Math.floor(elapsed / 60000)}:${String(Math.floor(elapsed / 1000) % 60).padStart(2, '0')} from first decision (${(elapsed / 1000 / RATED_HANDS).toFixed(1)}s/hand)`
    : '';
  const before = Math.round(rating.r);
  rating = glicko2(rating, [{ r: LEVEL_RATING[level], rd: LEVEL_RD, score }]);
  localStorage.setItem('lp.rating', JSON.stringify(rating));
  const after = Math.round(rating.r);
  renderTop();
  renderScorecard();
  $('#score-note').textContent =
    `Rated match vs level ${level}${NET.on ? ' (online, croupier-dealt)' : ''}: ${net >= 0 ? '+' : ''}${net} chips over ${RATED_HANDS} hands — ` +
    `margin score ${score.toFixed(2)} — rating ${before} → ${after} (${after - before >= 0 ? '+' : ''}${after - before})${clock}. Click a hand for the transcript.`;
  $('#m-score').classList.add('open');
  matchOpen = false;
  caption(`match over — <a href="#" id="again">deal the next match</a>`);
  $('#again').addEventListener('click', (e) => {
    e.preventDefault();
    if (NET.on) { $('#m-score').classList.remove('open'); return; }
    newMatch();
  });
}
async function newMatch() {
  docs = []; net = 0; handNo = 0; matchT0 = 0;
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
  if (rated && handNo > 0 && (matchOpen || NET.on)) { caption('level locks during a rated match'); return; }
  level = level >= 7 ? 2 : level + 1;
  localStorage.setItem('lp.level', level);
  renderTop(); renderHand();
});
$('#b-rated').addEventListener('click', () => {
  if (NET.on) {
    if (NET.rated && handNo > 0) { caption('rated locks during the match'); return; }
    rated = !rated;
    localStorage.setItem('lp.rated', rated ? '1' : '0');
    caption(rated ? '🏅 rated — begins at the next hand' : '☕ casual from the next match');
    renderTop();
    return;
  }
  rated = !rated;
  localStorage.setItem('lp.rated', rated ? '1' : '0');
  newMatch();
});
$('#b-sound').addEventListener('click', () => {
  audio(); soundOn = !soundOn;
  localStorage.setItem('lp.sound', soundOn ? '1' : '0');
  renderTop();
});
$('#b-bank').addEventListener('dblclick', () => {
  bank = 0;
  localStorage.setItem('lp.bank', '0');
  renderTop();
});
$('#b-turbo').addEventListener('click', () => {
  turbo = !turbo;
  localStorage.setItem('lp.turbo', turbo ? '1' : '0');
  renderTop();
});
$('#b-leak').addEventListener('click', () => {
  leakLive = !leakLive;
  localStorage.setItem('lp.leak', leakLive ? '1' : '0');
  renderTop();
});
$('#b-score').addEventListener('click', () => {
  if (rated && handNo > 0 && (matchOpen || (NET.on && NET.rated))) { caption('the scorecard opens when the rated match ends'); return; }
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
$('#b-log').addEventListener('click', () => {
  $('#logdrawer').classList.toggle('open');
  $('#b-log').classList.toggle('on');
});
document.body.classList.toggle('fourc', fourColor);
$('#b-fourc')?.classList.toggle('on', fourColor);
$('#b-fourc')?.addEventListener('click', () => {
  fourColor = !fourColor;
  localStorage.setItem('lp.fourc', fourColor ? '1' : '0');
  document.body.classList.toggle('fourc', fourColor);
  $('#b-fourc').classList.toggle('on', fourColor);
});
$('#b-help').addEventListener('click', () => $('#m-help').classList.add('open'));
document.querySelectorAll('.wrap .x').forEach((x) => x.addEventListener('click', () => x.closest('.wrap').classList.remove('open')));
document.querySelectorAll('.wrap').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) m.classList.remove('open'); }));
document.addEventListener('pointerdown', audio, { once: true });

// ---------------------------------------------------------------- shot mode
// Deterministic tableaux for the visual-critic rig: ?shot=preflop|flop|showdown
// Fixed seed, scripted actions, no timers, no sound — the same pixels forever.
async function shotMode(name) {
  soundOn = false;
  handNo = 7;
  renderTop();
  const seed = await sha256hex('shot|7');
  commit8 = (await sha256hex(seed)).slice(0, 8);
  h = newHand({
    seats: [{ name: 'You', stack: 2000 }, { name: `Level ${level}`, stack: 2000 }],
    button: 1, sb: SB, bb: BB, seedHex: seed, limit: true,
  });
  const SCRIPTS = {
    preflop: ['r40'],
    flop: ['r40', 'c', 'k', 'b20'],
    showdown: ['r40', 'c', 'k', 'b20', 'c', 'k', 'k', 'b40', 'c'],
  };
  const lastAct = {};
  for (const step of SCRIPTS[name] ?? []) {
    const L = legal(h);
    let a;
    if (step === 'c') a = { seat: L.seat, action: L.callAmount > 0 ? 'call' : 'check' };
    else if (step === 'k') a = { seat: L.seat, action: 'check' };
    else a = { seat: L.seat, action: L.actions.includes('bet') ? 'bet' : 'raise', amount: +step.slice(1) };
    act(h, a);
    lastAct[a.seat] = a.action + (a.amount ? ' ' + a.amount : '');
  }
  for (const [seat2, txt] of Object.entries(lastAct)) say(+seat2, txt);
  if (h.phase === 'done') {
    renderHand(true);
    const winSeats = new Set(h.result.winners.map((x) => x.seat));
    const winCards = new Set();
    for (const w2 of winSeats) for (const c of bestFive([...h.seats[w2].hole, ...h.board])) winCards.add(c);
    for (const i of [HERO, BOT]) seats[i].root.classList.toggle('winner', winSeats.has(i));
    [...$('#board').children].forEach((el, bi) => el.classList.add(winCards.has(h.board[bi]) ? 'win' : 'dead'));
    for (const i of [HERO, BOT]) {
      const won = winSeats.has(i);
      [...seats[i].cards.children].forEach((el, ci) => {
        el.classList.add(won && winCards.has(h.seats[i].hole[ci]) ? 'win' : 'dead');
      });
    }
    const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
    $('#verdict').innerHTML = Object.entries(h.result.evals ?? {}).map(([i, e]) =>
      `<span class="vtag ${winSeats.has(+i) ? 'vw' : 'vl'}">${+i === HERO ? 'You' : 'Bot'}: ${cap(handName(e))}</span>`).join('');
    const potEl = $('#pot');
    potEl.classList.add('winline');
    potEl.textContent = h.result.winners.map((x) => `${x.seat === HERO ? 'You win' : 'Bot wins'} ${x.amount}`).join(' · ');
    const bar = $('#actions');
    const bn = document.createElement('button');
    bn.id = 'b-next'; bn.textContent = 'NEXT HAND';
    bar.appendChild(bn);
  } else {
    renderHand();
    const L = legal(h);
    if (L.seat === HERO) {
      heroTurn(L);
      if (table) {
        const m = teachMix(L);
        if (m.known) mixOnButtons(m, L);
        document.querySelector('#actions .qbtn')?.classList.add('on');
      }
    }
  }
}

// ---------------------------------------------------------------- online
// Casual heads-up vs a human: the croupier deals (committed shuffle,
// per-envelope proofs verified right here), a generic room relays the
// chatter, and both browsers' engines referee each other's legality.
// Server-dealt, honestly labeled — the constitution's §6 lane. Humans are
// casual; a summoned ladder bot with rated on plays for the rating.
const CROUPIER = new URLSearchParams(location.search).get('server') || 'https://melvin.me/croupier';
const myPid = (() => {
  // per-tab identity (sessionStorage): lets one human test both seats in
  // two tabs, and a casual pid needs no more permanence than the sitting
  let p = sessionStorage.getItem('lp.pid');
  if (!p) { p = [...crypto.getRandomValues(new Uint8Array(8))].map((x) => x.toString(16).padStart(2, '0')).join(''); sessionStorage.setItem('lp.pid', p); }
  return p;
})();
const NET = {
  on: false, room: null, host: false, oppPid: null, oppName: null,
  es: null, seq: 0, oppSeq: -1, handNo: 0,
  sid: null, root: null, token: null, cev: null,
  reveals: new Map(),          // envelope index -> value (verified)
  waiters: [],
};
const cpost = (path, body, token) => fetch(CROUPIER + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
  body: JSON.stringify(body),
}).then((r) => r.json());
function roomSend(msg) {
  return cpost('/room/send', { room: NET.room, msg: { from: myPid, seq: NET.seq++, ...msg } });
}
function netStatus(t) { const el = $('#online-status'); if (el) el.innerHTML = t; }
const SUMMON_UI = `<select id="summon-pick" style="background:#00000042;color:var(--ink);border:1px solid #ffffff22;border-radius:6px;padding:4px 8px;font-size:13px">
  <option value="ladder:7">Bot · Lv 7 (the champion)</option>
  <option value="ladder:5">Bot · Lv 5</option>
  <option value="ladder:3">Bot · Lv 3</option>
  <option value="tag:0">Cmdr. Sterling (tight)</option>
  <option value="rock:0">Old Anchor (rock)</option>
  <option value="lag:0">Gunner Halloway (wild)</option>
  <option value="station:0">Cook Barnacle (calls)</option>
  <option value="maniac:0">Mad Wren (maniac)</option>
  <option value="citizen:7">Citizen 455c405b (declared · signs every message)</option>
</select> <button id="b-summon" class="mbtn" style="background:#3d6ea5">🤖 summon</button>`;
function wireSummon() {
  document.getElementById('b-summon')?.addEventListener('click', (e) => {
    const [bot, lvl] = (document.getElementById('summon-pick')?.value || 'ladder:7').split(':');
    NET.summon = { bot, level: +lvl || null };
    if (bot === 'ladder' && +lvl) { level = +lvl; localStorage.setItem('lp.level', level); }
    roomSend({ type: 'summon', bot, level: +lvl || undefined, turbo: turbo || undefined });
    e.target.textContent = '🤖 summoned…';
  });
}

let roomSeen = new Set();
function openRoomChannel() {
  roomSeen = new Set();
  const es = new EventSource(`${CROUPIER}/room/events?room=${NET.room}`);
  NET.es = es;
  es.onmessage = (e) => {
    if ($('#caption').textContent.startsWith('⚡ reconnect')) caption('');
    let entry; try { entry = JSON.parse(e.data); } catch { return; }
    const m = entry.msg;
    if (!m || m.from === myPid) return;
    // reconnects replay history — the server's entry id lands only once
    // (sender seqs reset on refresh, so they can't be the key)
    if (entry.id !== undefined) {
      if (roomSeen.has(entry.id)) return;
      roomSeen.add(entry.id);
    }
    handleRoomMsg(m, entry.t || 0);
  };
  // EventSource reconnects on its own; the caption is a heartbeat, not a verdict
  es.onerror = () => { if (NET.on) caption('⚡ reconnecting…'); };
  es.onopen = () => { if ($('#caption').textContent.startsWith('⚡ reconnect')) caption(''); };
}
const netWaiters = [];
const netInbox = [];
function nextMsg(pred, ms = 60000) {
  return new Promise((resolve, reject) => {
    const i = netInbox.findIndex(pred);
    if (i >= 0) return resolve(netInbox.splice(i, 1)[0]);
    netWaiters.push({ pred, resolve });
    setTimeout(() => reject(new Error('timeout waiting for opponent')), ms);
  });
}
function handleRoomMsg(m, t = 0) {
  if (m.type === 'hello' && NET.probing) {
    // probing: record live-looking hellos, commit to nothing yet
    if (Date.now() - t < 90000) { NET.probeHello = { from: m.from, name: m.name || null }; }
    return;
  }
  if (m.type === 'hello' && !NET.oppPid && m.re === myPid) {
    NET.oppPid = m.from;
    NET.oppName = m.name || null;
    NET.oppAgent = m.agent || null;
    NET.oppLevel = m.level || +(/Lv (\d)/.exec(m.name || '')?.[1] || 0) || null;
    clearInterval(NET.heartbeat);
    roomSend({ type: 'hello2', name: 'Guest', re: m.from });
    if (NET.host && !NET.on) startOnlineMatch();
    return;
  }
  if (m.type === 'hello2' && !NET.oppPid && m.re === myPid) { NET.oppPid = m.from; NET.oppName = m.name || null; NET.oppAgent = m.agent || null; clearInterval(NET.heartbeat); return; }
  if (m.type === 'hello' || m.type === 'hello2') return;
  for (let i = netWaiters.length - 1; i >= 0; i--) {
    if (netWaiters[i].pred(m)) {
      const w = netWaiters[i]; netWaiters.splice(i, 1); w.resolve(m);
      return;
    }
  }
  netInbox.push(m);
  if (netInbox.length > 200) netInbox.shift();
}

// ---- croupier session helpers (per hand)
function openCroupierChannel() {
  if (NET.cev) NET.cev.close();
  NET.reveals = new Map();
  const es = new EventSource(`${CROUPIER}/events?sid=${NET.sid}&token=${NET.token}`);
  NET.cev = es;
  es.onmessage = (e) => {
    let ev; try { ev = JSON.parse(e.data); } catch { return; }
    if (ev.ev === 'reveal' && ev.value !== undefined) {
      if (!verifyReveal(NET.root, ev)) { caption('⚠ PROOF FAILED — the croupier lied; aborting'); NET.on = false; return; }
      NET.reveals.set(ev.index, ev.value);
      for (let i = NET.waiters.length - 1; i >= 0; i--) {
        if (NET.waiters[i].idx.every((k) => NET.reveals.has(k))) {
          const w = NET.waiters[i]; NET.waiters.splice(i, 1); w.resolve();
        }
      }
    }
  };
}
const consent = (index, to) => cpost('/consent', { sid: NET.sid, op: { kind: 'reveal', index, to } }, NET.token);
function revealsReady(idx, ms = 60000) {
  return new Promise((resolve, reject) => {
    if (idx.every((k) => NET.reveals.has(k))) return resolve();
    NET.waiters.push({ idx, resolve });
    setTimeout(() => reject(new Error('table timeout')), ms);
  });
}

// ---- the online hand
const mySeatOnline = () => NET.host ? 0 : 1;
async function playOnlineHand() {
  NET.handNo++;
  handNo++;
  const meSeat = mySeatOnline(), oppSeat = 1 - meSeat;
  HERO_SEAT = meSeat;
  const oppName = NET.oppName || ('Guest ' + (NET.oppPid || '').slice(0, 4));
  // host creates the session; guest claims its token
  if (NET.host) {
    const S = await cpost('/create', { n: 52, parties: [myPid, NET.oppPid], openPolicy: 'none', claims: true, meta: { game: 'holdem-hu', hand: NET.handNo } });
    NET.sid = S.sid; NET.root = S.root;
    const mine = await cpost('/claim', { sid: S.sid, party: myPid, code: S.claims[myPid] });
    NET.token = mine.token;
    await roomSend({ type: 'start', handNo: NET.handNo, sid: S.sid, root: S.root, claim: S.claims[NET.oppPid] });
  } else {
    caption('waiting for the host to deal…');
    const m = await nextMsg((x) => x.type === 'start' && x.handNo === NET.handNo && x.from === NET.oppPid, 10 * 60000);
    caption('');
    NET.sid = m.sid; NET.root = m.root;
    const mine = await cpost('/claim', { sid: m.sid, party: myPid, code: m.claim });
    if (!mine.token) { caption('⚠ claim refused — host may be cheating; leaving'); NET.on = false; return; }
    NET.token = mine.token;
  }
  openCroupierChannel();
  commit8 = NET.root.slice(0, 8);

  // engine as betting referee; cards arrive from the croupier
  h = newHand({
    seats: meSeat === 0
      ? [{ name: 'You', stack: STACK }, { name: oppName, stack: STACK }]
      : [{ name: oppName, stack: STACK }, { name: 'You', stack: STACK }],
    button: NET.handNo % 2, sb: SB, bb: BB,
    seedHex: '00'.repeat(32), limit: true,
  });
  // NB: engine seats are absolute (0 host, 1 guest); the DOM maps seat-0 as
  // "me" — so online rendering uses a view swap:
  const viewSeat = (engineSeat) => engineSeat === meSeat ? 0 : 1;

  const cache = {};
  const handGrades = [];
  premove = null;
  seats.forEach((s2) => { s2.said.textContent = ''; });
  $('#verdict').textContent = '';
  logLine(`Hand #${NET.handNo} vs ${oppName} — root ${commit8}…`, 'lh2');
  caption('dealing…');

  // the deal: both clients consent the standard mapping
  const dealOps = [[0, NET.host ? myPid : NET.oppPid], [1, NET.host ? myPid : NET.oppPid],
    [2, NET.host ? NET.oppPid : myPid], [3, NET.host ? NET.oppPid : myPid]];
  for (const [idx, to] of dealOps) consent(idx, to);
  const myEnv = meSeat === 0 ? [0, 1] : [2, 3];
  await revealsReady(myEnv, 45000);
  h.seats[meSeat].hole = myEnv.map((i) => NET.reveals.get(i));
  renderOnline(viewSeat);
  sCard();
  posSignal(h.button === meSeat);

  let lastStreet = 0;
  let guard = 0;
  while (h.phase === 'act' && guard++ < 200 && NET.on) {
    const L = legal(h);
    if (L.seat === meSeat) {
      renderOnline(viewSeat);
      const a = await heroTurn(L);
      let g = null;
      if (table) {
        const mix = teachMix(L);
        if (mix.known) {
          const names = mixNames(mix, L);
          const chosen = a.action === 'fold' ? 'f' : (a.action === 'bet' || a.action === 'raise') ? 'b' : 'k';
          const ci = mix.acts.indexOf(chosen);
          let evLossBb = null;
          if (mix.solved) {
            const ev = riverEvs(h, meSeat, table, cache);
            const ei = ev ? ev.acts.indexOf(chosen) : -1;
            if (ei >= 0) evLossBb = (Math.max(...ev.evs) - ev.evs[ei]) / h.bb;
          }
          g = {
            street: STREETS[h.street], hinted: a.hinted, action: a.action,
            mix: Object.fromEntries(mix.acts.map((ac, i2) => [names[i2], +mix.probs[i2].toFixed(4)])),
            evLossBb,
          };
          handGrades.push(g);
        }
      }
      const preCommits = h.seats.map((x) => x.streetCommit);
      act(h, { seat: meSeat, action: a.action, amount: a.amount });
      say(0, a.action + (a.amount ? ' ' + a.amount : ''));
      logLine(`You ${a.action}${a.amount ? ' ' + a.amount : ''}`);
      await roomSend({ type: 'act', handNo: NET.handNo, sid: NET.sid, action: a.action, amount: a.amount ?? null });
      if (g) {
        const pC = g.mix[mixKeyOf(a)] ?? 0;
        const pM = Math.max(...Object.values(g.mix));
        sGrade(gradeWord(pC, pM));
      }
      sChip();
      await afterActOnline(lastStreet, preCommits, viewSeat);
      lastStreet = h.street;
    } else {
      renderOnline(viewSeat);
      caption(`waiting for ${oppName}…`);
      const m = await nextMsg((x) => x.type === 'act' && x.sid === NET.sid && x.from === NET.oppPid, 10 * 60000);
      caption('');
      // their engine move must be legal in OUR engine — mutual refereeing
      const L2 = legal(h);
      const legalNames = L2.actions;
      if (L2.seat !== oppSeat || !legalNames.includes(m.action)) {
        caption('⚠ illegal action from opponent — hand void');
        NET.on = false; return;
      }
      const preCommits = h.seats.map((x) => x.streetCommit);
      act(h, { seat: oppSeat, action: m.action, amount: m.amount ?? undefined });
      say(1, m.action + (m.amount ? ' ' + m.amount : ''));
      logLine(`${oppName} ${m.action}${m.amount ? ' ' + m.amount : ''}`);
      sChip();
      await afterActOnline(lastStreet, preCommits, viewSeat);
      lastStreet = h.street;
    }
  }
  if (!NET.on) return;

  // settle by hand: no all-ins are possible at these stacks in limit,
  // so the pot is single and whole
  const pot = h.seats.reduce((a2, s2) => a2 + s2.handCommit, 0);
  const folded = h.seats.findIndex((s2) => s2.folded);
  let winners = [];
  if (folded >= 0) {
    winners = [1 - folded];
  } else {
    // showdown: both publicize both holes (v1: always show)
    for (const idx of [0, 1, 2, 3]) consent(idx, 'all');
    await revealsReady([0, 1, 2, 3]);
    h.seats[0].hole = [NET.reveals.get(0), NET.reveals.get(1)];
    h.seats[1].hole = [NET.reveals.get(2), NET.reveals.get(3)];
    const e0 = evaluate([...h.seats[0].hole, ...h.board]);
    const e1 = evaluate([...h.seats[1].hole, ...h.board]);
    winners = e0.score > e1.score ? [0] : e1.score > e0.score ? [1] : [0, 1];
    renderOnline(viewSeat, true);
    const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
    $('#verdict').innerHTML = [0, 1].map((i) =>
      `<span class="vtag ${winners.includes(i) ? 'vw' : 'vl'}">${i === meSeat ? 'You' : oppName}: ${cap(handName(i === 0 ? e0 : e1))}</span>`).join('');
    // the golden five: the winning hand outlined, everything else dims
    const winCards = new Set();
    for (const w2 of winners) for (const c of bestFive([...h.seats[w2].hole, ...h.board])) winCards.add(c);
    [...$('#board').children].forEach((el, bi) => el.classList.add(winCards.has(h.board[bi]) ? 'win' : 'dead'));
    for (const i of [0, 1]) {
      const won = winners.includes(i);
      [...seats[viewSeat(i)].cards.children].forEach((el, ci) => {
        el.classList.add(won && winCards.has(h.seats[i].hole[ci]) ? 'win' : 'dead');
      });
    }
  }
  const share = Math.floor(pot / winners.length);
  const myDelta = (winners.includes(meSeat) ? share : 0) - h.seats[meSeat].handCommit;
  net += myDelta;
  bankAdd(myDelta);
  const potEl = $('#pot');
  potEl.classList.add('winline');
  potEl.textContent = winners.map((w) => `${w === meSeat ? 'You win' : oppName + ' wins'} ${share}`).join(' · ');
  for (const w of winners) seats[viewSeat(w)].root.classList.add('winner');
  for (const w of winners) logLine(`<span class="lw">${w === meSeat ? 'You win' : oppName + ' wins'} ${share}</span>`);
  caption(net !== 0 ? `net ${net >= 0 ? '+' : ''}${net}` : '');
  if (folded >= 0) h.seats[1 - meSeat].hole = null;
  riversAdd(handGrades);
  const doc = buildDoc(h, null, handGrades);
  doc.root = NET.root;
  doc.result = { showdown: folded < 0, pot, winners: winners.map((w) => ({ seat: w, amount: share })) };
  docs.push(doc);
  renderTop();
  await new Promise((resolve) => {
    const bar = $('#actions');
    bar.innerHTML = '';
    const bn = document.createElement('button');
    bn.id = 'b-next'; bn.textContent = 'NEXT HAND';
    bn.addEventListener('click', () => resolve());
    bar.appendChild(bn);
    setTimeout(resolve, turbo ? (folded >= 0 ? 300 : 700) : (folded >= 0 ? 2000 : 3200));
  });
  $('#actions').innerHTML = '';
  potEl.classList.remove('winline');
  seats.forEach((s2) => s2.root.classList.remove('winner'));
}

async function afterActOnline(lastStreet, preCommits, viewSeat) {
  const domPre = mySeatOnline() === 1 ? [preCommits[1], preCommits[0]] : preCommits;
  if (h.street !== lastStreet && h.phase === 'act') {
    await sweepBets(domPre);
    // board envelopes: 4..(4+len-1); consent to all, verify, overwrite dummies
    const need = Array.from({ length: h.board.length }, (_, k) => 4 + k)
      .filter((i) => !NET.reveals.has(i));
    for (const i of need) consent(i, 'all');
    await revealsReady(Array.from({ length: h.board.length }, (_, k) => 4 + k));
    for (let k = 0; k < h.board.length; k++) h.board[k] = NET.reveals.get(4 + k);
    logLine(`<span class="lm">${STREETS[h.street].toUpperCase()}  ${h.board.map((c) => ascii(c)).join(' ')}</span>`);
    renderOnline(viewSeat);
  } else if (h.phase !== 'act') {
    await sweepBets(domPre);
  }
}

// online rendering: engine seats -> DOM seats via the view swap; the
// opponent's dummy hole renders as backs (renderHand shows backs for
// seat index 1)
function renderOnline(viewSeat, reveal = false) {
  // remap: build a shallow view where DOM seat 0 = me
  const realSeats = h.seats;
  const me = mySeatOnline();
  if (me === 1) {
    h = { ...h, seats: [realSeats[1], realSeats[0]], button: h.button === 1 ? 0 : 1, toAct: h.toAct === -1 ? -1 : 1 - h.toAct };
    renderHand(reveal);
    h = { ...h, seats: realSeats, button: h.button === 1 ? 0 : 1, toAct: h.toAct === -1 ? -1 : 1 - h.toAct };
  } else {
    renderHand(reveal);
  }
}

async function startOnlineMatch() {
  NET.on = true;
  matchOpen = false;                      // stop the bot loop after its hand
  // rated online: only vs the ladder — the anchored opponent whose rating we
  // know. The seat declares itself (agent + level) so eligibility survives a
  // page refresh; humans and characters stay casual (no anchor, no trust).
  NET.rated = rated && !!NET.oppLevel
    && (NET.oppAgent || '').startsWith('librepoker-ladder');
  if (NET.rated) { level = NET.oppLevel; localStorage.setItem('lp.level', level); }
  netStatus(`connected — playing`);
  $('#m-online').classList.remove('open');
  docs = []; net = 0; handNo = 0; matchT0 = 0;
  renderTop();
  caption(NET.rated ? `🏅 rated match vs the Lv ${level} ladder — ${RATED_HANDS} hands, no assistance` : 'opponent connected');
  while (NET.on) {
    // the pill flipped mid-casual: a casual match has no end, so "next
    // match" means NOW — a fresh rated 20 begins at this hand
    if (!NET.rated && rated && !!NET.oppLevel && (NET.oppAgent || '').startsWith('librepoker-ladder')) {
      NET.rated = true;
      level = NET.oppLevel; localStorage.setItem('lp.level', level);
      docs = []; net = 0; handNo = 0; matchT0 = 0;
      renderTop();
      caption(`🏅 rated match begins — ${RATED_HANDS} hands, no assistance`);
    }
    try { await playOnlineHand(); } catch (e) {
      const botSeat = (NET.oppAgent || '').startsWith('librepoker-');
      if (String(e.message).includes('table timeout') && botSeat && NET.summon) {
        caption('the bot seat went quiet — summoning a fresh one…');
        NET.handNo--; handNo--;               // the dead hand never happened
        NET.oppPid = null; NET.oppName = null; NET.oppAgent = null; NET.oppLevel = null;
        await roomSend({ type: 'summon', bot: NET.summon.bot, level: NET.summon.level, turbo: turbo || undefined });
        const seated = await new Promise((r) => {
          const t0 = Date.now();
          const t = setInterval(() => {
            if (NET.oppPid) { clearInterval(t); r(true); }
            else if (Date.now() - t0 > 30000) { clearInterval(t); r(false); }
          }, 300);
        });
        if (seated) { caption('fresh seat: ' + (NET.oppName || 'bot')); continue; }
        caption('no bot answered — the fleet may be down'); break;
      }
      caption('online hand failed: ' + (e.message || e)); break;
    }
    if (NET.rated && handNo >= RATED_HANDS && NET.on) {
      await matchEnd();
      // between matches: counters reset NOW so the rated pill unlocks while
      // the scorecard is up — but the docs stay: the open scorecard's rows
      // must keep their transcripts clickable until the player moves on
      net = 0; handNo = 0; matchT0 = 0;
      renderTop();
      caption('match settled — 🏅/☕ can be switched now; close the scorecard to play on');
      await new Promise((r) => {
        const t = setInterval(() => {
          if (!$('#m-score').classList.contains('open')) { clearInterval(t); r(); }
        }, 250);
      });
      caption('');
      // the choice lives on the table, not behind a modal: nothing deals
      // until the player picks the next match's mode
      await new Promise((resolve) => {
        const bar = $('#actions');
        bar.innerHTML = '';
        const bn = document.createElement('button');
        bn.id = 'b-next';
        const bs = document.createElement('button');
        bs.id = 'b-call';
        const label = () => {
          bn.textContent = rated ? '🏅 NEXT RATED MATCH' : '▶ NEXT MATCH';
          bs.textContent = rated ? '☕ SWITCH TO CASUAL' : '🏅 SWITCH TO RATED';
        };
        label();
        bn.addEventListener('click', () => { bar.innerHTML = ''; docs = []; resolve(); });
        bs.addEventListener('click', () => {
          rated = !rated;
          localStorage.setItem('lp.rated', rated ? '1' : '0');
          label(); renderTop();
        });
        bar.append(bn, bs);
      });
      NET.rated = rated && !!NET.oppLevel
        && (NET.oppAgent || '').startsWith('librepoker-ladder');
      renderTop();
    }
  }
  HERO_SEAT = 0;
  caption('online match over — <a href="?">back to the bot</a>');
}

function startHeartbeat() {
  clearInterval(NET.heartbeat);
  NET.heartbeat = setInterval(() => { if (!NET.oppPid) roomSend({ type: 'hello' }); }, 45000);
}
async function hostExistingRoom(code) {
  NET.room = code.toUpperCase(); NET.host = true;
  $('#m-online').classList.add('open');
  openRoomChannel();
  await roomSend({ type: 'hello' });
  startHeartbeat();
  const link = `${location.origin}${location.pathname}?join=${NET.room}`;
  netStatus(`table <b>${NET.room}</b> — send your friend this link:<br>` +
    `<code style="font-size:12px;user-select:all">${link}</code> ` +
    `<button id="b-copylink" class="mbtn" style="background:var(--gold);color:#1c1812">📋 copy</button><br>` +
    `or <button id="b-summon" class="mbtn" style="background:#3d6ea5">🤖 summon a bot</button><br>waiting…`);
  document.getElementById('b-copylink').addEventListener('click', async (e) => {
    try { await navigator.clipboard.writeText(link); e.target.textContent = '✓ copied'; }
    catch { e.target.textContent = 'select it manually'; }
  });
  wireSummon();
}

async function enterLobby(joinCode) {
  $('#m-online').classList.add('open');
  if (joinCode) {
    NET.room = joinCode.toUpperCase();
    netStatus(`joining table <b>${NET.room}</b>…`);
    NET.probing = true; NET.probeHello = null;
    openRoomChannel();
    await new Promise((r) => setTimeout(r, 2500));   // let the replay land
    NET.probing = false;
    matchOpen = false;
    if (NET.probeHello) {
      // a live host is here: take the guest seat
      NET.host = false;
      NET.oppPid = NET.probeHello.from;
      NET.oppName = NET.probeHello.name;
      await roomSend({ type: 'hello', re: NET.probeHello.from });
      NET.on = true;
      netStatus('host found — waiting for the deal…');
      startOnlineGuestLoop();
    } else {
      // empty table: the seat is yours — host it
      NET.host = true;
      await roomSend({ type: 'hello' });
      startHeartbeat();
      const link = `${location.origin}${location.pathname}?join=${NET.room}`;
      netStatus(`this table was empty — <b>you are hosting ${NET.room}</b>.<br>` +
        `share: <code style="font-size:12px;user-select:all">${link}</code> ` +
        `<button id="b-copylink" class="mbtn" style="background:var(--gold);color:#1c1812">📋 copy</button><br>` +
        `or ${SUMMON_UI}<br>waiting…`);
      document.getElementById('b-copylink').addEventListener('click', async (e) => {
        try { await navigator.clipboard.writeText(link); e.target.textContent = '✓ copied'; }
        catch { e.target.textContent = 'select it manually'; }
      });
      wireSummon();
    }
    return;
  }
  $('#b-maketable').onclick = async () => {
    const r = await cpost('/room/create', { name: 'table', game: 'holdem-hu' });
    NET.room = r.room; NET.host = true;
    openRoomChannel();
    await roomSend({ type: 'hello' });
    startHeartbeat();
    const link = `${location.origin}${location.pathname}?join=${NET.room}`;
    netStatus(`table <b>${NET.room}</b> — send your friend this link:<br>` +
      `<code style="font-size:12px;user-select:all">${link}</code> ` +
      `<button id="b-copylink" class="mbtn" style="background:var(--gold);color:#1c1812">📋 copy</button><br>` +
      `or ${SUMMON_UI} · ` +
      `<a href="lobby.html" style="font-size:13px">browse the lobby</a><br>waiting…`);
    document.getElementById('b-copylink').addEventListener('click', async (e) => {
      try { await navigator.clipboard.writeText(link); e.target.textContent = '✓ copied'; }
      catch { e.target.textContent = 'select it manually'; }
    });
    wireSummon();
  };
}
async function startOnlineGuestLoop() {
  $('#m-online').classList.remove('open');
  docs = []; net = 0; handNo = 0;
  while (NET.on) {
    // the pill flipped mid-casual: a casual match has no end, so "next
    // match" means NOW — a fresh rated 20 begins at this hand
    if (!NET.rated && rated && !!NET.oppLevel && (NET.oppAgent || '').startsWith('librepoker-ladder')) {
      NET.rated = true;
      level = NET.oppLevel; localStorage.setItem('lp.level', level);
      docs = []; net = 0; handNo = 0; matchT0 = 0;
      renderTop();
      caption(`🏅 rated match begins — ${RATED_HANDS} hands, no assistance`);
    }
    try { await playOnlineHand(); } catch (e) { caption('online hand failed: ' + (e.message || e)); break; }
  }
  HERO_SEAT = 0;
  caption('online match over — <a href="?">back to the bot</a>');
}
$('#b-online').addEventListener('click', () => enterLobby(null));

// ---------------------------------------------------------------- boot
(async () => {
  renderTop();
  caption('fetching the strategy…');
  try {
    const r = await fetch('strategy-hulimit.json?v=17');
    const j = await r.json();
    table = j.table;
    if (j.edges) setEquityEdges(j.edges);
    caption('');
  } catch {
    caption('strategy failed to load — refresh to retry');
    return;
  }
  const shot = new URLSearchParams(location.search).get('shot');
  if (shot) { shotMode(shot); return; }
  const join = new URLSearchParams(location.search).get('join');
  if (join) { enterLobby(join); return; }
  const hostRoom = new URLSearchParams(location.search).get('table');
  if (hostRoom) { matchOpen = false; hostExistingRoom(hostRoom); return; }
  newMatch();
})();
