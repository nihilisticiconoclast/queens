// solver.js — the two engines behind every puzzle.
//
//   countSolutions / findSolutions — exhaustive search. Used to prove that a
//     board has exactly one solution.
//   findStep / solveLogically — human-style deduction. Used to prove that the
//     single solution can be reached without guessing, to rate difficulty, and
//     to produce hints.
//
// Board conventions: N×N cells, index i = r*N + c, regions[i] ∈ [0, N).
// A "unit" is anything that must hold exactly one queen:
//   units 0..N-1 are rows, N..2N-1 are columns, 2N..3N-1 are regions.

export const OPEN = 0, CROSS = 1, QUEEN = 2;
export const ROW = 0, COL = 1, REGION = 2;

// Row/column geometry depends only on N, so it is built once per size.
const geometryCache = new Map();
function geometry(N) {
  let g = geometryCache.get(N);
  if (g) return g;
  const cells = N * N;
  const rowOf = new Uint8Array(cells), colOf = new Uint8Array(cells);
  const rowCells = Array.from({ length: N }, () => []);
  const colCells = Array.from({ length: N }, () => []);
  const diag = new Array(cells); // the four diagonal neighbours
  for (let i = 0; i < cells; i++) {
    const r = (i / N) | 0, c = i % N;
    rowOf[i] = r; colOf[i] = c;
    rowCells[r].push(i);
    colCells[c].push(i);
    const d = [];
    for (const [dr, dc] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && rr < N && cc >= 0 && cc < N) d.push(rr * N + cc);
    }
    diag[i] = d;
  }
  g = { cells, rowOf, colOf, rowCells, colCells, diag };
  geometryCache.set(N, g);
  return g;
}

export function buildIndex(N, regions) {
  const geo = geometry(N);
  const regOf = Uint8Array.from(regions);
  const regionCells = Array.from({ length: N }, () => []);
  for (let i = 0; i < geo.cells; i++) regionCells[regOf[i]].push(i);
  const idx = {
    N,
    cells: geo.cells,
    regions: regOf,
    rowOf: geo.rowOf,
    colOf: geo.colOf,
    regOf,
    diag: geo.diag,
    unitCells: [...geo.rowCells, ...geo.colCells, ...regionCells],
  };
  // attacks[i]: every other cell that a queen on i rules out — its row,
  // column, region and the eight touching squares. Built on first use: the
  // exhaustive search doesn't need it, and the generator builds thousands of
  // indexes that only ever see the exhaustive search.
  let attacks = null;
  Object.defineProperty(idx, 'attacks', {
    get() { return attacks || (attacks = buildAttacks(idx)); },
  });
  return idx;
}

function buildAttacks(idx) {
  const { N, cells, rowOf, colOf, regOf, unitCells, diag } = idx;
  const attacks = new Array(cells);
  const seen = new Uint8Array(cells);
  for (let i = 0; i < cells; i++) {
    const list = [];
    const add = (j) => { if (j !== i && !seen[j]) { seen[j] = 1; list.push(j); } };
    for (const j of unitCells[rowOf[i]]) add(j);
    for (const j of unitCells[N + colOf[i]]) add(j);
    for (const j of unitCells[2 * N + regOf[i]]) add(j);
    for (const j of diag[i]) add(j);
    for (const j of list) seen[j] = 0;
    attacks[i] = Int16Array.from(list);
  }
  return attacks;
}

export const unitType = (idx, u) => Math.floor(u / idx.N);
export const unitNumber = (idx, u) => u % idx.N;

export function unitOf(idx, i, type) {
  if (type === ROW) return idx.rowOf[i];
  if (type === COL) return idx.N + idx.colOf[i];
  return 2 * idx.N + idx.regOf[i];
}

// Would a queen on a rule out b?
export function sees(idx, a, b) {
  if (a === b) return false;
  const dr = idx.rowOf[a] - idx.rowOf[b];
  const dc = idx.colOf[a] - idx.colOf[b];
  return dr === 0 || dc === 0 || idx.regOf[a] === idx.regOf[b] ||
    (dr >= -1 && dr <= 1 && dc >= -1 && dc <= 1);
}

// ─── 1. Exhaustive search ──────────────────────────────────────────────────
// Depth-first, always branching on the unit with the fewest open cells.
// Stops as soon as `cap` solutions are found, so "is it unique?" costs one
// solution plus a proof that no second exists.

export function countSolutions(idx, cap = 2) {
  return search(idx, cap, null);
}

export function findSolutions(idx, cap = 2) {
  const out = [];
  search(idx, cap, out);
  return out; // each solution: array of column indices, one per row
}

function search(idx, cap, out) {
  const { N, cells, rowOf, colOf, regOf, unitCells, diag } = idx;
  const U = 3 * N, N2 = 2 * N;
  const alive = new Uint8Array(cells).fill(1);
  const count = new Int16Array(U);
  for (let u = 0; u < U; u++) count[u] = unitCells[u].length;
  const done = new Uint8Array(U);
  const trail = new Int16Array(cells + 1);
  const placed = new Int16Array(N);
  const candBuf = new Int16Array(N * N); // per-depth candidate lists, stacked
  let tp = 0, found = 0;

  const kill = (i) => {
    alive[i] = 0; count[rowOf[i]]--; count[N + colOf[i]]--; count[N2 + regOf[i]]--;
    trail[tp++] = i;
  };
  const unkill = (i) => {
    alive[i] = 1; count[rowOf[i]]++; count[N + colOf[i]]++; count[N2 + regOf[i]]++;
  };

  function rec(depth, base) {
    if (depth === N) {
      found++;
      if (out) {
        const s = new Array(N);
        for (let k = 0; k < N; k++) s[rowOf[placed[k]]] = colOf[placed[k]];
        out.push(s);
      }
      return found >= cap;
    }
    let best = -1, bestCount = 1e9;
    for (let u = 0; u < U; u++) {
      if (done[u]) continue;
      const c = count[u];
      if (c < bestCount) { bestCount = c; best = u; if (c <= 1) break; }
    }
    if (bestCount === 0) return false;

    let end = base;
    const bc = unitCells[best];
    for (let k = 0; k < bc.length; k++) if (alive[bc[k]]) candBuf[end++] = bc[k];
    const loopMark = tp;
    for (let ci = base; ci < end; ci++) {
      const i = candBuf[ci];
      const mark = tp;
      const u1 = rowOf[i], u2 = N + colOf[i], u3 = N2 + regOf[i];
      for (const j of unitCells[u1]) if (alive[j]) kill(j); // includes i itself
      for (const j of unitCells[u2]) if (alive[j]) kill(j);
      for (const j of unitCells[u3]) if (alive[j]) kill(j);
      for (const j of diag[i]) if (alive[j]) kill(j);
      done[u1] = done[u2] = done[u3] = 1;
      placed[depth] = i;
      const stop = rec(depth + 1, end);
      done[u1] = done[u2] = done[u3] = 0;
      while (tp > mark) unkill(trail[--tp]);
      if (stop) {
        while (tp > loopMark) unkill(trail[--tp]);
        return true;
      }
      kill(i); // every solution with a queen on i has been counted
    }
    while (tp > loopMark) unkill(trail[--tp]);
    return false;
  }

  rec(0, 0);
  return found;
}

// ─── 2. Deduction ──────────────────────────────────────────────────────────
// State: Uint8Array over cells, each OPEN, CROSS or QUEEN.
//
// Techniques, easiest first (the level is used for the difficulty rating):
//   single  (1) — a unit has exactly one open cell left: it holds the queen.
//   confine (1) — a unit's open cells all lie inside one unit of another kind,
//                 so that other unit's queen is spoken for: cross out the rest.
//   attack  (2) — a queen on cell x would rule out every open cell of some
//                 unit, so x cannot hold a queen.
//   group   (3 for two units, 4 for three or more) — k units whose open cells
//                 all lie inside k units of another kind use up those units'
//                 queens: cross out everything else in them.

export function unitStats(idx, st) {
  const U = 3 * idx.N;
  const open = new Int16Array(U), queens = new Int16Array(U);
  for (let u = 0; u < U; u++) {
    const cs = idx.unitCells[u];
    for (let k = 0; k < cs.length; k++) {
      const s = st[cs[k]];
      if (s === OPEN) open[u]++;
      else if (s === QUEEN) queens[u]++;
    }
  }
  return { open, queens };
}

export function applyQueen(idx, st, i) {
  const crossed = [];
  st[i] = QUEEN;
  for (const j of idx.attacks[i]) {
    if (st[j] === OPEN) { st[j] = CROSS; crossed.push(j); }
  }
  return crossed;
}

export function applyStep(idx, st, step) {
  for (const i of step.cross) if (st[i] === OPEN) st[i] = CROSS;
  for (const i of step.place) applyQueen(idx, st, i);
}

const popcount = (m) => {
  let c = 0;
  while (m) { m &= m - 1; c++; }
  return c;
};

const bitsOf = (m) => {
  const out = [];
  for (let b = 0; m; b++, m >>= 1) if (m & 1) out.push(b);
  return out;
};

// Which pairs of unit kinds a group deduction can link (A's cells inside B's).
const GROUP_PAIRS = [
  [REGION, ROW], [REGION, COL], [ROW, REGION], [COL, REGION], [ROW, COL], [COL, ROW],
];

function findGroup(idx, st, stats, k) {
  const { N } = idx;
  for (const [ta, tb] of GROUP_PAIRS) {
    if (k === 1 && ta !== REGION && tb !== REGION) continue; // that's just a single
    const units = [], masks = [];
    for (let a = 0; a < N; a++) {
      const u = ta * N + a;
      if (stats.queens[u] || !stats.open[u]) continue;
      let m = 0;
      for (const i of idx.unitCells[u]) {
        if (st[i] === OPEN) m |= 1 << (unitOf(idx, i, tb) - tb * N);
      }
      units.push(u);
      masks.push(m);
    }
    if (k >= units.length) continue; // all remaining units at once proves nothing

    const chosen = [];
    const inChosen = new Uint8Array(3 * N);
    const dfs = (start, mask) => {
      if (chosen.length === k) {
        if (popcount(mask) !== k) return null;
        const cross = [];
        for (const b of bitsOf(mask)) {
          for (const i of idx.unitCells[tb * N + b]) {
            if (st[i] === OPEN && !inChosen[unitOf(idx, i, ta)]) cross.push(i);
          }
        }
        if (!cross.length) return null;
        return {
          type: k === 1 ? 'confine' : 'group',
          level: k === 1 ? 1 : k === 2 ? 3 : 4,
          units: chosen.slice(),
          via: bitsOf(mask).map((b) => tb * N + b),
          place: [],
          cross,
        };
      }
      for (let j = start; j < units.length; j++) {
        const m2 = mask | masks[j];
        if (popcount(m2) > k) continue; // the union only grows
        chosen.push(units[j]); inChosen[units[j]] = 1;
        const found = dfs(j + 1, m2);
        chosen.pop(); inChosen[units[j]] = 0;
        if (found) return found;
      }
      return null;
    };
    const step = dfs(0, 0);
    if (step) return step;
  }
  return null;
}

function findAttack(idx, st, stats) {
  const U = 3 * idx.N;
  const order = [];
  for (let u = 0; u < U; u++) if (!stats.queens[u] && stats.open[u] > 0) order.push(u);
  // Tightest units first: "this region only has two squares left…"
  order.sort((a, b) => stats.open[a] - stats.open[b] || b - a);
  for (const u of order) {
    const targets = idx.unitCells[u].filter((i) => st[i] === OPEN);
    const t0 = targets[0];
    const cross = [];
    for (const x of idx.attacks[t0]) {
      if (st[x] !== OPEN || unitOf(idx, x, unitType(idx, u)) === u) continue;
      let all = true;
      for (let k = 1; k < targets.length && all; k++) all = sees(idx, x, targets[k]);
      if (all) cross.push(x);
    }
    if (cross.length) return { type: 'attack', level: 2, units: [u], via: [], place: [], cross };
  }
  return null;
}

// Regions, then rows, then columns: "the last square of the blue region"
// reads more naturally than "the last square of column C".
function singleOrder(N) {
  const order = [];
  for (let u = 2 * N; u < 3 * N; u++) order.push(u);
  for (let u = 0; u < 2 * N; u++) order.push(u);
  return order;
}

// The easiest available deduction from state `st`, or null if none applies.
export function findStep(idx, st, { maxLevel = 4, maxGroup = Infinity } = {}) {
  const { N } = idx;
  const stats = unitStats(idx, st);
  for (let u = 0; u < 3 * N; u++) {
    if (stats.queens[u] > 1) return { type: 'contradiction', level: 0, units: [u], via: [], place: [], cross: [] };
    if (!stats.queens[u] && !stats.open[u]) return { type: 'contradiction', level: 0, units: [u], via: [], place: [], cross: [] };
  }
  for (const u of singleOrder(N)) {
    if (!stats.queens[u] && stats.open[u] === 1) {
      const i = idx.unitCells[u].find((c) => st[c] === OPEN);
      return { type: 'single', level: 1, units: [u], via: [], place: [i], cross: [] };
    }
  }
  let step = findGroup(idx, st, stats, 1);
  if (step) return step;
  if (maxLevel >= 2 && (step = findAttack(idx, st, stats))) return step;
  if (maxLevel >= 3 && (step = findGroup(idx, st, stats, 2))) return step;
  if (maxLevel >= 4) {
    const kMax = Math.min(N - 1, maxGroup);
    for (let k = 3; k <= kMax; k++) if ((step = findGroup(idx, st, stats, k))) return step;
  }
  return null;
}

// Solve by deduction alone. Returns whether it finished, the hardest technique
// needed (level), and how many steps it took.
export function solveLogically(idx, { state = null, maxLevel = 4, maxGroup = Infinity } = {}) {
  const st = state ? Uint8Array.from(state) : new Uint8Array(idx.cells);
  let level = 0, steps = 0;
  const used = { single: 0, confine: 0, attack: 0, group: 0 };
  for (;;) {
    let queens = 0;
    for (let i = 0; i < idx.cells; i++) if (st[i] === QUEEN) queens++;
    if (queens === idx.N) {
      const stats = unitStats(idx, st);
      const ok = stats.queens.every((q) => q === 1);
      return { solved: ok, level, steps, used, state: st };
    }
    const step = findStep(idx, st, { maxLevel, maxGroup });
    if (!step || step.type === 'contradiction') return { solved: false, level, steps, used, state: st };
    applyStep(idx, st, step);
    used[step.type]++;
    if (step.level > level) level = step.level;
    steps++;
  }
}

// ─── Every deduction available ─────────────────────────────────────────────
// findStep returns only the easiest deduction. Training needs all of them,
// so that a drill accepts any square the player can genuinely rule out.

function collectGroups(idx, st, stats, k, out) {
  const { N } = idx;
  for (const [ta, tb] of GROUP_PAIRS) {
    if (k === 1 && ta !== REGION && tb !== REGION) continue;
    const units = [], masks = [];
    for (let a = 0; a < N; a++) {
      const u = ta * N + a;
      if (stats.queens[u] || !stats.open[u]) continue;
      let m = 0;
      for (const i of idx.unitCells[u]) if (st[i] === OPEN) m |= 1 << (unitOf(idx, i, tb) - tb * N);
      units.push(u);
      masks.push(m);
    }
    if (k >= units.length) continue;
    const chosen = [];
    const inChosen = new Uint8Array(3 * N);
    const dfs = (start, mask) => {
      if (chosen.length === k) {
        if (popcount(mask) !== k) return;
        const cross = [];
        for (const b of bitsOf(mask)) {
          for (const i of idx.unitCells[tb * N + b]) if (st[i] === OPEN && !inChosen[unitOf(idx, i, ta)]) cross.push(i);
        }
        if (cross.length) {
          out.push({ type: k === 1 ? 'confine' : 'group', level: k === 1 ? 1 : k === 2 ? 3 : 4,
            units: chosen.slice(), via: bitsOf(mask).map((b) => tb * N + b), place: [], cross });
        }
        return;
      }
      for (let j = start; j < units.length; j++) {
        const m2 = mask | masks[j];
        if (popcount(m2) > k) continue;
        chosen.push(units[j]); inChosen[units[j]] = 1;
        dfs(j + 1, m2);
        chosen.pop(); inChosen[units[j]] = 0;
      }
    };
    dfs(0, 0);
  }
}

export function findAllSteps(idx, st, { maxGroup = 3 } = {}) {
  const { N } = idx;
  const stats = unitStats(idx, st);
  const out = [];
  for (let u = 0; u < 3 * N; u++) {
    if (!stats.queens[u] && stats.open[u] === 1) {
      out.push({ type: 'single', level: 1, units: [u], via: [], place: [idx.unitCells[u].find((c) => st[c] === OPEN)], cross: [] });
    }
  }
  for (let k = 1; k <= Math.min(maxGroup, N - 1); k++) collectGroups(idx, st, stats, k, out);
  for (let u = 0; u < 3 * N; u++) {
    if (stats.queens[u] || !stats.open[u]) continue;
    const targets = idx.unitCells[u].filter((i) => st[i] === OPEN);
    const cross = [];
    for (const x of idx.attacks[targets[0]]) {
      if (st[x] !== OPEN || unitOf(idx, x, unitType(idx, u)) === u) continue;
      if (targets.every((t) => t === targets[0] || sees(idx, x, t))) cross.push(x);
    }
    if (cross.length) out.push({ type: 'attack', level: 2, units: [u], via: [], place: [], cross });
  }
  return out;
}
