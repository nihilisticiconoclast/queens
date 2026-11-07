# Queens

A logic puzzle in the style of LinkedIn's daily *Queens*, with endless boards from 8 × 8 to 14 × 14.

Place one queen in every row, every column and every coloured region. No two queens may touch, not even diagonally. Tap a square once for a cross, twice for a queen, three times to clear it; drag to cross out a run of squares. Every game is timed.

**Play:** <https://nihilisticiconoclast.github.io/queens/> (once GitHub Pages is switched on: Settings → Pages → Deploy from a branch → `main`, `/ (root)`).

## What's guaranteed

- **Exactly one solution.** Every board is checked by exhaustive search before it is shown.
- **No guessing needed.** A second solver finishes every board using only human-style deductions (listed below), and never needs a group of more than three units.
- **Same key, same board.** A *sheet key* such as `10-K7Q2MX` (size, then code) seeds every random choice, so it draws the identical board — regions and colours — on any device. The address carries the key (`…/queens/#10-K7Q2MX`; older `?seed=` links still work), so links and bookmarks reopen a board. Any word works as a key: `12-gloucester`.
- **No free queens.** Regions are between 2 squares and 3 × the board width.

## Features

Seeded sheets (copy a link, or open any key), sizes 8–14, a clock that pauses when the tab is hidden, undo/redo (a drag is one move), hints that name and explain the next deduction or point out a mistake, optional auto-cross, conflict hatching, best times per size, and progress that survives a reload. Keyboard: arrows, Space, X, Q, Backspace, Ctrl+Z / Ctrl+Shift+Z.

### The Solver tab

Watch a sheet solved one deduction at a time, easiest first, never guessing. Each step first outlines the units it reasons about and shows in teal where it will act, then places the queen or crosses; a queen's crosses ripple outward from it.

- **Play / Step / Back / Reset / End**, and a **speed** slider (0.4 to 10 steps a second). Keyboard: Space, ← →, Home, End.
- **Difficulty profile**: one bar per step, height by difficulty (amber for Hard and Expert); click a bar to replay that step.
- **Start from your board**: continue from your Play-tab marks, unless one is wrong (it says which).
- **Summary** at the end: step count, the hardest step, and every shortcut used.
- **Watch another sheet** without touching your game; **Back to your sheet** returns. Watching the sheet you're playing marks that game as assisted, as do hints and replays: assisted solves don't set best times.

### Shortcuts

The solver knows four general techniques. Each step is matched to the most specific of 14 named **shortcuts** that fully explains it (`js/shortcuts.js`), and a shortcut joins your collection (kept in this browser) the first time the solver or a hint uses it. Cards show a diagram of the pattern, how often you've seen it, and **Show me** replays its first appearance.

| Shortcut | Level | On % of boards* |
|---|---|---|
| Last square | Easy | 100 |
| Region in one line | Easy | 100 |
| Line inside a region | Easy | 56 |
| Domino shadow | Medium | 78 |
| Blocked square | Medium | 55 |
| L-shape | Medium | 26 |
| Offset dominoes | Medium | 13 |
| Three in a row | Medium | 11 |
| Pair with a gap | Medium | 8 |
| Corner-to-corner pair | Medium | 6 |
| Two regions, two lines | Hard | 33 |
| Two lines, two regions | Hard | 8 |
| Two rows, two columns | Hard | 0.7 |
| Three-way squeeze | Expert | 11 |

\*420 boards, 60 per size, from `node tools/solve.mjs --stats 60`.

*Offset dominoes*: two units each down to two side-by-side squares, in neighbouring rows (or columns) and shifted by one, always take their queens on the two outer squares, because a queen on either inner square would touch both squares of the other pair. A shape shortcut is only claimed when its geometry explains every square crossed out; otherwise the step is a plain *Blocked square*.

### In a terminal

```sh
node tools/solve.mjs 10-K7Q2MX        # the board, every deduction in order, and the answer
node tools/solve.mjs --stats 200      # how often each shortcut turns up
```

## How a board is made (`js/generator.js`)

1. Place N queens at random — no shared row or column, no touching. This is the answer.
2. Grow one region outward from each queen (varied speeds and shapes; growth capped at 2.5N squares).
3. Find rival answers with the exhaustive solver. A square where a rival puts a queen and the answer doesn't can be handed to a neighbouring region (with a thin corridor if it's buried), which kills every rival using it and never touches the answer. Target the squares most rivals share; repeat until the answer is unique.
4. Run the deduction solver. If it stalls, hand away a square that's still open at the stall and return to step 3.

Every choice comes from an `sfc32` PRNG seeded by the key, and the generator avoids engine-dependent floating-point functions (no `pow`/`exp`/`log`/trig), so boards are bit-identical across browsers. Colours are assigned from a 14-tint palette using a precomputed integer cost matrix (normal and colour-blind-simulated distances), keeping touching regions distinct.

**Deductions and difficulty** (`js/solver.js`), easiest first. The label is the hardest one a board needs:

| Label | Deduction |
|---|---|
| Easy | A row, column or region has one available square; a region's available squares all lie in one row/column (or vice versa), so cross out the rest of that line |
| Medium | A queen on a square would leave some row, column or region with nowhere to go |
| Hard | Two regions fit inside the same two rows/columns (or the reverse) |
| Expert | The same with three |

Measured (Node 22, 150 boards per size): mean generation 4 ms at 8 × 8, 45 ms at 12 × 12, 150 ms at 14 × 14; worst seen 0.75 s. In Chrome a 14 × 14 sheet averages ~0.2 s. The page generates in a Web Worker (falling back to the main thread if workers are unavailable).

## Layout

```
index.html          page, controls, and the on-page explanation
css/queens.css      layout and board (palette/type come from the Tunnel tokens)
js/rng.js           seeded PRNG, sheet keys
js/solver.js        exhaustive search + deduction engine (the solver)
js/shortcuts.js     the 14 shortcuts: classifier, diagrams, full solve traces
js/generator.js     builds a unique, deducible board from a key
js/palette.js       region tints and colour assignment
js/explain.js       turns deductions into sentences
js/board.js         draws boards and shortcut diagrams
js/worker.js        runs the generator off the main thread
js/game.js          Play tab: input, clock, hints, storage, tabs
js/lab.js           Solver tab: playback, profile, shortcut collection
tools/solve.mjs     the solver in a terminal
test/engine.test.mjs, test/shortcuts.test.mjs
```

## Running and testing

ES modules need HTTP, so serve the folder rather than opening the file:

```sh
python3 -m http.server 8000      # then open http://localhost:8000
node --test                      # Node 20+; PER_SIZE=150 node --test for the long run
```

`test/shortcuts.test.mjs` holds each shortcut to its claim: on 140 real solves, every step classifies, shape shortcuts cross out only what their geometry explains, and every *Offset dominoes* really does end with queens on the outer squares; each card's diagram is checked to show its own rule.

The engine tests generate 25 boards per size (1,050 with `PER_SIZE=150`) and check each one: the stored answer obeys the rules, the exhaustive search finds exactly one solution, the deduction solver finishes it with every step consistent with the answer, regions are connected and within size limits, and colours are distinct. They also pin three *golden* boards: if the generator changes, those fail, because every shared key would now draw a different board. Change the generator deliberately, bump `GENERATOR_VERSION`, and update the fingerprints.

Local assets carry `?v=2` so a fresh page never pairs with a stale cached script; bump it everywhere when shipping changes.

## Design

The page uses the house **Tunnel** style, linked (not copied) from [`cuddly-lamp`](https://github.com/nihilisticiconoclast/cuddly-lamp) via jsDelivr: chart-paper ground, ink, Fraunces / Public Sans / IBM Plex Mono, hard edges, one red action. The board is drawn as a hand-tinted survey sheet with grid references and heavy boundary lines. If the CDN is unreachable the game still works: colour and component fallbacks sit at lower specificity than the house tokens, and the house mark/doodle are mounted only if their script arrives.
