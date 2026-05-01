import { customAlphabet } from "nanoid";
import { insertPage } from "./db.js";

const SLUG_ALPHABET = "23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
const OWNER_ALPHABET = "23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";

const slugGen = customAlphabet(SLUG_ALPHABET, 8);
const ownerGen = customAlphabet(OWNER_ALPHABET, 24);

export const SLUG_LENGTH = 8;

// Number of attempts before we give up on slug allocation. With a 56-char
// alphabet and 8 chars, the keyspace is ~96 billion entries — even at
// millions of pages, the per-attempt collision probability is ~10^-5, so
// 8 attempts is comfortable headroom.
const MAX_INSERT_ATTEMPTS = 8;

export function newSlug(): string {
  return slugGen();
}

export function newOwnerId(): string {
  return ownerGen();
}

export function isValidSlug(s: string): boolean {
  if (s.length !== SLUG_LENGTH) return false;
  for (const ch of s) {
    if (!SLUG_ALPHABET.includes(ch)) return false;
  }
  return true;
}

// Atomically allocate a unique slug + insert the page in a single round trip
// per attempt. D1 honours the `slug` PRIMARY KEY constraint, so a colliding
// INSERT is rejected at the DB layer; we catch and retry with a fresh slug.
//
// This replaces the older `slugExists()` + `insertPage()` two-step which
// was racy (two concurrent creates could pick the same slug between the
// existence check and the insert) AND had a fallback path that returned a
// 9-character slug that would 404 on every read endpoint.
export async function createPageWithUniqueSlug(
  db: D1Database,
  page: { title: string; content: string; owner_id: string },
): Promise<{ slug: string; created_at: number }> {
  let lastErr: unknown;
  for (let i = 0; i < MAX_INSERT_ATTEMPTS; i++) {
    const slug = newSlug();
    try {
      const row = await insertPage(db, { ...page, slug });
      return { slug, created_at: row.created_at };
    } catch (err) {
      // D1 surfaces UNIQUE / PRIMARY KEY violations as an Error whose message
      // includes "UNIQUE constraint failed". On any other error we bail
      // immediately rather than spin the loop.
      if (!isUniqueConstraintError(err)) throw err;
      lastErr = err;
    }
  }
  throw new Error(
    `slug allocation failed after ${MAX_INSERT_ATTEMPTS} attempts: ${String(lastErr)}`,
  );
}

function isUniqueConstraintError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(msg);
}
