// Public agent API: /api/v1/*
// CORS open. No auth on create/read. Updates require either the owner cookie
// set at creation time, or the literal cookie value replayed as `edit_token`
// in the JSON body — equivalent credentials, useful for stateless clients.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { getPage, updatePage, deletePage } from "../lib/db.js";
import { ensureOwnerCookie, signCookie, verifyCookie } from "../lib/auth.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { isValidSlug, createPageWithUniqueSlug } from "../lib/slug.js";
import { rejectIfOversize } from "../lib/limits.js";
import { bytesOf, originUrl, normalizeTitle, validateTitleField, validateContentField } from "../lib/http.js";
import { MAX_CONTENT_BYTES, MAX_PASSWORD_LENGTH } from "../types.js";
import type { AppEnv } from "../types.js";

const app = new Hono<AppEnv>();

const CORS_MAX_AGE_SECONDS = 86400;

app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type", "X-Page-Password"],
    maxAge: CORS_MAX_AGE_SECONDS,
  }),
);

// POST /pages
app.post("/pages", async (c) => {
  const tooBig = rejectIfOversize(c, MAX_CONTENT_BYTES);
  if (tooBig) return tooBig;

  let body: { title?: unknown; content?: unknown; password?: unknown };
  try {
    body = (await c.req.json()) as { title?: unknown; content?: unknown; password?: unknown };
  } catch {
    return c.json({ error: "invalid JSON" }, 400);
  }
  const title = typeof body.title === "string" ? body.title : "";
  const content = body.content;
  if (typeof content !== "string" || !content.trim()) {
    return c.json({ error: "content is required and must be a string" }, 400);
  }
  const titleErr = validateTitleField(title);
  if (titleErr) return c.json({ error: titleErr.message }, titleErr.status);
  if (bytesOf(content) > MAX_CONTENT_BYTES) {
    return c.json({ error: `content exceeds ${MAX_CONTENT_BYTES} bytes` }, 413);
  }

  // Optional password protection from the first publish (API only — the UI sets
  // passwords via the page settings instead).
  let passwordHash: string | null = null;
  if (body.password !== undefined && body.password !== null && body.password !== "") {
    if (typeof body.password !== "string") {
      return c.json({ error: "password must be a string" }, 400);
    }
    if (body.password.length > MAX_PASSWORD_LENGTH) {
      return c.json({ error: `password exceeds ${MAX_PASSWORD_LENGTH} chars` }, 400);
    }
    passwordHash = await hashPassword(body.password);
  }

  // Tie ownership to the requesting browser's cookie. Pure server-to-server
  // callers without cookies still get a stable owner_id (a freshly-minted one)
  // — but they won't be able to edit later because they can't replay it
  // unless they save the edit_token returned below.
  await ensureOwnerCookie(c);
  const ownerId = c.get("ownerId");
  // Same value as the cookie, surfaced under a friendly name for stateless
  // API clients that can't (or don't want to) maintain a cookie jar.
  const editToken = await signCookie(ownerId, c.env.COOKIE_SECRET);

  const { slug } = await createPageWithUniqueSlug(c.env.DB, {
    title: normalizeTitle(title),
    content,
    owner_id: ownerId,
    password_hash: passwordHash,
  });

  return c.json(
    {
      slug,
      url: `${originUrl(c)}/${slug}`,
      edit_url: `${originUrl(c)}/${slug}/edit`,
      edit_token: editToken,
      protected: passwordHash != null,
    },
    201,
  );
});

// GET /pages/:slug
app.get("/pages/:slug", async (c) => {
  const slug = c.req.param("slug");
  if (!isValidSlug(slug)) return c.json({ error: "not found" }, 404);
  const page = await getPage(c.env.DB, slug);
  if (!page) return c.json({ error: "not found" }, 404);

  // Full lockdown: a protected page only returns content when the request
  // carries the password (query `?password=` or `X-Page-Password` header) or
  // the owner credential (cookie / `?edit_token=`).
  if (page.password_hash != null) {
    const supplied = c.req.query("password") ?? c.req.header("X-Page-Password") ?? "";
    let allowed =
      supplied.length > 0 &&
      supplied.length <= MAX_PASSWORD_LENGTH &&
      (await verifyPassword(supplied, page.password_hash));
    if (!allowed) {
      const token = c.req.query("edit_token");
      if (token) {
        const uid = await verifyCookie(token, c.env.COOKIE_SECRET);
        if (uid && uid === page.owner_id) allowed = true;
      }
    }
    if (!allowed) {
      await ensureOwnerCookie(c);
      if (c.get("ownerId") === page.owner_id) allowed = true;
    }
    if (!allowed) {
      return c.json({ error: "password required", protected: true }, 401);
    }
  }

  return c.json({
    slug: page.slug,
    title: page.title,
    content: page.content,
    created_at: page.created_at,
    updated_at: page.updated_at,
    views: page.views,
    protected: page.password_hash != null,
  });
});

// PUT /pages/:slug — owner-only. Either the owner cookie or an `edit_token`
// body field (the literal cookie value) authorises the request.
app.put("/pages/:slug", async (c) => {
  const slug = c.req.param("slug");
  if (!isValidSlug(slug)) return c.json({ error: "not found" }, 404);
  const page = await getPage(c.env.DB, slug);
  if (!page) return c.json({ error: "not found" }, 404);

  const tooBig = rejectIfOversize(c, MAX_CONTENT_BYTES);
  if (tooBig) return tooBig;

  let body: { title?: unknown; content?: unknown; edit_token?: unknown };
  try {
    body = (await c.req.json()) as {
      title?: unknown;
      content?: unknown;
      edit_token?: unknown;
    };
  } catch {
    return c.json({ error: "invalid JSON" }, 400);
  }

  // Try the body-supplied credential first so stateless clients don't need a
  // cookie jar at all. Fall back to the cookie path for browsers/SPAs.
  let allowed = false;
  if (typeof body.edit_token === "string") {
    const uid = await verifyCookie(body.edit_token, c.env.COOKIE_SECRET);
    if (uid && uid === page.owner_id) allowed = true;
  }
  if (!allowed) {
    await ensureOwnerCookie(c);
    if (c.get("ownerId") === page.owner_id) allowed = true;
  }
  if (!allowed) {
    return c.json({ error: "not allowed" }, 403);
  }

  // Strip the credential before constructing the patch so it can never be
  // mistaken for a real field.
  delete body.edit_token;

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

// DELETE /pages/:slug — owner-only. Authorise with the owner cookie or an
// `edit_token` (query param or JSON body, the literal cookie value).
app.delete("/pages/:slug", async (c) => {
  const slug = c.req.param("slug");
  if (!isValidSlug(slug)) return c.json({ error: "not found" }, 404);
  const page = await getPage(c.env.DB, slug);
  if (!page) return c.json({ error: "not found" }, 404);

  let token = c.req.query("edit_token") ?? undefined;
  if (!token) {
    try {
      const body = (await c.req.json()) as { edit_token?: unknown };
      if (typeof body.edit_token === "string") token = body.edit_token;
    } catch {
      /* no/invalid body — fall back to the cookie */
    }
  }

  let allowed = false;
  if (token) {
    const uid = await verifyCookie(token, c.env.COOKIE_SECRET);
    if (uid && uid === page.owner_id) allowed = true;
  }
  if (!allowed) {
    await ensureOwnerCookie(c);
    if (c.get("ownerId") === page.owner_id) allowed = true;
  }
  if (!allowed) return c.json({ error: "not allowed" }, 403);

  await deletePage(c.env.DB, slug);
  c.executionCtx.waitUntil(
    c.env.OG_CACHE.delete(`og/${slug}.png`).catch((err) => {
      console.warn("og cache delete failed", { slug, err: String(err) });
    }),
  );
  return c.json({ slug, deleted: true });
});

export default app;
