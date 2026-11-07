// generator.js — builds a puzzle from a sheet key.
//
// 1. Place N queens at random so that no two share a row or column or touch.
//    This is the answer.
// 2. Grow N regions outward from those queens, one region per queen. Every
//    region now holds exactly one queen, so the answer is guaranteed valid.
// 3. Look for rival answers. Each square where a rival puts a queen (and the
//    real answer doesn't) can be handed to a neighbouring region — with a thin
//    corridor if it's buried — which kills every rival using that square and
//    never touches the real answer. Repeat until the answer is the only one.
// 4. Check that the board can be finished by deduction alone (solver.js). If
//    deduction stalls, hand away a square that is still open at the stall and
//    go back to step 3.
//
// Every random choice comes from a PRNG seeded by the sheet key, and nothing
// here uses floating-point functions that differ between JS engines (no pow,
// exp, log or trig), so a key produces the same board everywhere.
//
// Typical cost (Node 22): 8×8 ≈ 5 ms, 12×12 ≈ 50 ms, 14×14 ≈ 120 ms, worst
// seen ≈ 0.5 s. The page runs it in a Web Worker regardless.

import { createRng, formatKey, MIN_SIZE, MAX_SIZE } from './rng.js?v=2';
import { buildIndex, countSolutions, findSolutions, solveLogically, OPEN } from './solver.js?v=2';
import { assignColours } from './palette.js?v=2';

export const GENERATOR_VERSION = 1;
export const DIFFICULTY = ['', 'Easy', 'Medium', 'Hard', 'Expert'];

const EVAL_CAP = 4;       // stall repairs: count solutions up to this many
// Smallest region allowed. A one-square region is a free queen, so never.
export const minRegion = () => 2;
// Largest region allowed, so no single region swallows the board. Growth
// stops at 2.5N; repairs may stretch a region to 3N.
const growthCap = (N) => Math.floor(N * 2.5);
export const maxRegion = (N) => N * 3;
// Largest "group" deduction a puzzle may require (k regions packed into k
// rows, say). Beyond three, a human can't reasonably be expected to spot it.
const LOGIC = { maxGroup: 3 };
const MAX_ATTEMPTS = 400; // fresh layouts before giving up (never reached in testing)

export function generatePuzzle(size, code) {
  const N = Number(size);
  if (!(N >= MIN_SIZE && N <= MAX_SIZE)) throw new RangeError(`Board size must be ${MIN_SIZE}–${MAX_SIZE}`);
  const rng = createRng(`queens/v${GENERATOR_VERSION}/${N}/${code}`);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const solution = randomSolution(N, rng);
    const reg = growRegions(N, solution, rng);
    if (!reg) continue;
    const result = refine(N, reg, solution, rng);
    if (!result.ok) continue;

    // Relabel regions in reading order so ids carry no hint of the answer.
    const map = new Int16Array(N).fill(-1);
    const regions = new Array(N * N);
    let next = 0;
    for (let i = 0; i < N * N; i++) {
      if (map[reg[i]] < 0) map[reg[i]] = next++;
      regions[i] = map[reg[i]];
    }
    return {
      size: N,
      code,
      key: formatKey(N, code),
      version: GENERATOR_VERSION,
      regions,
      solution,                         // solution[row] = column
      colours: assignColours(N, regions, rng),
      level: result.level,
      difficulty: DIFFICULTY[result.level],
      attempts: attempt,
    };
  }
  throw new Error(`No puzzle found for ${formatKey(N, code)}`);
}

// ─── 1. The answer ─────────────────────────────────────────────────────────

function randomSolution(N, rng) {
  const sol = new Array(N).fill(-1);
  const used = new Uint8Array(N);
  const place = (r) => {
    if (r === N) return true;
    const cols = rng.shuffle(Array.from({ length: N }, (_, c) => c));
    for (const c of cols) {
      if (used[c] || (r > 0 && Math.abs(c - sol[r - 1]) <= 1)) continue;
      sol[r] = c; used[c] = 1;
      if (place(r + 1)) return true;
      used[c] = 0;
    }
    sol[r] = -1;
    return false;
  };
  place(0);
  return sol;
}

// ─── 2. The regions ────────────────────────────────────────────────────────
// Each region gets a growth speed (so sizes vary — a few stay tiny) and a
// shape style: a weight for a candidate square by how many of its four
// neighbours already belong to the region.

const STYLES = [
  [8, 2, 1, 1],   // tendril — likes squares it only just touches
  [2, 2, 1, 1],   // ragged
  [1, 1, 1, 1],   // neutral
  [1, 3, 9, 27],  // compact
];

function orth(N, i) {
  const r = (i / N) | 0, c = i % N, out = [];
  if (r > 0) out.push(i - N);
  if (r < N - 1) out.push(i + N);
  if (c > 0) out.push(i - 1);
  if (c < N - 1) out.push(i + 1);
  return out;
}

function growRegions(N, sol, rng) {
  const cells = N * N;
  const reg = new Int16Array(cells).fill(-1); // region id = row of its queen
  const speed = new Array(N), style = new Array(N);
  for (let g = 0; g < N; g++) {
    reg[g * N + sol[g]] = g;
    const u = rng.next();
    speed[g] = 0.05 + u * u * u * 2.5;
    style[g] = STYLES[rng.int(STYLES.length)];
  }
  const frontier = Array.from({ length: N }, () => []);
  const size = new Array(N).fill(1);
  const target = minRegion(N);
  const cap = growthCap(N);
  for (let left = cells - N; left > 0; left--) {
    for (let g = 0; g < N; g++) frontier[g].length = 0;
    for (let i = 0; i < cells; i++) {
      if (reg[i] !== -1) continue;
      const touching = [];
      for (const j of orth(N, i)) {
        const g = reg[j];
        if (g >= 0 && !touching.includes(g)) { touching.push(g); frontier[g].push(i); }
      }
    }
    // Regions still below the minimum grow first, so none ends up a single
    // square; regions at the cap wait unless nothing else can grow.
    let pool = [];
    for (let h = 0; h < N; h++) if (frontier[h].length && size[h] < target) pool.push(h);
    if (!pool.length) for (let h = 0; h < N; h++) if (frontier[h].length && size[h] < cap) pool.push(h);
    if (!pool.length) for (let h = 0; h < N; h++) if (frontier[h].length && size[h] < maxRegion(N)) pool.push(h);
    if (!pool.length) return null; // only oversized regions can reach what's left: start again
    let total = 0;
    for (const h of pool) total += speed[h];
    let x = rng.next() * total, g = -1;
    for (const h of pool) {
      g = h;
      x -= speed[h];
      if (x < 0) break;
    }
    const f = frontier[g];
    const weights = f.map((i) => style[g][orth(N, i).filter((j) => reg[j] === g).length - 1]);
    let y = rng.next() * weights.reduce((a, b) => a + b, 0), pick = f[f.length - 1];
    for (let k = 0; k < f.length; k++) {
      y -= weights[k];
      if (y < 0) { pick = f[k]; break; }
    }
    reg[pick] = g;
    size[g]++;
  }
  return size.every((n) => n >= target) ? reg : null; // a region got walled in: start again
}

function regionSizes(N, reg) {
  const size = new Array(N).fill(0);
  for (let i = 0; i < N * N; i++) size[reg[i]]++;
  return size;
}

// Would region g stay in one piece without the squares in `removed`?
// (Flood fill from its queen, which is never removed.)
function staysConnected(N, reg, g, removed, queen) {
  let size = 0;
  for (let i = 0; i < N * N; i++) if (reg[i] === g) size++;
  const seen = new Uint8Array(N * N);
  for (const i of removed) seen[i] = 1;
  const stack = [queen];
  seen[queen] = 1;
  let reached = 1;
  while (stack.length) {
    const i = stack.pop();
    for (const j of orth(N, i)) {
      if (!seen[j] && reg[j] === g) { seen[j] = 1; reached++; stack.push(j); }
    }
  }
  return reached === size - removed.length;
}

// ─── 3–4. Repair until unique and deducible ────────────────────────────────
// A move hands one or more squares (never a square of the real answer) to a
// neighbouring region. The real answer always survives a move.

const MAX_CORRIDOR = 4; // longest corridor carved to reach a buried square
const STALL_SAMPLE = 12; // repairs tried per round on a board that stalls
const BREAK_SAMPLE = 6;  // repairs tried per round on a board with rival answers
const RIVAL_SAMPLE = 24; // rival answers examined per round

const applyMove = (reg, m) => { for (const i of m.cells) reg[i] = m.to; };
const undoMove = (reg, m, from) => { for (const i of m.cells) reg[i] = from; };

// Moves that give away each square in `starts` (squares where rival answers
// put a queen) to a neighbouring region. If the square is buried inside its
// region, give away the shortest corridor that connects it to the border.
function breakingMoves(N, reg, sol, starts) {
  const moves = [];
  const size = regionSizes(N, reg), min = minRegion(N), max = maxRegion(N);
  for (const start of starts) {
    const from = reg[start];
    const queen = from * N + sol[from];
    const prev = new Int16Array(N * N).fill(-1);
    const dist = new Int16Array(N * N);
    prev[start] = start;
    const queue = [start];
    let shortest = -1, found = 0;
    for (let qi = 0; qi < queue.length && found < 4; qi++) {
      const i = queue[qi];
      if (dist[i] >= MAX_CORRIDOR || (shortest >= 0 && dist[i] > shortest + 1)) break;
      const targets = [];
      for (const j of orth(N, i)) if (reg[j] !== from && !targets.includes(reg[j])) targets.push(reg[j]);
      if (targets.length) {
        const cells = [];
        for (let k = i; ; k = prev[k]) { cells.push(k); if (k === start) break; }
        if (size[from] - cells.length >= min && staysConnected(N, reg, from, cells, queen)) {
          for (const to of targets) if (size[to] + cells.length <= max) moves.push({ cells, to });
          if (shortest < 0) shortest = dist[i];
          found++;
        }
      }
      for (const j of orth(N, i)) {
        if (prev[j] === -1 && reg[j] === from && j !== queen) {
          prev[j] = i; dist[j] = dist[i] + 1; queue.push(j);
        }
      }
    }
  }
  return moves;
}

// For a board with one answer that deduction can't finish: moves that take a
// still-open, non-answer square away from its region at the point where
// deduction stalled.
function stallMoves(N, reg, sol, stalled) {
  const isAnswer = new Uint8Array(N * N);
  for (let r = 0; r < N; r++) isAnswer[r * N + sol[r]] = 1;
  const moves = [];
  const size = regionSizes(N, reg), min = minRegion(N), max = maxRegion(N);
  for (let i = 0; i < N * N; i++) {
    if (stalled[i] !== OPEN || isAnswer[i]) continue;
    const from = reg[i];
    if (size[from] <= min) continue;
    const targets = [];
    for (const j of orth(N, i)) if (reg[j] !== from && !targets.includes(reg[j])) targets.push(reg[j]);
    if (!targets.length || !staysConnected(N, reg, from, [i], from * N + sol[from])) continue;
    for (const to of targets) if (size[to] < max) moves.push({ cells: [i], to });
  }
  return moves;
}

// A random border nudge, for when no targeted move exists.
function perturb(N, reg, sol, rng) {
  const isAnswer = new Uint8Array(N * N);
  for (let r = 0; r < N; r++) isAnswer[r * N + sol[r]] = 1;
  const size = regionSizes(N, reg), min = minRegion(N), max = maxRegion(N);
  for (let tries = 0; tries < 400; tries++) {
    const i = rng.int(N * N);
    if (isAnswer[i]) continue;
    const from = reg[i];
    if (size[from] <= min) continue;
    const others = orth(N, i).map((j) => reg[j]).filter((g) => g !== from && size[g] < max);
    if (!others.length || !staysConnected(N, reg, from, [i], from * N + sol[from])) continue;
    reg[i] = rng.pick(others);
    return true;
  }
  return false;
}

const openCount = (st) => { let n = 0; for (const s of st) if (s === OPEN) n++; return n; };

function refine(N, reg, sol, rng) {
  const sameAsSol = (s) => s.every((c, r) => c === sol[r]);
  for (let round = 0; round < 10 * N; round++) {
    const sols = findSolutions(buildIndex(N, reg), RIVAL_SAMPLE);

    if (sols.length === 1) {
      const logic = solveLogically(buildIndex(N, reg), LOGIC);
      if (logic.solved) return { ok: true, level: logic.level };
      // Unique but stalls: try a sample of repairs, keep the one that stays
      // unique and lets deduction get furthest.
      const moves = rng.shuffle(stallMoves(N, reg, sol, logic.state)).slice(0, STALL_SAMPLE);
      if (!moves.length) { if (!perturb(N, reg, sol, rng)) return { ok: false }; continue; }
      let best = [], bestScore = Infinity;
      for (const m of moves) {
        const from = reg[m.cells[0]];
        applyMove(reg, m);
        const idx = buildIndex(N, reg);
        const n = countSolutions(idx, EVAL_CAP);
        let score = 1000 + n;
        if (n === 1) {
          const l = solveLogically(idx, LOGIC);
          score = l.solved ? -1 : openCount(l.state);
        }
        undoMove(reg, m, from);
        if (score < bestScore) { bestScore = score; best = [m]; }
        else if (score === bestScore) best.push(m);
      }
      applyMove(reg, rng.pick(best));
      continue;
    }

    // Rival answers exist. Find a batch of them and target the squares where
    // the most of them put a queen: giving such a square to another region
    // kills every rival that used it.
    // Still drowning in rivals well into the repair: this layout is unlikely
    // to converge, and a fresh one is cheaper.
    if (round >= 3 * N && sols.length >= RIVAL_SAMPLE) return { ok: false };
    const rivals = sols.filter((s) => !sameAsSol(s));
    const tally = new Int16Array(N * N);
    for (const s of rivals) for (let r = 0; r < N; r++) if (s[r] !== sol[r]) tally[r * N + s[r]]++;
    const starts = [];
    for (let i = 0; i < N * N; i++) if (tally[i]) starts.push(i);
    rng.shuffle(starts).sort((a, b) => tally[b] - tally[a]); // stable: ties stay shuffled
    const moves = breakingMoves(N, reg, sol, starts.slice(0, 8));
    if (!moves.length) { if (!perturb(N, reg, sol, rng)) return { ok: false }; continue; }
    for (const m of moves) {
      m.kills = 0;
      for (const s of rivals) if (m.cells.some((i) => s[(i / N) | 0] === i % N)) m.kills++;
    }
    rng.shuffle(moves).sort((a, b) => b.kills - a.kills);
    // Of the strongest candidates, keep the one that leaves the fewest rivals.
    let best = null, bestCount = Infinity;
    for (const m of moves.slice(0, BREAK_SAMPLE)) {
      const from = reg[m.cells[0]];
      applyMove(reg, m);
      const n = countSolutions(buildIndex(N, reg), RIVAL_SAMPLE);
      undoMove(reg, m, from);
      if (n < bestCount) { bestCount = n; best = m; }
    }
    applyMove(reg, best);
  }
  return { ok: false };
}
