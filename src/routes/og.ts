// OG image generation. /og/:slug.png — 1200x630 PNG.
// R2-cached for 7 days. Cache busted on PUT.

import { Hono } from "hono";
import { ImageResponse } from "workers-og";
import { getPage } from "../lib/db.js";
import { isValidSlug } from "../lib/slug.js";
import { plaintextExcerpt } from "../lib/markdown.js";
import type { AppEnv } from "../types.js";

const app = new Hono<AppEnv>();

const CACHE_HEADERS = {
  "Content-Type": "image/png",
  "Cache-Control": "public, max-age=604800, immutable",
};

function safeFromCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return "";
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "";
  }
}

// workers-og parses this HTML with Cloudflare's HTMLRewriter, which does NOT
// decode HTML entities in text nodes. So anything we entity-escape (`&` ->
// `&amp;`, `<` -> `&lt;`, `'` -> `&#39;`) would render *literally* in the
// image. Instead we feed satori plain text: decode any entities back to real
// characters, then strip tag-like sequences and bare angle brackets — both so
// it reads cleanly and so a crafted title can't inject nodes into satori's
// tree (the safety the old escape gave us, kept without the visual artifacts).
function ogText(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => safeFromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&(?:apos|#39);/g, "'")
    .replace(/&nbsp;/g, " ")
    // decode &amp; LAST so "&amp;lt;" resolves to the literal "&lt;", not "<"
    .replace(/&amp;/g, "&")
    // strip real tag-like sequences (`<div>`, `</p>`, `<!--`), then drop any
    // remaining bare angle brackets so none can reach (and confuse) HTMLRewriter
    .replace(/<\/?[a-zA-Z!?][^>]*>/g, "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildHtml(title: string, excerpt: string): string {
  // workers-og runs satori; supports inline styles only, flexbox layouts.
  // Note: every flex parent that has multiple children needs display:flex.
  const safeTitle = ogText(title) || "untitled";
  const safeExcerpt = ogText(excerpt);
  return `
<div style="display: flex; flex-direction: column; width: 100%; height: 100%; padding: 80px; background: #FAF7F2; font-family: 'Newsreader', Georgia, serif; color: #1A1714; justify-content: space-between;">
  <div style="display: flex; flex-direction: column;">
    <div style="display: flex; align-items: center; gap: 12px; font-family: 'JetBrains Mono', monospace; font-size: 26px; color: #1A1714;">
      <span style="display: flex;">pencil</span>
      <span style="display: flex; color: #4A453E;">.md</span>
    </div>
  </div>
  <div style="display: flex; flex-direction: column; gap: 28px;">
    <div style="display: flex; font-size: 76px; line-height: 1.05; font-weight: 600; letter-spacing: -1.5px; color: #1A1714;">
      ${safeTitle}
    </div>
    <div style="display: flex; font-size: 30px; line-height: 1.4; color: #4A453E;">
      ${safeExcerpt}
    </div>
  </div>
  <div style="display: flex; align-items: flex-end; justify-content: space-between;">
    <div style="display: flex; height: 8px; width: 100%; background: #F4B400;"></div>
  </div>
</div>`;
}

app.get("/og/:filename", async (c) => {
  const filename = c.req.param("filename");
  const m = /^([A-Za-z0-9]+)\.png$/.exec(filename);
  if (!m) return c.text("not found", 404);
  const slug = m[1]!;
  if (!isValidSlug(slug)) return c.text("not found", 404);

  const cacheKey = `og/${slug}.png`;

  // Try R2 cache.
  const cached = await c.env.OG_CACHE.get(cacheKey);
  if (cached) {
    return new Response(cached.body, { headers: CACHE_HEADERS });
  }

  const page = await getPage(c.env.DB, slug);
  if (!page) return c.text("not found", 404);

  // Password-protected pages must not leak their title or content into the
  // shareable card — render a generic locked placeholder instead.
  const html = page.password_hash != null
    ? buildHtml("Password protected", "Enter the password on pencil.md to view this page.")
    : buildHtml(page.title, plaintextExcerpt(page.content, 140));
  const img = new ImageResponse(html, { width: 1200, height: 630 });
  const buf = await img.arrayBuffer();

  c.executionCtx.waitUntil(
    c.env.OG_CACHE.put(cacheKey, buf, {
      httpMetadata: { contentType: "image/png" },
    }).catch(() => {}),
  );

  return new Response(buf, { headers: CACHE_HEADERS });
});

export default app;
