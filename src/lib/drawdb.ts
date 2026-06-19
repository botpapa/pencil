// D1 helpers for the `drawings` table (draw.pencil.md). Mirrors lib/db.ts but
// for canvas scenes.

import { newSlug } from "./slug.js";
import type { DrawingRow, DrawingSummary } from "../types.js";

const MAX_INSERT_ATTEMPTS = 8;

function isUniqueConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(msg);
}

export async function getDrawing(db: D1Database, slug: string): Promise<DrawingRow | null> {
  const row = await db
    .prepare(
      "SELECT slug, title, scene, thumb_key, owner_id, views, created_at, updated_at, password_hash FROM drawings WHERE slug = ?",
    )
    .bind(slug)
    .first<DrawingRow>();
  return row ?? null;
}

export async function createDrawingWithUniqueSlug(
  db: D1Database,
  d: { title: string; scene: string; thumb_key: string | null; owner_id: string; password_hash?: string | null },
): Promise<{ slug: string; created_at: number }> {
  let lastErr: unknown;
  for (let i = 0; i < MAX_INSERT_ATTEMPTS; i++) {
    const slug = newSlug();
    const now = Date.now();
    try {
      await db
        .prepare(
          "INSERT INTO drawings (slug, title, scene, thumb_key, owner_id, views, created_at, updated_at, password_hash) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)",
        )
        .bind(slug, d.title, d.scene, d.thumb_key, d.owner_id, now, now, d.password_hash ?? null)
        .run();
      return { slug, created_at: now };
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      lastErr = err;
    }
  }
  throw new Error(`slug allocation failed after ${MAX_INSERT_ATTEMPTS} attempts: ${String(lastErr)}`);
}

export async function updateDrawing(
  db: D1Database,
  slug: string,
  patch: { title?: string; scene?: string; thumb_key?: string | null },
): Promise<number> {
  const now = Date.now();
  const sets: string[] = [];
  const binds: (string | number | null)[] = [];
  if (patch.title !== undefined) {
    sets.push("title = ?");
    binds.push(patch.title);
  }
  if (patch.scene !== undefined) {
    sets.push("scene = ?");
    binds.push(patch.scene);
  }
  if (patch.thumb_key !== undefined) {
    sets.push("thumb_key = ?");
    binds.push(patch.thumb_key);
  }
  sets.push("updated_at = ?");
  binds.push(now);
  binds.push(slug);
  await db.prepare(`UPDATE drawings SET ${sets.join(", ")} WHERE slug = ?`).bind(...binds).run();
  return now;
}

export async function deleteDrawing(db: D1Database, slug: string): Promise<void> {
  await db.prepare("DELETE FROM drawings WHERE slug = ?").bind(slug).run();
}

export async function incrementDrawingViews(db: D1Database, slug: string): Promise<void> {
  await db.prepare("UPDATE drawings SET views = views + 1 WHERE slug = ?").bind(slug).run();
}

export async function setDrawingPassword(
  db: D1Database,
  slug: string,
  passwordHash: string | null,
): Promise<void> {
  await db
    .prepare("UPDATE drawings SET password_hash = ?, updated_at = ? WHERE slug = ?")
    .bind(passwordHash, Date.now(), slug)
    .run();
}

export async function listDrawingsByOwner(db: D1Database, ownerId: string): Promise<DrawingSummary[]> {
  const { results } = await db
    .prepare(
      "SELECT slug, title, views, created_at, updated_at, (password_hash IS NOT NULL) AS protected FROM drawings WHERE owner_id = ? ORDER BY created_at DESC",
    )
    .bind(ownerId)
    .all<DrawingSummary>();
  return results ?? [];
}
