import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HEIGHT,
  WIDTH,
  PIECES,
  PIECE_NAMES,
  emptyBoard,
  enumeratePlacements,
  clearLines,
  countHoles,
  columnHeights,
  describePlacement,
  makeBag,
} from "../public/tetris.js";
import { buildRequest, pickPlacement, buildQuestions } from "../public/jev.js";

function boardFrom(rows) {
  // rows: bottom-most last, strings of '#' and '.', padded to HEIGHT at the top
  const board = emptyBoard();
  const offset = HEIGHT - rows.length;
  rows.forEach((row, i) => {
    for (let x = 0; x < WIDTH; x++) board[offset + i][x] = row[x] === "#" ? "X" : null;
  });
  return board;
}

test("every piece has 4 cells in every rotation", () => {
  for (const name of PIECE_NAMES) {
    for (const state of PIECES[name]) assert.equal(state.cells.length, 4, name);
  }
});

test("enumeratePlacements on an empty board covers every column", () => {
  const board = emptyBoard();
  const o = enumeratePlacements(board, "O");
  assert.equal(o.length, WIDTH - 1); // 9 distinct positions for a 2-wide block
  const i = enumeratePlacements(board, "I");
  assert.equal(i.length, 7 + 10); // 7 horizontal + 10 vertical
  const t = enumeratePlacements(board, "T");
  assert.equal(t.length, 2 * 8 + 2 * 9); // two 3-wide and two 2-wide rotations
  for (const p of [...o, ...i]) assert.equal(p.holesCreated, 0);
  // A T pointing down rests on its stem and covers two cells: real holes.
  const stemDown = t.find((p) => p.rotation === 2 && p.x === 0);
  assert.equal(stemDown.holesCreated, 2);
  for (const p of [...o, ...i, ...t]) {
    assert.equal(p.linesCleared, 0);
    for (const [x, y] of p.cells) {
      assert.ok(x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT);
    }
  }
});

test("an I piece dropped into a well clears four lines", () => {
  const rows = ["#########.", "#########.", "#########.", "#########."];
  const board = boardFrom(rows);
  const placements = enumeratePlacements(board, "I");
  const tetris = placements.find((p) => p.linesCleared === 4);
  assert.ok(tetris, "expected a four-line clear");
  assert.equal(tetris.x, 9);
  assert.equal(tetris.after.maxHeight, 0);
  assert.equal(describePlacement(tetris).lines_cleared, "four lines (a Tetris)");
  assert.equal(describePlacement(tetris).holes_created, "none");
});

test("holes are counted and reported when a placement covers a gap", () => {
  const board = boardFrom(["##..######"]);
  const placements = enumeratePlacements(board, "O");
  const covering = placements.find((p) => p.x === 1);
  assert.ok(covering);
  assert.equal(covering.holesCreated, 1); // O at x=1 rests on column 1, column 2 stays empty underneath
  assert.equal(describePlacement(covering).holes_created, "one hole");
  const clean = placements.find((p) => p.x === 2);
  assert.equal(clean.holesCreated, 0);
  assert.equal(clean.linesCleared, 1);
});

test("clearLines removes full rows and keeps the board height", () => {
  const board = boardFrom(["##########", "#....#####", "##########"]);
  const { board: after, cleared, rows } = clearLines(board);
  assert.equal(cleared, 2);
  assert.deepEqual(rows, [17, 19]);
  assert.equal(after.length, HEIGHT);
  assert.equal(countHoles(after), 0);
  assert.deepEqual(columnHeights(after), [1, 0, 0, 0, 0, 1, 1, 1, 1, 1]);
});

test("no placements when the board is full to the top", () => {
  const rows = Array.from({ length: HEIGHT }, () => "#########.");
  const board = boardFrom(rows);
  // Only the vertical I in the last column fits; every other piece is stuck.
  assert.equal(enumeratePlacements(board, "O").length, 0);
  assert.equal(enumeratePlacements(board, "I").length, 1);
});

test("makeBag returns every piece once", () => {
  const bag = makeBag(() => 0.42);
  assert.deepEqual([...bag].sort(), [...PIECE_NAMES].sort());
});

test("buildRequest produces one criteria entry per placement with stable fields", () => {
  const board = emptyBoard();
  const placements = enumeratePlacements(board, "L");
  const request = buildRequest(
    { board, piece: "L", nextPiece: "I", stats: placements[0].before, linesCleared: 0 },
    placements,
  );
  assert.equal(request.model, "jev-latest");
  assert.equal(Object.keys(request.questions.placement.criteria).length, placements.length);
  const fields = Object.keys(request.questions.placement.criteria.p0);
  for (const id of Object.keys(request.questions.placement.criteria)) {
    assert.deepEqual(Object.keys(request.questions.placement.criteria[id]), fields);
  }
  assert.equal(request.state.game.board_rows_top_to_bottom.length, HEIGHT);
  assert.equal(request.questions.strategy.type, "choice");
  assert.equal(request.questions.board_health.type, "score");
  assert.equal(request.questions.next_piece_fits.type, "noul");
  // Request should stay far below the 32k token state budget.
  assert.ok(JSON.stringify(request).length < 20_000);
});

test("pickPlacement maps the answer back and ranks alternatives", () => {
  const placements = enumeratePlacements(emptyBoard(), "T");
  const response = {
    answers: {
      placement: {
        type: "choice",
        choice: "p3",
        confidence: 0.4,
        probabilities: Object.fromEntries(placements.map((p) => [p.id, p.id === "p3" ? 0.5 : p.id === "p1" ? 0.3 : 0.01])),
      },
    },
  };
  const { chosen, ranked, confidence } = pickPlacement(response, placements);
  assert.equal(chosen.id, "p3");
  assert.equal(ranked[0].placement.id, "p3");
  assert.equal(ranked[1].placement.id, "p1");
  assert.equal(confidence, 0.4);
  assert.equal(Object.keys(buildQuestions(placements)).length, 4);
});

test("seeded bags give two players the same piece sequence", async () => {
  const { seededRandom } = await import("../public/tetris.js");
  const a = seededRandom(42);
  const b = seededRandom(42);
  const seqA = [...makeBag(a), ...makeBag(a), ...makeBag(a)];
  const seqB = [...makeBag(b), ...makeBag(b), ...makeBag(b)];
  assert.deepEqual(seqA, seqB);
  const c = seededRandom(43);
  assert.notDeepEqual([...makeBag(c)], seqA.slice(0, 7));
});

test("garbage rows push the stack up and report overflow at the top", async () => {
  const { addGarbage, GARBAGE } = await import("../public/tetris.js");
  const board = emptyBoard();
  board[HEIGHT - 1][0] = "X";
  const { board: after, overflow } = addGarbage(board, 2, 4);
  assert.equal(overflow, false);
  assert.equal(after.length, HEIGHT);
  assert.equal(after[HEIGHT - 3][0], "X"); // old bottom row moved up two
  assert.deepEqual(after[HEIGHT - 1].map((c) => (c ? 1 : 0)), [1, 1, 1, 1, 0, 1, 1, 1, 1, 1]);
  assert.equal(after[HEIGHT - 1][0], GARBAGE);
  const tall = emptyBoard();
  tall[1][3] = "X";
  assert.equal(addGarbage(tall, 2, 0).overflow, true);
  assert.equal(addGarbage(tall, 1, 0).overflow, false);
});
