// Engine tests. Run with:  node --test
//
// What must hold for every generated puzzle:
//   - the stored answer obeys every rule,
//   - it is the ONLY answer (exhaustive search),
//   - deduction alone reaches it, using groups of at most three units,
//   - every deduction step is sound (never crosses out or crowns wrongly),
//   - regions are connected, 2..3N squares, and coloured distinctly,
//   - the same key always gives the same board.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePuzzle, GENERATOR_VERSION, minRegion, maxRegion } from '../js/generator.js';
import { buildIndex, countSolutions, findStep, applyStep, OPEN, CROSS, QUEEN } from '../js/solver.js';
import { parseKey, normaliseCode, MIN_SIZE, MAX_SIZE } from '../js/rng.js';
import { PALETTE } from '../js/palette.js';

const PER_SIZE = Number(process.env.PER_SIZE || 25);

function checkAnswer(p) {
  const N = p.size, sol = p.solution;
  assert.equal(new Set(sol).size, N, 'one queen per column');
  const regionsHit = new Set(sol.map((c, r) => p.regions[r * N + c]));
  assert.equal(regionsHit.size, N, 'one queen per region');
  for (let r = 1; r < N; r++) assert.ok(Math.abs(sol[r] - sol[r - 1]) > 1, 'queens never touch');
}

function checkRegions(p) {
  const N = p.size;
  assert.equal(p.regions.length, N * N);
  for (let g = 0; g < N; g++) {
    const cells = p.regions.flatMap((v, i) => (v === g ? [i] : []));
    assert.ok(cells.length >= minRegion(N), `region ${g} too small (${cells.length})`);
    assert.ok(cells.length <= maxRegion(N), `region ${g} too large (${cells.length})`);
    const seen = new Set([cells[0]]);
    const stack = [cells[0]];
    while (stack.length) {
      const i = stack.pop(), r = (i / N) | 0, c = i % N;
      for (const [rr, cc] of [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]) {
        const j = rr * N + cc;
        if (rr >= 0 && rr < N && cc >= 0 && cc < N && p.regions[j] === g && !seen.has(j)) { seen.add(j); stack.push(j); }
      }
    }
    assert.equal(seen.size, cells.length, `region ${g} is in one piece`);
  }
  assert.equal(new Set(p.colours).size, N, 'colours are distinct');
  for (const c of p.colours) assert.ok(c >= 0 && c < PALETTE.length);
}

// Walk the deduction from an empty board, checking each step against the answer.
function checkDeduction(p) {
  const N = p.size, idx = buildIndex(N, p.regions);
  const isAnswer = new Uint8Array(N * N);
  p.solution.forEach((c, r) => { isAnswer[r * N + c] = 1; });
  const st = new Uint8Array(N * N);
  let steps = 0, level = 0;
  for (;;) {
    const step = findStep(idx, st, { maxGroup: 3 });
    if (!step) break;
    assert.notEqual(step.type, 'contradiction');
    for (const i of step.cross) assert.equal(isAnswer[i], 0, `${step.type} crossed out an answer square`);
    for (const i of step.place) assert.equal(isAnswer[i], 1, `${step.type} crowned a wrong square`);
    applyStep(idx, st, step);
    level = Math.max(level, step.level);
    steps++;
  }
  for (let i = 0; i < N * N; i++) assert.equal(st[i], isAnswer[i] ? QUEEN : CROSS, 'deduction finishes the board');
  assert.equal(level, p.level, 'stored difficulty matches the deduction');
  return steps;
}

for (let N = MIN_SIZE; N <= MAX_SIZE; N++) {
  test(`${N}×${N}: ${PER_SIZE} boards are valid, unique and deducible`, () => {
    const times = [];
    for (let k = 0; k < PER_SIZE; k++) {
      const t0 = performance.now();
      const p = generatePuzzle(N, `T${k}`);
      times.push(performance.now() - t0);
      checkAnswer(p);
      checkRegions(p);
      assert.equal(countSolutions(buildIndex(N, p.regions), 2), 1, `${p.key} has exactly one answer`);
      checkDeduction(p);
    }
    times.sort((a, b) => a - b);
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    console.log(`  ${N}×${N}: mean ${mean.toFixed(0)} ms, worst ${times.at(-1).toFixed(0)} ms`);
  });
}

test('same key, same board', () => {
  for (const key of ['8-ABC234', '13-HELLO-WORLD', '14-K7Q2MX']) {
    const { size, code } = parseKey(key, 10);
    const a = generatePuzzle(size, code), b = generatePuzzle(size, code);
    assert.deepEqual(a.regions, b.regions);
    assert.deepEqual(a.solution, b.solution);
    assert.deepEqual(a.colours, b.colours);
  }
});

// If this fails, the generator changed and every shared sheet key now makes a
// different board. Bump GENERATOR_VERSION deliberately, then update these.
test('golden boards are unchanged', () => {
  const fp = (p) => {
    let h = 2166136261;
    for (const v of [...p.regions, ...p.solution, ...p.colours]) { h ^= v; h = Math.imul(h, 16777619) >>> 0; }
    return h.toString(16);
  };
  assert.equal(GENERATOR_VERSION, 1);
  assert.equal(fp(generatePuzzle(8, 'GOLDEN')), 'bfbfb0cc');
  assert.equal(fp(generatePuzzle(11, 'GOLDEN')), 'a02449dc');
  assert.equal(fp(generatePuzzle(14, 'GOLDEN')), 'e8638355');
});

test('sheet keys parse forgivingly', () => {
  assert.deepEqual(parseKey('12-abc123', 8), { size: 12, code: 'ABC123' });
  assert.deepEqual(parseKey('  hello world ', 9), { size: 9, code: 'HELLO-WORLD' });
  assert.deepEqual(parseKey('7-ABC', 10), { size: 10, code: '7-ABC' }, 'size outside 8–14 is just part of the code');
  assert.deepEqual(parseKey('14·K7Q2MX', 8), { size: 14, code: 'K7Q2MX' });
  assert.equal(parseKey('   ', 8), null);
  assert.equal(normaliseCode('a  b__c'), 'A-B-C');
});

test('the exhaustive search counts correctly on a hand-made board', () => {
  // 8×8 with a region per row: the only constraint left is
  // rows/columns/no-touching, i.e. the 8-king-permutation count.
  const N = 8;
  const regions = Array.from({ length: N * N }, (_, i) => (i / N) | 0);
  assert.equal(countSolutions(buildIndex(N, regions), 1e6), 5242);
});
