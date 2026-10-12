// Shared request/response helpers used by both /api/v1 and the browser
// routes. Centralised here so size limits and validation stay in lockstep.

import { MAX_CONTENT_BYTES, MAX_TITLE_LENGTH } from "../types.js";

const enc = new TextEncoder();

export function bytesOf(s: string): number {
  return enc.encode(s).length;
}

export function originUrl(c: { req: { url: string } }): string {
  return new URL(c.req.url).origin;
}

// Telegram Instant View link for a page: works for any template hash straight
// from the IV editor, no approval needed. Returns null when not configured.
export function telegramIvUrl(pageUrl: string, rhash: string | undefined): string | null {
  const h = (rhash ?? "").trim();
  if (!/^[0-9a-f]{6,64}$/i.test(h)) return null;
  const u = new URL("https://t.me/iv");
  u.searchParams.set("url", pageUrl);
  u.searchParams.set("rhash", h);
  return u.toString();
}

export function normalizeTitle(s: string): string {
  return s.trim().slice(0, MAX_TITLE_LENGTH);
}

export type FieldError = { message: string; status: 400 | 413 };

export function validateTitleField(v: unknown): FieldError | null {
  if (v === undefined) return null;
  if (typeof v !== "string") return { message: "title must be a string", status: 400 };
  if (v.length > MAX_TITLE_LENGTH) {
    return { message: `title exceeds ${MAX_TITLE_LENGTH} chars`, status: 400 };
  }
  return null;
}

export function validateContentField(v: unknown): FieldError | null {
  if (v === undefined) return null;
  if (typeof v !== "string") return { message: "content must be a string", status: 400 };
  if (bytesOf(v) > MAX_CONTENT_BYTES) {
    return { message: `content exceeds ${MAX_CONTENT_BYTES} bytes`, status: 413 };
  }
  return null;
}
