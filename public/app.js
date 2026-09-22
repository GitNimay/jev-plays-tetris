import {
  WIDTH,
  HEIGHT,
  PIECES,
  PIECE_COLORS,
  emptyBoard,
  enumeratePlacements,
  lockPiece,
  clearLines,
  boardStats,
  collides,
  makeBag,
  scoreForLines,
  describePlacement,
} from "./tetris.js";
import { buildRequest, askJev, pickPlacement, JevError, syncModelFromServer, STRATEGY_OPTIONS, HEALTH_LEVELS } from "./jev.js";

const $ = (id) => document.getElementById(id);
const PRICE_PER_TOKEN = 0.042 / 1_000_000; // $0.042 per million input tokens (docs.typesafe.ai/models)

// ---- DOM ------------------------------------------------------------------
const canvas = $("board");
const ctx = canvas.getContext("2d");
const nextCanvas = $("next");
const nextCtx = nextCanvas.getContext("2d");
const CELL = canvas.width / WIDTH;

const ui = {
  status: $("status"),
  overlay: $("overlay"),
  start: $("start"),
  pause: $("pause"),
  reset: $("reset"),
  speed: $("speed"),
  score: $("score"),
  lines: $("lines"),
  level: $("level"),
  pieces: $("pieces"),
  calls: $("calls"),
  latency: $("latency"),
  tokens: $("tokens"),
  cost: $("cost"),
  agree: $("agree"),
  chosen: $("chosen"),
  decisionTitle: $("decisionTitle"),
  alternatives: $("alternatives"),
  strategy: $("strategy"),
  healthFill: $("healthFill"),
  healthValue: $("healthValue"),
  healthLegend: $("healthLegend"),
  nextFitFill: $("nextFitFill"),
  nextFitValue: $("nextFitValue"),
  reqJson: $("reqJson"),
  resJson: $("resJson"),
  error: $("error"),
};

// ---- Game state -------------------------------------------------------------
const game = {
  board: emptyBoard(),
  bag: [],
  current: null,
  next: null,
  score: 0,
  lines: 0,
  pieces: 0,
  over: false,
  running: false,
  active: null, // { piece, rotation, x, y } while animating a drop
  ghosts: [], // [{ cells, probability, chosen }]
  flash: [], // row indexes being cleared
};

const stats = { calls: 0, latency: 0, tokens: 0, agreements: 0, decisions: 0 };

let abort = null;
// False when the page is served without its proxy (static hosting, file://).
// The key lives in the server's .env, so the page sends no key.
let backendAvailable = true;
const NO_BACKEND_MESSAGE =
  "This copy of the page has no proxy server, so it cannot reach the model. " +
  "Run `npm start` locally or deploy the repo first.";

function nextPiece() {
  if (game.bag.length === 0) game.bag = makeBag();
  return game.bag.pop();
}

function resetGame() {
  game.board = emptyBoard();
  game.bag = [];
  game.current = nextPiece();
  game.next = nextPiece();
  game.score = 0;
  game.lines = 0;
  game.pieces = 0;
  game.over = false;
  game.active = null;
  game.ghosts = [];
  game.flash = [];
  Object.assign(stats, { calls: 0, latency: 0, tokens: 0, agreements: 0, decisions: 0 });
  ui.overlay.classList.add("hidden");
  ui.chosen.innerHTML = '<span class="muted">No move yet.</span>';
  ui.alternatives.innerHTML = "";
  ui.decisionTitle.textContent = "Move";
  renderReads(null);
  ui.reqJson.textContent = "–";
  ui.resJson.textContent = "–";
  hideError();
  renderStats();
  draw();
  drawNext();
}

// ---- Rendering ----------------------------------------------------------------
function drawCell(x, y, color, alpha = 1, outline = false) {
  const px = x * CELL;
  const py = y * CELL;
  ctx.globalAlpha = alpha;
  if (outline) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(px + 2, py + 2, CELL - 4, CELL - 4);
  } else {
    ctx.fillStyle = color;
    ctx.fillRect(px + 1, py + 1, CELL - 2, CELL - 2);
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.fillRect(px + 1, py + 1, CELL - 2, 4);
  }
  ctx.globalAlpha = 1;
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#e3e3e3";
  ctx.lineWidth = 1;
  for (let x = 1; x < WIDTH; x++) {
    ctx.beginPath();
    ctx.moveTo(x * CELL, 0);
    ctx.lineTo(x * CELL, canvas.height);
    ctx.stroke();
  }
  for (let y = 1; y < HEIGHT; y++) {
    ctx.beginPath();
    ctx.moveTo(0, y * CELL);
    ctx.lineTo(canvas.width, y * CELL);
    ctx.stroke();
  }
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const c = game.board[y][x];
      if (c) drawCell(x, y, game.flash.includes(y) ? "#ffffff" : PIECE_COLORS[c]);
    }
  }
  for (const g of game.ghosts) {
    const color = g.chosen ? PIECE_COLORS[game.current] : "#8a8a8a";
    const alpha = g.chosen ? 0.9 : Math.max(0.15, Math.min(0.6, g.probability * 1.5));
    for (const [x, y] of g.cells) drawCell(x, y, color, alpha, true);
    if (!g.chosen && g.probability >= 0.05) {
      const [lx, ly] = g.cells.reduce((a, b) => (b[1] < a[1] || (b[1] === a[1] && b[0] < a[0]) ? b : a));
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = "#525252";
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.fillText(`${Math.round(g.probability * 100)}%`, lx * CELL + 4, ly * CELL + 12);
      ctx.globalAlpha = 1;
    }
  }
  if (game.active) {
    const { piece, rotation, x, y } = game.active;
    for (const [cx, cy] of PIECES[piece][rotation].cells) {
      if (y + cy >= 0) drawCell(x + cx, y + cy, PIECE_COLORS[piece]);
    }
  }
}

function drawNext() {
  nextCtx.clearRect(0, 0, nextCanvas.width, nextCanvas.height);
  if (!game.next) return;
  const state = PIECES[game.next][0];
  const size = 12;
  const ox = (nextCanvas.width - state.width * size) / 2;
  const oy = (nextCanvas.height - state.height * size) / 2;
  nextCtx.fillStyle = PIECE_COLORS[game.next];
  for (const [cx, cy] of state.cells) nextCtx.fillRect(ox + cx * size + 1, oy + cy * size + 1, size - 2, size - 2);
}

function renderStats() {
  ui.score.textContent = game.score;
  ui.lines.textContent = game.lines;
  ui.level.textContent = level();
  ui.pieces.textContent = game.pieces;
  ui.calls.textContent = stats.calls;
  ui.latency.textContent = stats.calls ? `${Math.round(stats.latency / stats.calls)} ms` : "–";
  ui.tokens.textContent = stats.tokens.toLocaleString();
  ui.cost.textContent = `$${(stats.tokens * PRICE_PER_TOKEN).toFixed(4)}`;
  ui.agree.textContent = stats.decisions ? `${Math.round((100 * stats.agreements) / stats.decisions)}%` : "–";
}

function level() {
  return Math.floor(game.lines / 10) + 1;
}

function setStatus(text, cls = "") {
  ui.status.textContent = text;
  ui.status.className = `status ${cls}`;
}

function showError(message) {
  ui.error.textContent = message;
  ui.error.classList.remove("hidden");
}

function hideError() {
  ui.error.classList.add("hidden");
}

function barRow(name, probability, chosen = false, fillClass = "") {
  const pct = Math.round(probability * 100);
  return `<div class="bar-row${chosen ? " chosen" : ""}">
    <span class="name" title="${name}">${name}</span>
    <div class="bar"><div class="bar-fill ${fillClass}" style="width:${Math.max(1, pct)}%"></div></div>
    <span class="bar-value">${probability.toFixed(2)}</span>
  </div>`;
}

function describeForHumans(p) {
  const d = describePlacement(p);
  const lines = p.linesCleared ? `clears ${d.lines_cleared}` : "no clear";
  const holes = p.holesCreated ? d.holes_created : "no holes";
  return `${d.where} · ${lines} · ${holes}`;
}

function renderDecision(decision) {
  const { chosen, ranked, confidence } = decision;
  const d = describePlacement(chosen);
  const conf = `confidence ${confidence.toFixed(2)}`;
  ui.decisionTitle.textContent = "Move";
  ui.chosen.innerHTML = `<strong>${chosen.piece}</strong> → ${d.where}
    <span class="muted">(${conf})</span>
    <div class="desc">
      <span>lines <b>${d.lines_cleared}</b></span>
      <span>holes <b>${d.holes_created}</b></span>
      <span>height <b>${d.stack_height_after}</b></span>
      <span>surface <b>${d.surface_after}</b></span>
      <span>wells <b>${d.wells_after}</b></span>
    </div>`;
  ui.alternatives.innerHTML = ranked
    .slice(0, 6)
    .map((r) => barRow(describeForHumans(r.placement), r.probability, r.placement === chosen))
    .join("");
}

function renderReads(answers) {
  if (!answers) {
    ui.strategy.innerHTML = Object.keys(STRATEGY_OPTIONS).map((k) => barRow(k.replaceAll("_", " "), 0)).join("");
    ui.healthFill.style.left = "0%";
    ui.healthValue.textContent = "";
    ui.healthLegend.innerHTML = HEALTH_LEVELS.map((l) => `<span>${l.split(":")[0]}</span>`).join("");
    ui.nextFitFill.style.width = "0%";
    ui.nextFitValue.textContent = "";
    return;
  }
  const strategy = answers.strategy;
  if (strategy?.probabilities) {
    ui.strategy.innerHTML = Object.entries(strategy.probabilities)
      .sort((a, b) => b[1] - a[1])
      .map(([k, p]) => barRow(k.replaceAll("_", " "), p, k === strategy.choice))
      .join("");
  }
  const health = answers.board_health;
  if (typeof health?.score === "number") {
    const max = HEALTH_LEVELS.length - 1;
    ui.healthFill.style.left = `calc(${(100 * health.score) / max}% - 2px)`;
    const nearest = HEALTH_LEVELS[Math.round(health.score)] || "";
    ui.healthValue.textContent = `${health.score.toFixed(2)} · ${nearest.split(":")[0]}`;
  }
  const fit = answers.next_piece_fits;
  if (typeof fit?.noul === "number") {
    ui.nextFitFill.style.width = `${Math.round(fit.noul * 100)}%`;
    ui.nextFitValue.textContent = fit.noul.toFixed(2);
  }
}

// ---- Deciding -------------------------------------------------------------------
function heuristicDecision(placements) {
  const sorted = placements.slice().sort((a, b) => b.heuristic - a.heuristic);
  // Softmax over heuristic scores so the panel shows a distribution too.
  const max = sorted[0].heuristic;
  const weights = sorted.map((p) => Math.exp((p.heuristic - max) / 0.5));
  const sum = weights.reduce((a, b) => a + b, 0);
  return {
    chosen: sorted[0],
    ranked: sorted.map((p, i) => ({ placement: p, probability: weights[i] / sum })),
    confidence: weights[0] / sum,
  };
}

// Small gap between model calls so a fast game does not hammer the gateway.
// The drop animation already spaces most calls; this covers instant cases
// (e.g. only one legal placement, high speed slider).
const PACE_MS = 350;

async function jevDecision(placements, signal) {
  const request = buildRequest(
    {
      board: game.board,
      piece: game.current,
      nextPiece: game.next,
      stats: boardStats(game.board),
      linesCleared: game.lines,
    },
    placements,
  );
  ui.reqJson.textContent = JSON.stringify(request, null, 2);
  setStatus(`Choosing a spot for the ${game.current} (${placements.length} options)…`, "thinking");
  // No key is sent from the page; the server uses its .env fallback key.
  const { response, latencyMs } = await askJev(request, undefined, { signal });
  ui.resJson.textContent = JSON.stringify(response, null, 2);
  stats.calls += 1;
  stats.latency += latencyMs;
  stats.tokens += response?.usage?.input_tokens || 0;
  renderReads(response.answers);
  return pickPlacement(response, placements);
}

// ---- Animating --------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Like sleep, but stops early when the game is paused/reset.
function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function stepDelay() {
  // slider 1..10 → 220ms..10ms per animation step
  const v = Number(ui.speed.value);
  return Math.round(240 - v * 23);
}

async function animateDrop(target, signal) {
  const { piece, rotation, x: tx, y: ty } = target;
  const spawnX = Math.min(3, WIDTH - PIECES[piece][rotation].width);
  const cells = PIECES[piece][rotation].cells;
  let x = collides(game.board, cells, spawnX, 0) ? tx : spawnX;
  const active = { piece, rotation, x, y: 0 };
  game.active = active;
  draw();
  while (active.x !== tx) {
    if (signal.aborted) return;
    await sleep(stepDelay());
    const nx = active.x + Math.sign(tx - active.x);
    active.x = collides(game.board, cells, nx, active.y) ? tx : nx;
    draw();
  }
  while (active.y < ty) {
    if (signal.aborted) return;
    await sleep(stepDelay() * 0.6);
    active.y += 1;
    draw();
  }
}

// ---- Main loop --------------------------------------------------------------------
async function playLoop(signal) {
  while (game.running && !game.over && !signal.aborted) {
    const placements = enumeratePlacements(game.board, game.current);
    if (placements.length === 0) {
      endGame();
      return;
    }
    const heuristic = heuristicDecision(placements);
    let decision;
    try {
      if (stats.decisions > 0) await abortableSleep(PACE_MS, signal);
      decision = await jevDecision(placements, signal);
      hideError();
    } catch (err) {
      if (signal.aborted) return;
      // The gateway stayed down after retries: play the heuristic's move for
      // this one piece so the game survives, and try the model again next piece.
      handleJevError(err, { fatal: false });
      decision = heuristic;
    }
    if (signal.aborted) return;

    stats.decisions += 1;
    if (decision.chosen === heuristic.chosen) stats.agreements += 1;
    renderDecision(decision);
    renderStats();

    game.ghosts = decision.ranked
      .slice(0, 4)
      .map((r) => ({ cells: r.placement.cells, probability: r.probability, chosen: r.placement === decision.chosen }));
    setStatus(`Dropping ${game.current} at ${describePlacement(decision.chosen).where}`);
    await animateDrop(decision.chosen, signal);
    if (signal.aborted) return;

    game.active = null;
    game.ghosts = [];
    const locked = lockPiece(game.board, decision.chosen.piece, decision.chosen.rotation, decision.chosen.x, decision.chosen.y);
    const { board, cleared, rows } = clearLines(locked);
    if (cleared > 0) {
      game.board = locked;
      game.flash = rows;
      draw();
      await sleep(Math.max(80, stepDelay() * 1.5));
      game.flash = [];
    }
    game.board = board;
    game.score += scoreForLines(cleared, level());
    game.lines += cleared;
    game.pieces += 1;
    game.current = game.next;
    game.next = nextPiece();
    renderStats();
    draw();
    drawNext();
    if (collides(game.board, PIECES[game.current][0].cells, 3, 0)) {
      endGame();
      return;
    }
  }
}

function endGame() {
  game.over = true;
  game.running = false;
  ui.overlay.textContent = `Game over · ${game.lines} lines · ${game.score} points`;
  ui.overlay.classList.remove("hidden");
  setStatus("Game over. Press Reset to play again.");
  ui.start.disabled = true;
  ui.pause.disabled = true;
}

// Shows what went wrong. With fatal=false the game keeps going with a
// fallback move, so the banner is a warning, not a stop sign.
function handleJevError(err, { fatal = true } = {}) {
  if (err instanceof JevError) {
    if (err.status === 401 || err.status === 403) {
      showError(`Model call rejected: ${err.message}`);
    } else if (err.status === 429) {
      showError(
        fatal
          ? "Rate limited. Wait a moment, then press Start."
          : `Rate limited (${err.status}). Heuristic plays this piece; retrying the model next piece.`,
      );
    } else if (err.status === 422) {
      showError(`Model rejected the request (422): ${JSON.stringify(err.detail)}`);
    } else if (err.status === 0) {
      showError(
        fatal
          ? `Model call failed: ${err.message}`
          : `Model unreachable (${err.message}). Heuristic plays this piece; retrying the model next piece.`,
      );
    } else {
      showError(
        fatal
          ? `Model call failed (${err.status}): ${err.message}`
          : `Model busy (${err.status}). Heuristic plays this piece; retrying the model next piece.`,
      );
    }
  } else {
    showError(`Model call failed: ${err.message}`);
  }
  if (fatal) setStatus("Paused after an error.", "error");
}

// ---- Controls -----------------------------------------------------------------------
function start() {
  if (game.over) return;
  if (!backendAvailable) {
    showError(NO_BACKEND_MESSAGE);
    return;
  }
  hideError();
  game.running = true;
  ui.start.disabled = true;
  ui.pause.disabled = false;
  abort = new AbortController();
  playLoop(abort.signal).finally(() => {
    if (!game.over) {
      ui.start.disabled = false;
      ui.pause.disabled = true;
    }
  });
}

function pause() {
  game.running = false;
  abort?.abort();
  abort = null;
  ui.start.disabled = game.over;
  ui.pause.disabled = true;
  if (!game.over) setStatus(ui.status.classList.contains("error") ? ui.status.textContent : "Paused.");
}

function reset() {
  pause();
  resetGame();
  ui.start.disabled = false;
  ui.start.textContent = "Start";
  setStatus("Ready. Press Start.");
}

// ---- Wiring ---------------------------------------------------------------------------
ui.start.addEventListener("click", start);
ui.pause.addEventListener("click", pause);
ui.reset.addEventListener("click", reset);
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  if (e.key === " ") {
    e.preventDefault();
    if (game.running) pause();
    else start();
  }
});

function markNoBackend() {
  backendAvailable = false;
  setStatus("No proxy server. Run `npm start` first, then reload.");
}

fetch("api/config", { cache: "no-store" })
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
  .then((cfg) => {
    if (typeof cfg.model === "string" && cfg.model) syncModelFromServer();
  })
  .catch(markNoBackend);

resetGame();
setStatus("Press Start.");
