// HMAC-signed owner cookie with constant-time comparison.
// Cookie format: "<uid>.<base64url-hmac>".

import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { newOwnerId } from "./slug.js";
import type { AppEnv } from "../types.js";

const COOKIE_NAME = "pencil_uid";
// RFC 6265bis caps Max-Age at 400 days; modern browsers enforce this
// regardless of what we set. We refresh on every owner-cookie visit so the
// effective lifetime is "indefinite as long as you keep visiting".
const COOKIE_MAX_AGE = 60 * 60 * 24 * 400;

// Hard cap on the raw `pencil_uid` cookie value so we never burn HMAC time
// on attacker-supplied megabytes. Real values are 24 chars + "." + 43 chars
// of base64url-encoded SHA-256 = 68 chars; 128 leaves comfortable headroom
// for any future format change without inviting CPU DoS.
const MAX_COOKIE_VALUE_LENGTH = 128;

const enc = new TextEncoder();

function b64urlEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signCookie(uid: string, secret: string): Promise<string> {
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(uid));
  return `${uid}.${b64urlEncode(sig)}`;
}

export async function verifyCookie(value: string, secret: string): Promise<string | null> {
  // Length cap before any crypto: an attacker who sends a 1 MB cookie value
  // would otherwise force HMAC over the whole thing on every request.
  if (value.length === 0 || value.length > MAX_COOKIE_VALUE_LENGTH) return null;
  const dot = value.lastIndexOf(".");
  if (dot < 1 || dot >= value.length - 1) return null;
  const uid = value.slice(0, dot);
  // Recompute the expected signature and compare in constant time. This
  // sidesteps BufferSource type wrangling around `subtle.verify` while
  // giving the same security property.
  const expected = await signCookie(uid, secret);
  return constantTimeEqual(value, expected) ? uid : null;
}

// Constant-time equality. For equal-length inputs we use the platform's
// `crypto.subtle.timingSafeEqual` where available; otherwise we fall back to
// a hand-rolled XOR loop. Length mismatches return false immediately —
// disclosing length on a credential-shaped input is not a meaningful side
// channel here (HMACs are fixed-length and `pencil_uid` cookies are too).
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  const subtle = (crypto as unknown as { subtle?: { timingSafeEqual?: (a: BufferSource, b: BufferSource) => boolean } }).subtle;
  if (subtle && typeof subtle.timingSafeEqual === "function") {
    return subtle.timingSafeEqual(ab, bb);
  }
  let diff = 0;
  for (let i = 0; i < ab.length; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

// Read or mint the owner cookie for this request. Sets the cookie on the
// response if it was missing, invalid, or unsigned. Resulting uid is stored
// in c.var.ownerId.
export async function ensureOwnerCookie(c: Context<AppEnv>): Promise<string> {
  const raw = getCookie(c, COOKIE_NAME);
  let uid: string | null = null;
  if (raw) {
    uid = await verifyCookie(raw, c.env.COOKIE_SECRET);
  }
  let isNew = false;
  if (!uid) {
    uid = newOwnerId();
    isNew = true;
    const signed = await signCookie(uid, c.env.COOKIE_SECRET);
    setCookie(c, COOKIE_NAME, signed, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: COOKIE_MAX_AGE,
    });
  }
  c.set("ownerId", uid);
  c.set("isNewOwner", isNew);
  return uid;
}
