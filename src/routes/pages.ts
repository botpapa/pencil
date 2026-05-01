// Browser-facing page routes:
//   GET  /                  home (empty editor)
//   POST /                  create page (form OR JSON)
//   GET  /:slug             reader
//   GET  /:slug/edit        editor (cookie-owner only; otherwise redirect)
//   PUT  /:slug             update page (cookie-owner only)
//   POST /api/preview       server-rendered markdown preview (editor client)
//
// View-counter and OG cache invalidation live here too.

import { Hono } from "hono";
import { ensureOwnerCookie } from "../lib/auth.js";
import { isBotUA } from "../lib/security.js";
import { getPage, updatePage, incrementViews, setIndexable } from "../lib/db.js";
import { isValidSlug, createPageWithUniqueSlug } from "../lib/slug.js";
import { renderMarkdown, plaintextExcerpt } from "../lib/markdown.js";
import { rejectIfOversize, PREVIEW_MAX_BYTES } from "../lib/limits.js";
import {
  bytesOf,
  originUrl,
  normalizeTitle,
  validateTitleField,
  validateContentField,
} from "../lib/http.js";
import { homePage } from "../views/home.js";
import { editorPage } from "../views/editor.js";
import { readerPage } from "../views/reader.js";
import { notFoundPage } from "../views/stats.js";
import { MAX_CONTENT_BYTES } from "../types.js";
import type { AppEnv } from "../types.js";

const app = new Hono<AppEnv>();

// ---------- helpers ----------

function validateBody(
  title: unknown,
  content: unknown,
): { title: string; content: string } | { error: string; status: 400 | 413 } {
  if (typeof title !== "string" || typeof content !== "string") {
    return { error: "title and content must be strings", status: 400 };
  }
  if (!content.trim()) {
    return { error: "content is required", status: 400 };
  }
  const titleErr = validateTitleField(title);
  if (titleErr) return { error: titleErr.message, status: titleErr.status };
  if (bytesOf(content) > MAX_CONTENT_BYTES) {
    return { error: `content exceeds ${MAX_CONTENT_BYTES} bytes`, status: 413 };
  }
  return { title: normalizeTitle(title), content };
}

// ---------- routes ----------

// Home: empty editor.
app.get("/", async (c) => {
  await ensureOwnerCookie(c);
  return c.html(homePage());
});

// Create.
app.post("/", async (c) => {
  const tooBig = rejectIfOversize(c, MAX_CONTENT_BYTES, "text");
  if (tooBig) return tooBig;

  await ensureOwnerCookie(c);
  const ownerId = c.get("ownerId");

  const ctype = c.req.header("Content-Type") ?? "";
  let title: unknown;
  let content: unknown;
  let wantsJson = false;

  if (ctype.includes("application/json")) {
    wantsJson = true;
    try {
      const j = (await c.req.json()) as { title?: unknown; content?: unknown };
      title = j.title ?? "";
      content = j.content;
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
  } else {
    const form = await c.req.formData();
    title = form.get("title") ?? "";
    content = form.get("content") ?? "";
  }

  const v = validateBody(title, content);
  if ("error" in v) {
    if (wantsJson) return c.json({ error: v.error }, v.status);
    return c.text(v.error, v.status);
  }

  const { slug } = await createPageWithUniqueSlug(c.env.DB, {
    title: v.title,
    content: v.content,
    owner_id: ownerId,
  });

  const url = `${originUrl(c)}/${slug}`;
  const editUrl = `${originUrl(c)}/${slug}/edit`;

  if (wantsJson) {
    return c.json({ slug, url, edit_url: editUrl }, 201);
  }

  // Form post: send the user straight to the published reader page.
  return c.redirect(`/${slug}`, 303);
});

// Reader.
app.get("/:slug", async (c) => {
  const slug = c.req.param("slug");
  if (!isValidSlug(slug)) return c.html(notFoundPage(), 404);
  const page = await getPage(c.env.DB, slug);
  if (!page) return c.html(notFoundPage(), 404);

  await ensureOwnerCookie(c);
  const ownerId = c.get("ownerId");
  const isOwner = page.owner_id === ownerId;

  // View counter — skip self, skip bots. Run in waitUntil. Log failures so
  // observability picks up DB issues instead of swallowing them silently.
  const ua = c.req.header("User-Agent");
  if (!isOwner && !isBotUA(ua)) {
    c.executionCtx.waitUntil(
      incrementViews(c.env.DB, slug).catch((err) => {
        console.warn("view counter increment failed", { slug, err: String(err) });
      }),
    );
  }

  const htmlContent = renderMarkdown(page.content);
  const description = plaintextExcerpt(page.content, 160) || `pencil.md page ${slug}`;
  const canonicalUrl = `${originUrl(c)}/${slug}`;
  const ogImage = `${originUrl(c)}/og/${slug}.png`;

  return c.html(
    readerPage({
      slug,
      title: page.title,
      htmlContent,
      description,
      ogImage,
      canonicalUrl,
      createdAt: page.created_at,
      isOwner,
      indexable: page.indexable === 1,
    }),
  );
});

// Toggle search-engine indexing for a page (cookie-owner only).
app.post("/:slug/settings/indexable", async (c) => {
  const slug = c.req.param("slug");
  if (!isValidSlug(slug)) return c.html(notFoundPage(), 404);
  const page = await getPage(c.env.DB, slug);
  if (!page) return c.html(notFoundPage(), 404);

  await ensureOwnerCookie(c);
  if (page.owner_id !== c.get("ownerId")) {
    return c.text("forbidden", 403);
  }

  const form = await c.req.formData();
  const raw = form.get("indexable");
  const indexable: 0 | 1 = raw === "1" ? 1 : 0;

  await setIndexable(c.env.DB, slug, indexable);

  // Indexing flag affects OG image (canonical URL meta), so bust the cache.
  c.executionCtx.waitUntil(
    c.env.OG_CACHE.delete(`og/${slug}.png`).catch((err) => {
      console.warn("og cache delete failed", { slug, err: String(err) });
    }),
  );

  return c.redirect(`/${slug}/stats`, 303);
});

// Editor (cookie-owner only).
app.get("/:slug/edit", async (c) => {
  const slug = c.req.param("slug");
  if (!isValidSlug(slug)) return c.html(notFoundPage(), 404);
  const page = await getPage(c.env.DB, slug);
  if (!page) return c.html(notFoundPage(), 404);
  await ensureOwnerCookie(c);
  if (page.owner_id !== c.get("ownerId")) {
    return c.redirect(`/${slug}?notyours=1`, 303);
  }
  return c.html(
    editorPage({
      mode: "edit",
      slug,
      title: page.title,
      content: page.content,
    }),
  );
});

// Update (cookie-owner only).
app.put("/:slug", async (c) => {
  const slug = c.req.param("slug");
  if (!isValidSlug(slug)) return c.json({ error: "not found" }, 404);
  const page = await getPage(c.env.DB, slug);
  if (!page) return c.json({ error: "not found" }, 404);

  const tooBig = rejectIfOversize(c, MAX_CONTENT_BYTES);
  if (tooBig) return tooBig;

  await ensureOwnerCookie(c);
  if (page.owner_id !== c.get("ownerId")) {
    return c.json({ error: "not allowed" }, 403);
  }

  let body: { title?: unknown; content?: unknown };
  try {
    body = (await c.req.json()) as { title?: unknown; content?: unknown };
  } catch {
    return c.json({ error: "invalid JSON" }, 400);
  }

  const patch: { title?: string; content?: string } = {};
  if (body.title !== undefined) {
    const titleErr = validateTitleField(body.title);
    if (titleErr) return c.json({ error: titleErr.message }, titleErr.status);
    patch.title = normalizeTitle(body.title as string);
  }
  if (body.content !== undefined) {
    const contentErr = validateContentField(body.content);
    if (contentErr) return c.json({ error: contentErr.message }, contentErr.status);
    patch.content = body.content as string;
  }
  if (patch.title === undefined && patch.content === undefined) {
    return c.json({ error: "nothing to update" }, 400);
  }

  const updatedAt = await updatePage(c.env.DB, slug, patch);

  // Bust OG cache.
  c.executionCtx.waitUntil(
    c.env.OG_CACHE.delete(`og/${slug}.png`).catch((err) => {
      console.warn("og cache delete failed", { slug, err: String(err) });
    }),
  );

  return c.json({
    slug,
    url: `${originUrl(c)}/${slug}`,
    updated_at: updatedAt,
  });
});

// Server-rendered preview (used by editor client). Tighter cap than the
// public API endpoints — preview content is being typed live, never a paste
// of a megabyte document, and this is the only unauthenticated write surface.
app.post("/api/preview", async (c) => {
  const tooBig = rejectIfOversize(c, PREVIEW_MAX_BYTES, "text");
  if (tooBig) return tooBig;
  const text = await c.req.text();
  // Belt + braces: header could lie, double-check actual length.
  if (text.length > PREVIEW_MAX_BYTES) {
    return c.text("payload too large", 413);
  }
  const html = renderMarkdown(text);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
});

export default app;
