// training.js — the Training tab. Drills that isolate one skill at a time,
// timed, with immediate feedback; a skills map that steers practice towards
// what you're weakest at; and a review of your last solve on the Play tab.

import { buildIndex, findAllSteps, findStep, applyStep, applyQueen, OPEN, CROSS, QUEEN, ROW, COL, unitType, unitNumber } from './solver.js?v=3';
import { SHORTCUTS, SHORTCUT, classifyStep, traceSolve } from './shortcuts.js?v=3';
import { describeStep, cellRef, regionName, colLetter } from './explain.js?v=3';
import { BoardView, diagramSVG, snapshotSVG } from './board.js?v=3';
import { parseKey } from './rng.js?v=3';
import { DRILLS } from './drills-data.js?v=3';
import { noteShortcut } from './lab.js?v=3';

const LEVEL = ['', 'Easy', 'Medium', 'Hard', 'Expert'];
const HELP = {
  spot: 'Tap any square the position lets you rule out. Any valid deduction counts; a wrong tap costs the clean score, not the clock.',
  named: "Tap a square this skill rules out. A square some other deduction rules out gets a nudge, not a penalty: keep looking.",
  opening: 'Tap one square in each region that lies in a single row or column. The clock stops when you have them all.',
  trial: 'Pick the square that holds the queen. The clock stops on your pick, then the wrong one is played out so you can see it fail.',
  cascade: 'Tap the square of each remaining queen, in any order. Taps on wrong squares cost the clean score.',
};
const SPOT_TARGET = { 2: 4000, 3: 8000, 4: 12000 }; // ms; 20 s at 10×10 leaves ~3.4 s per key step
const CASCADE_PER_QUEEN = 800;

// Every skill the tab can drill. Shortcut skills come from the solver's
// catalogue (Medium and harder: the steps that decide a board).
export const SKILLS = [
  { id: 'opening', name: 'Opening sweep', level: 1, kind: 'opening', target: 4000,
    lesson: 'Almost every board opens the same way: a region that sits entirely in one row or column. Find all of them before anything else. Each one clears the rest of its line.' },
  ...SHORTCUTS.filter((s) => s.level >= 2 && DRILLS.spot[s.id]?.length).map((s) => ({
    id: s.id, name: s.name, level: s.level, kind: 'spot', target: SPOT_TARGET[s.level], lesson: s.rule, diagram: s.diagram,
  })),
  { id: 'trial', name: 'Three-move trial', level: 3, kind: 'trial', target: 8000,
    lesson: "When nothing simple is left, take a unit with only two squares left. Imagine its queen on one of them and follow what's forced. If something runs out of squares, the queen is on the other one. On these boards the wrong branch usually breaks within three moves." },
  { id: 'cascade', name: 'Cascade', level: 1, kind: 'cascade', target: null,
    lesson: "After the last hard step, the rest is forced: on a typical board that's three quarters of the queens. Place them without double-checking. Each is the last square left in some row, column or region." },
];
const SKILL = Object.fromEntries(SKILLS.map((s) => [s.id, s]));

// ─── Records (kept in this browser) ────────────────────────────────────────
const STORE = 'queens.training';
const SEEN = 'queens.lessons';   // skills whose worked example has been shown
let memStats = {}, memSeen = [];
const loadStats = () => { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return memStats; } };
const saveStats = (s) => { memStats = s; try { localStorage.setItem(STORE, JSON.stringify(s)); } catch { /* memory only */ } };
const loadSeen = () => { try { return new Set(JSON.parse(localStorage.getItem(SEEN)) || []); } catch { return new Set(memSeen); } };
const saveSeen = (s) => { memSeen = [...s]; try { localStorage.setItem(SEEN, JSON.stringify([...s])); } catch { /* memory only */ } };

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

// How solid a skill is, from its last ten attempts: clean rate (no wrong taps,
// not shown) and median time against target.
export function mastery(list) {
  const recent = (list || []).slice(-10);
  if (recent.length < 3) return { status: 'new', score: 0, tries: recent.length };
  const clean = recent.filter((a) => a.ok).length / recent.length;
  const ratios = recent.filter((a) => a.ms != null && a.t).map((a) => a.ms / a.t);
  const ratio = ratios.length ? median(ratios) : 3;
  const score = 0.5 * clean + 0.5 * Math.min(1, 1 / ratio);
  // Speed only counts alongside some accuracy, so fast guessing never looks like progress.
  const status = clean >= 0.8 && ratio <= 1 ? 'mastered' : clean >= 0.6 || (ratio <= 1.5 && clean >= 0.3) ? 'improving' : 'learning';
  return { status, score, clean, ratio, tries: recent.length };
}

// Mixed practice works at the edge of ability: Hard skills join once Medium
// ones are coming along, Expert once a Hard one is.
export function unlocked(skill, stats) {
  if (skill.level <= 2) return true;
  const going = (s) => ['improving', 'mastered'].includes(mastery(stats[s.id]).status);
  const total = Object.values(stats).reduce((a, l) => a + l.length, 0);
  const hardSkillGoing = SKILLS.some((s) => s.level >= 3 && going(s));   // practised one directly
  const hard = total >= 20 || hardSkillGoing || SKILLS.filter((s) => s.level === 2 && s.kind === 'spot' && going(s)).length >= 3;
  if (skill.level === 3) return hard;
  return hard && (total >= 40 || hardSkillGoing);
}

// A wrong branch of a two-way trial: queen on c, then only Easy/Medium logic.
function collapse(idx, st0, c) {
  const st = Uint8Array.from(st0);
  applyQueen(idx, st, c);
  const frames = [Uint8Array.from(st)], forced = [];
  for (let d = 0; d < 14; d++) {
    const s = findStep(idx, st, { maxLevel: 2 });
    if (!s) return { broke: false, frames, forced };
    if (s.type === 'contradiction') return { broke: true, frames, forced, unit: s.units[0] };
    applyStep(idx, st, s);
    frames.push(Uint8Array.from(st));
    forced.push(...s.place);
    if (st.filter((v) => v === QUEEN).length === idx.N) return { broke: false, frames, forced };
  }
  return { broke: false, frames, forced };
}

const withArticle = (name) => `${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name}`;

function unitWords(idx, puzzle, u) {
  const t = unitType(idx, u), n = unitNumber(idx, u);
  if (t === ROW) return `row ${n + 1}`;
  if (t === COL) return `column ${colLetter(n)}`;
  return `the ${regionName(puzzle, n)} region`;
}

const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

export function createTraining(ui, hooks) {
  // hooks: makePuzzle(size, code, channel) → Promise<puzzle>; lastSolve() → record|null
  const view = new BoardView(ui.frame);
  const cache = new Map();   // key → Promise<{ puzzle, idx, trace }>
  const recent = [];         // recently used positions, to avoid repeats
  let item = null, phase = 'idle', active = false;
  let startAt = 0, heldMs = 0, timer = null, cursor = 0, lastSkill = null, session = [], reviewed = null, token = 0;

  // ─── Positions ───
  function loadBoard(key) {
    if (!cache.has(key)) {
      const parsed = parseKey(key, 10);
      cache.set(key, hooks.makePuzzle(parsed.size, parsed.code, `train:${key}`).then((puzzle) => {
        const idx = buildIndex(puzzle.size, puzzle.regions);
        return { puzzle, idx, trace: traceSolve(idx) };
      }));
      if (cache.size > 16) cache.delete(cache.keys().next().value);
    }
    return cache.get(key);
  }

  function choosePosition(skill) {
    const pool = skill.kind === 'spot' ? DRILLS.spot[skill.id].map((p) => ({ key: p[0], step: p[1] }))
      : skill.kind === 'trial' ? DRILLS.trial.map((p) => ({ key: p[0], step: p[1], unit: p[2] }))
        : skill.kind === 'cascade' ? DRILLS.cascade.map((p) => ({ key: p[0], step: p[1] }))
          : DRILLS.opening.map((k) => ({ key: k }));
    const fresh = pool.filter((p) => !recent.includes(`${skill.id}|${p.key}|${p.step}`));
    const pos = pick(fresh.length ? fresh : pool);
    recent.push(`${skill.id}|${pos.key}|${pos.step}`);
    if (recent.length > 30) recent.shift();
    return { skill: skill.id, kind: skill.kind, ...pos };
  }

  function chooseSpec() {
    const mode = ui.mode.value;
    if (mode === 'opening' || mode === 'trial' || mode === 'cascade') return choosePosition(SKILL[mode]);
    if (mode === 'spot') {
      const id = ui.skill.value;
      if (id === 'any') return choosePosition(pick(SKILLS.filter((s) => s.kind === 'spot')));
      return { ...choosePosition(SKILL[id]), named: true };   // only this skill's squares count
    }
    // Mixed: weight towards the weakest unlocked skills, never the same twice running.
    const stats = loadStats();
    let pool = SKILLS.filter((s) => unlocked(s, stats));
    if (pool.length > 1) pool = pool.filter((s) => s.id !== lastSkill);
    const weights = pool.map((s) => {
      const m = mastery(stats[s.id]);
      return Math.max(0.05, m.status === 'new' ? 1.1 : 1.15 - m.score);
    });
    let x = Math.random() * weights.reduce((a, b) => a + b, 0);
    for (let k = 0; k < pool.length; k++) { x -= weights[k]; if (x < 0) return choosePosition(pool[k]); }
    return choosePosition(pool[pool.length - 1]);
  }

  async function materialize(spec) {
    const { puzzle, idx, trace } = await loadBoard(spec.key);
    const it = { ...spec, puzzle, idx, trace, wrong: 0, found: new Set() };
    const n = puzzle.size;
    if (spec.kind === 'spot') {
      it.state = Uint8Array.from(trace.steps[spec.step].before);
      it.solverStep = trace.steps[spec.step];
      // Every deduction available here, named. (None is Easy: the drill
      // positions sit where the solver had nothing simpler.)
      it.deductions = findAllSteps(idx, it.state).map((d) => ({ ...d, sc: classifyStep(d, idx, it.state) }));
      it.deductions.push({ ...it.solverStep.step, sc: spec.skill });
      it.answers = new Set(it.deductions.flatMap((d) => d.cross));
      it.mine = new Set(it.deductions.filter((d) => d.sc === spec.skill).flatMap((d) => d.cross));
    } else if (spec.kind === 'opening') {
      it.state = new Uint8Array(n * n);
      it.targets = [];
      for (let g = 0; g < n; g++) {
        const cells = idx.unitCells[2 * n + g];
        if (new Set(cells.map((i) => idx.rowOf[i])).size === 1 || new Set(cells.map((i) => idx.colOf[i])).size === 1) it.targets.push(g);
      }
    } else if (spec.kind === 'trial') {
      it.state = Uint8Array.from(trace.steps[spec.step].before);
      it.cands = idx.unitCells[spec.unit].filter((i) => it.state[i] === OPEN);
      it.chains = it.cands.map((c) => collapse(idx, it.state, c));
      const sol = (i) => puzzle.solution[Math.floor(i / n)] === i % n;
      it.answer = it.cands.find(sol);
      it.wrongCand = it.cands.find((c) => !sol(c));
    } else {
      it.state = Uint8Array.from(trace.steps[spec.step].before);
      it.remaining = puzzle.solution.map((c, r) => r * n + c).filter((i) => it.state[i] !== QUEEN);
      it.total = it.remaining.length;
    }
    return it;
  }

  // ─── Clock ───
  const elapsed = () => heldMs + (timer ? performance.now() - startAt : 0);
  function runClock() {
    startAt = performance.now();
    clearInterval(timer);
    timer = setInterval(() => { ui.clock.textContent = (elapsed() / 1000).toFixed(1); }, 100);
  }
  function holdClock() {
    if (!timer) return;
    heldMs = elapsed();
    clearInterval(timer);
    timer = null;
  }
  function stopClock() {
    const ms = elapsed();
    clearInterval(timer);
    timer = null;
    heldMs = 0;
    ui.clock.textContent = (ms / 1000).toFixed(1);
    return ms;
  }

  // ─── Painting ───
  function paint(extra = {}) {
    view.paint({ marks: item.state, ...extra });
  }

  function say(text, tone = '') { ui.feedback.textContent = text; ui.feedback.dataset.tone = tone; }

  function setPrimary(label) { ui.next.textContent = label; }

  // ─── The flow ───
  async function next() {
    if (phase === 'loading') return;
    const my = ++token;
    holdClock();
    heldMs = 0;
    phase = 'loading';
    ui.lesson.hidden = true;
    ui.next.classList.add('btn--route');
    const veil = setTimeout(() => {
      if (my === token) { ui.veil.hidden = false; ui.veilText.hidden = false; ui.veilText.textContent = 'Setting up the position'; }
    }, 150);
    let it;
    try {
      it = await materialize(chooseSpec());
    } catch (err) {
      console.error(err);
      if (my === token) { phase = 'idle'; say("Couldn't set up that position. Try again."); setPrimary('Start'); }
      return;
    } finally {
      clearTimeout(veil);
    }
    if (my !== token) return;
    ui.veil.hidden = true;
    present(it);
  }

  function present(it) {
    item = it;
    lastSkill = it.skill;
    const skill = SKILL[it.skill];
    view.build(it.puzzle, { focusable: true, cursor: 0, label: `Training board, ${it.puzzle.size} by ${it.puzzle.size}` });
    cursor = 0;
    ui.name.textContent = skill.name;
    ui.level.textContent = LEVEL[skill.level];
    ui.tag.hidden = true;
    ui.result.hidden = true;
    ui.result.textContent = '';
    ui.clock.textContent = '0.0';
    ui.show.disabled = false;
    ui.show.classList.remove('is-nudged');
    setPrimary('Skip');
    if (it.kind === 'spot') {
      paint();
      ui.prompt.textContent = it.named
        ? `There's a ${skill.name} here. Tap a square it lets you cross out.`
        : 'Something here can be crossed out. Tap a square you can rule out.';
    } else if (it.kind === 'opening') {
      paint();
      ui.prompt.textContent = `Tap every region that sits entirely in one row or column. This board has ${it.targets.length}.`;
    } else if (it.kind === 'trial') {
      paint({ rings: it.cands });
      ui.prompt.textContent = `One of the two outlined squares holds ${unitWords(it.idx, it.puzzle, it.unit)}'s queen. Which one? Imagine a queen on each and follow what's forced.`;
    } else {
      paint();
      ui.prompt.textContent = `Everything left is forced. Place the last ${it.total} queens as fast as you can: tap once per queen.`;
    }
    say('');
    ui.help.textContent = HELP[it.kind === 'spot' && it.named ? 'named' : it.kind];
    const seen = loadSeen();
    if (!seen.has(it.skill) && !(loadStats()[it.skill] || []).length) {
      // First time: a worked example before the clock starts.
      seen.add(it.skill);
      saveSeen(seen);
      phase = 'intro';
      ui.lessonName.textContent = skill.name;
      ui.lessonText.textContent = skill.lesson;
      ui.lessonDiagram.innerHTML = skill.diagram ? diagramSVG(skill.diagram) : '';
      ui.lesson.hidden = false;
      ui.veil.hidden = false;
      ui.veilText.hidden = true;
      // One red button per view: while the card is up, starting is the main action.
      ui.next.classList.remove('btn--route');
      ui.show.disabled = true;
      ui.lessonGo.focus();
    } else {
      begin();
    }
  }

  function begin() {
    ui.veil.hidden = true;
    ui.lesson.hidden = true;
    ui.next.classList.add('btn--route');
    ui.show.disabled = false;
    phase = 'running';
    heldMs = 0;
    runClock();
    view.cells[cursor]?.focus({ preventScroll: true });
  }

  function finish(skillId, ms, ok, target, words) {
    phase = 'done';
    record(skillId, ms, ok, target);
    conclude(skillId, ok, words);
  }

  // The verdict on screen (recorded separately, so an animation can come between).
  function conclude(skillId, ok, { tag, result, text }) {
    ui.tag.hidden = !tag;
    if (tag) { ui.tag.textContent = tag; ui.tag.dataset.level = SKILL[skillId]?.level || SHORTCUT[skillId]?.level || 1; }
    ui.result.hidden = !result;
    ui.result.textContent = result || '';
    say(text, ok ? 'good' : '');
    ui.show.disabled = true;
    setPrimary('Next');
    ui.next.focus({ preventScroll: true });
  }

  function settle() {
    ui.show.disabled = true;
    setPrimary('Next');
    say('');
  }

  function verdict(ms, target) {
    if (!target) return secs(ms);
    return ms <= target ? `${secs(ms)}, under the ${secs(target)} target` : `${secs(ms)} (target ${secs(target)})`;
  }

  function flashWrong(i) {
    const el = view.cells[i];
    el.classList.remove('is-wrong');
    void el.offsetWidth;
    el.classList.add('is-wrong');
    setTimeout(() => el.classList.remove('is-wrong'), 600);
    item.wrong++;
    if (item.wrong >= 3) ui.show.classList.add('is-nudged');
  }

  // ─── Answers ───
  function tap(i) {
    if (phase !== 'running' || !item) return;
    const it = item, n = it.puzzle.size, ref = cellRef(i, n);
    if (it.kind === 'spot') {
      if (it.state[i] !== OPEN) { say(`${ref} is already ruled out.`); return; }
      if (!it.answers.has(i)) { flashWrong(i); say(`Nothing rules out ${ref} yet.`); return; }
      const covering = it.deductions.filter((d) => d.cross.includes(i));
      if (it.named && !it.mine.has(i)) {
        // Sound, but not the skill being drilled: no penalty, keep looking.
        say(`True, ${ref} can go, but that's ${withArticle(SHORTCUT[covering[0].sc].name)}, not ${withArticle(SKILL[it.skill].name)}. Keep looking.`);
        return;
      }
      const ms = stopClock();
      // Credit the drilled skill when it explains the square, else the easiest deduction that does.
      const d = covering.find((c) => c.sc === it.skill) || [...covering].sort((a, b) => SHORTCUT[a.sc].level - SHORTCUT[b.sc].level)[0];
      const sc = d.sc;
      noteShortcut(sc, it.key);
      const credited = SKILL[sc] ? sc : it.skill;
      const target = SKILL[credited].target;
      item.state = Uint8Array.from(it.state);
      item.state[i] = CROSS;
      paint({ focus: d.units.flatMap((u) => it.idx.unitCells[u]), ghostCrosses: d.cross.filter((x) => x !== i) });
      let text = describeStep(d, it.idx, it.puzzle);
      if (sc !== it.skill) text += ` There was ${withArticle(SKILL[it.skill].name)} here too.`;
      finish(credited, ms, it.wrong === 0, target, { tag: SHORTCUT[sc].name, result: verdict(ms, target), text });
    } else if (it.kind === 'opening') {
      const g = it.puzzle.regions[i];
      if (it.found.has(g)) return;
      if (!it.targets.includes(g)) { flashWrong(i); say(`The ${regionName(it.puzzle, g)} region spans more than one row and more than one column.`); return; }
      it.found.add(g);
      paintOpening();
      if (it.found.size < it.targets.length) { say(`${it.found.size} of ${it.targets.length}.`); return; }
      const ms = stopClock();
      finish('opening', ms, it.wrong === 0, SKILL.opening.target, {
        tag: 'Opening sweep', result: verdict(ms, SKILL.opening.target),
        text: `All ${it.targets.length} found. Each clears the rest of its line, and on most boards that's the whole opening.`,
      });
    } else if (it.kind === 'trial') {
      if (!it.cands.includes(i)) { say('Choose one of the two outlined squares.'); return; }
      const ms = stopClock();
      const ok = i === it.answer;
      phase = 'done';
      record('trial', ms, ok && it.wrong === 0, SKILL.trial.target);   // counted now; the replay is just to watch
      settle();
      playCollapse(it, ok ? it.wrongCand : i, () => conclude('trial', ok, {
        tag: 'Three-move trial', result: ok ? verdict(ms, SKILL.trial.target) : 'Not that one',
        text: collapseText(it, ok ? it.wrongCand : i, ok),
      }));
    } else {
      if (it.state[i] === QUEEN) return;
      if (!it.remaining.includes(i)) {
        flashWrong(i);
        say(it.state[i] === CROSS ? `${ref} is already ruled out.` : `${ref} isn't one of them. Look for a row, column or region down to one square.`);
        return;
      }
      applyQueen(it.idx, it.state, i);
      it.remaining = it.remaining.filter((x) => x !== i);
      paint();
      if (it.remaining.length) { say(`${it.total - it.remaining.length} of ${it.total}.`); return; }
      const ms = stopClock();
      const target = CASCADE_PER_QUEEN * it.total;
      finish('cascade', ms, it.wrong === 0, target, {
        tag: 'Cascade', result: verdict(ms, target),
        text: `${it.total} queens in ${secs(ms)}: ${secs(ms / it.total)} each.`,
      });
    }
  }

  function paintOpening(all = false) {
    const it = item, n = it.puzzle.size, idx = it.idx;
    const shown = all ? new Set(it.targets) : it.found;
    const focus = [], ghosts = [];
    for (const g of shown) {
      const cells = idx.unitCells[2 * n + g];
      focus.push(...cells);
      const rows = new Set(cells.map((i) => idx.rowOf[i]));
      const line = rows.size === 1 ? idx.unitCells[idx.rowOf[cells[0]]] : idx.unitCells[n + idx.colOf[cells[0]]];
      ghosts.push(...line.filter((x) => idx.regOf[x] !== g));
    }
    paint({ focus, ghostCrosses: ghosts });
  }

  // Animate the wrong branch of a trial breaking: imagined marks in teal.
  function playCollapse(it, cand, done) {
    const chain = it.chains[it.cands.indexOf(cand)];
    const base = it.state;
    const frames = chain.frames;
    const my = token;
    let k = 0;
    const show = () => {
      if (my !== token) return;   // moved on: the replay stops
      const st = frames[k];
      const ghostQueens = [], ghostCrosses = [];
      for (let i = 0; i < st.length; i++) {
        if (st[i] === QUEEN && base[i] !== QUEEN) ghostQueens.push(i);
        else if (st[i] === CROSS && base[i] === OPEN) ghostCrosses.push(i);
      }
      const last = k === frames.length - 1;
      paint({ ghostQueens, ghostCrosses, rings: [cand], focus: last && chain.unit != null ? it.idx.unitCells[chain.unit] : [] });
      // Narrate as it goes: the habit being taught is following the chain.
      const n = it.puzzle.size;
      const sofar = chain.forced.filter((i) => st[i] === QUEEN).map((i) => cellRef(i, n));
      const end = chain.unit != null ? `${unitWords(it.idx, it.puzzle, chain.unit)} has no squares left.` : 'the board jams.';
      let words = `Imagine a queen on ${cellRef(cand, n)}`;
      if (sofar.length) words += `: it forces ${sofar.join(', then ')}${last ? `, and then ${end}` : '…'}`;
      else words += last ? `: after a few crossings, ${end}` : '…';
      say(words);
      if (!last) { k++; setTimeout(show, 520); }
      else setTimeout(() => {
        if (my !== token) return;
        item.state = Uint8Array.from(base);
        applyQueen(it.idx, item.state, it.answer);
        paint({ rings: [it.answer], focus: chain.unit != null ? it.idx.unitCells[chain.unit] : [] });
        done();
      }, 900);
    };
    show();
  }

  function collapseText(it, cand, ok) {
    const chain = it.chains[it.cands.indexOf(cand)];
    const n = it.puzzle.size;
    const forced = chain.forced.map((i) => cellRef(i, n));
    const unit = chain.unit != null ? unitWords(it.idx, it.puzzle, chain.unit) : null;
    const runs = unit ? `${unit} has no squares left` : 'the board jams';
    // With no forced queens the break comes through crossings alone (never at once:
    // that would have been a Medium step, and these positions have none).
    const middle = forced.length
      ? `A queen on ${cellRef(cand, n)} forces ${forced.join(', then ')}, and then ${runs}`
      : `With a queen on ${cellRef(cand, n)}, a few crossings later ${runs}`;
    return `${ok ? 'Right. ' : ''}${middle}. So the queen is on ${cellRef(it.answer, n)}.`;
  }

  function showMe() {
    if (phase !== 'running' || !item) return;
    const it = item, ms = stopClock();
    const skill = SKILL[it.skill];
    if (it.kind === 'spot') {
      const s = it.solverStep;
      noteShortcut(s.shortcut, it.key);
      paint({ focus: s.step.units.flatMap((u) => it.idx.unitCells[u]), ghostCrosses: s.step.cross });
      finish(it.skill, null, false, skill.target, { tag: SHORTCUT[s.shortcut].name, result: 'Shown', text: describeStep(s.step, it.idx, it.puzzle) });
    } else if (it.kind === 'opening') {
      paintOpening(true);
      finish('opening', null, false, skill.target, { tag: 'Opening sweep', result: 'Shown', text: `These ${it.targets.length} regions each sit in one line, so each clears the rest of it.` });
    } else if (it.kind === 'trial') {
      phase = 'done';
      record('trial', null, false, skill.target);
      settle();
      playCollapse(it, it.wrongCand, () => conclude('trial', false, { tag: 'Three-move trial', result: 'Shown', text: collapseText(it, it.wrongCand, false) }));
    } else {
      for (const i of it.remaining) applyQueen(it.idx, it.state, i);
      paint({ ghostQueens: [] });
      finish('cascade', null, false, CASCADE_PER_QUEEN * it.total, { tag: 'Cascade', result: 'Shown', text: 'Each of those was the last square left in some row, column or region.' });
    }
    void ms;
  }

  // ─── Records, session, skills map ───
  function record(skillId, ms, ok, target) {
    const stats = loadStats();
    const list = (stats[skillId] ||= []);
    list.push({ ms: ms == null ? null : Math.round(ms), t: target, ok, at: Date.now() });
    if (list.length > 30) list.splice(0, list.length - 30);
    saveStats(stats);
    session.push({ skillId, ms, ok });
    renderSession();
    renderSkills();
  }

  function renderSession() {
    if (!session.length) { ui.session.textContent = 'No drills yet this session.'; return; }
    const clean = session.filter((s) => s.ok).length;
    const med = median(session.filter((s) => s.ms != null).map((s) => s.ms));
    ui.session.textContent = `This session: ${session.length} ${session.length === 1 ? 'drill' : 'drills'}, ${clean} clean${med != null ? `, median ${secs(med)}` : ''}.`;
  }

  const STATUS_WORDS = { new: 'New', learning: 'Learning', improving: 'Improving', mastered: 'Mastered' };

  function renderSkills() {
    const stats = loadStats();
    let mastered = 0;
    ui.skillList.replaceChildren(...SKILLS.map((s) => {
      const list = stats[s.id] || [];
      const m = mastery(list);
      if (m.status === 'mastered') mastered++;
      const li = document.createElement('li');
      li.className = 'skill';
      li.dataset.status = m.status;
      li.dataset.level = s.level;
      const recentList = list.slice(-10);
      const times = list.filter((a) => a.ms != null).slice(-10).map((a) => a.ms);
      const med = median(times);
      const target = s.target ? secs(s.target) : `${secs(CASCADE_PER_QUEEN)} a queen`;
      li.innerHTML = `<div class="skill-name"><strong></strong> <span class="card-level"></span></div>
        <span class="pill"></span>
        <span class="skill-stat"></span>
        <span class="mini" aria-hidden="true"></span>
        <button class="linkish" type="button">Practise</button>`;
      li.querySelector('strong').textContent = s.name;
      li.querySelector('.card-level').textContent = LEVEL[s.level] + (unlocked(s, stats) ? '' : ', joins Mixed later');
      li.querySelector('.pill').textContent = STATUS_WORDS[m.status];
      li.querySelector('.skill-stat').textContent = list.length
        ? `${list.length} ${list.length === 1 ? 'try' : 'tries'}, ${Math.round(100 * (m.clean ?? list.filter((a) => a.ok).length / list.length))}% clean, median ${med != null ? secs(med) : '–'} (target ${target})`
        : `Not tried yet (target ${target})`;
      const mini = li.querySelector('.mini');
      for (const a of recentList) {
        const bar = document.createElement('i');
        const h = a.ms == null ? 1 : Math.min(1, a.ms / (2 * (a.t || 4000)));
        bar.style.setProperty('--h', Math.max(0.12, h).toFixed(2));
        bar.className = a.ok ? 'ok' : 'miss';
        mini.appendChild(bar);
      }
      li.querySelector('button').addEventListener('click', () => practise(s.id));
      return li;
    }));
    const tried = SKILLS.filter((s) => (stats[s.id] || []).length).length;
    ui.skillCount.textContent = `${mastered} of ${SKILLS.length} mastered, ${tried} tried`;
    ui.skillReset.hidden = tried === 0;
  }

  function practise(id) {
    const s = SKILL[id];
    if (s.kind === 'spot') { ui.mode.value = 'spot'; ui.skill.value = id; }
    else ui.mode.value = s.kind;
    syncMode();
    ui.frame.scrollIntoView({ behavior: 'smooth', block: 'center' });
    next();
  }

  // ─── Review of the last solve ───
  async function renderReview() {
    const rec = hooks.lastSolve();
    if (!rec || !rec.log?.length) { ui.rvEmpty.hidden = false; ui.rvBody.hidden = true; ui.rvMeta.textContent = ''; return; }
    if (reviewed === rec.id) return;
    reviewed = rec.id;
    let board;
    try { board = await loadBoard(rec.key); } catch { return; }
    const { puzzle, idx } = board;
    const n = puzzle.size;
    // When did each queen of the answer arrive (its last placement)?
    const arrivals = puzzle.solution.map((c, r) => {
      const i = r * n + c;
      let t = null;
      for (const [tm, cell, to] of rec.log) if (cell === i && to === 2) t = tm;
      return { i, t };
    }).filter((a) => a.t != null).sort((a, b) => a.t - b.t);
    if (arrivals.length < n) { ui.rvEmpty.hidden = false; ui.rvBody.hidden = true; return; }
    const st = new Uint8Array(n * n);
    let prev = 0;
    const queens = arrivals.map((a, k) => {
      const gap = a.t - prev;
      prev = a.t;
      // What would have unlocked this queen from the queens already down?
      const trace = traceSolve(idx, st);
      const j = trace.steps.findIndex((s) => s.placed.includes(a.i));
      const path = j >= 0 ? trace.steps.slice(0, j + 1) : [];
      const unlock = path.reduce((best, s) => (!best || SHORTCUT[s.shortcut].level > SHORTCUT[best.shortcut].level ? s : best), null);
      applyQueen(idx, st, a.i);
      return { k, i: a.i, gap, unlock };
    });
    const total = rec.time || arrivals[arrivals.length - 1].t;
    const max = Math.max(...queens.map((q) => q.gap));
    const slow = [...queens].sort((a, b) => b.gap - a.gap).slice(0, 3);
    ui.rvMeta.textContent = `Sheet ${rec.key}, ${secs(total)}`;
    ui.rvSplits.replaceChildren(...queens.map((q) => {
      const b = document.createElement('span');
      b.className = 'split' + (slow.includes(q) ? ' is-slow' : '');
      b.style.setProperty('--h', Math.max(0.06, q.gap / max).toFixed(3));
      b.title = `Queen ${q.k + 1} (${cellRef(q.i, n)}): ${secs(q.gap)}`;
      return b;
    }));
    ui.rvSummary.textContent = `Bars are your queens in the order you placed them; height is the time each took. The slowest took ${secs(slow[0].gap)}, ${Math.round((100 * slow[0].gap) / total)}% of the solve.`;
    ui.rvCards.replaceChildren(...slow.map((q) => {
      const u = q.unlock;
      const li = document.createElement('li');
      li.className = 'card review-card';
      const sc = u ? SHORTCUT[u.shortcut] : null;
      li.innerHTML = `${u ? snapshotSVG(puzzle, u.before, { focus: u.step.units.flatMap((x) => idx.unitCells[x]), ghostCrosses: u.step.cross, ghostQueens: u.step.place }) : ''}
        <div class="card-body"><h3></h3><p class="card-rule"></p><p class="card-meta"></p></div>`;
      li.querySelector('h3').textContent = `Queen ${q.k + 1}: ${secs(q.gap)}`;
      li.querySelector('.card-rule').textContent = sc
        ? `The way in was ${sc.level >= 2 ? withArticle(sc.name) : `an easy ${sc.name}`}. ${describeStep(u.step, idx, puzzle)}`
        : 'This queen followed directly.';
      const drill = !sc ? null : SKILL[u.shortcut] ? u.shortcut : u.shortcut === 'region-in-line' ? 'opening' : 'cascade';
      if (drill) {
        const btn = document.createElement('button');
        btn.className = 'linkish';
        btn.type = 'button';
        btn.textContent = `Practise ${SKILL[drill].name}`;
        btn.addEventListener('click', () => practise(drill));
        li.querySelector('.card-meta').append(btn);
      }
      return li;
    }));
    ui.rvEmpty.hidden = true;
    ui.rvBody.hidden = false;
  }

  // ─── Wiring ───
  function syncMode() { ui.skillField.hidden = ui.mode.value !== 'spot'; }

  ui.skill.replaceChildren(new Option('Any key step', 'any'),
    ...SKILLS.filter((s) => s.kind === 'spot').map((s) => new Option(`${s.name} (${LEVEL[s.level]})`, s.id)));
  ui.mode.addEventListener('change', () => { syncMode(); if (phase === 'running') next(); });
  ui.skill.addEventListener('change', () => { if (phase === 'running') next(); });
  ui.next.addEventListener('click', () => next());
  ui.show.addEventListener('click', showMe);
  ui.lessonGo.addEventListener('click', begin);
  ui.skillReset.addEventListener('click', () => { saveStats({}); saveSeen(new Set()); session = []; renderSession(); renderSkills(); });

  ui.board.addEventListener('click', (e) => {
    const i = view.cells.indexOf(e.target.closest('.cell'));
    if (i >= 0) { cursor = i; tap(i); }
  });
  ui.board.addEventListener('keydown', (e) => {
    if (!item || e.ctrlKey || e.metaKey || e.altKey) return;
    const n = item.puzzle.size, r = Math.floor(cursor / n), c = cursor % n;
    const go = (rr, cc) => {
      e.preventDefault();
      view.cells[cursor].tabIndex = -1;
      cursor = Math.max(0, Math.min(n - 1, rr)) * n + Math.max(0, Math.min(n - 1, cc));
      view.cells[cursor].tabIndex = 0;
      view.cells[cursor].focus();
    };
    if (e.key === 'ArrowUp') go(r - 1, c);
    else if (e.key === 'ArrowDown') go(r + 1, c);
    else if (e.key === 'ArrowLeft') go(r, c - 1);
    else if (e.key === 'ArrowRight') go(r, c + 1);
    else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); tap(cursor); }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && phase === 'running') holdClock(); else if (!document.hidden && active && phase === 'running' && !timer) runClock(); });

  syncMode();
  renderSession();
  renderSkills();

  return {
    activate() {
      active = true;
      renderSkills();
      renderReview();
      if (phase === 'running' && !timer) runClock();
    },
    deactivate() { active = false; if (phase === 'running') holdClock(); },
    showReview() { ui.review.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
    refreshReview() { reviewed = null; if (active) renderReview(); },
    get state() { return { phase, kind: item?.kind || null, skill: item?.skill || null, key: item?.key || null, wrong: item?.wrong || 0, session: session.length }; },
    // For tests: where the answers are.
    get debug() { return item && { answers: item.answers ? [...item.answers] : null, mine: item.mine ? [...item.mine] : null, named: !!item.named, targets: item.targets || null, cands: item.cands || null, answer: item.answer ?? null, remaining: item.remaining || null, regions: item.puzzle.regions }; },
  };
}
