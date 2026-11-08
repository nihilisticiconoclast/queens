// lab.js — the Solver tab. Watch a sheet solved one deduction at a time,
// easiest first, and collect the shortcuts the solver uses along the way.
//
// The Solver tab follows the sheet you're playing, but can wander off to
// another sheet (New sheet, a size, "Show me" on a shortcut card) without
// touching your game; "Back to your sheet" returns it.

import { buildIndex, OPEN } from './solver.js?v=3';
import { SHORTCUTS, SHORTCUT, traceSolve } from './shortcuts.js?v=3';
import { describeStep } from './explain.js?v=3';
import { BoardView, diagramSVG } from './board.js?v=3';
import { MIN_SIZE, MAX_SIZE, randomCode, formatKey, parseKey } from './rng.js?v=3';

const LEVEL = ['', 'Easy', 'Medium', 'Hard', 'Expert'];
const INTRO = 'The solver makes one deduction at a time, always the easiest one available, and never guesses. Press Play to watch, or Step to go at your own pace.';

// ─── The shortcut collection (kept in this browser) ────────────────────────
const STORE = 'queens.shortcuts';
const listeners = new Set();

export function foundShortcuts() {
  try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; }
}

function saveFound(found) {
  try { localStorage.setItem(STORE, JSON.stringify(found)); } catch { /* memory only */ }
}

// Record one sighting. Returns true the first time a shortcut is seen.
export function noteShortcut(id, key) {
  const found = foundShortcuts();
  const isNew = !found[id];
  found[id] = isNew ? { count: 1, key, at: Date.now() } : { ...found[id], count: found[id].count + 1 };
  saveFound(found);
  for (const fn of listeners) fn(id, isNew);
  return isNew;
}

// ─── The tab ───────────────────────────────────────────────────────────────
export function createLab(ui, hooks) {
  // hooks: makePuzzle(size, code) → Promise<puzzle>; playSheet() → puzzle;
  //        playerStart() → { ok, state, reason }; solverUsed(key)
  const view = new BoardView(ui.frame);
  let puzzle = null, idx = null, trace = null, pos = 0;
  let following = true, startMode = 'empty', playing = false, active = false;
  let playTimer = null, pending = null, loadToken = 0, counted = new Set(), lastNew = null;
  let queued = null; // a sheet to follow, waiting until the tab is opened

  // Speed slider: 0–100 maps to 2.6 s per step down to about 0.1 s.
  const stepMs = () => Math.round(2600 * Math.pow(0.04, Number(ui.speed.value) / 100));
  function showSpeed() {
    const rate = 1000 / stepMs();
    ui.speedOut.textContent = rate < 1 ? `${rate.toFixed(1)} steps a second` : `${Math.round(rate)} ${Math.round(rate) === 1 ? 'step' : 'steps'} a second`;
  }

  const stateAt = (k) => (k < trace.steps.length ? trace.steps[k].before : trace.final);
  const focusOf = (s) => s.step.units.flatMap((u) => idx.unitCells[u]);

  // ─── Painting ───
  function paint(k, { focusStep = null, think = false, delays = null } = {}) {
    view.paint({
      marks: stateAt(k),
      focus: focusStep ? focusOf(focusStep) : [],
      ghostQueens: think ? focusStep.step.place : [],
      ghostCrosses: think ? focusStep.step.cross : [],
      delays,
    });
  }

  // Marks appear as a ripple: outward from a new queen, or outward from the
  // middle of the units that justified the crosses.
  function rippleDelays(s, spread) {
    const n = puzzle.size, delays = new Float64Array(n * n);
    const changed = [...s.placed, ...s.crossed];
    let cr, cc;
    if (s.placed.length) { cr = Math.floor(s.placed[0] / n); cc = s.placed[0] % n; }
    else {
      const f = focusOf(s);
      cr = f.reduce((a, i) => a + Math.floor(i / n), 0) / f.length;
      cc = f.reduce((a, i) => a + (i % n), 0) / f.length;
    }
    const dist = (i) => Math.max(Math.abs(Math.floor(i / n) - cr), Math.abs((i % n) - cc));
    const far = Math.max(1, ...changed.map(dist));
    for (const i of s.crossed) delays[i] = Math.round((dist(i) / far) * spread);
    return delays;
  }

  // ─── Narration, counter, profile ───
  function narrate() {
    ui.newBadge.hidden = true;
    ui.summary.hidden = true;
    if (!trace) return;
    const total = trace.steps.length;
    ui.count.textContent = String(pos);
    ui.of.textContent = `of ${total} ${total === 1 ? 'step' : 'steps'}`;
    if (pos === 0) {
      ui.tag.hidden = true;
      ui.text.textContent = startMode === 'board' ? `Starting from your board. ${INTRO}` : INTRO;
    } else {
      const s = trace.steps[pos - 1];
      const sc = SHORTCUT[s.shortcut];
      ui.tag.hidden = false;
      ui.tag.textContent = sc.name;
      ui.tag.dataset.level = sc.level;
      let text = describeStep(s.step, idx, puzzle);
      if (s.step.type === 'single') text += ' That rules out its row, its column, its region and the squares around it.';
      ui.text.textContent = text;
      ui.newBadge.hidden = lastNew !== pos - 1;
    }
    if (pos === total) showSummary();
    for (const [k, bar] of [...ui.profile.children].entries()) {
      bar.classList.toggle('is-done', k < pos);
      bar.classList.toggle('is-current', k === pos - 1);
    }
    ui.back.disabled = pos === 0;
    ui.reset.disabled = pos === 0;
    ui.next.disabled = pos === total;
    ui.end.disabled = pos === total;
    ui.play.textContent = playing ? 'Pause' : pos === total ? 'Play again' : pos === 0 ? 'Play' : 'Play on';
  }

  function showSummary() {
    const counts = {};
    let hardest = null;
    for (const s of trace.steps) {
      counts[s.shortcut] = (counts[s.shortcut] || 0) + 1;
      if (!hardest || SHORTCUT[s.shortcut].level > SHORTCUT[hardest].level) hardest = s.shortcut;
    }
    const lead = trace.solved
      ? `Solved ${startMode === 'board' ? 'from your board ' : ''}in ${trace.steps.length} ${trace.steps.length === 1 ? 'step' : 'steps'}.`
      : `Stuck after ${trace.steps.length} steps: this position needs more than the solver's deductions.`;
    ui.text.textContent = hardest ? `${lead} Hardest step: ${SHORTCUT[hardest].name} (${LEVEL[SHORTCUT[hardest].level]}).` : lead;
    ui.tag.hidden = true;
    ui.summary.replaceChildren(...SHORTCUTS.filter((s) => counts[s.id]).map((s) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.dataset.level = s.level;
      chip.textContent = `${s.name} ×${counts[s.id]}`;
      return chip;
    }));
    ui.summary.hidden = false;
  }

  function buildProfile() {
    ui.profile.replaceChildren(...trace.steps.map((s, k) => {
      const sc = SHORTCUT[s.shortcut];
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'bar';
      b.dataset.level = sc.level;
      b.title = `Step ${k + 1}: ${sc.name}`;
      b.setAttribute('aria-label', `Step ${k + 1}: ${sc.name}, ${LEVEL[sc.level]}`);
      b.addEventListener('click', () => { pause(); pos = k; advance(); });
      return b;
    }));
  }

  // ─── Recording what was seen ───
  function record(k) {
    if (counted.has(k)) return;
    counted.add(k);
    if (following) hooks.solverUsed(puzzle.key);
    if (noteShortcut(trace.steps[k].shortcut, puzzle.key)) lastNew = k;
  }

  // ─── Moving through the solve ───
  function flush() {
    if (!pending) return;
    clearTimeout(pending.timer);
    const fn = pending.fn;
    pending = null;
    fn();
  }

  function advance(animated = true) {
    flush();
    if (!trace || pos >= trace.steps.length) return false;
    const s = trace.steps[pos];
    const ms = stepMs();
    const think = animated && ms >= 280 ? Math.round(ms * 0.45) : 0;
    const apply = () => {
      pos++;
      paint(pos, { focusStep: s, delays: animated ? rippleDelays(s, Math.min(ms * 0.4, 650)) : null });
      record(pos - 1);
      narrate();
    };
    if (!think) { apply(); return true; }
    // First show the reasoning: the units involved, and ghost marks where
    // the deduction will act. Then make the marks.
    paint(pos, { focusStep: s, think: true });
    ui.count.textContent = String(pos + 1);
    ui.tag.hidden = false;
    ui.tag.textContent = SHORTCUT[s.shortcut].name;
    ui.tag.dataset.level = SHORTCUT[s.shortcut].level;
    ui.newBadge.hidden = true;
    ui.summary.hidden = true;
    ui.text.textContent = describeStep(s.step, idx, puzzle);
    pending = { fn: apply, timer: setTimeout(() => { pending = null; apply(); }, think) };
    return true;
  }

  function jump(k) {
    pause();
    pos = Math.max(0, Math.min(k, trace.steps.length));
    paint(pos, { focusStep: pos > 0 ? trace.steps[pos - 1] : null });
    narrate();
  }

  function tick() {
    if (!playing) return;
    if (!advance(true)) { playing = false; narrate(); return; }
    playTimer = setTimeout(tick, stepMs());
  }

  function play() {
    if (!trace) return;
    if (pos >= trace.steps.length) jump(0);
    playing = true;
    narrate();
    tick();
  }

  function pause() {
    playing = false;
    clearTimeout(playTimer);
    flush();
    if (trace) narrate();
  }

  // ─── Sheets ───
  function computeTrace() {
    counted = new Set();
    lastNew = null;
    let start = null;
    ui.startNote.hidden = true;
    if (startMode === 'board') {
      const res = following ? hooks.playerStart() : { ok: false, reason: 'Your board is a different sheet, so the solver starts from empty.' };
      if (res.ok) start = res.state;
      else { ui.startNote.textContent = res.reason; ui.startNote.hidden = false; }
    }
    trace = traceSolve(idx, start);
    pos = 0;
    buildProfile();
    paint(0);
    narrate();
  }

  function setPuzzle(p, follow) {
    pause();
    puzzle = p;
    following = follow;
    idx = buildIndex(p.size, p.regions);
    view.build(p, { label: `Solver board, ${p.size} by ${p.size}` });
    ui.key.textContent = p.key;
    ui.difficulty.textContent = p.difficulty;
    ui.ret.hidden = following;
    ui.boardStart.disabled = !following;
    for (const b of ui.sizes.children) b.setAttribute('aria-pressed', String(Number(b.dataset.size) === p.size));
    computeTrace();
  }

  async function loadOwn(size, code) {
    const token = ++loadToken;
    pause();
    const veil = setTimeout(() => { if (token === loadToken) { ui.veil.hidden = false; ui.veilText.textContent = `Drawing sheet ${formatKey(size, code)}`; } }, 140);
    try {
      const p = await hooks.makePuzzle(size, code);
      if (token !== loadToken) return false;
      const own = hooks.playSheet();
      setPuzzle(p, !!own && own.key === p.key);
      return true;
    } catch (err) {
      console.error(err);
      return false;
    } finally {
      clearTimeout(veil);
      if (token === loadToken) ui.veil.hidden = true;
    }
  }

  // ─── Shortcut cards ───
  function renderCards(highlight = null) {
    const found = foundShortcuts();
    const list = SHORTCUTS.filter((s) => found[s.id]);
    ui.scCount.textContent = `${list.length} of ${SHORTCUTS.length} found`;
    ui.scEmpty.hidden = list.length > 0;
    ui.scForget.hidden = list.length === 0;
    ui.scCards.replaceChildren(...list.map((s) => {
      const rec = found[s.id];
      const li = document.createElement('li');
      li.className = 'card' + (s.id === highlight ? ' is-new' : '');
      li.dataset.level = s.level;
      li.id = `shortcut-${s.id}`;
      li.innerHTML = `${diagramSVG(s.diagram)}<div class="card-body"><h3>${s.name} <span class="card-level">${LEVEL[s.level]}</span></h3>` +
        `<p class="card-rule"></p><p class="card-meta"></p><button class="linkish" type="button">Show me</button></div>`;
      li.querySelector('.card-rule').textContent = s.rule;
      const meta = li.querySelector('.card-meta');
      meta.append(`Seen ${rec.count} ${rec.count === 1 ? 'time' : 'times'}. First on sheet `);
      const key = document.createElement('span');
      key.className = 'key-inline';
      key.textContent = rec.key;
      meta.append(key, '.');
      li.querySelector('button').addEventListener('click', () => showMe(s.id));
      return li;
    }));
  }

  // Replay the first use of a shortcut, from an empty board, on the sheet
  // where it was first seen.
  async function showMe(id) {
    const rec = foundShortcuts()[id];
    if (!rec) return;
    if (!puzzle || rec.key !== puzzle.key) {
      const parsed = parseKey(rec.key, 8);
      if (!parsed || !(await loadOwn(parsed.size, parsed.code))) return;
    }
    if (startMode !== 'empty') { startMode = 'empty'; ui.emptyStart.checked = true; computeTrace(); }
    const k = trace.steps.findIndex((s) => s.shortcut === id);
    ui.frame.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (k < 0) { jump(0); ui.text.textContent = `This sheet only shows ${SHORTCUT[id].name} from a part-solved board.`; return; }
    jump(k);
    setTimeout(() => advance(true), 350);
  }

  listeners.add((id, isNew) => { if (active || isNew) renderCards(isNew ? id : null); });

  // ─── Wiring ───
  for (let n = MIN_SIZE; n <= MAX_SIZE; n++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = String(n);
    b.dataset.size = String(n);
    b.setAttribute('aria-pressed', 'false');
    b.setAttribute('aria-label', `Watch a ${n} by ${n} sheet`);
    b.addEventListener('click', () => loadOwn(n, randomCode()));
    ui.sizes.appendChild(b);
  }
  ui.newSheet.addEventListener('click', () => loadOwn(puzzle ? puzzle.size : 8, randomCode()));
  ui.ret.addEventListener('click', () => { const p = hooks.playSheet(); if (p) setPuzzle(p, true); });
  ui.play.addEventListener('click', () => (playing ? pause() : play()));
  ui.next.addEventListener('click', () => { pause(); advance(true); });
  ui.back.addEventListener('click', () => jump(pos - 1));
  ui.reset.addEventListener('click', () => jump(0));
  ui.end.addEventListener('click', () => jump(trace.steps.length));
  ui.speed.addEventListener('input', showSpeed);
  for (const radio of [ui.emptyStart, ui.boardStart]) {
    radio.addEventListener('change', () => { startMode = ui.boardStart.checked ? 'board' : 'empty'; computeTrace(); });
  }
  ui.scForget.addEventListener('click', () => { saveFound({}); renderCards(); });
  document.addEventListener('keydown', (e) => {
    if (!active || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target instanceof HTMLElement && e.target.closest('input, select, textarea, button')) return;
    const keys = {
      ' ': () => (playing ? pause() : play()),
      ArrowRight: () => { pause(); advance(true); },
      ArrowLeft: () => jump(pos - 1),
      Home: () => jump(0),
      End: () => jump(trace.steps.length),
    };
    if (keys[e.key] && trace) { e.preventDefault(); keys[e.key](); }
  });
  showSpeed();
  renderCards();

  return {
    // The sheet you're playing changed: follow it unless the tab has wandered.
    follow(p) {
      if (!following && puzzle) return;
      if (active) setPuzzle(p, true);
      else queued = p; // traced when the tab is opened, not on every new game
    },
    activate() {
      active = true;
      if (queued) { const p = queued; queued = null; setPuzzle(p, true); }
      else if (following && startMode === 'board') computeTrace();
      renderCards();
    },
    deactivate() { active = false; pause(); },
    get state() { return trace && !queued && { key: puzzle.key, pos, total: trace.steps.length, playing, following, startMode, shortcut: pos ? trace.steps[pos - 1].shortcut : null }; },
  };
}
