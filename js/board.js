// board.js — draws a puzzle board: tinted cells, region borders, grid
// references, marks and highlights. Used by both the Play and Solver tabs,
// and (at miniature scale) by the shortcut diagrams.

import { PALETTE } from './palette.js?v=2';
import { cellRef, colLetter, regionName } from './explain.js?v=2';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MARK_WORDS = ['empty', 'crossed out', 'queen'];

// Straight runs along grid lines where isEdge(a, b) holds between the cells
// either side, merged so long borders are one stroke.
export function edgeRuns(h, w, isEdge) {
  const d = [];
  for (let c = 1; c < w; c++) {
    let start = -1;
    for (let r = 0; r <= h; r++) {
      const on = r < h && isEdge(r * w + c - 1, r * w + c);
      if (on && start < 0) start = r;
      if (!on && start >= 0) { d.push(`M${c} ${start}V${r}`); start = -1; }
    }
  }
  for (let r = 1; r < h; r++) {
    let start = -1;
    for (let c = 0; c <= w; c++) {
      const on = c < w && isEdge((r - 1) * w + c, r * w + c);
      if (on && start < 0) start = c;
      if (!on && start >= 0) { d.push(`M${start} ${r}H${c}`); start = -1; }
    }
  }
  return d.join('');
}

// Outline of an arbitrary set of cells.
export function outlinePath(n, set) {
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

function svgLayer(cls, n) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('viewBox', `0 0 ${n} ${n}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  return svg;
}

function span(text) {
  const s = document.createElement('span');
  s.textContent = text;
  return s;
}

export class BoardView {
  // frame: an element holding .refs-cols, .refs-rows and a .board
  constructor(frame) {
    this.frame = frame;
    this.board = frame.querySelector('.board');
    this.colRefs = frame.querySelector('.refs-cols');
    this.rowRefs = frame.querySelector('.refs-rows');
    this.cells = [];
    this.puzzle = null;
  }

  build(puzzle, { focusable = false, cursor = 0, label = '' } = {}) {
    const n = puzzle.size;
    this.puzzle = puzzle;
    this.frame.style.setProperty('--n', n);
    this.board.replaceChildren();
    this.board.classList.remove('is-solved');
    if (label) this.board.setAttribute('aria-label', label);
    this.cells = [];
    for (let r = 0; r < n; r++) {
      const row = document.createElement('div');
      row.className = 'row';
      row.setAttribute('role', 'row');
      for (let c = 0; c < n; c++) {
        const i = r * n + c;
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.setAttribute('role', 'gridcell');
        if (focusable) cell.tabIndex = i === cursor ? 0 : -1;
        cell.style.setProperty('--tint', PALETTE[puzzle.colours[puzzle.regions[i]]].hex);
        cell.style.setProperty('--r', r);
        row.appendChild(cell);
        this.cells.push(cell);
      }
      this.board.appendChild(row);
    }
    const reg = puzzle.regions;
    const lines = svgLayer('board-lines', n);
    lines.innerHTML =
      `<path class="grid" d="${edgeRuns(n, n, (a, b) => reg[a] === reg[b])}"/>` +
      `<path class="bounds" d="${edgeRuns(n, n, (a, b) => reg[a] !== reg[b])}M0 0H${n}V${n}H0Z"/>`;
    this.hintLayer = svgLayer('hint-lines', n);
    this.board.append(lines, this.hintLayer);
    this.colRefs.replaceChildren(...Array.from({ length: n }, (_, c) => span(colLetter(c))));
    this.rowRefs.replaceChildren(...Array.from({ length: n }, (_, r) => span(String(r + 1))));
    this._labels = Array(n * n).fill(-1);
  }

  // marks: 0 empty / 1 cross / 2 queen per cell. The rest are optional
  // overlays; delays (ms per cell) stagger marks as they appear.
  paint({ marks, auto = null, clash = null, focus = [], ghostQueens = [], ghostCrosses = [], rings = [], delays = null }) {
    const n = this.puzzle.size;
    const f = new Set(focus), gq = new Set(ghostQueens), gx = new Set(ghostCrosses), rg = new Set(rings);
    for (let i = 0; i < n * n; i++) {
      const el = this.cells[i], m = marks[i];
      el.classList.toggle('is-queen', m === 2);
      el.classList.toggle('is-cross', m === 1);
      el.classList.toggle('is-auto', m === 0 && !!auto && auto[i] === 1);
      el.classList.toggle('is-clash', !!clash && clash[i] === 1);
      el.classList.toggle('hint-focus', f.has(i));
      el.classList.toggle('hint-queen', gq.has(i));
      el.classList.toggle('hint-cross', gx.has(i));
      el.classList.toggle('hint-ring', rg.has(i));
      if (delays && delays[i]) el.style.setProperty('--delay', `${delays[i]}ms`);
      else el.style.removeProperty('--delay');
      if (this._labels[i] !== m) {
        this._labels[i] = m;
        el.setAttribute('aria-label', `${cellRef(i, n)}, ${regionName(this.puzzle, this.puzzle.regions[i])} region, ${MARK_WORDS[m]}`);
      }
    }
    this.hintLayer.innerHTML = f.size ? `<path d="${outlinePath(n, f)}"/>` : '';
  }
}

// ─── Shortcut diagrams ─────────────────────────────────────────────────────
// A small static board from a { regions, marks } spec (see shortcuts.js).

const DIAGRAM_TINTS = { a: '#ACEDD3', b: '#F7B983', c: '#C5B5EA' };
const CROWN = 'M3.6 17.2 2.6 7.9l5 3.6L12 4.9l4.4 6.6 5-3.6-1 9.3ZM3.8 18.6h16.4V21H3.8Z';

export function diagramSVG(spec, cellSize = 25) {
  const h = spec.regions.length, w = spec.regions[0].length;
  const regionAt = (i) => spec.regions[Math.floor(i / w)][i % w];
  const parts = [];
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const g = spec.regions[r][c];
      const fill = DIAGRAM_TINTS[g] || 'var(--diagram-ground)';
      parts.push(`<rect x="${c}" y="${r}" width="1" height="1" fill="${fill}"/>`);
    }
  }
  parts.push(`<path class="d-grid" d="${edgeRuns(h, w, (a, b) => regionAt(a) === regionAt(b))}"/>`);
  parts.push(`<path class="d-bounds" d="${edgeRuns(h, w, (a, b) => regionAt(a) !== regionAt(b) && (regionAt(a) !== '.' || regionAt(b) !== '.'))}"/>`);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const m = spec.marks[r][c];
      if (m === 'x' || m === 'X') {
        parts.push(`<path class="d-x${m === 'X' ? ' is-new' : ''}" d="M${c + 0.33} ${r + 0.33}L${c + 0.67} ${r + 0.67}M${c + 0.67} ${r + 0.33}L${c + 0.33} ${r + 0.67}"/>`);
      } else if (m === 'Q' || m === 'q') {
        parts.push(`<path class="d-q${m === 'Q' ? ' is-new' : ''}" transform="translate(${c + 0.11} ${r + 0.1}) scale(${0.78 / 24})" d="${CROWN}"/>`);
      }
    }
  }
  return `<svg class="diagram" viewBox="-0.08 -0.08 ${w + 0.16} ${h + 0.16}" width="${w * cellSize}" height="${h * cellSize}" role="img" aria-hidden="true">${parts.join('')}</svg>`;
}
