// rng.js — seeded randomness and sheet keys.
//
// A "sheet key" names a puzzle: `<size>-<code>`, e.g. `10-K7Q2MX`.
// The same key always produces the same puzzle, on any device, because every
// random choice the generator makes is drawn from a PRNG seeded by the key.

export const MIN_SIZE = 8;
export const MAX_SIZE = 14;

// 30 characters, none of which can be misread for another (no 0/O, 1/I/L, U/V).
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

// cyrb128 — hashes a string into four 32-bit words.
function cyrb128(str) {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4; h2 ^= h1; h3 ^= h1; h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

// sfc32 — small, fast, integer-only PRNG (identical output in every JS engine).
function sfc32(a, b, c, d) {
  return function next() {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

export function createRng(seedText) {
  const next = sfc32(...cyrb128(String(seedText)));
  for (let i = 0; i < 12; i++) next(); // discard the warm-up
  return {
    next,
    int: (n) => Math.floor(next() * n),
    range: (lo, hi) => lo + next() * (hi - lo),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
      }
      return arr;
    },
  };
}

// A fresh, unseeded code for "New puzzle".
export function randomCode(length = 6) {
  const bytes = new Uint32Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

// Anything typed into the sheet box becomes a code: upper-cased, with runs of
// spaces/punctuation collapsed to single hyphens. "hello world" → "HELLO-WORLD".
export function normaliseCode(text) {
  return String(text ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

// "12-ABC123" → { size: 12, code: "ABC123" }. A key without a valid size prefix
// is treated as a bare code for the fallback size.
export function parseKey(text, fallbackSize) {
  const clean = normaliseCode(text);
  if (!clean) return null;
  const m = clean.match(/^(\d{1,2})-(.+)$/);
  if (m) {
    const n = Number(m[1]);
    if (n >= MIN_SIZE && n <= MAX_SIZE) return { size: n, code: m[2] };
  }
  return { size: fallbackSize, code: clean };
}

export const formatKey = (size, code) => `${size}-${code}`;
