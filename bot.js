// bot.js — a declared agent for the Libre Poker lobby. Watches listed
// rooms; when a table says {type:'summon', level}, a bot sits down as the
// guest, names itself honestly, verifies every one of the croupier's
// proofs like any other citizen, referees the host's actions with its own
// engine, and plays the ladder strategy at the summoned level.
//
//   node bot.js [--croupier https://melvin.me/croupier] [--max 4]
//
// Machines are citizens, not contraband (constitution §2.5).
import fs from 'node:fs';
import { newHand, legal, act, evaluate, rngFromSeed } from './engine/poker.js';
import { ladderDecide, setEquityEdges } from './engine/ladder.js';
import { riverMix } from './engine/river-solver.js';
import { verifyReveal } from './croupier-verify.js';
import { createHash, randomBytes } from 'node:crypto';

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const BASE = arg('croupier', 'https://melvin.me/croupier');
const MAX_TABLES = Number(arg('max', 4));
const LEVEL_EPS = { 2: .45, 3: .3, 4: .2, 5: .12, 6: .06, 7: 0 };
const sha = (s) => createHash('sha256').update(s).digest('hex');

const T = JSON.parse(fs.readFileSync(new URL('./strategy-hulimit.json', import.meta.url), 'utf8'));
if (T.edges) setEquityEdges(T.edges);
console.log(`bot: strategy loaded (${T.iterations.toLocaleString()} iterations)`);

const post = (path, body, token) => fetch(BASE + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
  body: JSON.stringify(body),
}).then((r) => r.json());

function sse(url, onEvent, onClose) {
  const ctl = new AbortController();
  fetch(url, { signal: ctl.signal }).then(async (res) => {
    const reader = res.body.getReader();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const m = chunk.match(/^data: (.*)$/m);
        if (m) { try { onEvent(JSON.parse(m[1])); } catch { /* bad frame */ } }
      }
    }
    onClose?.();
  }).catch(() => onClose?.());
  return ctl;
}

// ---------------------------------------------------------------- a seat
const engaged = new Map();      // room -> true
const watched = new Map();      // room -> AbortController

async function playRoom(room, level) {
  const pid = 'bot-' + randomBytes(6).toString('hex');
  const name = `Bot · Lv ${level}`;
  let seq = 0, hostPid = null;
  const inbox = [];
  const waiters = [];
  const send = (msg) => post('/room/send', { room, msg: { from: pid, seq: seq++, agent: 'librepoker-ladder', ...msg } });
  const next = (pred, ms = 10 * 60000) => new Promise((resolve, reject) => {
    const i = inbox.findIndex(pred);
    if (i >= 0) return resolve(inbox.splice(i, 1)[0]);
    waiters.push({ pred, resolve });
    setTimeout(() => reject(new Error('opponent timeout')), ms);
  });
  const roomCtl = sse(`${BASE}/room/events?room=${room}`, (entry) => {
    const m = entry.msg;
    if (!m || m.from === pid) return;
    if (m.type === 'hello' && !hostPid) { hostPid = m.from; return; }
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(m)) { const w = waiters[i]; waiters.splice(i, 1); return w.resolve(m); }
    }
    inbox.push(m);
    if (inbox.length > 200) inbox.shift();
  });

  try {
    await new Promise((r) => setTimeout(r, 800));           // let the replay land
    if (!hostPid) { await next((m) => m.type === 'hello', 30000).then((m) => { hostPid = m.from; }).catch(() => {}); }
    if (!hostPid) throw new Error('no host in room');
    await send({ type: 'hello', name });
    console.log(`bot: seated in ${room} vs ${hostPid.slice(0, 8)} at Lv ${level}`);

    let handNo = 0;
    for (;;) {
      handNo++;
      const start = await next((m) => m.type === 'start' && m.handNo === handNo);
      const claimed = await post('/claim', { sid: start.sid, party: pid, code: start.claim });
      if (!claimed.token) throw new Error('claim refused');
      const reveals = new Map();
      const rWaiters = [];
      const cCtl = sse(`${BASE}/events?sid=${start.sid}&token=${claimed.token}`, (ev) => {
        if (ev.ev === 'reveal' && ev.value !== undefined) {
          if (!verifyReveal(start.root, ev)) { console.error('bot: PROOF FAILED', room); return; }
          reveals.set(ev.index, ev.value);
          for (let i = rWaiters.length - 1; i >= 0; i--) {
            if (rWaiters[i].idx.every((k) => reveals.has(k))) { const w = rWaiters[i]; rWaiters.splice(i, 1); w.resolve(); }
          }
        }
      });
      const ready = (idx) => new Promise((resolve) => {
        if (idx.every((k) => reveals.has(k))) return resolve();
        rWaiters.push({ idx, resolve });
      });
      const consent = (index, to) => post('/consent', { sid: start.sid, op: { kind: 'reveal', index, to } }, claimed.token);

      // bot is always the guest: engine seat 1
      const h = newHand({
        seats: [{ name: 'host', stack: 2000 }, { name, stack: 2000 }],
        button: handNo % 2, sb: 10, bb: 20, seedHex: '00'.repeat(32), limit: true,
      });
      for (const [idx, to] of [[0, hostPid], [1, hostPid], [2, pid], [3, pid]]) consent(idx, to);
      await ready([2, 3]);
      h.seats[1].hole = [reveals.get(2), reveals.get(3)];

      const rng = rngFromSeed(sha(`${start.sid}|bot|${handNo}`));
      const cache = {};
      let lastStreet = 0, guard = 0;
      while (h.phase === 'act' && guard++ < 200) {
        const L = legal(h);
        if (L.seat === 1) {
          await new Promise((r) => setTimeout(r, 700 + rng() * 900));   // think a beat
          let a = null;
          if (h.street === 3) {
            const mix = riverMix(h, 1, T.table, cache);
            if (mix) {
              const eps = LEVEL_EPS[level] ?? 0;
              const probs = mix.probs.map((p) => (1 - eps) * p + eps / mix.probs.length);
              let x = rng(), pick = 0;
              for (let k = 0; k < probs.length; k++) { x -= probs[k]; if (x <= 0) { pick = k; break; } }
              const ch = mix.acts[Math.min(pick, mix.acts.length - 1)];
              if (ch === 'f' && L.callAmount > 0) a = { seat: 1, action: 'fold' };
              else if (ch === 'b' && (L.actions.includes('bet') || L.actions.includes('raise'))) {
                a = { seat: 1, action: L.actions.includes('bet') ? 'bet' : 'raise', amount: L.minRaiseTo };
              } else a = { seat: 1, action: L.callAmount > 0 ? 'call' : 'check' };
            }
          }
          if (!a) a = ladderDecide(h, 1, L, T.table, LEVEL_EPS[level] ?? 0, rng);
          act(h, a);
          await send({ type: 'act', handNo, action: a.action, amount: a.amount ?? null });
        } else {
          const m = await next((x) => x.type === 'act' && x.handNo === handNo);
          const L2 = legal(h);
          if (L2.seat !== 0 || !L2.actions.includes(m.action)) throw new Error('host played illegally');
          act(h, { seat: 0, action: m.action, amount: m.amount ?? undefined });
        }
        // street advanced: sync the board
        if (h.street !== lastStreet && h.phase === 'act') {
          const idx = Array.from({ length: h.board.length }, (_, k) => 4 + k);
          for (const i of idx) if (!reveals.has(i)) consent(i, 'all');
          await ready(idx);
          for (let k = 0; k < h.board.length; k++) h.board[k] = reveals.get(4 + k);
          lastStreet = h.street;
        }
      }
      // showdown: publicize (v1 always shows)
      if (!h.seats.some((s2) => s2.folded)) {
        for (const i of [0, 1, 2, 3]) consent(i, 'all');
        await ready([0, 1, 2, 3]).catch(() => {});
      }
      cCtl.abort();
    }
  } catch (e) {
    console.log(`bot: leaving ${room}: ${e.message || e}`);
  } finally {
    roomCtl.abort();
    engaged.delete(room);
  }
}

// ---------------------------------------------------------------- watcher
async function scan() {
  if (engaged.size >= MAX_TABLES) return;
  let list;
  try { list = (await fetch(BASE + '/room/list').then((r) => r.json())).rooms || []; } catch { return; }
  for (const t of list) {
    if (watched.has(t.room) || engaged.has(t.room)) continue;
    const ctl = sse(`${BASE}/room/events?room=${t.room}`, (entry) => {
      const m = entry.msg;
      if (m?.type === 'summon' && !engaged.has(t.room) && engaged.size < MAX_TABLES) {
        engaged.set(t.room, true);
        const lvl = Math.min(7, Math.max(2, m.level | 0 || 5));
        ctl.abort(); watched.delete(t.room);
        playRoom(t.room, lvl);
      }
    }, () => watched.delete(t.room));
    watched.set(t.room, ctl);
    if (watched.size > 50) break;
  }
}
setInterval(scan, 4000);
scan();
console.log(`bot: watching the lobby at ${BASE} (max ${MAX_TABLES} tables)`);
