#!/usr/bin/env node
// tools/drills.mjs — builds js/drills-data.js, the Training tab's positions.
//
//   node tools/drills.mjs [boards per size]     (default 1500, sizes 8–12)
//
// Positions are stored as sheet keys plus a step number: the page regenerates
// each board from its key (generation is deterministic) and replays the solve
// to that step. If the generator or solver changes, rebuild this file;
// test/training.test.mjs checks a sample still lines up.

import { writeFileSync } from 'node:fs';
import { generatePuzzle, GENERATOR_VERSION } from '../js/generator.js?v=3';
import { buildIndex, findAllSteps, findStep, applyStep, applyQueen, unitStats, OPEN, QUEEN, REGION } from '../js/solver.js?v=3';
import { SHORTCUT, traceSolve } from '../js/shortcuts.js?v=3';

const PER_SIZE = Number(process.argv[2] || 1500);
const SIZES = [8, 9, 10, 11, 12];
const CAP = 40;
const MAX_ANSWER_SHARE = 0.3; // positions where guessing would pay too well are skipped

const spot = {}, trial = [], cascade = [], opening = [];

// Would a two-way trial on `unit` settle it with Easy/Medium logic? Returns
// the candidate that breaks and how many forced moves it takes.
function trialOutcome(idx, st0, unit) {
  const cands = idx.unitCells[unit].filter((i) => st0[i] === OPEN);
  if (cands.length !== 2) return null;
  const res = cands.map((c) => {
    const st = Uint8Array.from(st0);
    applyQueen(idx, st, c);
    for (let depth = 1; depth <= 12; depth++) {
      const s = findStep(idx, st, { maxLevel: 2 });
      if (!s) return { c, broke: false };
      if (s.type === 'contradiction') return { c, broke: true, depth };
      applyStep(idx, st, s);
      if (st.filter((v) => v === QUEEN).length === idx.N) return { c, broke: false, solved: true };
    }
    return { c, broke: false };
  });
  const broken = res.filter((r) => r.broke);
  return broken.length === 1 && broken[0].depth <= 6 ? { wrong: broken[0].c, depth: broken[0].depth } : null;
}

let boards = 0;
const t0 = Date.now();
for (const n of SIZES) {
  for (let k = 0; k < PER_SIZE; k++) {
    const code = `TR${k}`;
    const key = `${n}-${code}`;
    const p = generatePuzzle(n, code);
    const idx = buildIndex(n, p.regions);
    const t = traceSolve(idx);
    boards++;
    const levels = t.steps.map((s) => SHORTCUT[s.shortcut].level);

    // Spot the key step: one position per skill per board.
    const used = new Set();
    t.steps.forEach((s, j) => {
      if (levels[j] < 2 || used.has(s.shortcut)) return;
      const open = s.before.filter((v) => v === OPEN).length;
      const answers = new Set(findAllSteps(idx, s.before).flatMap((d) => d.cross));
      if (answers.size / open > MAX_ANSWER_SHARE) return;
      (spot[s.shortcut] ||= []).push([key, j]);
      used.add(s.shortcut);
    });

    // Three-move trial: the first Hard/Expert impasse, if a two-way trial on
    // its tightest unit breaks one branch within six forced moves.
    const hard = levels.findIndex((l) => l >= 3);
    if (hard >= 0) {
      const st0 = t.steps[hard].before;
      const stats = unitStats(idx, st0);
      let best = -1;
      for (let u = 0; u < 3 * n; u++) if (!stats.queens[u] && stats.open[u] === 2 && (best < 0 || u >= 2 * n)) best = u;
      const out = best >= 0 && trialOutcome(idx, st0, best);
      if (out) trial.push([key, hard, best]);
    }

    // Cascade: everything after the last key step, if four or more queens remain.
    let lastKey = -1;
    levels.forEach((l, j) => { if (l >= 2) lastKey = j; });
    const queensLeft = t.steps.slice(lastKey + 1).reduce((a, s) => a + s.placed.length, 0);
    if (lastKey >= 0 && queensLeft >= 4) cascade.push([key, lastKey + 1]);

    // Opening sweep: boards that start with two or more regions in one line.
    let confined = 0;
    for (let g = 0; g < n; g++) {
      const cells = idx.unitCells[2 * n + g];
      const rows = new Set(cells.map((i) => idx.rowOf[i])), cols = new Set(cells.map((i) => idx.colOf[i]));
      if (rows.size === 1 || cols.size === 1) confined++;
    }
    if (confined >= 2 && n <= 11) opening.push(key);
  }
  process.stderr.write(`size ${n} done, ${boards} boards, ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
}

// Keep up to CAP per list, spread across sizes (round-robin by size).
function spread(list, keyOf = (x) => x[0]) {
  const bySize = {};
  for (const x of list) (bySize[keyOf(x).split('-')[0]] ||= []).push(x);
  const out = [];
  for (let i = 0; out.length < CAP; i++) {
    let added = false;
    for (const s of Object.keys(bySize)) if (bySize[s][i] && out.length < CAP) { out.push(bySize[s][i]); added = true; }
    if (!added) break;
  }
  return out;
}

const data = {
  spot: Object.fromEntries(Object.entries(spot).filter(([id]) => SHORTCUT[id].level >= 2).map(([id, l]) => [id, spread(l)])),
  trial: spread(trial),
  cascade: spread(cascade),
  opening: spread(opening, (x) => x),
};
const counts = Object.fromEntries(Object.entries(data.spot).map(([id, l]) => [id, l.length]));
writeFileSync(new URL('../js/drills-data.js', import.meta.url),
  `// Generated by tools/drills.mjs from ${boards} boards (sizes ${SIZES.join(', ')}). Do not edit by hand.\n` +
  `// Each position is a sheet key and a step number in the solver's trace.\n` +
  `export const DRILL_GENERATOR = ${GENERATOR_VERSION};\n` +
  `export const DRILLS = ${JSON.stringify(data)};\n`);
console.log(JSON.stringify({ boards, spot: counts, trial: data.trial.length, cascade: data.cascade.length, opening: data.opening.length }, null, 1));
