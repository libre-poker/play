// engine/wl-address.js — pay-to-URI deposit addresses in the browser: the
// webledgers convention, self-contained (own sha256, own secp256k1 — the
// same affine math as bots/lib/nostr.js, no node imports).
//
//   P_int   = lift_x(hostX) + int(sha256(utf8(uri)))·G
//   address = p2tr(taptweak(P_int.x))            (BIP341, no script tree)
//
// Pure public computation: the page derives the user's deposit address
// from the cashier's pubkey (right there in its DID) with no server
// round-trip. Parity-tested against bots/lib/webledger-address.js.

// ---- sha256, sync, pure JS
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
export function sha256(bytes) {
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const l = bytes.length;
  const padded = new Uint8Array(((l + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[l] = 0x80;
  const bitLen = l * 8;
  new DataView(padded.buffer).setUint32(padded.length - 4, bitLen >>> 0);
  new DataView(padded.buffer).setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  const w = new Uint32Array(64);
  const rr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    const dv = new DataView(padded.buffer, off, 64);
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rr(w[i - 15], 7) ^ rr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rr(w[i - 2], 17) ^ rr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) new DataView(out.buffer).setUint32(i * 4, H[i]);
  return out;
}

// ---- secp256k1 affine (same math as bots/lib/nostr.js)
const P = 2n ** 256n - 2n ** 32n - 977n;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = {
  x: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  y: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
};
const mod = (a, m = P) => ((a % m) + m) % m;
function modpow(b, e, m) { let r = 1n; b = mod(b, m); while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; } return r; }
const inv = (a, m = P) => modpow(mod(a, m), m - 2n, m);
function add(a, b) {
  if (!a) return b; if (!b) return a;
  if (a.x === b.x && mod(a.y + b.y) === 0n) return null;
  let l;
  if (a.x === b.x && a.y === b.y) l = mod(3n * a.x * a.x * inv(2n * a.y));
  else l = mod((b.y - a.y) * inv(mod(b.x - a.x)));
  const x = mod(l * l - a.x - b.x);
  return { x, y: mod(l * (a.x - x) - a.y) };
}
function mul(k, pt) { let r = null, q = pt; k = mod(k, N); while (k > 0n) { if (k & 1n) r = add(r, q); q = add(q, q); k >>= 1n; } return r; }
const hexToB = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
const bToHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const bToInt = (b) => BigInt('0x' + (bToHex(b) || '0'));
const intToB = (i) => hexToB(i.toString(16).padStart(64, '0'));
function liftX(xHex) {
  const x = BigInt('0x' + xHex);
  const y2 = mod(x * x * x + 7n);
  let y = modpow(y2, (P + 1n) / 4n, P);
  if (modpow(y, 2n, P) !== y2) throw new Error('not on curve');
  if ((y & 1n) === 1n) y = P - y;
  return { x, y };
}
const tagged = (tag, ...bs) => {
  const t = sha256(new TextEncoder().encode(tag));
  const all = new Uint8Array(64 + bs.reduce((a, b) => a + b.length, 0));
  all.set(t); all.set(t, 32);
  let o = 64;
  for (const b of bs) { all.set(b, o); o += b.length; }
  return sha256(all);
};

// ---- bech32m + taptweak
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}
const hrpExpand = (hrp) => [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
function convertBits(data, from, to, pad) {
  let acc = 0, bits = 0;
  const out = [];
  for (const v of data) {
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & ((1 << to) - 1)); }
  }
  if (pad && bits > 0) out.push((acc << (to - bits)) & ((1 << to) - 1));
  return out;
}
function p2trAddress(outputXHex, hrp = 'tb') {
  const data = [1, ...convertBits(hexToB(outputXHex), 8, 5, true)];
  const chk = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 0x2bc830a3;
  let out = hrp + '1';
  for (const d of data) out += CHARSET[d];
  for (let i = 0; i < 6; i++) out += CHARSET[(chk >> (5 * (5 - i))) & 31];
  return out;
}
function taptweakX(internalXHex) {
  const px = hexToB(internalXHex);
  const t = bToInt(tagged('TapTweak', px));
  if (t >= N) throw new Error('unlucky tweak');
  const Q = add(liftX(internalXHex), mul(t, G));
  return bToHex(intToB(Q.x));
}

// ---- the convention
export const uriTweak = (uri) => mod(bToInt(sha256(new TextEncoder().encode(uri))), N);

export function depositAddressFor(hostXHex, uri, hrp = 'tb') {
  const Pt = add(liftX(hostXHex), mul(uriTweak(uri), G));
  if (!Pt) throw new Error('degenerate uri tweak');
  const internalX = bToHex(intToB(Pt.x));
  const outputX = taptweakX(internalX);
  return { address: p2trAddress(outputX, hrp), internalX, outputX };
}
