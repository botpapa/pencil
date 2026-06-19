import type { PageRow, PageSummary } from "../types.js";

export async function getPage(db: D1Database, slug: string): Promise<PageRow | null> {
  const row = await db
    .prepare(
      "SELECT slug, title, content, owner_id, views, created_at, updated_at, indexable, password_hash FROM pages WHERE slug = ?",
    )
    .bind(slug)
    .first<PageRow>();
  return row ?? null;
}

export async function insertPage(
  db: D1Database,
  page: {
    slug: string;
    title: string;
    content: string;
    owner_id: string;
    password_hash?: string | null;
  },
): Promise<PageRow> {
  const now = Date.now();
  const passwordHash = page.password_hash ?? null;
  await db
    .prepare(
      "INSERT INTO pages (slug, title, content, owner_id, views, created_at, updated_at, password_hash) VALUES (?, ?, ?, ?, 0, ?, ?, ?)",
    )
    .bind(page.slug, page.title, page.content, page.owner_id, now, now, passwordHash)
    .run();
  return {
    slug: page.slug,
    title: page.title,
    content: page.content,
    owner_id: page.owner_id,
    views: 0,
    created_at: now,
    updated_at: now,
    indexable: 0,
    password_hash: passwordHash,
  };
}

// Owner's pages, newest first. Derives `protected` from password_hash so the
// caller never has to touch the hash itself.
export async function listPagesByOwner(
  db: D1Database,
  ownerId: string,
): Promise<PageSummary[]> {
  const { results } = await db
    .prepare(
      "SELECT slug, title, views, created_at, updated_at, (password_hash IS NOT NULL) AS protected FROM pages WHERE owner_id = ? ORDER BY created_at DESC",
    )
    .bind(ownerId)
    .all<PageSummary>();
  return results ?? [];
}

// Cheap indexed existence check (idx_pages_owner) for the footer "Pages" link.
export async function ownerHasPages(db: D1Database, ownerId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS one FROM pages WHERE owner_id = ? LIMIT 1")
    .bind(ownerId)
    .first<{ one: number }>();
  return row != null;
}

// Set (string) or clear (null) a page's password hash.
export async function setPasswordHash(
  db: D1Database,
  slug: string,
  passwordHash: string | null,
): Promise<void> {
  await db
    .prepare("UPDATE pages SET password_hash = ?, updated_at = ? WHERE slug = ?")
    .bind(passwordHash, Date.now(), slug)
    .run();
}

export async function deletePage(db: D1Database, slug: string): Promise<void> {
  await db.prepare("DELETE FROM pages WHERE slug = ?").bind(slug).run();
}

export async function setIndexable(
  db: D1Database,
  slug: string,
  indexable: 0 | 1,
): Promise<void> {
  await db
    .prepare("UPDATE pages SET indexable = ? WHERE slug = ?")
    .bind(indexable, slug)
    .run();
}

export async function updatePage(
  db: D1Database,
  slug: string,
  patch: { title?: string; content?: string },
): Promise<number> {
  const now = Date.now();
  const sets: string[] = [];
  const binds: (string | number)[] = [];
  if (patch.title !== undefined) {
    sets.push("title = ?");
    binds.push(patch.title);
  }
  if (patch.content !== undefined) {
    sets.push("content = ?");
    binds.push(patch.content);
  }
  sets.push("updated_at = ?");
  binds.push(now);
  binds.push(slug);
  await db.prepare(`UPDATE pages SET ${sets.join(", ")} WHERE slug = ?`).bind(...binds).run();
  return now;
}

export async function incrementViews(db: D1Database, slug: string): Promise<void> {
  await db.prepare("UPDATE pages SET views = views + 1 WHERE slug = ?").bind(slug).run();
}
