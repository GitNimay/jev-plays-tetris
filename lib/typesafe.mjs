// Shared proxy logic: forwards one request to the TypeSafe API with the key
// the visitor supplied. Used by server.mjs (local) and api/*.js (Vercel).
//
// Solo-via-gateway: set AI_GATEWAY_API_KEY (or TYPESAFE_API_KEY) in .env and
// TYPESAFE_API_BASE=https://ai-gateway.vercel.sh/typesafe to call
// typesafe-ai/jev through Vercel AI Gateway with the same request shape.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Zero-dependency .env loader so `npm start` picks up keys without --env-file.
// Vercel hosted deploys inject env vars directly, so this is a no-op there.
// Existing process env always wins over .env.
try {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const envPath = join(root, ".env");
  if (existsSync(envPath)) {
    for (const rawLine of readFileSync(envPath, "utf8").split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(m[1] in process.env)) process.env[m[1]] = v;
    }
  }
} catch {
  /* .env is optional */
}

export const DIRECT_BASE = "https://api.typesafe.ai";
export const AI_GATEWAY_BASE = "https://ai-gateway.vercel.sh/typesafe";
const hasGatewayKey = Boolean(process.env.AI_GATEWAY_API_KEY);
export const TYPESAFE_BASE = process.env.TYPESAFE_API_BASE || (hasGatewayKey ? AI_GATEWAY_BASE : DIRECT_BASE);
export const IS_GATEWAY = TYPESAFE_BASE.includes("ai-gateway.vercel.sh");
// Optional host-provided fallback key; leave unset for a public deployment.
// Accepts either a direct TypeSafe key or a Vercel AI Gateway key.
export const SERVER_KEY = process.env.TYPESAFE_API_KEY || process.env.AI_GATEWAY_API_KEY || "";
// Model id the frontend should send. Direct API uses jev-latest,
// AI Gateway uses typesafe-ai/jev.
export const JEV_MODEL = process.env.JEV_MODEL || (IS_GATEWAY ? "typesafe-ai/jev" : "jev-latest");
export const UPSTREAM_TIMEOUT_MS = 30_000;
// Upstream statuses the proxy itself retries before answering the page.
const RETRY_UPSTREAM = new Set([502, 503, 504]);
const UPSTREAM_MAX_ATTEMPTS = 3;

export function keyFromAuthorization(header) {
  const match = /^Bearer\s+(.+)$/i.exec((header || "").trim());
  const key = match ? match[1].trim() : "";
  return key || SERVER_KEY;
}

// Returns { status, headers, body } ready to be written to the client.
export async function forwardToTypeSafe({ path, method, key, body }) {
  if (!key) {
    return jsonResult(401, {
      detail: { error_type: "authentication_error", message: "Enter your TypeSafe API key in the page first." },
    });
  }
  // The AI Gateway does not expose TypeSafe's /v1/models listing.
  // Answer key checks locally so Test still works in solo mode.
  if (IS_GATEWAY && path === "/v1/models" && method === "GET") {
    return jsonResult(200, { models: [{ name: JEV_MODEL }] });
  }
  // Normalize the model id: old pages send jev-latest to the direct API,
  // the gateway expects typesafe-ai/jev (and vice versa).
  let outboundBody = body;
  try {
    const parsed = typeof body === "string" ? JSON.parse(body) : body;
    if (parsed && typeof parsed === "object" && typeof parsed.model === "string") {
      if (IS_GATEWAY && (parsed.model === "jev-latest" || parsed.model === "jev-preview" || parsed.model.startsWith("jev-"))) {
        outboundBody = JSON.stringify({ ...parsed, model: "typesafe-ai/jev" });
      } else if (!IS_GATEWAY && parsed.model === "typesafe-ai/jev") {
        outboundBody = JSON.stringify({ ...parsed, model: "jev-latest" });
      } else if (typeof outboundBody !== "string") {
        outboundBody = JSON.stringify(parsed);
      }
    }
  } catch {
    /* leave body untouched; upstream will reject it */
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    // Retry fast transient failures (gateway 502/503/504) here so one
    // overloaded moment does not fail the move. Slow/hard failures pass
    // through to the page, which has its own retry loop.
    let upstream = null;
    let waitMs = 800;
    for (let attempt = 1; ; attempt++) {
      upstream = await fetch(`${TYPESAFE_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: method === "POST" ? outboundBody : undefined,
        signal: controller.signal,
      });
      if (!RETRY_UPSTREAM.has(upstream.status) || attempt >= UPSTREAM_MAX_ATTEMPTS) break;
      const retryAfter = Number(upstream.headers.get("retry-after"));
      const wait = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : waitMs) + Math.random() * 200;
      await upstream.text().catch(() => {}); // drain before waiting
      await new Promise((r) => setTimeout(r, wait));
      waitMs = Math.min(waitMs * 2, 4000);
    }
    const text = await upstream.text();
    const headers = {
      "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    };
    const retryAfter = upstream.headers.get("retry-after");
    if (retryAfter) headers["Retry-After"] = retryAfter;
    const requestId = upstream.headers.get("x-typesafe-request-id");
    if (requestId) headers["X-Typesafe-Request-Id"] = requestId;
    return { status: upstream.status, headers, body: text };
  } catch (err) {
    const timedOut = err?.name === "AbortError";
    return jsonResult(timedOut ? 504 : 502, {
      detail: {
        error_type: timedOut ? "timeout" : "upstream_error",
        message: timedOut ? "TypeSafe API did not answer in time." : `Could not reach TypeSafe API: ${err.message}`,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

export function jsonResult(status, obj) {
  return {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    body: JSON.stringify(obj),
  };
}

export function configResult() {
  return jsonResult(200, { serverKeyConfigured: Boolean(SERVER_KEY), model: JEV_MODEL, viaGateway: IS_GATEWAY });
}

// Writes a result object to a Node http.ServerResponse.
export function writeResult(res, result) {
  res.writeHead(result.status, { ...result.headers, "Content-Length": Buffer.byteLength(result.body) });
  res.end(result.body);
}

// Reads a request body as a string. Vercel pre-parses JSON into req.body;
// plain Node leaves the stream untouched. Handles both.
export async function readJsonBody(req, maxBytes = 1_000_000) {
  if (req.body !== undefined && req.body !== null) {
    return typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Validates that the body is JSON; returns an error result or null.
export function validateJson(body) {
  try {
    JSON.parse(body);
    return null;
  } catch {
    return jsonResult(400, { detail: { error_type: "bad_request", message: "Body must be JSON." } });
  }
}
