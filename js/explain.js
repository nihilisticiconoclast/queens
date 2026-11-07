// explain.js — turns solver output into sentences a player can act on.

import { PALETTE } from './palette.js?v=3';
import { unitType, unitNumber, ROW, COL } from './solver.js?v=3';

export const colLetter = (c) => String.fromCharCode(65 + c);
export const cellRef = (i, N) => `${colLetter(i % N)}${Math.floor(i / N) + 1}`;
export const regionName = (puzzle, g) => PALETTE[puzzle.colours[g]].name;

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six'];
const word = (n) => NUMBER_WORDS[n] ?? String(n);
const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function joinList(items, conj = 'and') {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${conj} ${items.at(-1)}`;
}

// "row 4", "columns B and E", "the mint region", "the mint and coral regions"
function unitsLabel(idx, puzzle, units) {
  const type = unitType(idx, units[0]);
  const nums = units.map((u) => unitNumber(idx, u)).sort((a, b) => a - b);
  const many = nums.length > 1;
  if (type === ROW) return `${many ? 'rows' : 'row'} ${joinList(nums.map((n) => String(n + 1)))}`;
  if (type === COL) return `${many ? 'columns' : 'column'} ${joinList(nums.map(colLetter))}`;
  return `the ${joinList(nums.map((n) => regionName(puzzle, n)))} ${many ? 'regions' : 'region'}`;
}

const kindPlural = (idx, u) => ['rows', 'columns', 'regions'][unitType(idx, u)];

function refsLabel(cells, N, conj = 'and') {
  return joinList([...cells].sort((a, b) => a - b).map((i) => cellRef(i, N)), conj);
}

export function describeStep(step, idx, puzzle) {
  const N = idx.N;
  switch (step.type) {
    case 'single': {
      const where = unitsLabel(idx, puzzle, step.units);
      return `${capitalise(where)} has one available square left, ${cellRef(step.place[0], N)}. Its queen goes there.`;
    }
    case 'confine':
    case 'group': {
      const a = unitsLabel(idx, puzzle, step.units);
      const b = unitsLabel(idx, puzzle, step.via);
      const k = step.units.length;
      if (k === 1) {
        return `All the available squares of ${a} lie in ${b}, so ${b} must take its queen from ${a}. ` +
          `Cross out the rest of ${b}.`;
      }
      return `${capitalise(a)} have all their available squares in ${b}. Those ${word(k)} ${kindPlural(idx, step.units[0])} ` +
        `need ${word(k)} queens and ${b} hold exactly ${word(k)}, so every other square in ${b} can be crossed out.`;
    }
    case 'attack': {
      const target = unitsLabel(idx, puzzle, step.units);
      if (step.cross.length === 1) {
        const cell = refsLabel(step.cross, N);
        return `A queen on ${cell} would rule out every available square of ${target}, so ${cell} can be crossed out.`;
      }
      return `A queen on any of ${refsLabel(step.cross, N, 'or')} would rule out every available square of ${target}, so they can all be crossed out.`;
    }
    default:
      return '';
  }
}

// Rule breaks found on the board, worded for the message line and hints.
export function describeClash(issue, idx, puzzle) {
  const N = idx.N;
  if (issue.kind === 'touch') return `The queens on ${refsLabel(issue.cells, N)} touch.`;
  return `${capitalise(word(issue.cells.length))} queens share ${unitsLabel(idx, puzzle, [issue.unit])}.`;
}
