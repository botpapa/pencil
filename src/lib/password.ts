// Per-page password protection.
//
// Hashing: PBKDF2-HMAC-SHA256 (the only KDF available in the Workers runtime —
// no native bcrypt/argon2). The stored value is self-describing so the work
// factor can change later without a schema migration:
//   pbkdf2$<iterations>$<salt-base64url>$<hash-base64url>
//
// Access: once a visitor enters the right password we mint a signed per-page
// cookie so they aren't re-prompted. The signature is over the slug AND the
// current password hash, so changing/removing the password invalidates every
// outstanding access cookie automatically.

import { signCookie, constantTimeEqual } from "./auth.js";

const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;
const enc = new TextEncoder();

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  let t = s.replaceAll("-", "+").replaceAll("_", "/");
  const pad = t.length % 4;
  if (pad) t += "=".repeat(4 - pad);
  const bin = atob(t);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pbkdf2(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    HASH_BITS,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64urlEncode(salt)}$${b64urlEncode(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number.parseInt(parts[1]!, 10);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;
  let salt: Uint8Array<ArrayBuffer>;
  try {
    salt = b64urlDecode(parts[2]!);
  } catch {
    return false;
  }
  const hash = await pbkdf2(password, salt, iterations);
  // Compare base64url strings (equal-length for matching hashes) in constant
  // time, reusing the auth module's helper.
  return constantTimeEqual(b64urlEncode(hash), parts[3]!);
}

// ---------- per-page access cookie ----------

export const PAGE_ACCESS_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

export function pageAccessCookieName(slug: string): string {
  return `pencil_pw_${slug}`;
}

function accessMessage(slug: string, passwordHash: string): string {
  // No dots in the payload (slug is alnum; the hash uses base64url + `$`), so
  // the signCookie "<payload>.<sig>" format stays unambiguous.
  return `pwaccess:${slug}:${passwordHash}`;
}

export async function signPageAccess(
  slug: string,
  passwordHash: string,
  secret: string,
): Promise<string> {
  return signCookie(accessMessage(slug, passwordHash), secret);
}

export async function verifyPageAccess(
  token: string | undefined,
  slug: string,
  passwordHash: string,
  secret: string,
): Promise<boolean> {
  if (!token) return false;
  const expected = await signPageAccess(slug, passwordHash, secret);
  return constantTimeEqual(token, expected);
}
