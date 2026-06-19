import { Hono } from "hono";
import { securityHeaders } from "./lib/security.js";
import { ensureOwnerCookie } from "./lib/auth.js";
import { ownerHasPages } from "./lib/db.js";
import pages from "./routes/pages.js";
import api from "./routes/api.js";
import stats from "./routes/stats.js";
import og from "./routes/og.js";
import draw from "./routes/draw.js";
import { docsPage } from "./views/docs.js";
import { aboutPage } from "./views/about.js";
import { notFoundPage } from "./views/stats.js";
import { errorPage } from "./views/error.js";
import type { AppEnv } from "./types.js";

const app = new Hono<AppEnv>();

app.use("*", securityHeaders);

// Host dispatch: draw.pencil.md (and draw.localhost for dev) is its own app.
// Runs after securityHeaders so the draw responses still get the CSP/headers.
app.use("*", async (c, next) => {
  const host = (c.req.header("host") ?? "").split(":")[0]!.toLowerCase();
  if (host === "draw.pencil.md" || host.startsWith("draw.localhost")) {
    return draw.fetch(c.req.raw, c.env, c.executionCtx);
  }
  await next();
});

// Health check.
app.get("/health", (c) => c.json({ ok: true, app: c.env.APP_NAME }));

// API docs (HTML).
app.get("/api", async (c) => {
  await ensureOwnerCookie(c);
  const hasPages = await ownerHasPages(c.env.DB, c.get("ownerId"));
  return c.html(docsPage(new URL(c.req.url).origin, hasPages));
});

// About page (SEO entry point).
app.get("/about", async (c) => {
  await ensureOwnerCookie(c);
  const hasPages = await ownerHasPages(c.env.DB, c.get("ownerId"));
  return c.html(aboutPage(new URL(c.req.url).origin, hasPages));
});

// Public agent API.
app.route("/api/v1", api);

// OG images.
app.route("/", og);

// Owner-only stats (must come before /:slug).
app.route("/", stats);

// Page routes (home, create, reader, editor, update, preview).
app.route("/", pages);

app.notFound((c) => {
  // JSON 404 for /api/* paths; HTML 404 for everything else.
  const url = new URL(c.req.url);
  if (url.pathname.startsWith("/api")) {
    return c.json({ error: "not found" }, 404);
  }
  return c.html(notFoundPage(), 404);
});

app.onError((err, c) => {
  // Log just the message + name; avoid serialising the full Error which can
  // include URLs / cookies via toString-on-context implementations.
  console.error("unhandled error", {
    name: err instanceof Error ? err.name : "unknown",
    message: err instanceof Error ? err.message : String(err),
  });
  const url = new URL(c.req.url);
  if (url.pathname.startsWith("/api")) {
    return c.json({ error: "internal error" }, 500);
  }
  // HTML 500 — distinct from 404 so users can tell the difference.
  return c.html(errorPage(), 500);
});

export default app;
