import type { PageRow } from "../types.js";

export async function getPage(db: D1Database, slug: string): Promise<PageRow | null> {
  const row = await db
    .prepare(
      "SELECT slug, title, content, owner_id, views, created_at, updated_at, indexable FROM pages WHERE slug = ?",
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
  },
): Promise<PageRow> {
  const now = Date.now();
  await db
    .prepare(
      "INSERT INTO pages (slug, title, content, owner_id, views, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
    )
    .bind(page.slug, page.title, page.content, page.owner_id, now, now)
    .run();
  return {
    ...page,
    views: 0,
    created_at: now,
    updated_at: now,
    indexable: 0,
  };
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
