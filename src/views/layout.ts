// HTML rendering helpers + base layout.
// Tagged template `html` escapes interpolations by default.
// Wrap pre-sanitized strings with `raw()` to opt out.

const RAW = Symbol("raw-html");
type Raw = { [RAW]: string };

export function raw(s: string): Raw {
  return { [RAW]: s };
}

function isRaw(v: unknown): v is Raw {
  return typeof v === "object" && v !== null && RAW in (v as object);
}

export function escape(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = "";
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < values.length) {
      const v = values[i];
      if (v == null || v === false) continue;
      if (Array.isArray(v)) {
        for (const item of v) {
          if (item == null || item === false) continue;
          out += isRaw(item) ? item[RAW] : escape(String(item));
        }
      } else if (isRaw(v)) {
        out += v[RAW];
      } else {
        out += escape(String(v));
      }
    }
  }
  return out;
}

// Build the URL of the draw.* sibling app for the current host. Works in prod
// (pencil.md → https://draw.pencil.md) and locally (localhost:8787 →
// http://draw.localhost:8787). Defaults to prod when host is unknown.
export function drawUrl(host?: string): string {
  if (!host) return "https://draw.pencil.md";
  if (host.startsWith("draw.")) host = host.slice(5);
  const local = host.includes("localhost") || /^(127\.|0\.0\.0\.0)/.test(host);
  return `${local ? "http" : "https"}://draw.${host}`;
}

export type LayoutOpts = {
  title: string;
  description?: string;
  ogImage?: string;
  canonicalUrl?: string;
  bodyClass?: string;
  bodyData?: Record<string, string>;
  scripts?: string[]; // paths relative to /
  noIndex?: boolean;
  // Show the "pages" link in the footer. Set by handlers when the current
  // owner cookie has at least one published page.
  showPagesLink?: boolean;
  // Current request host (e.g. "pencil.md" or "localhost:8787"), used to build
  // the footer "draw" link to the matching draw.* subdomain.
  host?: string;
  // Topbar is opt-in. Pass a pre-rendered header string (or `raw(...)`) to
  // render it; omit to render no topbar at all. There is no built-in default.
  topbar?: string | Raw;
  body: string | Raw;
};

export function layout(opts: LayoutOpts): string {
  const dataAttrs = Object.entries(opts.bodyData ?? {})
    .map(([k, v]) => ` data-${escape(k)}="${escape(v)}"`)
    .join("");
  const scripts = (opts.scripts ?? [])
    .map((s) => `<script type="module" src="${escape(s)}" defer></script>`)
    .join("\n");
  const topbar = opts.topbar
    ? isRaw(opts.topbar)
      ? opts.topbar[RAW]
      : opts.topbar
    : "";
  const bodyHtml = isRaw(opts.body) ? opts.body[RAW] : opts.body;
  const desc = opts.description ?? "Open-source, free, telegra.ph-style markdown sharing service.";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escape(opts.title)}</title>
<meta name="description" content="${escape(desc)}">
${opts.noIndex ? `<meta name="robots" content="noindex,nofollow">` : ""}
<link rel="stylesheet" href="/styles.css">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta property="og:type" content="article">
<meta property="og:title" content="${escape(opts.title)}">
<meta property="og:description" content="${escape(desc)}">
${opts.ogImage ? `<meta property="og:image" content="${escape(opts.ogImage)}">` : ""}
${opts.canonicalUrl ? `<meta property="og:url" content="${escape(opts.canonicalUrl)}"><link rel="canonical" href="${escape(opts.canonicalUrl)}">` : ""}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escape(opts.title)}">
<meta name="twitter:description" content="${escape(desc)}">
${opts.ogImage ? `<meta name="twitter:image" content="${escape(opts.ogImage)}">` : ""}
${scripts}
</head>
<body class="${escape(opts.bodyClass ?? "")}"${dataAttrs}>
<div class="app">
${topbar}
<main class="main">
${bodyHtml}
</main>
<footer class="footer">
<a href="/about">about</a> &middot; <a href="${escape(drawUrl(opts.host))}">draw</a> &middot; <a href="/api">api</a>${opts.showPagesLink ? ` &middot; <a href="/pages">my pages</a>` : ""}
</footer>
</div>
</body>
</html>`;
}
