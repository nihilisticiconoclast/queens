// Shortcut tests. Run with:  node --test
//
// Each shortcut makes a claim (its rule text and its diagram). These tests
// hold the claims to account: against real solves of generated boards, and
// against the diagrams themselves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePuzzle } from '../js/generator.js?v=3';
import { buildIndex, OPEN } from '../js/solver.js?v=3';
import { SHORTCUTS, SHORTCUT, shapeOf, classifyStep, traceSolve } from '../js/shortcuts.js?v=3';

const PER_SIZE = Number(process.env.SHORTCUT_BOARDS || 20);
const rc = (i, N) => [Math.floor(i / N), i % N];
const touches = (a, b, N) => {
  const [r1, c1] = rc(a, N), [r2, c2] = rc(b, N);
  return a !== b && Math.abs(r1 - r2) <= 1 && Math.abs(c1 - c2) <= 1;
};
const linesUp = (a, b, N) => {
  const [r1, c1] = rc(a, N), [r2, c2] = rc(b, N);
  return r1 === r2 || c1 === c2;
};

// Walk real solves and collect every step with its context.
const SAMPLES = [];
for (let N = 8; N <= 14; N++) {
  for (let k = 0; k < PER_SIZE; k++) {
    const p = generatePuzzle(N, `SC${k}`);
    const idx = buildIndex(N, p.regions);
    const trace = traceSolve(idx);
    SAMPLES.push({ p, idx, trace });
  }
}

test('every solve finishes, and every step is a known shortcut', () => {
  const ids = new Set(SHORTCUTS.map((s) => s.id));
  assert.equal(ids.size, SHORTCUTS.length, 'shortcut ids are unique');
  for (const { p, trace } of SAMPLES) {
    assert.ok(trace.solved, `${p.key} solves`);
    for (const s of trace.steps) assert.ok(ids.has(s.shortcut), `${s.shortcut} is in the catalogue`);
  }
});

test('trace steps never contradict the answer', () => {
  for (const { p, idx, trace } of SAMPLES) {
    const N = idx.N;
    const isAnswer = (i) => p.solution[Math.floor(i / N)] === i % N;
    for (const s of trace.steps) {
      for (const i of s.placed) assert.ok(isAnswer(i), `${p.key}: ${s.shortcut} crowned a wrong square`);
      for (const i of s.crossed) assert.ok(!isAnswer(i), `${p.key}: ${s.shortcut} crossed out an answer square`);
    }
  }
});

test('shape shortcuts cross out exactly what their rule describes', () => {
  for (const { p, idx, trace } of SAMPLES) {
    const N = idx.N;
    for (const s of trace.steps) {
      if (s.step.type !== 'attack') continue;
      const target = idx.unitCells[s.step.units[0]].filter((i) => s.before[i] === OPEN);
      const shape = shapeOf(target, N);
      const where = `${p.key} ${s.shortcut}`;
      switch (s.shortcut) {
        case 'domino-shadow':
          assert.equal(shape, 'domino', where);
          for (const x of s.step.cross) assert.ok(target.every((t) => touches(x, t, N)), `${where}: crossed square touches both`);
          break;
        case 'offset-dominoes':
          assert.equal(shape, 'domino', where); // its claim (queens outside) is tested below
          break;
        case 'corner-pair':
          assert.equal(shape, 'diagonal', where);
          for (const x of s.step.cross) {
            const [a, b] = target;
            assert.ok((touches(x, a, N) && touches(x, b, N)) || (linesUp(x, a, N) && touches(x, b, N)) || (linesUp(x, b, N) && touches(x, a, N)), where);
          }
          break;
        case 'gap-pair':
        case 'line-of-three':
          assert.equal(shape, s.shortcut === 'gap-pair' ? 'gap' : 'three', where);
          // squares beside the middle of the line, across it
          for (const x of s.step.cross) assert.ok(target.every((t) => touches(x, t, N)), `${where}: crossed square touches every one`);
          break;
        case 'corner-l':
          assert.equal(shape, 'L', where);
          for (const x of s.step.cross) assert.ok(target.every((t) => linesUp(x, t, N) || touches(x, t, N)), `${where}: explained by lines and touching`);
          break;
        case 'blocked': {
          // either no named shape, or the shape's geometry doesn't explain every cross
          const geometric = { domino: touches, gap: touches, three: touches,
            diagonal: (x, t) => linesUp(x, t, N) || touches(x, t, N), L: (x, t) => linesUp(x, t, N) || touches(x, t, N) }[shape];
          if (geometric) assert.ok(s.step.cross.some((x) => !target.every((t) => geometric(x, t, N))), `${where}: a named shape that fully explains its crosses`);
          break;
        }
        default:
          assert.fail(`attack step classified as ${s.shortcut}`);
      }
    }
  }
});

test('offset dominoes: both queens really do take the outer squares', () => {
  let seen = 0;
  for (const { p, idx, trace } of SAMPLES) {
    const N = idx.N;
    for (const s of trace.steps) {
      if (s.shortcut !== 'offset-dominoes') continue;
      const u = idx.unitCells[s.step.units[0]].filter((i) => s.before[i] === OPEN);
      // find the partner domino through one of the crossed squares
      let pair = null;
      for (const x of s.step.cross) {
        for (const v of [idx.rowOf[x], N + idx.colOf[x], 2 * N + idx.regOf[x]]) {
          const cells = idx.unitCells[v].filter((i) => s.before[i] === OPEN);
          if (v !== s.step.units[0] && cells.length === 2 && cells.includes(x) && shapeOf(cells, N) === 'domino') pair = cells;
        }
      }
      assert.ok(pair, `${p.key}: partner domino found`);
      const all = [...u, ...pair];
      const across = idx.rowOf[u[0]] === idx.rowOf[u[1]];
      const pos = (i) => (across ? idx.colOf[i] : idx.rowOf[i]);
      const shared = pos(u[0]) === pos(pair[0]) || pos(u[0]) === pos(pair[1]) ? pos(u[0]) : pos(u[1]);
      const outer = all.filter((i) => pos(i) !== shared);
      assert.equal(outer.length, 2, `${p.key}: two outer squares`);
      for (const i of outer) assert.equal(p.solution[Math.floor(i / N)], i % N, `${p.key}: queen on the outer square`);
      seen++;
    }
  }
  assert.ok(seen > 0, 'the sample contains offset dominoes');
});

// ─── The diagrams ────────────────────────────────────────────────────────

function parse(d) {
  const h = d.regions.length, w = d.regions[0].length;
  assert.equal(d.marks.length, h);
  for (const row of [...d.regions, ...d.marks]) assert.equal(row.length, w);
  const at = (r, c) => ({ region: d.regions[r][c], mark: d.marks[r][c] });
  const cells = [];
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) cells.push({ r, c, ...at(r, c) });
  return { h, w, cells };
}

const sees = (a, b) => (a.r === b.r || a.c === b.c || (Math.abs(a.r - b.r) <= 1 && Math.abs(a.c - b.c) <= 1)) && !(a.r === b.r && a.c === b.c);
const key = (cell) => `${cell.r},${cell.c}`;
const asSet = (cells) => new Set(cells.map(key));

test('attack diagrams cross out exactly the squares that see the whole unit', () => {
  const expectShape = { 'domino-shadow': 'domino', 'corner-pair': 'diagonal', 'gap-pair': 'gap', 'line-of-three': 'three', 'corner-l': 'L', blocked: 'other' };
  for (const [id, shape] of Object.entries(expectShape)) {
    const { w, cells } = parse(SHORTCUT[id].diagram);
    const unit = cells.filter((x) => x.region === 'a' && x.mark === '.');
    assert.equal(shapeOf(unit.map((x) => x.r * w + x.c), w), shape, `${id} diagram shape`);
    const shouldCross = cells.filter((x) => x.region !== 'a' && x.mark !== 'x' && unit.every((u) => sees(x, u)));
    const crossed = cells.filter((x) => x.mark === 'X');
    assert.deepEqual(asSet(crossed), asSet(shouldCross), `${id} diagram crosses the right squares`);
  }
});

test('offset dominoes diagram: queens outside, crosses inside', () => {
  const { cells } = parse(SHORTCUT['offset-dominoes'].diagram);
  for (const r of ['a', 'b']) {
    const dom = cells.filter((x) => x.region === r);
    assert.equal(dom.length, 2);
    assert.deepEqual(dom.map((x) => x.mark).sort(), ['Q', 'X']);
  }
  const queens = cells.filter((x) => x.mark === 'Q');
  assert.ok(!sees(queens[0], queens[1]) || queens[0].r !== queens[1].r, 'queens do not touch');
  assert.ok(Math.abs(queens[0].c - queens[1].c) === 2, 'queens are the two outer squares');
});

test('last-square diagram: the queen is the only square left', () => {
  const { cells } = parse(SHORTCUT['last-square'].diagram);
  const open = cells.filter((x) => x.region === 'a' && x.mark !== 'x');
  assert.equal(open.length, 1);
  assert.equal(open[0].mark, 'Q');
});

// Group diagrams: units A have all their available squares inside units B
// (|A| = |B|); the crosses must be exactly B's other available squares.
const lineOf = (kind) => (x) => (kind === 'row' ? x.r : x.c);
const GROUPS = {
  'region-in-line': { a: { regions: ['a'] }, b: 'row' },
  'regions-in-lines': { a: { regions: ['a', 'b'] }, b: 'row' },
  'three-squeeze': { a: { regions: ['a', 'b', 'c'] }, b: 'row' },
  'line-in-region': { a: { rows: [1] }, b: 'region' },
  'lines-in-regions': { a: { rows: [1, 2] }, b: 'region' },
  'line-pair': { a: { rows: [1, 3] }, b: 'col' },
};

test('group diagrams cross out exactly what the pigeonhole frees', () => {
  for (const [id, spec] of Object.entries(GROUPS)) {
    const { cells } = parse(SHORTCUT[id].diagram);
    const available = (x) => x.mark !== 'x' && x.mark !== 'X';
    const inA = spec.a.regions
      ? (x) => spec.a.regions.includes(x.region)
      : (x) => spec.a.rows.includes(x.r);
    const aCells = cells.filter((x) => inA(x) && available(x));
    let bOf;
    if (spec.b === 'region') bOf = (x) => x.region;
    else bOf = lineOf(spec.b);
    const bUnits = new Set(aCells.map(bOf));
    const aCount = spec.a.regions ? spec.a.regions.length : spec.a.rows.length;
    assert.equal(bUnits.size, aCount, `${id}: A fits in exactly |A| units`);
    if (spec.b === 'region') assert.ok(![...bUnits].includes('.'), `${id}: B units are named regions`);
    const shouldCross = cells.filter((x) => bUnits.has(bOf(x)) && !inA(x) && x.mark !== 'x');
    const crossed = cells.filter((x) => x.mark === 'X');
    assert.deepEqual(asSet(crossed), asSet(shouldCross), `${id} diagram`);
  }
});

test('every shortcut has a rule and a well-formed diagram', () => {
  for (const s of SHORTCUTS) {
    assert.ok(s.rule.length > 20 && s.name.length > 2, s.id);
    assert.ok(s.level >= 1 && s.level <= 4, s.id);
    parse(s.diagram);
  }
});

test('classifyStep is the single source used by traceSolve', () => {
  const { idx, trace } = SAMPLES[0];
  for (const s of trace.steps) assert.equal(classifyStep(s.step, idx, s.before), s.shortcut);
});
