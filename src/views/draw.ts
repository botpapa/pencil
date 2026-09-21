// HTML shells for draw.pencil.md. The client (client/draw.ts) mounts the
// canvas, toolbar, and mode UI into #draw-root; the server only provides the
// title field, the action buttons, and the initial scene JSON.

import type { DrawingSummary } from "../types.js";

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

type Mode = "new" | "edit" | "read";

const PERSON_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5"/></svg>`;

type ShellOpts = {
  mode: Mode;
  slug?: string;
  title: string;
  scene: string; // JSON string
  ogImage?: string;
  canonicalUrl?: string;
  isOwner?: boolean;
  // Render the "my drawings" link in the topbar (owner has >= 1 drawing).
  showListLink?: boolean;
};

function shell(opts: ShellOpts): string {
  const titleText = opts.title || (opts.mode === "read" ? "untitled" : "");
  const pageTitle =
    opts.mode === "read" ? `${titleText || "untitled"} — draw.pencil.md` : "new drawing — draw.pencil.md";
  const isEditor = opts.mode !== "read";

  // The title is an editable input in the editor, a static heading in the reader.
  const titleEl = isEditor
    ? `<input class="draw-title" id="draw-title" type="text" maxlength="200" autocomplete="off" spellcheck="true" placeholder="title" value="${esc(opts.title)}" />`
    : `<h1 class="draw-title draw-title--read">${esc(titleText)}</h1>`;

  // Same affordance as the text app's footer "my pages" link, but the canvas
  // has no footer, so it's an icon-only "profile" button in the topbar next to
  // save/edit. Deliberately NOT a .btn — the client finds the reader's edit
  // button via ".draw-actions a.btn".
  const listLink = opts.showListLink
    ? `<a class="draw-profile" href="/pages" title="my drawings" aria-label="my drawings">${PERSON_ICON}</a>`
    : "";

  // Owner of a published drawing sees an "edit" affordance; the editor itself
  // shows save.
  const actions = isEditor
    ? `<div class="draw-actions" id="draw-actions">
         <span class="draw-status" id="draw-status" role="status" aria-live="polite"></span>
         <button class="btn" id="draw-reset" type="button">reset</button>
         <button class="btn btn--primary" id="draw-save" type="button">${opts.mode === "edit" ? "save" : "publish"}</button>
         ${listLink}
       </div>
       <div class="reset-confirm" id="reset-confirm" role="dialog" aria-label="Reset canvas" hidden>
         <p class="reset-confirm-q">Clear the canvas? This permanently removes everything on it.</p>
         <div class="reset-confirm-row">
           <button class="btn" id="reset-cancel" type="button">cancel</button>
           <button class="btn btn--danger" id="reset-yes" type="button">reset</button>
         </div>
       </div>`
    : opts.isOwner && opts.slug
      ? `<div class="draw-actions" id="draw-actions"><a class="btn btn--primary" href="/${esc(opts.slug)}/edit">edit</a>${listLink}</div>`
      : listLink
        ? `<div class="draw-actions" id="draw-actions">${listLink}</div>`
        : "";

  const data = `data-mode="${opts.mode}"${opts.slug ? ` data-slug="${esc(opts.slug)}"` : ""}`;

  const ogTags = opts.ogImage
    ? `<meta property="og:image" content="${esc(opts.ogImage)}"><meta name="twitter:image" content="${esc(opts.ogImage)}"><meta name="twitter:card" content="summary_large_image">`
    : "";
  const canonical = opts.canonicalUrl
    ? `<meta property="og:url" content="${esc(opts.canonicalUrl)}"><link rel="canonical" href="${esc(opts.canonicalUrl)}">`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<title>${esc(pageTitle)}</title>
<meta name="robots" content="noindex,nofollow">
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(titleText || "draw.pencil.md")}">
${ogTags}
${canonical}
<link rel="stylesheet" href="/styles.css">
<link rel="stylesheet" href="/draw.css">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<script type="module" src="/client/draw.js" defer></script>
</head>
<body class="draw-body" ${data}>
<header class="draw-topbar">
  ${titleEl}
  ${actions}
</header>
<main class="canvas-root" id="draw-root"></main>
<script type="application/json" id="scene-data">${opts.scene.replaceAll("<", "\\u003c")}</script>
</body>
</html>`;
}

export function drawEditorPage(opts: {
  mode: "new" | "edit";
  slug?: string;
  title: string;
  scene: string;
  showListLink?: boolean;
}): string {
  return shell(opts);
}

export function drawReaderPage(opts: {
  slug: string;
  title: string;
  scene: string;
  ogImage: string;
  canonicalUrl: string;
  isOwner: boolean;
  showListLink?: boolean;
}): string {
  return shell({ ...opts, mode: "read" });
}

// The owner's drawings — same list as pencil.md/pages, same markup and
// classes (styles.css), so the two apps look alike.
export function drawListPage(drawings: DrawingSummary[], pencilUrl: string): string {
  const fmtDate = (ms: number) =>
    new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  const rows = drawings
    .map(
      (d) => `<li class="page-row">
          <a class="page-title" href="/${esc(d.slug)}">${esc(d.title || "untitled")}</a>
          <span class="page-meta">${d.protected ? `<span class="lock" title="password protected">🔒</span> ` : ""}${fmtDate(d.created_at)} &middot; ${d.views.toLocaleString()} ${d.views === 1 ? "view" : "views"}</span>
          <a class="page-edit" href="/${esc(d.slug)}/edit">edit</a>
        </li>`,
    )
    .join("");
  const list = drawings.length
    ? `<ul class="pages-list">${rows}</ul>`
    : `<p class="placeholder" style="margin-top:2rem"><em>no drawings yet. <a href="/">draw one</a>.</em></p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>your drawings — draw.pencil.md</title>
<meta name="robots" content="noindex,nofollow">
<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/draw.css">
<link rel="icon" href="/favicon.svg" type="image/svg+xml"></head>
<body class="draw-body draw-pages">
<div class="app">
<main class="main">
<section class="pages">
  <h1 class="pages-heading">your drawings</h1>
  <p class="label">stored on this browser &middot; <a href="/">new drawing</a></p>
  ${list}
</section>
</main>
<footer class="footer">
<a href="${esc(pencilUrl)}">pencil.md</a> &middot; <a href="${esc(pencilUrl)}/pages">my pages</a>
</footer>
</div>
</body></html>`;
}

export function drawNotFound(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>404 — draw.pencil.md</title><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/draw.css">
<meta name="robots" content="noindex,nofollow"></head>
<body class="draw-body draw-404"><section class="draw-404-box"><p class="number">404</p><p class="label">no such drawing</p><p style="margin-top:2rem"><a class="btn" href="/">draw one</a></p></section></body></html>`;
}
