// shortcuts.js — named patterns ("shortcuts") that the solver's deductions
// fall into, from the general rule to the very specific shape.
//
// The solver itself only knows four techniques (solver.js). Each step it
// takes is classified here into the most specific shortcut that describes it:
// an "attack" step whose target unit is down to two side-by-side squares is a
// Domino shadow; if a second domino sits offset beside it, it's Offset
// dominoes; anything without a named shape is a Blocked square.
//
// Each shortcut carries a small diagram. Diagram grids use, per cell:
//   regions: a–c = a coloured region, '.' = some other region
//   marks:   x = already crossed out, X = crossed out by this shortcut,
//            Q = queen placed by this shortcut, '.' = nothing
// test/shortcuts.test.mjs checks that every diagram really shows its rule.

import { OPEN, QUEEN, ROW, COL, REGION, unitType, unitOf, findStep, applyStep } from './solver.js?v=2';

export const SHORTCUTS = [
  {
    id: 'last-square', level: 1, name: 'Last square',
    rule: 'When a row, column or region is down to one available square, its queen goes there.',
    diagram: { regions: ['aaa.', '.a..', '.a..'], marks: ['xxx.', '.Q..', '.x..'] },
  },
  {
    id: 'region-in-line', level: 1, name: 'Region in one line',
    rule: "When all of a region's available squares lie in one row or column, that line's queen must come from the region. Cross out the rest of the line.",
    diagram: { regions: ['.a...', '.aaa.', '.....'], marks: ['.x...', 'X...X', '.....'] },
  },
  {
    id: 'line-in-region', level: 1, name: 'Line inside a region',
    rule: "When all of a row's (or column's) available squares lie inside one region, that region's queen must sit in the line. Cross out the rest of the region.",
    diagram: { regions: ['.aa..', 'aaa..', '..a..'], marks: ['.XX..', '...xx', '..X..'] },
  },
  {
    id: 'domino-shadow', level: 2, name: 'Domino shadow',
    rule: 'When a row, column or region is down to two side-by-side squares, its queen will touch every square beside both of them. Cross out those squares.',
    diagram: { regions: ['....', '.aa.', '....'], marks: ['.XX.', 'x..x', '.XX.'] },
  },
  {
    id: 'corner-pair', level: 2, name: 'Corner-to-corner pair',
    rule: 'When the last two squares touch only at a corner, cross out the other two corners of their 2 × 2 block, and any square that lines up with one of the pair while touching the other.',
    diagram: { regions: ['....', '.a..', '..a.', '....'], marks: ['..X.', '..XX', 'XX..', '.X..'] },
  },
  {
    id: 'gap-pair', level: 2, name: 'Pair with a gap',
    rule: 'When the last two squares sit in one line with a single square between them, the squares on either side of that gap, across the line, can be crossed out.',
    diagram: { regions: ['.....', '.aaa.', '.....'], marks: ['..X..', 'x.x.x', '..X..'] },
  },
  {
    id: 'line-of-three', level: 2, name: 'Three in a row',
    rule: 'When the last three squares form a straight line, the squares on either side of the middle one can be crossed out.',
    diagram: { regions: ['.....', '.aaa.', '.....'], marks: ['..X..', 'x...x', '..X..'] },
  },
  {
    id: 'corner-l', level: 2, name: 'L-shape',
    rule: 'When the last three squares form an L, cross out the square that completes its 2 × 2 block, and the squares just past the corner, in line with each arm.',
    diagram: { regions: ['....', '.aa.', '.a..', '....'], marks: ['.X..', 'X...', '..X.', '....'] },
  },
  {
    id: 'offset-dominoes', level: 2, name: 'Offset dominoes',
    rule: 'When two units are each down to two side-by-side squares, in neighbouring rows (or columns) and offset by one, both queens go in the two outer squares: a queen on either inner square would touch both squares of the other domino.',
    diagram: { regions: ['.....', '.aa..', '..bb.', '.....'], marks: ['.....', '.QX..', '..XQ.', '.....'] },
  },
  {
    id: 'blocked', level: 2, name: 'Blocked square',
    rule: 'If a queen on some square would leave a row, column or region with no available square, that square can be crossed out.',
    diagram: { regions: ['.....', '.aaa.', '..a..', '.....'], marks: ['..X..', 'x...x', '.....', '.....'] },
  },
  {
    id: 'regions-in-lines', level: 3, name: 'Two regions, two lines',
    rule: "When two regions fit entirely inside the same two rows (or columns), those rows' queens belong to them. Cross out everything else in both rows.",
    diagram: { regions: ['......', '.aab..', '.abb..', '......'], marks: ['......', 'X...XX', 'X...XX', '......'] },
  },
  {
    id: 'lines-in-regions', level: 3, name: 'Two lines, two regions',
    rule: "When two rows (or columns) have all their available squares inside the same two regions, those regions' queens are in these rows. Cross out the rest of both regions.",
    diagram: { regions: ['aa.bb', '.aab.', '.abb.', 'aa.bb'], marks: ['XX.XX', 'x...x', 'x...x', 'XX.XX'] },
  },
  {
    id: 'line-pair', level: 3, name: 'Two rows, two columns',
    rule: "When two rows only have available squares in the same two columns (or the reverse), those columns' queens are in these rows. Cross out the rest of both columns.",
    diagram: { regions: ['.....', '.....', '.....', '.....', '.....'], marks: ['.X.X.', 'x.x.x', '.X.X.', 'x.x.x', '.X.X.'] },
  },
  {
    id: 'three-squeeze', level: 4, name: 'Three-way squeeze',
    rule: "The same idea with three: when three regions fit inside three rows (or columns), or three rows inside three regions, those queens are spoken for. Cross out everything else in them.",
    diagram: { regions: ['.......', '.aa.bb.', '.a.c.b.', '.cccc..', '.......'], marks: ['.......', 'X..X..X', 'X.X.X.X', 'X....XX', '.......'] },
  },
];

export const SHORTCUT = Object.fromEntries(SHORTCUTS.map((s) => [s.id, s]));

// The shape made by a set of squares: two side-by-side ('domino'), touching
// at a corner ('diagonal'), two in a line with one gap ('gap'), three in a
// straight line ('three'), three in a 2×2 block ('L'), or 'other'.
export function shapeOf(cells, N) {
  const pts = cells.map((i) => [Math.floor(i / N), i % N]);
  const rows = pts.map((p) => p[0]), cols = pts.map((p) => p[1]);
  const h = Math.max(...rows) - Math.min(...rows), w = Math.max(...cols) - Math.min(...cols);
  if (pts.length === 2) {
    if (h + w === 1) return 'domino';
    if (h === 1 && w === 1) return 'diagonal';
    if ((h === 0 && w === 2) || (h === 2 && w === 0)) return 'gap';
    return 'other';
  }
  if (pts.length === 3) {
    if ((h === 0 && w === 2) || (h === 2 && w === 0)) return 'three';
    if (h === 1 && w === 1) return 'L';
  }
  return 'other';
}

const openCells = (idx, st, u) => idx.unitCells[u].filter((i) => st[i] === OPEN);

// Two ways one square can rule out another without regions coming into it.
const touching = (idx, a, b) => Math.abs(idx.rowOf[a] - idx.rowOf[b]) <= 1 && Math.abs(idx.colOf[a] - idx.colOf[b]) <= 1;
const lineOrTouch = (idx, a, b) => idx.rowOf[a] === idx.rowOf[b] || idx.colOf[a] === idx.colOf[b] || touching(idx, a, b);

// Is the attack step's target domino `pair` one half of an offset pair? That
// needs some crossed-out square to be the inner end of a second domino (the
// last two squares of another unit) lying parallel, one line over, shifted
// by one square.
function isOffsetDominoes(step, idx, st, pair) {
  const N = idx.N;
  const [a, b] = pair;
  const across = idx.rowOf[a] === idx.rowOf[b]; // dominoes lying along a row
  const line = (i) => (across ? idx.rowOf[i] : idx.colOf[i]);
  const pos = (i) => (across ? idx.colOf[i] : idx.rowOf[i]);
  for (const x of step.cross) {
    for (const t of [REGION, ROW, COL]) {
      const v = unitOf(idx, x, t);
      if (v === step.units[0]) continue;
      const other = openCells(idx, st, v);
      if (other.length !== 2 || !other.includes(x) || shapeOf(other, N) !== 'domino') continue;
      if ((idx.rowOf[other[0]] === idx.rowOf[other[1]]) !== across) continue;
      const shift = Math.abs(Math.min(pos(a), pos(b)) - Math.min(pos(other[0]), pos(other[1])));
      if (Math.abs(line(a) - line(other[0])) === 1 && shift === 1) return true;
    }
  }
  return false;
}

// The shortcut a solver step is an instance of. `st` is the board state
// *before* the step.
export function classifyStep(step, idx, st) {
  switch (step.type) {
    case 'single':
      return 'last-square';
    case 'confine':
      return unitType(idx, step.units[0]) === REGION ? 'region-in-line' : 'line-in-region';
    case 'group': {
      if (step.units.length >= 3) return 'three-squeeze';
      if (unitType(idx, step.units[0]) === REGION) return 'regions-in-lines';
      if (unitType(idx, step.via[0]) === REGION) return 'lines-in-regions';
      return 'line-pair';
    }
    case 'attack': {
      // A shape shortcut only applies when its geometry explains every square
      // crossed out. If some square is only ruled out through a region (say
      // it shares a row with one candidate and a region with the other), the
      // step is a plain Blocked square, whatever the shape.
      const target = openCells(idx, st, step.units[0]);
      const every = (rel) => step.cross.every((x) => target.every((t) => rel(idx, x, t)));
      switch (shapeOf(target, idx.N)) {
        case 'domino':
          if (isOffsetDominoes(step, idx, st, target)) return 'offset-dominoes';
          return every(touching) ? 'domino-shadow' : 'blocked';
        case 'diagonal': return every(lineOrTouch) ? 'corner-pair' : 'blocked';
        case 'gap': return every(touching) ? 'gap-pair' : 'blocked';
        case 'three': return every(touching) ? 'line-of-three' : 'blocked';
        case 'L': return every(lineOrTouch) ? 'corner-l' : 'blocked';
        default: return 'blocked';
      }
    }
    default:
      return null;
  }
}

// The full solve from a starting state, one deduction per step, with each
// step's shortcut and the squares it changed. Used by the Solver tab, the
// command-line solver and the tests.
export function traceSolve(idx, start = null, options = {}) {
  const st = start ? Uint8Array.from(start) : new Uint8Array(idx.cells);
  const steps = [];
  for (;;) {
    const step = findStep(idx, st, options);
    if (!step || step.type === 'contradiction') break;
    const before = Uint8Array.from(st);
    const shortcut = classifyStep(step, idx, before);
    applyStep(idx, st, step);
    const placed = [], crossed = [];
    for (let i = 0; i < idx.cells; i++) {
      if (before[i] !== st[i]) (st[i] === QUEEN ? placed : crossed).push(i);
    }
    steps.push({ step, shortcut, before, placed, crossed });
  }
  let queens = 0;
  for (const s of st) if (s === QUEEN) queens++;
  return { steps, solved: queens === idx.N, final: st };
}
