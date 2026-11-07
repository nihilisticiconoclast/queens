// worker.js — generates puzzles off the main thread, so the page never stalls
// while a large board is being repaired into a unique one.

import { generatePuzzle } from './generator.js?v=1';

self.onmessage = ({ data }) => {
  const { id, size, code } = data;
  try {
    self.postMessage({ id, puzzle: generatePuzzle(size, code) });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
