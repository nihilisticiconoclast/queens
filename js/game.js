// game.js — the page: board, marking, clock, sheets, hints and saved progress.

import { MIN_SIZE, MAX_SIZE, randomCode, parseKey, formatKey } from './rng.js?v=1';
import { buildIndex, findStep, applyQueen, CROSS } from './solver.js?v=1';
import { PALETTE } from './palette.js?v=1';
import { describeStep, describeClash, cellRef, colLetter, regionName } from './explain.js?v=1';

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
};
const SVG_NS = 'http://www.w3.org/2000/svg';

// ─── Game state ────────────────────────────────────────────────────────────
let puzzle = null, idx = null, marks = null, cells = [], hintLayer = null;
let undoStack = [], redoStack = [];
let elapsed = 0, runningSince = null, ticker = null, lastAutosave = 0;
let solved = false, paused = false, loading = false, hintsUsed = 0, hint = null;
let cursor = 0, loadToken = 0, drag = null;

const N = () => puzzle.size;
const canPlay = () => puzzle && !solved && !paused && !loading;

// ─── Puzzle generation: a Web Worker, or the main thread as a fallback ─────
let worker = null, workerBroken = false, requestId = 0;
const pending = new Map();

function mainThread(size, code) {
  return import('./generator.js?v=1').then((m) => m.generatePuzzle(size, code));
}

function makePuzzle(size, code) {
  if (!workerBroken && pending.size && worker) {
    // A newer request supersedes the one in flight: drop it.
    worker.terminate();
    worker = null;
    pending.clear();
  }
  if (!workerBroken && !worker) {
    try {
      worker = new Worker(new URL('./worker.js?v=1', import.meta.url), { type: 'module' });
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
    pending.set(id, { resolve, reject, size, code });
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
  saveGame();
}

// ─── Building the board ────────────────────────────────────────────────────
function buildBoard() {
  const n = N();
  ui.frame.style.setProperty('--n', n);
  ui.board.replaceChildren();
  ui.board.classList.remove('is-solved');
  ui.board.setAttribute('aria-label', `Queens board, ${n} by ${n}. Arrow keys move; space marks a square.`);
  cells = [];
  for (let r = 0; r < n; r++) {
    const row = document.createElement('div');
    row.className = 'row';
    row.setAttribute('role', 'row');
    for (let c = 0; c < n; c++) {
      const i = r * n + c;
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.setAttribute('role', 'gridcell');
      cell.tabIndex = i === cursor ? 0 : -1;
      cell.style.setProperty('--tint', PALETTE[puzzle.colours[puzzle.regions[i]]].hex);
      cell.style.setProperty('--r', r);
      row.appendChild(cell);
      cells.push(cell);
    }
    ui.board.appendChild(row);
  }
  ui.board.appendChild(boardLines());
  hintLayer = document.createElementNS(SVG_NS, 'svg');
  hintLayer.setAttribute('class', 'hint-lines');
  hintLayer.setAttribute('viewBox', `0 0 ${n} ${n}`);
  hintLayer.setAttribute('preserveAspectRatio', 'none');
  hintLayer.setAttribute('aria-hidden', 'true');
  ui.board.appendChild(hintLayer);

  ui.colRefs.replaceChildren(...Array.from({ length: n }, (_, c) => span(colLetter(c))));
  ui.rowRefs.replaceChildren(...Array.from({ length: n }, (_, r) => span(String(r + 1))));
}

function span(text) {
  const s = document.createElement('span');
  s.textContent = text;
  return s;
}

// Region borders as merged straight runs: heavy where two regions meet,
// hairline inside a region. Drawn in grid units over the cells.
function edgeRuns(n, isEdge) {
  const d = [];
  for (let c = 1; c < n; c++) {             // vertical lines x = c
    let start = -1;
    for (let r = 0; r <= n; r++) {
      const on = r < n && isEdge(r * n + c - 1, r * n + c);
      if (on && start < 0) start = r;
      if (!on && start >= 0) { d.push(`M${c} ${start}V${r}`); start = -1; }
    }
  }
  for (let r = 1; r < n; r++) {             // horizontal lines y = r
    let start = -1;
    for (let c = 0; c <= n; c++) {
      const on = c < n && isEdge((r - 1) * n + c, r * n + c);
      if (on && start < 0) start = c;
      if (!on && start >= 0) { d.push(`M${start} ${r}H${c}`); start = -1; }
    }
  }
  return d.join('');
}

function boardLines() {
  const n = N(), reg = puzzle.regions;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'board-lines');
  svg.setAttribute('viewBox', `0 0 ${n} ${n}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const grid = document.createElementNS(SVG_NS, 'path');
  grid.setAttribute('class', 'grid');
  grid.setAttribute('d', edgeRuns(n, (a, b) => reg[a] === reg[b]));
  const bounds = document.createElementNS(SVG_NS, 'path');
  bounds.setAttribute('class', 'bounds');
  bounds.setAttribute('d', edgeRuns(n, (a, b) => reg[a] !== reg[b]) + `M0 0H${n}V${n}H0Z`);
  svg.append(grid, bounds);
  return svg;
}

// Outline of an arbitrary set of cells (for hint highlights).
function outline(set) {
  const n = N();
  const inSet = (r, c) => r >= 0 && r < n && c >= 0 && c < n && set.has(r * n + c);
  const d = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!inSet(r, c)) continue;
      if (!inSet(r - 1, c)) d.push(`M${c} ${r}H${c + 1}`);
      if (!inSet(r + 1, c)) d.push(`M${c} ${r + 1}H${c + 1}`);
      if (!inSet(r, c - 1)) d.push(`M${c} ${r}V${r + 1}`);
      if (!inSet(r, c + 1)) d.push(`M${c + 1} ${r}V${r + 1}`);
    }
  }
  return d.join('');
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

const MARK_WORDS = ['empty', 'crossed out', 'queen'];

function render() {
  if (!puzzle) return;
  const n = N();
  const { clash, issues } = conflicts();
  const auto = settings.autoCross ? autoCrosses() : null;
  const h = hint || { focus: [], place: [], cross: [], ring: [] };
  const focus = new Set(h.focus);
  for (let i = 0; i < n * n; i++) {
    const el = cells[i], m = marks[i];
    el.classList.toggle('is-queen', m === Q);
    el.classList.toggle('is-cross', m === X);
    el.classList.toggle('is-auto', m === EMPTY && !!auto && auto[i] === 1);
    el.classList.toggle('is-clash', clash[i] === 1);
    el.classList.toggle('hint-focus', focus.has(i));
    el.classList.toggle('hint-queen', h.place.includes(i));
    el.classList.toggle('hint-cross', h.cross.includes(i));
    el.classList.toggle('hint-ring', h.ring.includes(i));
    const region = regionName(puzzle, puzzle.regions[i]);
    el.setAttribute('aria-label', `${cellRef(i, n)}, ${region} region, ${MARK_WORDS[m]}`);
  }
  hintLayer.innerHTML = focus.size ? `<path d="${outline(focus)}"/>` : '';
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
  try { history.replaceState(null, '', `${location.pathname}?seed=${encodeURIComponent(puzzle.key)}`); } catch { /* sandboxed */ }
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
  redoStack.push(ch);
  afterChange();
}

function redo() {
  if (!canPlay() || !redoStack.length) return;
  const ch = redoStack.pop();
  for (const [i, , to] of ch) marks[i] = to;
  undoStack.push(ch);
  afterChange();
}

function clearBoard() {
  if (solved) {                       // "Replay": same sheet, fresh clock
    const ch = [];
    for (let i = 0; i < marks.length; i++) setMark(i, EMPTY, ch);
    undoStack = []; redoStack = [];
    solved = false; elapsed = 0; hintsUsed = 0; hint = null;
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
  const counts = hintsUsed === 0;      // hinted solves don't set records
  const isBest = counts && (previousBest == null || time < previousBest);
  rec.solved = (rec.solved || 0) + 1;
  if (isBest) rec.best = time;
  records[n] = rec;
  store.set('queens.records', records);

  let text = `Solved in ${formatTime(time)}`;
  if (hintsUsed) text += ` with ${hintsUsed} ${hintsUsed === 1 ? 'hint' : 'hints'}. Hinted times don't count towards your best.`;
  else if (previousBest == null) text += `. Your first ${n} × ${n}.`;
  else if (isBest) text += `, a new best for ${n} × ${n} (was ${formatTime(previousBest)}).`;
  else text += `. Your best for ${n} × ${n} is ${formatTime(previousBest)}.`;
  setMessage(text, 'win');

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
    return { text: describeStep(step, idx, puzzle), focus: step.units.flatMap((u) => idx.unitCells[u]),
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
  const url = new URL(location.href);
  url.search = `?seed=${encodeURIComponent(puzzle.key)}`;
  url.hash = '';
  try {
    await navigator.clipboard.writeText(url.href);
    flash(ui.copy, 'Copied');
  } catch {
    setMessage(`Link to this sheet: ${url.href}`);
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
function init() {
  wireControls();
  if (window.TunnelFigure) mountHouseFigures();
  else $('tunnel-js')?.addEventListener('load', mountHouseFigures, { once: true });

  const saved = store.get('queens.game', null);
  const fromUrl = new URLSearchParams(location.search).get('seed');
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
  },
};
