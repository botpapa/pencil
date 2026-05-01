// Request-body size enforcement helpers. Reject oversize requests by their
// declared `Content-Length` BEFORE we parse / read the body — otherwise an
// attacker can force the worker to buffer multi-MB payloads only to discard
// them after the fact (CPU + memory pressure on the way to the cap).
//
// Cloudflare's edge sets `Content-Length` for any request that has a body of
// known size, including all the ones we care about (JSON / form / text).
// Chunked requests without a length header are conservatively treated as
// oversize since we can't pre-validate them.

import type { Context } from "hono";
import type { AppEnv } from "../types.js";

export type LimitDecision =
  | { ok: true }
  | { ok: false; status: 413 | 411 | 400; message: string };

export function checkContentLength(
  c: Context<AppEnv>,
  maxBytes: number,
): LimitDecision {
  const raw = c.req.header("Content-Length");
  if (raw == null) {
    // No Content-Length on a write request — could be chunked transfer or a
    // misbehaving client. Reject rather than parse blindly.
    return {
      ok: false,
      status: 411,
      message: "Content-Length header required",
    };
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    return {
      ok: false,
      status: 400,
      message: "invalid Content-Length",
    };
  }
  if (n > maxBytes) {
    return {
      ok: false,
      status: 413,
      message: `payload exceeds ${maxBytes} bytes`,
    };
  }
  return { ok: true };
}

// Convenience: short-circuit a Hono handler with the appropriate error
// response if the request is oversize. Returns null when the request is
// within bounds (caller continues), otherwise returns a Response to return.
export function rejectIfOversize(
  c: Context<AppEnv>,
  maxBytes: number,
  format: "json" | "text" = "json",
): Response | null {
  const decision = checkContentLength(c, maxBytes);
  if (decision.ok) return null;
  if (format === "json") {
    return c.json({ error: decision.message }, decision.status);
  }
  return c.text(decision.message, decision.status);
}

// Cap on the markdown preview endpoint — smaller than MAX_CONTENT_BYTES
// because preview is always being typed live (no megabyte paste of an
// existing document) and is the only unauthenticated write endpoint.
export const PREVIEW_MAX_BYTES = 64 * 1024;
