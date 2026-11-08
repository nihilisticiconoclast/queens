#!/usr/bin/env node
// tools/solve.mjs — the solver, in a terminal.
//
//   node tools/solve.mjs 10-K7Q2MX          the board, then every deduction in order
//   node tools/solve.mjs --stats 200        how often each shortcut turns up (8×8–14×14)
//   node tools/solve.mjs --stats 200 12 14  …for chosen sizes only

import { generatePuzzle } from '../js/generator.js?v=3';
import { buildIndex } from '../js/solver.js?v=3';
import { SHORTCUTS, SHORTCUT, traceSolve } from '../js/shortcuts.js?v=3';
import { describeStep, colLetter } from '../js/explain.js?v=3';
import { PALETTE } from '../js/palette.js?v=3';
import { parseKey, MIN_SIZE, MAX_SIZE } from '../js/rng.js?v=3';

const args = process.argv.slice(2);

if (args[0] === '--stats') {
  const perSize = Number(args[1] || 100);
  const sizes = args.length > 2 ? args.slice(2).map(Number) : Array.from({ length: MAX_SIZE - MIN_SIZE + 1 }, (_, k) => MIN_SIZE + k);
  const uses = Object.fromEntries(SHORTCUTS.map((s) => [s.id, 0]));
  const boards = Object.fromEntries(SHORTCUTS.map((s) => [s.id, 0]));
  let total = 0, steps = 0;
  for (const n of sizes) {
    for (let k = 0; k < perSize; k++) {
      const p = generatePuzzle(n, `STAT${k}`);
      const trace = traceSolve(buildIndex(n, p.regions));
      const seen = new Set();
      for (const s of trace.steps) { uses[s.shortcut]++; seen.add(s.shortcut); }
      for (const id of seen) boards[id]++;
      steps += trace.steps.length;
      total++;
    }
  }
  console.log(`${total} boards (sizes ${sizes.join(', ')}), ${(steps / total).toFixed(1)} steps per board on average\n`);
  console.log('shortcut'.padEnd(26) + 'steps'.padStart(8) + '   on % of boards');
  for (const s of SHORTCUTS) {
    console.log(s.name.padEnd(26) + String(uses[s.id]).padStart(8) + `   ${((100 * boards[s.id]) / total).toFixed(1).padStart(5)}%`);
  }
  process.exit(0);
}

const parsed = parseKey(args[0] || '', 8);
if (!parsed) {
  console.error('Usage: node tools/solve.mjs <sheet key>   e.g. 10-K7Q2MX');
  process.exit(1);
}
const p = generatePuzzle(parsed.size, parsed.code);
const N = p.size;
const idx = buildIndex(N, p.regions);
const letter = (g) => String.fromCharCode(97 + g);

console.log(`Sheet ${p.key} (${p.difficulty})\n`);
console.log('     ' + Array.from({ length: N }, (_, c) => colLetter(c)).join(' '));
for (let r = 0; r < N; r++) {
  const row = Array.from({ length: N }, (_, c) => letter(p.regions[r * N + c])).join(' ');
  console.log(String(r + 1).padStart(3) + '  ' + row);
}
console.log('\n' + Array.from({ length: N }, (_, g) => `${letter(g)} = ${PALETTE[p.colours[g]].name}`).join(', ') + '\n');

const trace = traceSolve(idx);
trace.steps.forEach((s, k) => {
  console.log(`${String(k + 1).padStart(3)}. ${SHORTCUT[s.shortcut].name}: ${describeStep(s.step, idx, p)}`);
});
const counts = {};
for (const s of trace.steps) counts[s.shortcut] = (counts[s.shortcut] || 0) + 1;
console.log(`\n${trace.solved ? 'Solved' : 'Stuck'} after ${trace.steps.length} steps.`);
console.log('Shortcuts: ' + SHORTCUTS.filter((s) => counts[s.id]).map((s) => `${s.name} ×${counts[s.id]}`).join(', '));
console.log('\nAnswer:   ' + p.solution.map((c, r) => `${colLetter(c)}${r + 1}`).join(' '));
