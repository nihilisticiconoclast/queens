// game.js — the page: the Play tab (board, marking, clock, sheets, hints,
// saved progress) and the switch to the Solver tab (lab.js).

import { MIN_SIZE, MAX_SIZE, randomCode, parseKey, formatKey } from './rng.js?v=3';
import { buildIndex, findStep, applyQueen, CROSS } from './solver.js?v=3';
import { describeStep, describeClash, cellRef } from './explain.js?v=3';
import { classifyStep, SHORTCUT } from './shortcuts.js?v=3';
import { BoardView } from './board.js?v=3';
import { createLab, noteShortcut } from './lab.js?v=3';
import { createTraining } from './training.js?v=3';

const EMPTY = 0, X = 1, Q = 2;                 // what the player has put on a square
const cycle = (m) => (m + 1) % 3;              // tap: empty → cross → queen → empty
const DEFAULT_MESSAGE = 'One queen in every row, column and colour. Queens may not touch, not even at the corners.';

// ─── Storage (never fatal: private modes can refuse it) ────────────────────
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* memory only */ }
  },
};

const settings = Object.assign({ size: 8, autoCross: false }, store.get('queens.settings', {}));
if (!(settings.size >= MIN_SIZE && settings.size <= MAX_SIZE)) settings.size = 8;
const records = store.get('queens.records', {});
const saveSettings = () => store.set('queens.settings', settings);

// ─── DOM ───────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const ui = {
  frame: $('board-frame'), board: $('board'), colRefs: $('refs-cols'), rowRefs: $('refs-rows'),
  veil: $('veil'), veilText: $('veil-text'), veilBtn: $('veil-btn'), stamp: $('stamp'), stampTime: $('stamp-time'),
  message: $('message'), clock: $('clock'), pause: $('pause'), key: $('sheet-key'), difficulty: $('difficulty'),
  copy: $('copy'), sizes: $('sizes'), newBtn: $('new'), openForm: $('open-form'), openInput: $('sheet-input'),
  openError: $('open-error'), undo: $('undo'), redo: $('redo'), clear: $('clear'), hint: $('hint'),
  auto: $('auto'), bestLabel: $('best-label'), best: $('best'), solvedLabel: $('solved-label'), solvedCount: $('solved-count'),
  tabs: { play: $('tab-play'), solver: $('tab-solver'), training: $('tab-training') },
  panels: { play: $('panel-play'), solver: $('panel-solver'), training: $('panel-training') },
  reviewLink: $('review-link'),
};
const playView = new BoardView(ui.frame);

// ─── Game state ────────────────────────────────────────────────────────────
let puzzle = null, idx = null, marks = null, cells = [];
let undoStack = [], redoStack = [];
let elapsed = 0, runningSince = null, ticker = null, lastAutosave = 0;
let solved = false, paused = false, loading = false, hintsUsed = 0, hint = null;
let cursor = 0, loadToken = 0, drag = null;
// Help that disqualifies a solve from records: the solver was watched on
// this sheet, or it's a replay of a sheet already solved.
let helped = { solver: false, replay: false };
let tab = 'play', clockWasRunning = false;
// Every change to the board with the puzzle-clock time it happened, so the
// Training tab can review where a solve's time went.
let moveLog = [];
const MAX_LOG = 1500;
function logChanges(changes, revert = false) {
  const t = Math.round(elapsedNow());
  for (const [i, from, to] of changes) moveLog.push([t, i, revert ? from : to]);
  if (moveLog.length > MAX_LOG) moveLog.splice(0, moveLog.length - MAX_LOG);
}

const N = () => puzzle.size;
const canPlay = () => puzzle && !solved && !paused && !loading;

// Inside an embedded viewer the page's own URL isn't the one people share,
// so "Copy link" copies the bare sheet key instead.
const framed = (() => { try { return window.self !== window.top; } catch { return true; } })();

// The sheet key lives in the address after a # (10-K7Q2MX is a valid
// fragment). Older ?seed= links still open.
function keyFromAddress() {
  let hash = '';
  try { hash = decodeURIComponent(location.hash.slice(1)); } catch { /* malformed */ }
  return hash || new URLSearchParams(location.search).get('seed');
}

function writeKeyToAddress(key) {
  try {
    if (location.search) history.replaceState(null, '', location.pathname + location.hash);
    if (keyFromAddress() !== key) location.replace(`#${key}`);
  } catch { /* some sandboxes refuse */ }
}

// ─── Puzzle generation: a Web Worker, or the main thread as a fallback ─────
let worker = null, workerBroken = false, requestId = 0;
const pending = new Map();

function mainThread(size, code) {
  return import('./generator.js?v=3').then((m) => m.generatePuzzle(size, code));
}

// Each tab asks on its own channel. A newer request on a channel supersedes
// that channel's request in flight (the worker is restarted and the other
// channel's work is sent again), so neither tab can cancel the other's.
function makePuzzle(size, code, channel = 'play') {
  if (!workerBroken && worker) {
    const stale = [...pending].filter(([, job]) => job.channel === channel);
    if (stale.length) {
      worker.terminate();
      worker = null;
      for (const [id] of stale) pending.delete(id);
    }
  }
  if (!workerBroken && !worker) {
    try {
      worker = new Worker(new URL('./worker.js?v=3', import.meta.url), { type: 'module' });
      for (const [id, job] of pending) worker.postMessage({ id, size: job.size, code: job.code });
      worker.onmessage = ({ data }) => {
        const job = pending.get(data.id);
        if (!job) return;
        pending.delete(data.id);
        if (data.error) job.reject(new Error(data.error));
        else job.resolve(data.puzzle);
      };
      worker.onerror = (e) => {
        e.preventDefault?.();
        workerBroken = true;
        worker?.terminate();
        worker = null;
        const jobs = [...pending.values()];
        pending.clear();
        for (const job of jobs) mainThread(job.size, job.code).then(job.resolve, job.reject);
      };
    } catch {
      workerBroken = true;
      worker = null;
    }
  }
  if (workerBroken || !worker) return mainThread(size, code);
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    pending.set(id, { resolve, reject, size, code, channel });
    worker.postMessage({ id, size, code });
  });
}

// ─── Loading a sheet ───────────────────────────────────────────────────────
async function load(size, code, restore = null) {
  const token = ++loadToken;
  const key = formatKey(size, code);
  stopClock();
  loading = true;
  ui.openError.hidden = true;
  const veilTimer = setTimeout(() => { if (token === loadToken) showVeil(`Drawing sheet ${key}`, false); }, 140);
  let p;
  try {
    p = await makePuzzle(size, code);
  } catch (err) {
    if (token !== loadToken) return;
    clearTimeout(veilTimer);
    loading = false;
    if (paused) showVeil('Paused', true);
    else hideVeil();
    setMessage(`Couldn't draw sheet ${key}. Try another key.`);
    console.error(err);
    if (puzzle && !solved && !paused) startClock();
    return;
  }
  if (token !== loadToken) return;
  clearTimeout(veilTimer);
  loading = false;
  hideVeil();
  startGame(p, restore);
}

function startGame(p, restore) {
  puzzle = p;
  idx = buildIndex(p.size, p.regions);
  marks = new Uint8Array(p.size * p.size);
  if (restore && typeof restore.marks === 'string' && restore.marks.length === marks.length) {
    for (let i = 0; i < marks.length; i++) marks[i] = Math.min(2, Number(restore.marks[i]) || 0);
  }
  undoStack = []; redoStack = [];
  hint = null; solved = false; paused = false;
  elapsed = restore?.elapsed > 0 ? restore.elapsed : 0;
  hintsUsed = restore?.hints > 0 ? restore.hints : 0;
  helped = { solver: !!restore?.helped?.solver, replay: !!restore?.helped?.replay };
  moveLog = Array.isArray(restore?.log) ? restore.log.slice(-MAX_LOG) : [];
  ui.reviewLink.hidden = true;
  settings.size = p.size;
  saveSettings();
  cursor = 0;
  ui.stamp.hidden = true;
  ui.stamp.classList.remove('is-in');
  ui.pause.textContent = 'Pause';
  buildBoard();
  showSheet();
  render();
  startClock();
  // A game restored mid-way, or one that finished loading in a background
  // tab, starts paused: the clock only runs while you can see the board.
  if ((restore && marks.some((m) => m !== EMPTY)) || document.hidden) pauseGame();
  if (tab !== 'play') { clockWasRunning = runningSince != null; stopClock(); }
  saveGame();
  lab.follow(p);
}

// ─── Building the board ────────────────────────────────────────────────────
function buildBoard() {
  const n = N();
  playView.build(puzzle, { focusable: true, cursor, label: `Queens board, ${n} by ${n}. Arrow keys move; space marks a square.` });
  cells = playView.cells;
}

// ─── Rendering ─────────────────────────────────────────────────────────────
function conflicts() {
  const n = N(), clash = new Uint8Array(n * n), issues = [];
  for (let u = 0; u < 3 * n; u++) {
    const qs = idx.unitCells[u].filter((i) => marks[i] === Q);
    if (qs.length > 1) {
      for (const i of idx.unitCells[u]) clash[i] = 1;
      issues.push({ kind: 'unit', unit: u, cells: qs });
    }
  }
  for (let i = 0; i < n * n; i++) {
    if (marks[i] !== Q) continue;
    for (const j of idx.diag[i]) {
      if (j > i && marks[j] === Q) { clash[i] = clash[j] = 1; issues.push({ kind: 'touch', cells: [i, j] }); }
    }
  }
  return { clash, issues };
}

function autoCrosses() {
  const n = N(), out = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) if (marks[i] === Q) for (const j of idx.attacks[i]) out[j] = 1;
  return out;
}

function render() {
  if (!puzzle) return;
  const { clash, issues } = conflicts();
  const h = hint || { focus: [], place: [], cross: [], ring: [] };
  playView.paint({
    marks,
    auto: settings.autoCross ? autoCrosses() : null,
    clash,
    focus: h.focus,
    ghostQueens: h.place,
    ghostCrosses: h.cross,
    rings: h.ring,
  });
  ui.undo.disabled = !undoStack.length || !canPlay();
  ui.redo.disabled = !redoStack.length || !canPlay();
  ui.hint.disabled = !canPlay();
  ui.clear.textContent = solved ? 'Replay' : 'Clear';
  ui.clear.disabled = loading || paused || (!solved && !marks.some((m) => m !== EMPTY));
  if (!solved && !hint) setMessage(issues.length ? describeClash(issues[0], idx, puzzle) : DEFAULT_MESSAGE);
}

function setMessage(text, tone = '') {
  ui.message.textContent = text;
  ui.message.dataset.tone = tone;
}

function showSheet() {
  const n = N();
  ui.key.textContent = puzzle.key;
  ui.difficulty.textContent = puzzle.difficulty;
  ui.difficulty.title = `Hardest deduction needed: ${puzzle.difficulty.toLowerCase()}`;
  for (const b of ui.sizes.children) b.setAttribute('aria-pressed', String(Number(b.dataset.size) === n));
  showRecord();
  writeKeyToAddress(puzzle.key);
  document.title = `Queens · ${puzzle.key}`;
}

function showRecord() {
  const n = N(), rec = records[n] || {};
  ui.bestLabel.textContent = `Best ${n} × ${n}`;
  ui.best.textContent = rec.best != null ? formatTime(rec.best) : '—';
  ui.solvedLabel.textContent = `Solved at ${n} × ${n}`;
  ui.solvedCount.textContent = String(rec.solved || 0);
}

// ─── Moves, undo, redo ─────────────────────────────────────────────────────
function setMark(i, to, changes) {
  const from = marks[i];
  if (from === to) return;
  marks[i] = to;
  changes.push([i, from, to]);
}

function commit(changes) {
  if (!changes.length) return;
  logChanges(changes);
  undoStack.push(changes);
  redoStack = [];
  afterChange();
}

function afterChange() {
  hint = null;
  render();
  checkWin();
  saveGame();
}

function undo() {
  if (!canPlay() || !undoStack.length) return;
  const ch = undoStack.pop();
  for (let k = ch.length - 1; k >= 0; k--) marks[ch[k][0]] = ch[k][1];
  logChanges(ch, true);
  redoStack.push(ch);
  afterChange();
}

function redo() {
  if (!canPlay() || !redoStack.length) return;
  const ch = redoStack.pop();
  for (const [i, , to] of ch) marks[i] = to;
  logChanges(ch);
  undoStack.push(ch);
  afterChange();
}

function clearBoard() {
  if (solved) {                       // "Replay": same sheet, fresh clock
    const ch = [];
    for (let i = 0; i < marks.length; i++) setMark(i, EMPTY, ch);
    undoStack = []; redoStack = [];
    solved = false; elapsed = 0; hintsUsed = 0; hint = null;
    helped.replay = true;
    moveLog = [];
    ui.reviewLink.hidden = true;
    ui.board.classList.remove('is-solved');
    ui.stamp.hidden = true;
    ui.stamp.classList.remove('is-in');
    render();
    startClock();
    saveGame();
    return;
  }
  if (!canPlay()) return;
  const ch = [];
  for (let i = 0; i < marks.length; i++) setMark(i, EMPTY, ch);
  commit(ch);
}

// ─── Pointer input: tap cycles a square, drag crosses out a path ───────────
function cellAt(e) {
  const rect = ui.board.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return -1;
  const n = N();
  return Math.floor((y / rect.height) * n) * n + Math.floor((x / rect.width) * n);
}

// Squares on the straight path from a to b (excluding a), so fast drags leave no gaps.
function pathCells(a, b) {
  const n = N();
  let r0 = Math.floor(a / n), c0 = a % n;
  const r1 = Math.floor(b / n), c1 = b % n;
  const dr = Math.abs(r1 - r0), dc = Math.abs(c1 - c0), sr = r0 < r1 ? 1 : -1, sc = c0 < c1 ? 1 : -1;
  let err = dc - dr;
  const out = [];
  while (r0 !== r1 || c0 !== c1) {
    const e2 = 2 * err;
    if (e2 > -dr) { err -= dr; c0 += sc; }
    if (e2 < dc) { err += dc; r0 += sr; }
    out.push(r0 * n + c0);
  }
  return out;
}

function paint(i) {
  if (drag.mode === X && marks[i] === EMPTY) setMark(i, X, drag.changes);
  else if (drag.mode === EMPTY && marks[i] === X) setMark(i, EMPTY, drag.changes);
}

ui.board.addEventListener('pointerdown', (e) => {
  if (!canPlay() || (e.pointerType === 'mouse' && e.button !== 0)) return;
  const i = cellAt(e);
  if (i < 0) return;
  e.preventDefault();
  ui.board.setPointerCapture?.(e.pointerId);
  drag = { id: e.pointerId, start: i, last: i, moved: false, mode: null, changes: [] };
  moveCursor(i, false);
});

ui.board.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const i = cellAt(e);
  if (i < 0 || i === drag.last) return;
  if (!drag.moved) {
    drag.moved = true;
    const m = marks[drag.start];
    drag.mode = m === EMPTY ? X : m === X ? EMPTY : null; // a drag from a queen does nothing
    if (drag.mode !== null) paint(drag.start);
  }
  if (drag.mode !== null) for (const j of pathCells(drag.last, i)) paint(j);
  drag.last = i;
  render();
});

function endDrag(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const d = drag;
  drag = null;
  if (!d.moved) {
    const ch = [];
    setMark(d.start, cycle(marks[d.start]), ch);
    commit(ch);
  } else {
    commit(d.changes);
  }
}
ui.board.addEventListener('pointerup', endDrag);
ui.board.addEventListener('pointercancel', endDrag);
ui.board.addEventListener('contextmenu', (e) => e.preventDefault());

// ─── Keyboard ──────────────────────────────────────────────────────────────
function moveCursor(i, focus = true) {
  if (cells[cursor]) cells[cursor].tabIndex = -1;
  cursor = i;
  cells[i].tabIndex = 0;
  if (focus) cells[i].focus();
}

// Keep the roving cursor on whichever square has focus, however it got there
// (Tab, a screen reader's virtual cursor, or a click).
ui.board.addEventListener('focusin', (e) => {
  const i = cells.indexOf(e.target);
  if (i >= 0 && i !== cursor) moveCursor(i, false);
});

ui.board.addEventListener('keydown', (e) => {
  if (!puzzle || e.ctrlKey || e.metaKey || e.altKey) return;
  const n = N(), r = Math.floor(cursor / n), c = cursor % n;
  const clamp = (v) => Math.max(0, Math.min(n - 1, v));
  const go = (rr, cc) => { e.preventDefault(); moveCursor(clamp(rr) * n + clamp(cc)); };
  const set = (to) => {
    e.preventDefault();
    if (!canPlay()) return;
    const ch = [];
    setMark(cursor, to, ch);
    commit(ch);
  };
  switch (e.key) {
    case 'ArrowUp': return go(r - 1, c);
    case 'ArrowDown': return go(r + 1, c);
    case 'ArrowLeft': return go(r, c - 1);
    case 'ArrowRight': return go(r, c + 1);
    case 'Home': return go(r, 0);
    case 'End': return go(r, n - 1);
    case ' ': case 'Enter': return set(cycle(marks[cursor]));
    case 'x': case 'X': return set(marks[cursor] === X ? EMPTY : X);
    case 'q': case 'Q': return set(marks[cursor] === Q ? EMPTY : Q);
    case 'Backspace': case 'Delete': return set(EMPTY);
    default:
  }
});

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLElement && e.target.closest('input, textarea, select')) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
  else if (mod && k === 'y') { e.preventDefault(); redo(); }
});

// ─── Clock ─────────────────────────────────────────────────────────────────
function formatTime(ms) {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const two = (v) => String(v).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(ss)}` : `${m}:${two(ss)}`;
}

const elapsedNow = () => elapsed + (runningSince != null ? performance.now() - runningSince : 0);

function showTime() {
  ui.clock.textContent = formatTime(elapsedNow());
  if (runningSince != null && performance.now() - lastAutosave > 5000) saveGame();
}

function startClock() {
  if (runningSince != null || solved || !puzzle) return;
  runningSince = performance.now();
  clearInterval(ticker);
  ticker = setInterval(showTime, 250);
  showTime();
}

function stopClock() {
  if (runningSince != null) elapsed = elapsedNow();
  runningSince = null;
  clearInterval(ticker);
  ticker = null;
  if (puzzle) showTime();
}

function showVeil(text, withButton) {
  ui.veilText.textContent = text;
  ui.veilBtn.hidden = !withButton;
  ui.veil.hidden = false;
  ui.board.setAttribute('aria-hidden', 'true');
}

function hideVeil() {
  ui.veil.hidden = true;
  ui.board.removeAttribute('aria-hidden');
}

function pauseGame() {
  if (!puzzle || solved || paused || loading) return;
  stopClock();
  paused = true;
  drag = null;
  showVeil('Paused', true);
  ui.pause.textContent = 'Resume';
  render();
  saveGame();
}

function resumeGame() {
  if (!paused) return;
  paused = false;
  hideVeil();
  ui.pause.textContent = 'Pause';
  startClock();
  render();
  cells[cursor]?.focus({ preventScroll: true });
}

document.addEventListener('visibilitychange', () => { if (document.hidden) pauseGame(); });
window.addEventListener('pagehide', () => saveGame());

// ─── Winning ───────────────────────────────────────────────────────────────
function checkWin() {
  if (solved) return;
  const n = N();
  let queens = 0;
  for (const m of marks) if (m === Q) queens++;
  if (queens !== n || conflicts().issues.length) return;

  solved = true;
  stopClock();
  hint = null;
  const time = Math.round(elapsed);
  const rec = records[n] || { best: null, solved: 0 };
  const previousBest = rec.best;
  const counts = hintsUsed === 0 && !helped.solver && !helped.replay; // help means no record
  const isBest = counts && (previousBest == null || time < previousBest);
  rec.solved = (rec.solved || 0) + 1;
  if (isBest) rec.best = time;
  records[n] = rec;
  store.set('queens.records', records);

  let text = `Solved in ${formatTime(time)}`;
  const aids = [];
  if (hintsUsed) aids.push(`${hintsUsed} ${hintsUsed === 1 ? 'hint' : 'hints'}`);
  if (helped.solver) aids.push('the solver');
  if (helped.replay) text = `Solved again in ${formatTime(time)}. Replays don't count towards your best.`;
  else if (aids.length) text += ` with ${aids.join(' and ')}. Assisted times don't count towards your best.`;
  else if (previousBest == null) text += `. Your first ${n} × ${n}.`;
  else if (isBest) text += `, a new best for ${n} × ${n} (was ${formatTime(previousBest)}).`;
  else text += `. Your best for ${n} × ${n} is ${formatTime(previousBest)}.`;
  setMessage(text, 'win');

  store.set('queens.lastSolve', { id: Date.now(), key: puzzle.key, size: n, time, log: moveLog, hints: hintsUsed, helped });
  training.refreshReview();
  ui.reviewLink.hidden = false;
  ui.board.classList.add('is-solved');
  ui.stamp.dataset.corner = quietestCorner();
  ui.stampTime.textContent = formatTime(time);
  ui.stamp.hidden = false;
  ui.stamp.classList.remove('is-in');
  void ui.stamp.offsetWidth; // restart the animation
  ui.stamp.classList.add('is-in');
  showRecord();
  render();
  saveGame();
}

// The stamp goes in whichever corner covers the fewest crowns.
function quietestCorner() {
  const n = N(), rows = Math.ceil(n * 0.22), cols = Math.ceil(n * 0.38);
  const count = (top, left) => {
    let q = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const rr = top ? r : n - 1 - r, cc = left ? c : n - 1 - c;
        if (marks[rr * n + cc] === Q) q++;
      }
    }
    return q;
  };
  const corners = [['br', count(false, false)], ['bl', count(false, true)], ['tr', count(true, false)], ['tl', count(true, true)]];
  return corners.reduce((best, c) => (c[1] < best[1] ? c : best))[0];
}

// ─── Hints ─────────────────────────────────────────────────────────────────
function computeHint() {
  const n = N(), sol = puzzle.solution;
  const isAnswer = (i) => sol[Math.floor(i / n)] === i % n;
  const empty = { focus: [], place: [], cross: [], ring: [] };

  const { issues } = conflicts();
  if (issues.length) {
    const is = issues[0];
    return { ...empty, text: `${describeClash(is, idx, puzzle)} Remove one of them.`,
      focus: is.kind === 'unit' ? idx.unitCells[is.unit] : [], ring: is.cells };
  }
  for (let i = 0; i < n * n; i++) {
    if (marks[i] === Q && !isAnswer(i)) {
      return { ...empty, text: `The queen on ${cellRef(i, n)} isn't part of the solution.`, ring: [i] };
    }
  }
  for (let i = 0; i < n * n; i++) {
    if (marks[i] === X && isAnswer(i)) {
      return { ...empty, text: `The cross on ${cellRef(i, n)} is covering a square that needs a queen.`, ring: [i] };
    }
  }
  // Everything on the board is right: find the next deduction from here.
  const st = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) if (marks[i] === X) st[i] = CROSS;
  for (let i = 0; i < n * n; i++) if (marks[i] === Q) applyQueen(idx, st, i);
  const step = findStep(idx, st);
  if (step && step.type !== 'contradiction' && (step.place.length || step.cross.length)) {
    const shortcut = classifyStep(step, idx, st);
    return { text: `${SHORTCUT[shortcut].name}. ${describeStep(step, idx, puzzle)}`, shortcut, focus: step.units.flatMap((u) => idx.unitCells[u]),
      place: step.place, cross: step.cross, ring: [] };
  }
  const r = sol.findIndex((c, row) => marks[row * n + c] !== Q);
  const i = r * n + sol[r];
  return { ...empty, text: `Try a queen on ${cellRef(i, n)}.`, place: [i] };
}

function giveHint() {
  if (!canPlay()) return;
  if (!hint) {
    hint = computeHint();
    if (hint.shortcut) noteShortcut(hint.shortcut, puzzle.key);
    hintsUsed++;
    saveGame();
  }
  render();
  setMessage(hint.text, 'hint');
  ui.message.classList.remove('is-nudged');
  void ui.message.offsetWidth;
  ui.message.classList.add('is-nudged');
}

// ─── Saving ────────────────────────────────────────────────────────────────
function saveGame() {
  if (!puzzle || !marks) return;
  lastAutosave = performance.now();
  store.set('queens.game', {
    key: puzzle.key,
    marks: Array.from(marks).join(''),
    elapsed: Math.round(elapsedNow()),
    hints: hintsUsed,
    helped,
    log: moveLog,
    solved,
  });
}

// ─── Controls ──────────────────────────────────────────────────────────────
function flash(button, text) {
  const original = button.dataset.label || button.textContent;
  button.dataset.label = original;
  button.textContent = text;
  clearTimeout(button._flash);
  button._flash = setTimeout(() => { button.textContent = original; }, 1600);
}

async function copyLink() {
  if (!puzzle) return;
  const text = framed ? puzzle.key : `${location.origin}${location.pathname}#${puzzle.key}`;
  try {
    await navigator.clipboard.writeText(text);
    flash(ui.copy, 'Copied');
  } catch {
    setMessage(framed ? `This sheet's key is ${puzzle.key}.` : `Link to this sheet: ${text}`);
  }
}

function wireControls() {
  for (let n = MIN_SIZE; n <= MAX_SIZE; n++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = String(n);
    b.dataset.size = String(n);
    b.setAttribute('aria-pressed', 'false');
    b.setAttribute('aria-label', `${n} by ${n}`);
    b.addEventListener('click', () => {
      settings.size = n;
      saveSettings();
      load(n, randomCode());
    });
    ui.sizes.appendChild(b);
  }
  ui.newBtn.addEventListener('click', () => load(settings.size, randomCode()));
  ui.pause.addEventListener('click', () => (paused ? resumeGame() : pauseGame()));
  ui.veilBtn.addEventListener('click', resumeGame);
  if (framed) ui.copy.textContent = 'Copy key';
  ui.copy.addEventListener('click', copyLink);
  ui.undo.addEventListener('click', undo);
  ui.redo.addEventListener('click', redo);
  ui.clear.addEventListener('click', clearBoard);
  ui.hint.addEventListener('click', giveHint);
  ui.auto.checked = !!settings.autoCross;
  ui.auto.addEventListener('change', () => {
    settings.autoCross = ui.auto.checked;
    saveSettings();
    render();
  });
  ui.openForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const parsed = parseKey(ui.openInput.value, settings.size);
    if (!parsed) {
      ui.openError.textContent = 'Type a sheet key such as 12-K7Q2MX, or any word.';
      ui.openError.hidden = false;
      return;
    }
    ui.openInput.value = '';
    ui.openInput.blur();
    load(parsed.size, parsed.code);
  });
}

// The house mark and per-page doodle come from the shared Tunnel script on a
// CDN. The game must not depend on it, so mount only if and when it arrives.
function mountHouseFigures() {
  const TF = window.TunnelFigure;
  if (!TF) return;
  try {
    $('sig').innerHTML = TF.tunnelFigureSVG(null, { variant: 'mark' });
    const doodle = $('doodle');
    doodle.innerHTML = TF.tunnelFigureSVG(document.body.dataset.seed || 'queens', { variant: 'doodle' });
    TF.placeDoodle(doodle);
  } catch (err) {
    console.warn('Tunnel figure unavailable', err);
  }
}

// ─── Start ─────────────────────────────────────────────────────────────────
// ─── The Solver tab ────────────────────────────────────────────────────────
// What the solver may start from when asked to continue from your board:
// everything you've marked, provided none of it is wrong.
function playerStart() {
  if (!puzzle) return { ok: false, reason: 'Nothing to start from yet.' };
  const n = N(), sol = puzzle.solution;
  const { issues } = conflicts();
  if (issues.length) return { ok: false, reason: `${describeClash(issues[0], idx, puzzle)} The solver starts from empty until that's fixed.` };
  for (let i = 0; i < n * n; i++) {
    const answer = sol[Math.floor(i / n)] === i % n;
    if (marks[i] === Q && !answer) return { ok: false, reason: `The queen on ${cellRef(i, n)} isn't part of the solution, so the solver starts from empty.` };
    if (marks[i] === X && answer) return { ok: false, reason: `The cross on ${cellRef(i, n)} covers a square that needs a queen, so the solver starts from empty.` };
  }
  const st = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) if (marks[i] === X) st[i] = CROSS;
  for (let i = 0; i < n * n; i++) if (marks[i] === Q) applyQueen(idx, st, i);
  return { ok: true, state: st };
}

const lab = createLab({
  frame: $('lab-frame'), veil: $('lab-veil'), veilText: $('lab-veil-text'),
  count: $('lab-count'), of: $('lab-of'), key: $('lab-key'), difficulty: $('lab-difficulty'), ret: $('lab-return'),
  tag: $('lab-tag'), newBadge: $('lab-new'), text: $('lab-text'), summary: $('lab-summary'), profile: $('lab-profile'),
  play: $('lab-play'), next: $('lab-next'), back: $('lab-back'), reset: $('lab-reset'), end: $('lab-end'),
  speed: $('lab-speed'), speedOut: $('lab-speed-out'), emptyStart: $('lab-start-empty'), boardStart: $('lab-start-board'),
  startNote: $('lab-start-note'), sizes: $('lab-sizes'), newSheet: $('lab-new-sheet'),
  scCount: $('sc-count'), scEmpty: $('sc-empty'), scForget: $('sc-forget'), scCards: $('sc-cards'),
}, {
  makePuzzle: (size, code) => makePuzzle(size, code, 'lab'),
  playSheet: () => puzzle,
  playerStart,
  solverUsed: (key) => {
    if (puzzle && key === puzzle.key && !solved && !helped.solver) { helped.solver = true; saveGame(); }
  },
});

const training = createTraining({
  frame: $('tr-frame'), board: $('tr-board'), veil: $('tr-veil'), veilText: $('tr-veil-text'),
  lesson: $('tr-lesson'), lessonName: $('tr-lesson-name'), lessonText: $('tr-lesson-text'), lessonDiagram: $('tr-lesson-diagram'), lessonGo: $('tr-lesson-go'),
  clock: $('tr-clock'), name: $('tr-name'), level: $('tr-level'), tag: $('tr-tag'), result: $('tr-result'),
  prompt: $('tr-prompt'), feedback: $('tr-feedback'), next: $('tr-next'), show: $('tr-show'),
  mode: $('tr-mode'), skill: $('tr-skill'), skillField: $('tr-skill-field'), session: $('tr-session'), help: $('tr-help'),
  skillList: $('sk-list'), skillCount: $('sk-count'), skillReset: $('sk-reset'),
  review: $('review'), rvEmpty: $('rv-empty'), rvBody: $('rv-body'), rvMeta: $('rv-meta'), rvSplits: $('rv-splits'), rvSummary: $('rv-summary'), rvCards: $('rv-cards'),
}, {
  makePuzzle: (size, code, channel) => makePuzzle(size, code, channel),
  lastSolve: () => store.get('queens.lastSolve', null),
});

function showTab(name) {
  if (name === tab) return;
  const from = tab;
  tab = name;
  for (const k of Object.keys(ui.tabs)) {
    const on = k === name;
    ui.tabs[k].setAttribute('aria-selected', String(on));
    ui.tabs[k].tabIndex = on ? 0 : -1;
    ui.panels[k].hidden = !on;
  }
  if (name === 'play') {
    lab.deactivate();
    training.deactivate();
    if (clockWasRunning && !paused && !solved && !loading) startClock();
    render();
    return;
  }
  if (from === 'play') { clockWasRunning = runningSince != null; stopClock(); } // your clock waits elsewhere
  if (name === 'solver') { training.deactivate(); lab.activate(); }
  else { lab.deactivate(); training.activate(); }
}

ui.reviewLink.addEventListener('click', () => { showTab('training'); training.showReview(); });

for (const [name, el] of Object.entries(ui.tabs)) {
  el.addEventListener('click', () => showTab(name));
  el.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const order = Object.keys(ui.tabs);
      const next = order[(order.indexOf(name) + (e.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length];
      showTab(next);
      ui.tabs[next].focus();
    }
  });
}

function init() {
  wireControls();
  if (window.TunnelFigure) mountHouseFigures();
  else $('tunnel-js')?.addEventListener('load', mountHouseFigures, { once: true });

  // Typing or pasting a key into the address, or stepping back, opens it.
  window.addEventListener('hashchange', () => {
    const parsed = parseKey(keyFromAddress(), settings.size);
    if (parsed && formatKey(parsed.size, parsed.code) !== puzzle?.key) load(parsed.size, parsed.code);
  });

  const saved = store.get('queens.game', null);
  const fromUrl = keyFromAddress();
  const savedKey = saved && typeof saved.key === 'string' ? parseKey(saved.key, settings.size) : null;
  const resumable = savedKey && !saved.solved;

  if (fromUrl) {
    const parsed = parseKey(fromUrl, settings.size);
    if (parsed) {
      const key = formatKey(parsed.size, parsed.code);
      if (resumable && saved.key === key) return load(parsed.size, parsed.code, saved);
      return load(parsed.size, parsed.code);
    }
  }
  if (resumable) return load(savedKey.size, savedKey.code, saved);
  return load(settings.size, randomCode());
}

init();

// For tests and the curious: window.queens.state() describes the live game.
window.queens = {
  state: () => puzzle && {
    key: puzzle.key, size: puzzle.size, solved, paused, loading, hintsUsed,
    elapsed: Math.round(elapsedNow()), marks: Array.from(marks).join(''), regions: puzzle.regions.join(','),
    engine: workerBroken || !worker ? 'main thread' : 'worker',
    tab, helped: { ...helped }, lab: lab.state, training: training.state, logLength: moveLog.length,
  },
  drill: () => training.debug,
};
