// Pure Tetris engine. No DOM, no network. Used by the browser and by node tests.
//
// Code owns everything deterministic here: piece geometry, collision, line
// clears, enumerating every legal placement and describing each outcome.
// Jev (see jev.js) only picks between the placements this module produces.

export const WIDTH = 10;
export const HEIGHT = 20;

// Each piece: list of rotation states; each state is a list of [x, y] cells
// with y growing downwards. States are listed in clockwise order.
const RAW_PIECES = {
  I: [
    [[0, 1], [1, 1], [2, 1], [3, 1]],
    [[2, 0], [2, 1], [2, 2], [2, 3]],
  ],
  O: [[[0, 0], [1, 0], [0, 1], [1, 1]]],
  T: [
    [[1, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [1, 1], [2, 1], [1, 2]],
    [[0, 1], [1, 1], [2, 1], [1, 2]],
    [[1, 0], [0, 1], [1, 1], [1, 2]],
  ],
  S: [
    [[1, 0], [2, 0], [0, 1], [1, 1]],
    [[1, 0], [1, 1], [2, 1], [2, 2]],
  ],
  Z: [
    [[0, 0], [1, 0], [1, 1], [2, 1]],
    [[2, 0], [1, 1], [2, 1], [1, 2]],
  ],
  J: [
    [[0, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [2, 0], [1, 1], [1, 2]],
    [[0, 1], [1, 1], [2, 1], [2, 2]],
    [[1, 0], [1, 1], [0, 2], [1, 2]],
  ],
  L: [
    [[2, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [1, 1], [1, 2], [2, 2]],
    [[0, 1], [1, 1], [2, 1], [0, 2]],
    [[0, 0], [1, 0], [1, 1], [1, 2]],
  ],
};

export const PIECE_NAMES = Object.keys(RAW_PIECES);

export const PIECE_COLORS = {
  I: "#3fd6f0",
  O: "#f5d547",
  T: "#b565f2",
  S: "#5fe38a",
  Z: "#f26b6b",
  J: "#5b8cff",
  L: "#f4a340",
};

// Normalise every rotation so its bounding box starts at (0,0) and record its size.
export const PIECES = Object.fromEntries(
  Object.entries(RAW_PIECES).map(([name, states]) => [
    name,
    states.map((cells) => {
      const minX = Math.min(...cells.map((c) => c[0]));
      const minY = Math.min(...cells.map((c) => c[1]));
      const norm = cells.map(([x, y]) => [x - minX, y - minY]);
      return {
        cells: norm,
        width: Math.max(...norm.map((c) => c[0])) + 1,
        height: Math.max(...norm.map((c) => c[1])) + 1,
      };
    }),
  ]),
);

export function emptyBoard() {
  return Array.from({ length: HEIGHT }, () => new Array(WIDTH).fill(null));
}

export function cloneBoard(board) {
  return board.map((row) => row.slice());
}

export function collides(board, cells, x, y) {
  for (const [cx, cy] of cells) {
    const bx = x + cx;
    const by = y + cy;
    if (bx < 0 || bx >= WIDTH || by >= HEIGHT) return true;
    if (by >= 0 && board[by][bx]) return true;
  }
  return false;
}

// Returns the y at which the piece rests when dropped from `y` straight down.
export function dropY(board, cells, x, y) {
  let cur = y;
  while (!collides(board, cells, x, cur + 1)) cur += 1;
  return cur;
}

export function lockPiece(board, piece, rotation, x, y) {
  const next = cloneBoard(board);
  for (const [cx, cy] of PIECES[piece][rotation].cells) {
    const by = y + cy;
    if (by >= 0) next[by][x + cx] = piece;
  }
  return next;
}

// Removes full rows and returns { board, cleared, rows } (rows = indexes removed).
export function clearLines(board) {
  const rows = [];
  const kept = [];
  board.forEach((row, i) => {
    if (row.every((c) => c)) rows.push(i);
    else kept.push(row.slice());
  });
  while (kept.length < HEIGHT) kept.unshift(new Array(WIDTH).fill(null));
  return { board: kept, cleared: rows.length, rows };
}

export function columnHeights(board) {
  const heights = new Array(WIDTH).fill(0);
  for (let x = 0; x < WIDTH; x++) {
    for (let y = 0; y < HEIGHT; y++) {
      if (board[y][x]) {
        heights[x] = HEIGHT - y;
        break;
      }
    }
  }
  return heights;
}

// A hole is an empty cell with at least one filled cell above it in its column.
export function countHoles(board) {
  let holes = 0;
  for (let x = 0; x < WIDTH; x++) {
    let covered = false;
    for (let y = 0; y < HEIGHT; y++) {
      if (board[y][x]) covered = true;
      else if (covered) holes += 1;
    }
  }
  return holes;
}

export function bumpiness(heights) {
  let total = 0;
  for (let x = 0; x < heights.length - 1; x++) total += Math.abs(heights[x] - heights[x + 1]);
  return total;
}

// Wells: columns at least `depth` lower than both neighbours (walls count as tall).
export function wells(heights, depth = 3) {
  const found = [];
  for (let x = 0; x < heights.length; x++) {
    const left = x === 0 ? Infinity : heights[x - 1];
    const right = x === heights.length - 1 ? Infinity : heights[x + 1];
    const d = Math.min(left, right) - heights[x];
    if (d >= depth) found.push({ column: x, depth: d });
  }
  return found;
}

export function boardStats(board) {
  const heights = columnHeights(board);
  return {
    heights,
    maxHeight: Math.max(...heights),
    aggregateHeight: heights.reduce((a, b) => a + b, 0),
    holes: countHoles(board),
    bumpiness: bumpiness(heights),
    wells: wells(heights),
  };
}

// Classic hand-tuned linear evaluation (used only by the built-in fallback
// player and for the "what code alone would pick" comparison).
export function heuristicScore(outcome) {
  const s = outcome.after;
  return (
    -0.51 * s.aggregateHeight +
    0.76 * outcome.linesCleared -
    0.36 * s.holes -
    0.18 * s.bumpiness
  );
}

// Enumerates every reachable (rotation, x) for `piece` on `board`. A placement
// is reachable when the piece fits at the spawn row and can drop straight down.
export function enumeratePlacements(board, piece) {
  const before = boardStats(board);
  const seen = new Set();
  const placements = [];
  PIECES[piece].forEach((state, rotation) => {
    for (let x = 0; x <= WIDTH - state.width; x++) {
      if (collides(board, state.cells, x, 0)) continue;
      const y = dropY(board, state.cells, x, 0);
      const locked = lockPiece(board, piece, rotation, x, y);
      const key = locked.map((r) => r.map((c) => (c ? "#" : ".")).join("")).join("/");
      if (seen.has(key)) continue; // identical outcome from another rotation (O, I, S, Z)
      seen.add(key);
      const { board: after, cleared, rows } = clearLines(locked);
      const stats = boardStats(after);
      const outcome = {
        id: `p${placements.length}`,
        piece,
        rotation,
        x,
        y,
        cells: state.cells.map(([cx, cy]) => [x + cx, y + cy]),
        linesCleared: cleared,
        clearedRows: rows,
        holesCreated: Math.max(0, stats.holes - before.holes),
        holesRemoved: Math.max(0, before.holes - stats.holes),
        heightDelta: stats.maxHeight - before.maxHeight,
        before,
        after: stats,
        afterBoard: after,
      };
      outcome.heuristic = heuristicScore(outcome);
      placements.push(outcome);
    }
  });
  return placements;
}

// ---- Descriptions for Jev -------------------------------------------------
// Jev reads text, not numbers. Every feature becomes a short named bucket so
// the model compares situations rather than doing arithmetic.

export function describeLines(n) {
  return ["none", "one line", "two lines", "three lines", "four lines (a Tetris)"][n] ?? `${n} lines`;
}

export function describeHoles(n) {
  if (n === 0) return "none";
  if (n === 1) return "one hole";
  if (n === 2) return "two holes";
  return "three or more holes";
}

export function describeHeight(maxHeight) {
  if (maxHeight <= 4) return "very low";
  if (maxHeight <= 8) return "low";
  if (maxHeight <= 12) return "medium";
  if (maxHeight <= 15) return "high";
  return "dangerously high, close to the top";
}

export function describeSurface(bump) {
  if (bump <= 4) return "flat";
  if (bump <= 9) return "slightly uneven";
  if (bump <= 16) return "bumpy";
  return "very jagged";
}

export function describeWells(list) {
  if (list.length === 0) return "no deep wells";
  if (list.length === 1) return `one deep well at column ${list[0].column + 1}`;
  return `${list.length} deep wells`;
}

function describeWhere(placement) {
  const xs = placement.cells.map((c) => c[0]);
  const left = Math.min(...xs) + 1;
  const right = Math.max(...xs) + 1;
  return left === right ? `column ${left}` : `columns ${left}-${right}`;
}

function describeHeightChange(placement) {
  const d = placement.heightDelta;
  if (placement.linesCleared > 0 && d < 0) return "stack gets lower";
  if (d <= 0) return "stack does not get taller";
  if (d === 1) return "stack grows by one row";
  return "stack grows by several rows";
}

// The Choice criteria entry for one placement. Same field names on every
// option so Jev can compare them directly.
export function describePlacement(p) {
  const holes = p.holesCreated;
  return {
    where: describeWhere(p),
    lines_cleared: describeLines(p.linesCleared),
    holes_created: describeHoles(holes),
    holes_uncovered: p.holesRemoved > 0 ? describeHoles(p.holesRemoved) : "none",
    stack_height_after: describeHeight(p.after.maxHeight),
    height_change: describeHeightChange(p),
    surface_after: describeSurface(p.after.bumpiness),
    wells_after: describeWells(p.after.wells),
  };
}

export function boardToText(board) {
  return board.map((row) => row.map((c) => (c ? "#" : ".")).join(""));
}

// ---- Garbage (versus mode) --------------------------------------------------------
// Pushes `count` garbage rows in from the bottom, each full except one gap.
// Returns { board, overflow }: overflow is true when the shift pushed filled
// cells out of the top, which ends the receiving player's game.
export const GARBAGE = "G";

export function addGarbage(board, count, gapColumn) {
  if (count <= 0) return { board, overflow: false };
  const n = Math.min(count, HEIGHT);
  let overflow = false;
  for (let y = 0; y < n; y++) if (board[y].some((c) => c)) overflow = true;
  const rows = board.slice(n).map((r) => r.slice());
  for (let i = 0; i < n; i++) {
    const row = new Array(WIDTH).fill(GARBAGE);
    row[gapColumn] = null;
    rows.push(row);
  }
  return { board: rows, overflow };
}

// ---- Random bag ------------------------------------------------------------

// Small seeded PRNG (mulberry32) so two players can share one piece sequence.
export function seededRandom(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeBag(random = Math.random) {
  const bag = PIECE_NAMES.slice();
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  return bag;
}

export function scoreForLines(lines, level) {
  return [0, 100, 300, 500, 800][lines] * level;
}
