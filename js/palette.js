// palette.js — region tints and how they are handed out.
//
// Fourteen map tints in three lightness bands, chosen so that every pair is
// clearly different to normal vision (OKLab ΔE ≥ 0.079). With fourteen hues
// some pairs inevitably merge for colour-blind players, so the assignment
// below also keeps those pairs away from each other — and the heavy region
// borders mean the board never depends on colour alone.

export const PALETTE = [
  { name: 'butter',     hex: '#F3E99A' },
  { name: 'mint',       hex: '#ACEDD3' },
  { name: 'sky',        hex: '#B1DDF9' },
  { name: 'blush',      hex: '#F9CDCD' },
  { name: 'apricot',    hex: '#F7B983' },
  { name: 'lime',       hex: '#B5DB85' },
  { name: 'lavender',   hex: '#C5B5EA' },
  { name: 'rose',       hex: '#ECA2B4' },
  { name: 'coral',      hex: '#E68A6E' },
  { name: 'moss',       hex: '#7FBA83' },
  { name: 'teal',       hex: '#6BB6BC' },
  { name: 'cornflower', hex: '#85A1DA' },
  { name: 'orchid',     hex: '#CD8CC7' },
  { name: 'ochre',      hex: '#D2AE5B' },
];

// COST[i][j]: how badly tints i and j clash when they touch. Precomputed
// offline from OKLab distance plus deuteranope/protanope-simulated distance
// (1e7/ΔE² + 5e6/ΔE_cvd², ΔE in thousandths) and stored as integers, so the
// colouring is bit-identical in every browser.
const COST = [
  [0, 1827, 642, 1429, 1347, 2474, 342, 448, 315, 422, 304, 193, 207, 589],
  [1827, 0, 2683, 50683, 926, 1736, 714, 753, 328, 545, 521, 307, 312, 515],
  [642, 2683, 0, 2296, 588, 668, 1945, 867, 319, 468, 692, 503, 481, 392],
  [1429, 50683, 2296, 0, 1839, 1206, 1224, 1416, 495, 560, 656, 395, 449, 632],
  [1347, 926, 588, 1839, 0, 50672, 620, 1552, 1163, 2730, 687, 352, 438, 2991],
  [2474, 1736, 668, 1206, 50672, 0, 448, 832, 609, 1160, 562, 275, 298, 1612],
  [342, 714, 1945, 1224, 620, 448, 0, 2030, 537, 582, 1663, 1716, 1781, 457],
  [448, 753, 867, 1416, 1552, 832, 2030, 0, 1736, 1333, 41652, 1163, 1971, 1049],
  [315, 328, 319, 495, 1163, 609, 537, 1736, 0, 5195, 640, 477, 897, 2925],
  [422, 545, 468, 560, 2730, 1160, 582, 1333, 5195, 0, 2076, 607, 737, 3089],
  [304, 521, 692, 656, 687, 562, 1663, 41652, 640, 2076, 0, 2551, 22581, 672],
  [193, 307, 503, 395, 352, 275, 1716, 1163, 477, 607, 2551, 0, 5403, 359],
  [207, 312, 481, 449, 438, 298, 1781, 1971, 897, 737, 22581, 5403, 0, 448],
  [589, 515, 392, 632, 2991, 1612, 457, 1049, 2925, 3089, 672, 359, 448, 0],
];

// How strongly two regions touch: a shared edge counts for more than a
// corner, and a long shared border for more than a short one.
function contactWeights(N, regions) {
  const edges = Array.from({ length: N }, () => new Int32Array(N));
  const corners = Array.from({ length: N }, () => new Int32Array(N));
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const g = regions[r * N + c];
      if (c + 1 < N) { const h = regions[r * N + c + 1]; if (h !== g) { edges[g][h]++; edges[h][g]++; } }
      if (r + 1 < N) { const h = regions[(r + 1) * N + c]; if (h !== g) { edges[g][h]++; edges[h][g]++; } }
      if (r + 1 < N && c + 1 < N) { const h = regions[(r + 1) * N + c + 1]; if (h !== g) { corners[g][h]++; corners[h][g]++; } }
      if (r + 1 < N && c > 0) { const h = regions[(r + 1) * N + c - 1]; if (h !== g) { corners[g][h]++; corners[h][g]++; } }
    }
  }
  const w = Array.from({ length: N }, () => new Int32Array(N));
  for (let g = 0; g < N; g++) {
    for (let h = 0; h < N; h++) {
      if (edges[g][h]) w[g][h] = 3 + Math.min(edges[g][h], 6);
      else if (corners[g][h]) w[g][h] = 1;
    }
  }
  return w;
}

// Returns, for each region, an index into PALETTE (all distinct). Starts from a
// seeded shuffle, then swaps colours — including unused ones — while that
// lowers the total clash between touching regions.
export function assignColours(N, regions, rng) {
  const K = PALETTE.length;
  const w = contactWeights(N, regions);
  const perm = rng.shuffle(Array.from({ length: K }, (_, i) => i));
  const clash = (g) => {
    let s = 0;
    for (let h = 0; h < N; h++) if (w[g][h]) s += w[g][h] * COST[perm[g]][perm[h]];
    return s;
  };
  let improved = true;
  for (let pass = 0; improved && pass < 20; pass++) {
    improved = false;
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < K; j++) {
        if (i === j) continue;
        const before = clash(i) + (j < N ? clash(j) : 0);
        let t = perm[i]; perm[i] = perm[j]; perm[j] = t;
        const after = clash(i) + (j < N ? clash(j) : 0);
        if (after < before) improved = true;
        else { t = perm[i]; perm[i] = perm[j]; perm[j] = t; }
      }
    }
  }
  return perm.slice(0, N);
}
