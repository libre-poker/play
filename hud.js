// hud.js — the heads-up ladder: where your hand stands right now.
// Loaded only when the 📊 chip is pressed (or the page is opened with ?ladder), so the
// trainer is unchanged for anyone who never asks for it. A practice aid: it switches
// itself off in rated and online matches.
// Reads the cards already drawn on the table (it does not touch the game), ranks every
// hand the other player could hold on this board, and shows the rungs from the nuts down
// with a marker on yours. 100% = the nuts, 0% = the worst possible hand.
// Percentages are against a random hand, not against what this opponent would bet with.
import { rankOf, suitOf, RANKS } from './engine/poker.js';
import { PREFLOP, RUNGS, ladder, byTheRiver } from './standing.js?v=1';

const $ = (s) => document.querySelector(s);
const RANK_NAME = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const GLYPH = { c: '♣', d: '♦', h: '♥', s: '♠' };

// ---- read the table -------------------------------------------------------
function readCards(el) {
  const out = [];
  if (!el) return out;
  for (const c of el.querySelectorAll('.card')) {
    if (c.classList.contains('back')) return [];
    const suit = [...c.classList].find((k) => /^s-[cdhs]$/.test(k));
    const cr = c.querySelector('.cr');
    if (!suit || !cr) return [];
    let r = (cr.childNodes[0]?.textContent || '').trim();
    if (r === '10') r = 'T';
    const ri = RANKS.indexOf(r), si = 'cdhs'.indexOf(suit[2]);
    if (ri < 0 || si < 0) return [];
    out.push(si * 13 + ri);
  }
  return out;
}

// One colour per rung, strongest to weakest: violet monsters, blue made hands, green, gold pairs, orange, grey.
const RUNG_COLOR = ['#5b2a9d', '#6b3fb0', '#7a55c2', '#1c5fa8', '#1f7fa6', '#14806a', '#2f8f4e',
  '#8a7a00', '#b07d00', '#c2691f', '#c0502c', '#b03a48', '#7b6470', '#6f7480'];
const eqColor = (eq) => RUNG_COLOR[eq >= 75 ? 0 : eq >= 66 ? 3 : eq >= 60 ? 5 : eq >= 55 ? 7 : eq >= 50 ? 8 : eq >= 45 ? 9 : eq >= 40 ? 11 : 13];

// ---- drawing ------------------------------------------------------------------
// One decimal place. Never round up to 100.0 unless it really is the nuts.
const pct = (x) => (x < 1 && x > 0.9995 ? '99.9' : (x * 100).toFixed(1)) + '%';
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const cardText = (c) => RANK_NAME[rankOf(c)] + GLYPH['cdhs'[suitOf(c)]];

function drawPreflop(root, hole) {
  const r0 = rankOf(hole[0]), r1 = rankOf(hole[1]), hi = Math.max(r0, r1), lo = Math.min(r0, r1);
  const key = RANKS[hi] + RANKS[lo] + (hi === lo ? '' : suitOf(hole[0]) === suitOf(hole[1]) ? 's' : 'o');
  const order = Object.entries(PREFLOP).sort((a, b) => b[1] - a[1]);
  const place = order.findIndex(([k]) => k === key);
  const now = 1 - place / (order.length - 1);
  head(root, 'Before the flop', now, key, 'Starting hand ' + (place + 1) + ' of 169', null, eqColor(PREFLOP[key]));
  const marks = ['AA', 'JJ', 'AKs', 'AQo', '99', 'KQs', 'A9o', '66', 'QJo', 'K7s', 'T9s', '33', 'J8o', '96s', 'T5o', '83s', '72o'];
  const rows = marks.filter((k) => k !== key).map((k) => [k, PREFLOP[k], false]).concat([[key, PREFLOP[key], true]]).sort((a, b) => b[1] - a[1]);
  const list = root.appendChild(el('div', 'hud-rungs'));
  for (const [k, eq, me] of rows) {
    const row = list.appendChild(el('div', 'hud-rung' + (me ? ' me' : '')));
    row.style.setProperty('--c', eqColor(eq));
    row.appendChild(el('span', 'hud-name', k + (me ? '  ← you' : '')));
    const bar = row.appendChild(el('span', 'hud-bar')); bar.appendChild(el('i')).style.width = Math.round((eq - 30) / 55 * 100) + '%';
    row.appendChild(el('span', 'hud-share', eq.toFixed(1) + '%'));
  }
  root.appendChild(el('p', 'hud-note', 'The number beside each hand is how often it wins against a random hand if all the cards are dealt. s = suited, o = offsuit.'));
}

function head(root, street, now, title, sub, river, color, alt) {
  root.appendChild(el('div', 'hud-street', street));
  const big = root.appendChild(el('div', 'hud-big'));
  big.appendChild(el('b', '', pct(now)));
  const name = big.appendChild(el('span', '', title)); if (color) { name.style.color = color; big.querySelector('b').style.color = color; }
  if (alt) { const a = big.appendChild(el('span', 'hud-alt')); const n = a.appendChild(el('b', '', alt[0])); if (color) n.style.color = color; a.appendChild(el('i', '', alt[1])); }
  root.appendChild(el('div', 'hud-sub', sub));
  const track = root.appendChild(el('div', 'hud-track'));
  track.appendChild(el('i', 'hud-fill')).style.width = Math.round(now * 100) + '%';
  if (river != null) { const m = track.appendChild(el('i', 'hud-river')); m.style.left = Math.round(river * 100) + '%'; m.title = 'by the river'; }
  const ends = root.appendChild(el('div', 'hud-ends')); ends.appendChild(el('span', '', '0% worst')); ends.appendChild(el('span', '', 'the nuts 100%'));
}

let mode = 'range';
try { mode = localStorage.getItem('lp.ladder.mode') || 'range'; } catch { /* private window */ }
function drawPostflop(root, hole, board, lp) {
  const L = ladder(hole, board, lp), river = byTheRiver(hole, board, L);
  const street = board.length === 3 ? 'On the flop' : board.length === 4 ? 'On the turn' : 'On the river';
  const R = L.range, useRange = !!R && mode === 'range';
  // which hands are we measuring against?
  const pick = root.appendChild(el('div', 'hud-mode'));
  for (const [id, label] of [['range', 'hands that play this way'], ['any', 'any hand']]) {
    const b = pick.appendChild(el('button', id === (useRange ? 'range' : 'any') ? 'on' : '', label)); b.type = 'button';
    if (id === 'range' && !R) { b.disabled = true; b.title = window.__lpLadder?.noRange || 'Available once the bot has acted this hand'; }
    b.addEventListener('click', () => { mode = id; try { localStorage.setItem('lp.ladder.mode', id); } catch { /* private window */ } last = ''; refresh(); });
  }
  const now = useRange ? R.now : L.now, byRiver = river ? (useRange ? river.range : river.any) : null;
  head(root, street, now, L.nuts ? 'The nuts' : RUNGS[L.myRung],
    'You beat ' + pct(now) + (useRange ? ' of the hands that play this way' : ' of the hands they could hold'), byRiver, RUNG_COLOR[L.myRung],
    R && [pct(useRange ? L.now : R.now), useRange ? 'any hand' : 'plays this way']);
  if (R) {
    const d = R.now - L.now;
    if (Math.abs(d) > 0.03) root.appendChild(el('div', 'hud-other', d < 0 ? 'Their betting says they are stronger than random' : 'Their play looks weaker than random'));
  }
  if (byRiver != null) {
    const d = byRiver - now;
    root.appendChild(el('div', 'hud-river-line', 'By the river you win ' + pct(byRiver) + (d > 0.06 ? ' — your draws add to it' : d < -0.06 ? ' — hands behind you can catch up' : '')));
  }
  const list = root.appendChild(el('div', 'hud-rungs' + (useRange ? ' r4' : '')));
  const shares = useRange ? R.shares : L.counts.map((c) => c / L.n), max = Math.max(...shares);
  RUNGS.forEach((name, i) => {
    if (!L.counts[i] && i !== L.myRung) return;
    const row = list.appendChild(el('div', 'hud-rung' + (i === L.myRung ? ' me' : '')));
    row.style.setProperty('--c', RUNG_COLOR[i]);
    row.appendChild(el('span', 'hud-name', name + (i === L.myRung ? '  ← you' : '')));
    const bar = row.appendChild(el('span', 'hud-bar')); bar.appendChild(el('i')).style.width = Math.max(shares[i] > 0 ? 2 : 0, Math.round(shares[i] / max * 100)) + '%';
    const share = shares[i];
    if (useRange) row.appendChild(el('span', 'hud-any', (L.counts[i] / L.n * 100).toFixed(1) + '%')).title = 'share of any hand';
    row.appendChild(el('span', 'hud-share', share > 0 && share < 0.0005 ? '<0.1%' : (share * 100).toFixed(1) + '%'));
  });
  root.appendChild(el('p', 'hud-note', useRange
    ? 'Each rung shows its share of the hands the bot would hold after playing this way: every one of the ' + L.n.toLocaleString('en') + ' possible hands, weighed by how often the bot\'s own strategy plays it like this (' + R.decisions + (R.decisions === 1 ? ' decision' : ' decisions') + ' so far; about ' + pct(R.kept) + ' of hands get here). Exact for the bot, not a read on a person.'
    : 'Each rung shows what share of the ' + L.n.toLocaleString('en') + ' hands they could hold sits there. Against a random hand, not against how this opponent plays.'));
}

const CSS = "#hud{position:fixed;top:56px;right:10px;bottom:10px;width:330px;z-index:40;overflow:auto;box-sizing:border-box;\n  background:#fbf7ee;color:#22262e;border:1px solid #d8cdb6;border-radius:14px;padding:14px 14px 10px;\n  font:14.5px/1.35 system-ui,-apple-system,\"Segoe UI\",sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.28)}\n#hud h2{margin:0 0 8px;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#7a6a4a;display:flex;justify-content:space-between;align-items:center}\n#hud-toggle{font:inherit;font-size:11px;border:1px solid #d8cdb6;background:#fff;color:#55606e;border-radius:999px;padding:2px 9px;cursor:pointer}\n.hud-cards{font-size:15px;font-weight:700;letter-spacing:.02em;margin-bottom:8px}\n.hud-street{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#8a7d66}\n.hud-big{display:flex;align-items:baseline;gap:10px;margin:2px 0 0}\n.hud-big b{font-size:40px;line-height:1;font-weight:800;color:#1f6f8b}\n.hud-big span{font-size:16px;font-weight:700}\n.hud-sub{color:#55606e;margin:2px 0 8px}\n.hud-track{position:relative;height:10px;border-radius:999px;background:#e7dfcd;overflow:visible}\n.hud-fill{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,#c9772b,#d9b23c 45%,#2f8f6b)}\n.hud-river{position:absolute;top:-4px;width:3px;height:18px;margin-left:-1px;border-radius:2px;background:#22262e}\n.hud-ends{display:flex;justify-content:space-between;font-size:10.5px;color:#8a7d66;margin:3px 0 6px}\n.hud-river-line{font-size:12.5px;color:#22262e;margin:0 0 8px;padding-left:9px;border-left:3px solid #22262e}\n.hud-rungs{display:grid;gap:4px;margin-top:8px}\n.hud-rung{--c:#6f7480;display:grid;grid-template-columns:minmax(0,2.3fr) minmax(0,1fr) 52px;align-items:center;gap:8px;padding:5px 8px 5px 9px;border-radius:7px;border-left:6px solid var(--c);background:#fff}\n.hud-rung.me{background:var(--c);color:#fff;box-shadow:0 0 0 2px #22262e}\n.hud-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:800;color:var(--c)} .hud-rung.me .hud-name{color:#fff}\n.hud-bar{height:9px;border-radius:999px;background:#ece5d6;overflow:hidden}\n.hud-bar i{display:block;height:100%;background:var(--c);border-radius:999px}\n.hud-rung.me .hud-bar{background:rgba(255,255,255,.28)} .hud-rung.me .hud-bar i{background:#fff}\n.hud-share{text-align:right;font-variant-numeric:tabular-nums;font-weight:700;color:#22262e} .hud-rung.me .hud-share{color:#fff}\n.hud-note,.hud-idle{color:#8a7d66;font-size:11.5px;margin:10px 0 0}\nbody.hud-closed #hud{bottom:auto;height:auto} body.hud-closed #hud-body{display:none}\n@media (min-width:1000px){ body.hud-open:not(.hud-closed) #stage,body.hud-open:not(.hud-closed) #bottom{padding-right:350px} }\n@media (max-width:999px){ #hud{top:auto;left:8px;right:8px;width:auto;max-height:46vh;bottom:8px} body.hud-open:not(.hud-closed) #bottom{padding-bottom:46vh} }\nbody:not(.hud-open) #hud{display:none}\n.hud-mode{display:flex;gap:4px;margin:0 0 8px;background:#efe8d8;border-radius:999px;padding:3px}.hud-mode button{flex:1;font:inherit;font-size:12px;font-weight:700;border:0;background:transparent;color:#6b6352;border-radius:999px;padding:4px 6px;cursor:pointer}.hud-mode button.on{background:#22262e;color:#fff}.hud-mode button:disabled{opacity:.45;cursor:default}.hud-other{font-size:13px;color:#55606e;margin:0 0 8px}.hud-other b{color:#22262e}\n.hud-rungs.r4 .hud-rung{grid-template-columns:minmax(0,2fr) minmax(0,.7fr) 40px 50px;gap:6px}.hud-any{text-align:right;font-size:12px;font-variant-numeric:tabular-nums;color:#857c69}.hud-rung.me .hud-any{color:rgba(255,255,255,.72)}\n.hud-big .hud-alt{margin-left:auto;text-align:right;font-weight:400;line-height:1.1;color:#857c69}.hud-alt b{display:block;font-size:19px;font-weight:700;color:#6b6352;opacity:.8}.hud-alt i{font-style:normal;font-size:11px}\n.hud-off{color:#8a7d66;font-size:13px;margin:6px 0 0}";

// Practice only: rated matches promise no assistance, and online means a real opponent.
// A practice-only page (the no-limit trainer) says so itself with window.__lpLadder = { practice: true }.
const allowed = () => !!window.__lpLadder?.practice || !$('#b-rated')?.classList.contains('on') && ($('#seat-1 .nm')?.textContent || 'Bot') === 'Bot';

let last = '';
function refresh() {
  const root = $('#hud-body'); if (!root || !document.body.classList.contains('hud-open')) return;
  const ok = allowed();
  const hole = ok ? readCards($('#cards-0')) : [], board = ok ? readCards($('#board')) : [];
  const lp = window.__lp || null;
  const sig = ok + '|' + hole.join(',') + '|' + board.join(',') + '|' + (lp?.hand?.log?.length ?? 0) + '|' + (lp?.rounds ? lp.rounds.join('/') : '') + '|' + (lp?.level ?? '') + '|' + mode;
  if (sig === last) return; last = sig;
  root.textContent = '';
  if (!ok) { root.appendChild(el('p', 'hud-off', 'The ladder is a practice aid. It is off in rated and online matches.')); return; }
  if (hole.length !== 2 || ![0, 3, 4, 5].includes(board.length)) {
    root.appendChild(el('p', 'hud-idle', 'Deal a hand and the ladder shows where your cards stand.'));
    return;
  }
  root.appendChild(el('div', 'hud-cards', hole.map(cardText).join(' ') + (board.length ? '   ·   ' + board.map(cardText).join(' ') : '')));
  if (board.length === 0) drawPreflop(root, hole); else drawPostflop(root, hole, board, lp);
}

let built = false, timer = null;
function build() {
  built = true;
  document.head.appendChild(el('style', '', CSS));
  const panel = el('aside'); panel.id = 'hud'; panel.setAttribute('aria-label', 'Hand ladder');
  const h2 = panel.appendChild(el('h2', '', 'Where you stand '));
  const fold = h2.appendChild(el('button', '', 'hide / show')); fold.id = 'hud-toggle'; fold.type = 'button';
  fold.addEventListener('click', () => document.body.classList.toggle('hud-closed'));
  const body = panel.appendChild(el('div')); body.id = 'hud-body';
  document.body.appendChild(panel);
  const later = () => { clearTimeout(timer); timer = setTimeout(refresh, 120); };
  new MutationObserver(later).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
}

// Open or close the ladder. Remembers the choice for next time.
export function toggle(force) {
  if (!built) build();
  const open = force ?? !document.body.classList.contains('hud-open');
  document.body.classList.toggle('hud-open', open);
  document.body.classList.remove('hud-closed');
  $('#b-ladder')?.classList.toggle('on', open);
  try { localStorage.setItem('lp.ladder', open ? '1' : '0'); } catch { /* private window */ }
  last = ''; refresh();
}
