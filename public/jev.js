// Builds the TypeSafe request for one Tetris move and reads the answer.
//
// One request per piece, following the speculative fan-out pattern: the
// placement Choice is the question that drives the game; the others are
// cheap extra judgments over the same state that the UI displays.

import { boardToText, describePlacement, describeHeight, describeSurface, describeHoles } from "./tetris.js";

export let MODEL = "jev-latest";

// Solo-via-gateway: the server reports which model id to send
// (jev-latest direct, typesafe-ai/jev on Vercel AI Gateway).
// Call once on page load; falls back to jev-latest when offline.
export async function syncModelFromServer() {
  try {
    const res = await fetch("api/config", { cache: "no-store" });
    if (!res.ok) return MODEL;
    const cfg = await res.json();
    if (typeof cfg.model === "string" && cfg.model) MODEL = cfg.model;
  } catch {
    /* static hosting or file://: keep default */
  }
  return MODEL;
}

export function setModel(name) {
  if (typeof name === "string" && name) MODEL = name;
}

export const STRATEGY_OPTIONS = {
  build_clean: "The stack is low and tidy. Keep building a flat surface and wait for a chance to clear several lines at once.",
  clear_lines: "Lines can be cleared soon. Take clears as they come and keep the stack from growing.",
  repair_surface: "The surface is jagged or has holes. Prefer placements that smooth it out or uncover holes, even without clearing lines.",
  survive: "The stack is close to the top. Take any placement that lowers or does not raise the stack, even if it is ugly.",
};

export const HEALTH_LEVELS = [
  "Clean: low, flat stack with no holes",
  "Fine: some unevenness or a hole or two, plenty of room",
  "Rough: several holes or a jagged surface, room is shrinking",
  "Critical: stack near the top, the game may be lost within a few pieces",
];

export function buildState({ board, piece, nextPiece, stats, linesCleared }) {
  return {
    game: {
      rules: "Standard Tetris. Board is 10 columns wide and 20 rows tall. Rows fill left to right; a full row disappears. The game is lost when the stack reaches the top.",
      board_rows_top_to_bottom: boardToText(board),
      legend: "# is a filled cell, . is an empty cell. The first row is the top of the board.",
      column_heights_left_to_right: stats.heights,
      stack_height: describeHeight(stats.maxHeight),
      holes_in_stack: describeHoles(stats.holes),
      surface: describeSurface(stats.bumpiness),
      current_piece: piece,
      next_piece: nextPiece,
      lines_cleared_so_far: linesCleared,
    },
  };
}

export function buildQuestions(placements) {
  const criteria = {};
  for (const p of placements) criteria[p.id] = describePlacement(p);
  return {
    placement: {
      type: "choice",
      instructions: {
        question: "Which placement of `game.current_piece` should the player choose? Each option describes the board after that placement.",
        priorities: [
          "Clearing lines is good. Clearing more lines at once is better.",
          "Do not create holes. A placement with holes_created of none beats one that creates holes, unless the one with holes clears far more lines or the stack is dangerously high.",
          "Keep the stack low. Prefer a lower stack_height_after and a height_change that does not grow the stack.",
          "Keep the surface flat. Prefer surface_after of flat over slightly uneven, bumpy, or very jagged.",
          "One deep well is acceptable because the next I piece can fill it. Several deep wells are bad.",
          "When the stack is dangerously high, survival matters more than a clean surface.",
        ],
      },
      criteria,
    },
    strategy: {
      type: "choice",
      instructions: "Looking at `game`, which strategy fits the current situation best for the next few pieces?",
      criteria: STRATEGY_OPTIONS,
    },
    board_health: {
      type: "score",
      instructions: "How healthy is the stack in `game` for a Tetris player who wants to keep playing for a long time?",
      criteria: HEALTH_LEVELS,
    },
    next_piece_fits: {
      type: "noul",
      instructions: "Given `game.column_heights_left_to_right` and `game.surface`, is there an obvious clean spot for `game.next_piece` after this move, without creating holes?",
      criteria: {
        true: "A clean spot is easy to see.",
        false: "The next piece will be awkward to place.",
      },
    },
  };
}

export function buildRequest(gameInfo, placements) {
  return {
    state: buildState(gameInfo),
    model: MODEL,
    questions: buildQuestions(placements),
  };
}

// Statuses worth retrying: rate limits (429/529) and transient gateway or
// upstream failures (502/503/504). The AI Gateway returns 503 when it is
// momentarily overloaded, which usually clears within seconds.
const RETRY_STATUSES = new Set([429, 502, 503, 504, 529]);

export class JevError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

function errorMessage(body, status) {
  const raw = body?.detail?.message ?? body?.error ?? body?.message ?? body?.raw;
  if (typeof raw === "string" && raw) return raw;
  if (raw !== undefined && raw !== null) {
    try {
      return JSON.stringify(raw);
    } catch {
      /* fall through to HTTP status */
    }
  }
  return `HTTP ${status}`;
}

// Calls the local proxy (server.mjs), which forwards to the model with the
// server's key. Retries rate limits and transient gateway errors with
// exponential backoff plus jitter, honoring Retry-After when present.
export async function askJev(request, apiKey, { signal, maxAttempts = 5 } = {}) {
  let delay = 600;
  for (let attempt = 1; ; attempt++) {
    let res;
    const started = performance.now();
    try {
      const headers = { "Content-Type": "application/json" };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      res = await fetch("api/systemone", {
        method: "POST",
        headers,
        body: JSON.stringify(request),
        signal,
      });
    } catch (err) {
      // Aborted by the game (pause/reset): stop immediately, never retry.
      if (signal?.aborted) throw err;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, delay + Math.random() * 250));
        delay = Math.min(delay * 2, 5000);
        continue;
      }
      throw new JevError(`Network error: ${err.message}`, 0, null);
    }
    const latencyMs = performance.now() - started;
    let body = null;
    const text = await res.text();
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }
    if (res.ok) return { response: body, latencyMs };
    if (RETRY_STATUSES.has(res.status) && attempt < maxAttempts) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait =
        (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : delay) + Math.random() * 250;
      await abortableWait(wait, signal);
      delay = Math.min(delay * 2, 5000);
      continue;
    }
    throw new JevError(errorMessage(body, res.status), res.status, body);
  }
}

// Sleep that rejects immediately if the game is paused/reset mid-wait.
function abortableWait(ms, signal) {
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

// Reads the Choice answer and maps it back onto the placements. Falls back
// to the first placement if the answer somehow names an unknown option.
export function pickPlacement(response, placements) {
  const answer = response?.answers?.placement;
  if (!answer || answer.type !== "choice") throw new JevError("Response has no placement choice", 500, response);
  const byId = new Map(placements.map((p) => [p.id, p]));
  const ranked = Object.entries(answer.probabilities || {})
    .filter(([id]) => byId.has(id))
    .sort((a, b) => b[1] - a[1])
    .map(([id, probability]) => ({ placement: byId.get(id), probability }));
  const chosen = byId.get(answer.choice) || ranked[0]?.placement || placements[0];
  return { chosen, ranked, confidence: answer.confidence ?? 0 };
}
