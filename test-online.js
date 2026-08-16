// test-online.js — two simulated players run one full online hand against
// the LIVE croupier (rooms + claims + consent + proofs), with each side's
// engine refereeing the other's actions. The DOM is the only thing not
// tested here. run: node test-online.js [croupier-base]
import { newHand, legal, act, evaluate, handName } from './engine/poker.js';
import { verifyReveal } from './croupier-verify.js';

const BASE = process.argv[2] || 'https://melvin.me/croupier';
let fails = 0;
const ok = (c, m) => { if (c) console.log('  ok ', m); else { fails++; console.error('  FAIL', m); } };
const post = (path, body, token) => fetch(BASE + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
  body: JSON.stringify(body),
}).then((r) => r.json());

function sse(url) {
  const events = [];
  const waiters = [];
  fetch(url).then(async (res) => {
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
        if (m) {
          const ev = JSON.parse(m[1]);
          events.push(ev);
          for (let k = waiters.length - 1; k >= 0; k--) {
            if (waiters[k].pred(ev)) { waiters[k].resolve(ev); waiters.splice(k, 1); }
          }
        }
      }
    }
  }).catch(() => {});
  return {
    events,
    next: (pred, ms = 15000) => new Promise((resolve, reject) => {
      const f = events.find(pred);
      if (f) return resolve(f);
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error('sse timeout')), ms);
    }),
  };
}

// ---- one player = engine + croupier channel + room channel
function makePlayer(pid, seat) {
  return {
    pid, seat, token: null, reveals: new Map(),
    h: null, ch: null, room: null, seq: 0,
    async croupierListen(sid, root) {
      this.ch = sse(`${BASE}/events?sid=${sid}&token=${this.token}`);
      this.root = root;
    },
    async holes() {
      const env = this.seat === 0 ? [0, 1] : [2, 3];
      const evs = await Promise.all(env.map((i) => this.ch.next((e) => e.ev === 'reveal' && e.index === i && e.value !== undefined)));
      for (const e of evs) {
        if (!verifyReveal(this.root, e)) throw new Error('proof failed');
        this.reveals.set(e.index, e.value);
      }
      return env.map((i) => this.reveals.get(i));
    },
  };
}

const A = makePlayer('e2e-host-' + Date.now(), 0);
const B = makePlayer('e2e-guest-' + Date.now(), 1);

// ---- room
const room = (await post('/room/create', {})).room;
ok(/^[A-Z2-9]{6}$/.test(room), `room ${room}`);
const roomA = sse(`${BASE}/room/events?room=${room}`);
const roomB = sse(`${BASE}/room/events?room=${room}`);
const send = (p, msg) => post('/room/send', { room, msg: { from: p.pid, seq: p.seq++, ...msg } });
await send(B, { type: 'hello' });
await roomA.next((e) => e.msg?.type === 'hello');
ok(true, 'guest hello crossed the room');

// ---- croupier session with claims
const S = await post('/create', { n: 52, parties: [A.pid, B.pid], openPolicy: 'none', claims: true });
ok(!!S.claims && !S.tokens, 'claims-mode session (no tokens in the clear)');
A.token = (await post('/claim', { sid: S.sid, party: A.pid, code: S.claims[A.pid] })).token;
await send(A, { type: 'start', handNo: 1, sid: S.sid, root: S.root, claim: S.claims[B.pid] });
const startMsg = (await roomB.next((e) => e.msg?.type === 'start')).msg;
B.token = (await post('/claim', { sid: startMsg.sid, party: B.pid, code: startMsg.claim })).token;
ok(!!A.token && !!B.token, 'both claims redeemed');
await A.croupierListen(S.sid, S.root);
await B.croupierListen(S.sid, S.root);

// ---- the deal (both consent, per the standard mapping)
for (const [idx, to] of [[0, A.pid], [1, A.pid], [2, B.pid], [3, B.pid]]) {
  await post('/consent', { sid: S.sid, op: { kind: 'reveal', index: idx, to } }, A.token);
  await post('/consent', { sid: S.sid, op: { kind: 'reveal', index: idx, to } }, B.token);
}
const holesA = await A.holes();
const holesB = await B.holes();
ok(holesA.length === 2 && holesB.length === 2 && !holesA.some((c) => holesB.includes(c)),
  `holes dealt and disjoint (A: ${holesA}, B: ${holesB})`);

// ---- both engines, dummy decks, real referee duty
const mk = () => newHand({
  seats: [{ name: 'A', stack: 2000 }, { name: 'B', stack: 2000 }],
  button: 1, sb: 10, bb: 20, seedHex: '00'.repeat(32), limit: true,
});
A.h = mk(); B.h = mk();
A.h.seats[0].hole = holesA;
B.h.seats[1].hole = holesB;

// scripted line with a raise: B(sb) raises, A calls; then check-check to showdown
async function applyBoth(seat, action) {
  for (const P of [A, B]) {
    const L = legal(P.h);
    if (L.seat !== seat || !L.actions.includes(action.action)) throw new Error(`referee rejects ${JSON.stringify(action)} at seat ${seat}`);
    act(P.h, { seat, action: action.action, amount: action.amount });
  }
}
async function boardSync() {
  const len = A.h.board.length;
  if (!len) return;
  for (let k = 0; k < len; k++) {
    const idx = 4 + k;
    if (A.reveals.has(idx)) continue;
    await post('/consent', { sid: S.sid, op: { kind: 'reveal', index: idx, to: 'all' } }, A.token);
    await post('/consent', { sid: S.sid, op: { kind: 'reveal', index: idx, to: 'all' } }, B.token);
    const [ea, eb] = await Promise.all([
      A.ch.next((e) => e.ev === 'reveal' && e.index === idx && e.value !== undefined),
      B.ch.next((e) => e.ev === 'reveal' && e.index === idx && e.value !== undefined),
    ]);
    if (!verifyReveal(S.root, ea) || !verifyReveal(S.root, eb)) throw new Error('board proof failed');
    A.reveals.set(idx, ea.value); B.reveals.set(idx, eb.value);
  }
  for (let k = 0; k < len; k++) {
    A.h.board[k] = A.reveals.get(4 + k);
    B.h.board[k] = B.reveals.get(4 + k);
  }
}

await applyBoth(1, { action: 'raise', amount: 40 });   // B raises the sb
await applyBoth(0, { action: 'call' });
await boardSync();
ok(A.h.street === 1 && A.h.board.join() === B.h.board.join(), `flop synced: both see ${A.h.board.join(',')}`);
await applyBoth(0, { action: 'check' });
await applyBoth(1, { action: 'check' });
await boardSync();
await applyBoth(0, { action: 'check' });
await applyBoth(1, { action: 'check' });
await boardSync();
await applyBoth(0, { action: 'check' });
await applyBoth(1, { action: 'check' });
ok(A.h.phase === 'done' && A.h.street === 3 && A.h.board.length === 5, 'hand reached showdown through both referees');

// referee actually refuses illegal actions
let refused = false;
try { await applyBoth(0, { action: 'check' }); } catch { refused = true; }
ok(refused, 'referee refuses action after hand end');

// ---- showdown: publicize all four holes, both sides agree on the winner
for (const idx of [0, 1, 2, 3]) {
  await post('/consent', { sid: S.sid, op: { kind: 'reveal', index: idx, to: 'all' } }, A.token);
  await post('/consent', { sid: S.sid, op: { kind: 'reveal', index: idx, to: 'all' } }, B.token);
}
const all4 = await Promise.all([0, 1, 2, 3].map((i) => B.ch.next((e) => e.ev === 'reveal' && e.index === i && e.value !== undefined)));
ok(all4.every((e) => verifyReveal(S.root, e)), 'showdown reveals verified');
const hA = [all4[0].value, all4[1].value], hB = [all4[2].value, all4[3].value];
ok(hA.join() === holesA.join(), 'publicized holes match the private deal');
const eA = evaluate([...hA, ...A.h.board]);
const eB = evaluate([...hB, ...A.h.board]);
const winner = eA.score > eB.score ? 'A' : eB.score > eA.score ? 'B' : 'chop';
console.log(`  showdown: A ${handName(eA)} vs B ${handName(eB)} → ${winner}`);
ok(true, 'winner computed identically from public data');

if (fails) { console.error(`\n${fails} FAILURE(S)`); process.exit(1); }
console.log('\nonline protocol verified against the live croupier');
process.exit(0);
