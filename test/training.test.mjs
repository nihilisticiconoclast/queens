// Training tests. Run with:  node --test
//
// The drill library (js/drills-data.js) names positions by sheet key and step
// number, so it silently breaks if the generator or solver changes. These
// tests regenerate a sample and check every claim the Training tab relies on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePuzzle, GENERATOR_VERSION } from '../js/generator.js?v=3';
import { buildIndex, findAllSteps, findStep, applyStep, applyQueen, OPEN, QUEEN } from '../js/solver.js?v=3';
import { SHORTCUT, traceSolve } from '../js/shortcuts.js?v=3';
import { parseKey } from '../js/rng.js?v=3';
import { DRILLS, DRILL_GENERATOR } from '../js/drills-data.js?v=3';
import { SKILLS, mastery, unlocked } from '../js/training.js?v=3';

const SAMPLE = Number(process.env.DRILL_SAMPLE || 4);
const board = (key) => {
  const { size, code } = parseKey(key, 10);
  const p = generatePuzzle(size, code);
  const idx = buildIndex(size, p.regions);
  return { p, idx, trace: traceSolve(idx), n: size };
};
const spaced = (list, k) => list.filter((_, i) => i % Math.max(1, Math.floor(list.length / k)) === 0).slice(0, k);

test('the library was built with this generator', () => {
  assert.equal(DRILL_GENERATOR, GENERATOR_VERSION);
});

test('spot positions sit just before the shortcut they drill, and guessing does not pay', () => {
  for (const [id, list] of Object.entries(DRILLS.spot)) {
    assert.ok(SHORTCUT[id].level >= 2, `${id} is a key step`);
    for (const [key, step] of spaced(list, SAMPLE)) {
      const { idx, trace } = board(key);
      const s = trace.steps[step];
      assert.equal(s?.shortcut, id, `${key} step ${step} is still a ${id}`);
      const open = s.before.filter((v) => v === OPEN).length;
      const answers = new Set(findAllSteps(idx, s.before).flatMap((d) => d.cross));
      assert.ok(answers.size / open <= 0.3, `${key}: at most 30% of open squares are answers`);
      for (const i of s.step.cross) assert.ok(answers.has(i), `${key}: the solver's own step is accepted`);
    }
  }
});

test('trial positions: exactly one of the two squares breaks within six forced moves', () => {
  for (const [key, step, unit] of spaced(DRILLS.trial, SAMPLE * 3)) {
    const { p, idx, trace, n } = board(key);
    const st0 = trace.steps[step].before;
    assert.ok(SHORTCUT[trace.steps[step].shortcut].level >= 3, `${key}: a Hard/Expert impasse`);
    const cands = idx.unitCells[unit].filter((i) => st0[i] === OPEN);
    assert.equal(cands.length, 2, `${key}: two candidates`);
    const breaks = cands.map((c) => {
      const st = Uint8Array.from(st0);
      applyQueen(idx, st, c);
      for (let d = 1; d <= 6; d++) {
        const s = findStep(idx, st, { maxLevel: 2 });
        if (!s) return false;
        if (s.type === 'contradiction') return true;
        applyStep(idx, st, s);
      }
      return false;
    });
    assert.equal(breaks.filter(Boolean).length, 1, `${key}: one branch breaks`);
    const survivor = cands[breaks.indexOf(false)];
    assert.equal(p.solution[Math.floor(survivor / n)], survivor % n, `${key}: the survivor is the answer`);
  }
});

test('cascade positions: only Easy steps remain, with four or more queens to place', () => {
  for (const [key, step] of spaced(DRILLS.cascade, SAMPLE * 3)) {
    const { trace, n } = board(key);
    const rest = trace.steps.slice(step);
    assert.ok(rest.every((s) => SHORTCUT[s.shortcut].level === 1), `${key}: nothing hard left`);
    const queensLeft = n - trace.steps[step].before.filter((v) => v === QUEEN).length;
    assert.ok(queensLeft >= 4, `${key}: ${queensLeft} queens left`);
  }
});

test('opening positions start with two or more regions in one line', () => {
  for (const key of spaced(DRILLS.opening, SAMPLE * 3)) {
    const { idx, n } = board(key);
    let confined = 0;
    for (let g = 0; g < n; g++) {
      const cells = idx.unitCells[2 * n + g];
      if (new Set(cells.map((i) => idx.rowOf[i])).size === 1 || new Set(cells.map((i) => idx.colOf[i])).size === 1) confined++;
    }
    assert.ok(confined >= 2, key);
  }
});

test('findAllSteps never contradicts the answer', () => {
  for (const key of ['9-FAS1', '11-FAS2', '13-FAS3']) {
    const { p, idx, trace, n } = board(key);
    const answer = (i) => p.solution[Math.floor(i / n)] === i % n;
    for (const s of trace.steps) {
      for (const d of findAllSteps(idx, s.before)) {
        for (const i of d.cross) assert.ok(!answer(i), `${key}: crossed an answer square`);
        for (const i of d.place) assert.ok(answer(i), `${key}: crowned a wrong square`);
      }
    }
  }
});

test('mastery follows its stated rules', () => {
  assert.equal(mastery([]).status, 'new');
  assert.equal(mastery([{ ms: 1000, t: 4000, ok: true }, { ms: 1000, t: 4000, ok: true }]).status, 'new');
  const fast = Array.from({ length: 10 }, () => ({ ms: 2000, t: 4000, ok: true }));
  assert.equal(mastery(fast).status, 'mastered');
  const sloppy = Array.from({ length: 10 }, (_, i) => ({ ms: 2000, t: 4000, ok: i < 7 }));
  assert.equal(mastery(sloppy).status, 'improving', '70% clean is not mastered');
  const slow = Array.from({ length: 10 }, () => ({ ms: 12000, t: 4000, ok: false }));
  assert.equal(mastery(slow).status, 'learning');
  const guessing = Array.from({ length: 10 }, (_, i) => ({ ms: 1500, t: 4000, ok: i < 2 }));
  assert.equal(mastery(guessing).status, 'learning', 'fast but mostly wrong is not progress');
  assert.ok(SKILLS.every((s) => s.lesson && s.name && s.level >= 1), 'every skill has a lesson');
});

test('the unlock ladder never skips a rung', () => {
  const tries = (ok, ms, t, k) => Array.from({ length: k }, () => ({ ok, ms, t }));
  const level = (L) => SKILLS.filter((s) => s.level === L);
  const cases = [
    {},
    { trial: tries(true, 3000, 8000, 5) },                              // practised a Hard skill directly
    { 'three-squeeze': tries(true, 5000, 12000, 5) },                   // practised an Expert one
    Object.fromEntries(level(2).slice(0, 3).map((s) => [s.id, tries(true, 2000, 4000, 4)])),
    { opening: tries(false, 9000, 4000, 25) },                          // lots of tries, none good
    { opening: tries(false, 9000, 4000, 45) },
  ];
  for (const stats of cases) {
    const open = (L) => level(L).every((s) => unlocked(s, stats));
    assert.ok(open(1) && open(2));
    if (open(4)) assert.ok(open(3), `Expert open but Hard shut for ${Object.keys(stats)}`);
  }
  assert.ok(!level(3).some((s) => unlocked(s, {})), 'Hard starts shut');
  assert.ok(level(4).every((s) => unlocked(s, cases[2])) && level(3).every((s) => unlocked(s, cases[2])), 'doing well at Expert opens both');
  assert.ok(level(3).every((s) => unlocked(s, cases[4])) && !level(4).some((s) => unlocked(s, cases[4])), '25 tries opens Hard only');
});
