// Routes for draw.pencil.md (mounted when the request host starts with "draw.").
// Mirrors the text app: create / read / edit / update / delete / password, plus
// image upload to R2 and a thumbnail-backed OG card.

import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { ensureOwnerCookie } from "../lib/auth.js";
import { isBotUA } from "../lib/security.js";
import {
  hashPassword,
  verifyPassword,
  signPageAccess,
  verifyPageAccess,
  pageAccessCookieName,
  PAGE_ACCESS_MAX_AGE,
} from "../lib/password.js";
import {
  getDrawing,
  createDrawingWithUniqueSlug,
  updateDrawing,
  deleteDrawing,
  incrementDrawingViews,
  setDrawingPassword,
} from "../lib/drawdb.js";
import { isValidSlug, newSlug } from "../lib/slug.js";
import { rejectIfOversize } from "../lib/limits.js";
import { bytesOf, originUrl, normalizeTitle, validateTitleField } from "../lib/http.js";
import { drawEditorPage, drawReaderPage, drawNotFound } from "../views/draw.js";
import {
  MAX_SCENE_BYTES,
  MAX_IMAGE_BYTES,
  ALLOWED_IMAGE_TYPES,
  MAX_PASSWORD_LENGTH,
} from "../types.js";
import type { AppEnv, DrawingRow } from "../types.js";

const app = new Hono<AppEnv>();

const EMPTY_SCENE = JSON.stringify({
  schemaVersion: 1,
  elements: [],
  viewport: { x: 0, y: 0, zoom: 1 },
});

// Image element URLs must reference an image we issued (same-origin /img/<name>),
// never an arbitrary external URL — otherwise a crafted/shared scene could make
// every viewer's browser fetch attacker-controlled URLs (tracking / IP leak).
const SAFE_IMG_URL = /^\/img\/[A-Za-z0-9._-]+$/;

// Scene validation: valid JSON, expected top-level shape, size-capped, and every
// image element points at one of our own uploaded images.
function validateScene(raw: unknown): { ok: true; scene: string } | { ok: false; status: 400 | 413; error: string } {
  if (typeof raw !== "string") return { ok: false, status: 400, error: "scene must be a string" };
  if (bytesOf(raw) > MAX_SCENE_BYTES) return { ok: false, status: 413, error: "scene too large" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, status: 400, error: "scene is not valid JSON" };
  }
  const elements = (parsed as { elements?: unknown })?.elements;
  if (typeof parsed !== "object" || parsed === null || !Array.isArray(elements)) {
    return { ok: false, status: 400, error: "scene shape invalid" };
  }
  for (const el of elements) {
    if (el && typeof el === "object" && (el as { type?: unknown }).type === "image") {
      const url = (el as { url?: unknown }).url;
      if (typeof url !== "string" || !SAFE_IMG_URL.test(url)) {
        return { ok: false, status: 400, error: "invalid image reference" };
      }
    }
  }
  return { ok: true, scene: raw };
}

function bustThumb(c: { env: AppEnv["Bindings"]; executionCtx: { waitUntil(p: Promise<unknown>): void } }, key: string | null): void {
  if (!key) return;
  c.executionCtx.waitUntil(c.env.IMAGES.delete(key).catch(() => {}));
}

// Decode a `data:image/png;base64,...` thumbnail and store it in R2.
async function storeThumb(c: { env: AppEnv["Bindings"] }, slug: string, dataUrl: unknown): Promise<string | null> {
  if (typeof dataUrl !== "string") return null;
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return null;
  try {
    const bin = atob(m[1]!);
    if (bin.length > 1_000_000) return null; // ~1 MB thumb cap
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const key = `thumb/${slug}.png`;
    await c.env.IMAGES.put(key, bytes, { httpMetadata: { contentType: "image/png" } });
    return key;
  } catch {
    return null;
  }
}

async function canView(
  c: import("hono").Context<AppEnv>,
  d: DrawingRow,
  ownerId: string,
): Promise<boolean> {
  if (d.password_hash == null) return true;
  if (d.owner_id === ownerId) return true;
  return verifyPageAccess(getCookie(c, pageAccessCookieName(d.slug)), d.slug, d.password_hash, c.env.COOKIE_SECRET);
}

// ---------- editor ----------

app.get("/", async (c) => {
  await ensureOwnerCookie(c);
  return c.html(drawEditorPage({ mode: "new", title: "", scene: EMPTY_SCENE }));
});

// ---------- create ----------

// Body cap = scene (2 MB) + thumbnail data-URL (~1.3 MB) + title/password slack.
const MAX_DRAW_BODY_BYTES = MAX_SCENE_BYTES + 2 * 1024 * 1024;

app.post("/", async (c) => {
  const tooBig = rejectIfOversize(c, MAX_DRAW_BODY_BYTES);
  if (tooBig) return tooBig;
  await ensureOwnerCookie(c);
  const ownerId = c.get("ownerId");

  let body: { title?: unknown; scene?: unknown; thumb?: unknown; password?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid JSON" }, 400);
  }
  const titleErr = validateTitleField(body.title);
  if (titleErr) return c.json({ error: titleErr.message }, titleErr.status);
  const v = validateScene(body.scene);
  if (!v.ok) return c.json({ error: v.error }, v.status);

  let passwordHash: string | null = null;
  if (typeof body.password === "string" && body.password) {
    if (body.password.length > MAX_PASSWORD_LENGTH) return c.json({ error: "password too long" }, 400);
    passwordHash = await hashPassword(body.password);
  }

  // Allocate the slug first so the thumbnail key can reference it.
  const slug = newSlug();
  const thumbKey = await storeThumb(c, slug, body.thumb);
  // createDrawingWithUniqueSlug retries on collision; pass our slug attempt via
  // a thin wrapper by just inserting and falling back if needed.
  const created = await createDrawingWithUniqueSlug(c.env.DB, {
    title: normalizeTitle(typeof body.title === "string" ? body.title : ""),
    scene: v.scene,
    thumb_key: thumbKey,
    owner_id: ownerId,
    password_hash: passwordHash,
  });

  return c.json(
    {
      slug: created.slug,
      url: `${originUrl(c)}/${created.slug}`,
      edit_url: `${originUrl(c)}/${created.slug}/edit`,
    },
    201,
  );
});

// ---------- reader ----------

app.get("/:slug", async (c) => {
  const slug = c.req.param("slug");
  if (!isValidSlug(slug)) return c.html(drawNotFound(), 404);
  const d = await getDrawing(c.env.DB, slug);
  if (!d) return c.html(drawNotFound(), 404);

  await ensureOwnerCookie(c);
  const ownerId = c.get("ownerId");
  const isOwner = d.owner_id === ownerId;

  if (d.password_hash != null && !(await canView(c, d, ownerId))) {
    return c.html(unlockShell(slug, false), 401);
  }

  const ua = c.req.header("User-Agent");
  if (!isOwner && !isBotUA(ua)) {
    c.executionCtx.waitUntil(incrementDrawingViews(c.env.DB, slug).catch(() => {}));
  }

  return c.html(
    drawReaderPage({
      slug,
      title: d.title,
      scene: d.scene,
      ogImage: `${originUrl(c)}/og/${slug}.png`,
      canonicalUrl: `${originUrl(c)}/${slug}`,
      isOwner,
    }),
  );
});

// ---------- editor for an existing drawing ----------

app.get("/:slug/edit", async (c) => {
  const slug = c.req.param("slug");
  if (!isValidSlug(slug)) return c.html(drawNotFound(), 404);
  const d = await getDrawing(c.env.DB, slug);
  if (!d) return c.html(drawNotFound(), 404);
  await ensureOwnerCookie(c);
  if (d.owner_id !== c.get("ownerId")) return c.redirect(`/${slug}`, 303);
  return c.html(drawEditorPage({ mode: "edit", slug, title: d.title, scene: d.scene }));
});

// ---------- update ----------

app.put("/:slug", async (c) => {
  const tooBig = rejectIfOversize(c, MAX_DRAW_BODY_BYTES);
  if (tooBig) return tooBig;
  const slug = c.req.param("slug");
  if (!isValidSlug(slug)) return c.json({ error: "not found" }, 404);
  const d = await getDrawing(c.env.DB, slug);
  if (!d) return c.json({ error: "not found" }, 404);
  await ensureOwnerCookie(c);
  if (d.owner_id !== c.get("ownerId")) return c.json({ error: "not allowed" }, 403);

  let body: { title?: unknown; scene?: unknown; thumb?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid JSON" }, 400);
  }
  const patch: { title?: string; scene?: string; thumb_key?: string | null } = {};
  if (body.title !== undefined) {
    const e = validateTitleField(body.title);
    if (e) return c.json({ error: e.message }, e.status);
    patch.title = normalizeTitle(body.title as string);
  }
  if (body.scene !== undefined) {
    const v = validateScene(body.scene);
    if (!v.ok) return c.json({ error: v.error }, v.status);
    patch.scene = v.scene;
  }
  if (body.thumb !== undefined) {
    bustThumb(c, d.thumb_key);
    patch.thumb_key = await storeThumb(c, slug, body.thumb);
  }
  if (Object.keys(patch).length === 0) return c.json({ error: "nothing to update" }, 400);

  const updatedAt = await updateDrawing(c.env.DB, slug, patch);
  return c.json({ slug, url: `${originUrl(c)}/${slug}`, updated_at: updatedAt });
});

// ---------- delete ----------

app.post("/:slug/delete", async (c) => {
  const slug = c.req.param("slug");
  if (!isValidSlug(slug)) return c.html(drawNotFound(), 404);
  const d = await getDrawing(c.env.DB, slug);
  if (!d) return c.html(drawNotFound(), 404);
  await ensureOwnerCookie(c);
  if (d.owner_id !== c.get("ownerId")) return c.text("forbidden", 403);
  await deleteDrawing(c.env.DB, slug);
  bustThumb(c, d.thumb_key);
  return c.redirect(`/`, 303);
});

// ---------- password ----------

app.post("/:slug/unlock", async (c) => {
  const slug = c.req.param("slug");
  if (!isValidSlug(slug)) return c.html(drawNotFound(), 404);
  const d = await getDrawing(c.env.DB, slug);
  if (!d) return c.html(drawNotFound(), 404);
  if (d.password_hash == null) return c.redirect(`/${slug}`, 303);
  const form = await c.req.formData();
  const password = String(form.get("password") ?? "");
  const ok = password.length > 0 && password.length <= MAX_PASSWORD_LENGTH && (await verifyPassword(password, d.password_hash));
  if (!ok) return c.html(unlockShell(slug, true), 401);
  const token = await signPageAccess(slug, d.password_hash, c.env.COOKIE_SECRET);
  setCookie(c, pageAccessCookieName(slug), token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: PAGE_ACCESS_MAX_AGE,
  });
  return c.redirect(`/${slug}`, 303);
});

app.post("/:slug/settings/password", async (c) => {
  const slug = c.req.param("slug");
  if (!isValidSlug(slug)) return c.json({ error: "not found" }, 404);
  const d = await getDrawing(c.env.DB, slug);
  if (!d) return c.json({ error: "not found" }, 404);
  await ensureOwnerCookie(c);
  if (d.owner_id !== c.get("ownerId")) return c.json({ error: "not allowed" }, 403);
  let body: { password?: unknown; remove?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid JSON" }, 400);
  }
  if (body.remove) {
    await setDrawingPassword(c.env.DB, slug, null);
    return c.json({ ok: true, protected: false });
  }
  if (typeof body.password !== "string" || !body.password) return c.json({ error: "password required" }, 400);
  if (body.password.length > MAX_PASSWORD_LENGTH) return c.json({ error: "password too long" }, 400);
  await setDrawingPassword(c.env.DB, slug, await hashPassword(body.password));
  return c.json({ ok: true, protected: true });
});

// ---------- image upload + serving ----------

app.post("/api/images", async (c) => {
  await ensureOwnerCookie(c);
  const ct = c.req.header("Content-Type") ?? "";
  if (!ALLOWED_IMAGE_TYPES.includes(ct)) return c.json({ error: "unsupported image type" }, 415);
  // Require a Content-Length within the cap so unknown-length / oversize bodies
  // are rejected before we buffer them.
  const tooBig = rejectIfOversize(c, MAX_IMAGE_BYTES);
  if (tooBig) return tooBig;
  const buf = await c.req.arrayBuffer();
  if (buf.byteLength > MAX_IMAGE_BYTES) return c.json({ error: "image too large" }, 413);
  const ext = ct.split("/")[1]!.replace("jpeg", "jpg");
  const key = `img/${c.get("ownerId").slice(0, 6)}-${newSlug()}.${ext}`;
  await c.env.IMAGES.put(key, buf, { httpMetadata: { contentType: ct } });
  // Relative same-origin URL — keeps scenes host-agnostic and satisfies the
  // SAFE_IMG_URL check in validateScene.
  return c.json({ url: `/img/${key.slice(4)}`, key }, 201);
});

app.get("/img/:name", async (c) => {
  const name = c.req.param("name");
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return c.text("not found", 404);
  const obj = await c.env.IMAGES.get(`img/${name}`);
  if (!obj) return c.text("not found", 404);
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
});

// ---------- OG thumbnail ----------

app.get("/og/:filename", async (c) => {
  const m = /^([A-Za-z0-9]+)\.png$/.exec(c.req.param("filename"));
  if (!m || !isValidSlug(m[1]!)) return c.text("not found", 404);
  const slug = m[1]!;
  const d = await getDrawing(c.env.DB, slug);
  if (!d || d.password_hash != null || !d.thumb_key) {
    // No public thumbnail — let it 404 (reader still works; just no rich card).
    return c.text("not found", 404);
  }
  const obj = await c.env.IMAGES.get(d.thumb_key);
  if (!obj) return c.text("not found", 404);
  return new Response(obj.body, {
    headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
  });
});

// Minimal unlock screen (kept here to avoid coupling to the text app's view).
function unlockShell(slug: string, error: boolean): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>password protected — draw.pencil.md</title>
<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/draw.css"><meta name="robots" content="noindex,nofollow"></head>
<body class="draw-body draw-404"><section class="draw-404-box">
<p class="lock-icon" style="font-size:3rem;margin:0">🔒</p>
<h1 style="font-family:var(--font-serif);font-weight:600;margin:1rem 0 .3rem">password protected</h1>
<form method="POST" action="/${slug}/unlock" style="display:flex;gap:.5rem;justify-content:center;margin-top:2rem;flex-wrap:wrap">
<input type="password" name="password" placeholder="password" autofocus required class="pw-input" style="font-family:var(--font-mono);padding:.55rem .8rem;border:1px solid var(--rule);border-radius:6px;background:var(--bg)">
<button class="btn btn--primary" type="submit">unlock</button></form>
${error ? `<p style="color:var(--danger);font-family:var(--font-mono);font-size:12px;margin-top:1rem">wrong password — try again.</p>` : ""}
</section></body></html>`;
}

export default app;
