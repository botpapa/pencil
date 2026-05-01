// Owner-only stats. 404 for non-owners — never reveal existence to others.

import { Hono } from "hono";
import { ensureOwnerCookie } from "../lib/auth.js";
import { getPage } from "../lib/db.js";
import { isValidSlug } from "../lib/slug.js";
import { statsPage, notFoundPage } from "../views/stats.js";
import type { AppEnv } from "../types.js";

const app = new Hono<AppEnv>();

app.get("/:slug/stats", async (c) => {
  const slug = c.req.param("slug");
  if (!isValidSlug(slug)) return c.html(notFoundPage(), 404);
  const page = await getPage(c.env.DB, slug);
  if (!page) return c.html(notFoundPage(), 404);
  await ensureOwnerCookie(c);
  if (page.owner_id !== c.get("ownerId")) {
    return c.html(notFoundPage(), 404);
  }
  return c.html(
    statsPage(slug, page.title, page.views, page.created_at, page.indexable === 1),
  );
});

export default app;
