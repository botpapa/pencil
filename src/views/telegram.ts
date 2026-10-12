// Telegram Instant View bait page.
//
// Telegram's link crawler ("TelegramBot (like TwitterBot)") renders a page as
// Instant View only when an approved template exists for its domain — except
// for one undocumented case: teletype.in's approved template is keyed on a
// `tg:site_verification` meta tag rather than the domain, so any page that
// carries that tag *and* teletype's article markup gets Instant View on any
// domain, no template submission needed. Teletype's custom-domain blogs rely
// on it; the recipe was reverse-engineered in
// https://gist.github.com/fishchev/ed2ca15d5ffd9594d41498a4bf9ba12e and
// https://github.com/petrows/wp-tg-instantview. We serve this page to the
// crawler only; browsers never see it.

import { escape } from "./layout.js";

// Teletype's verification value — this is what the IV template matches on.
const TELETYPE_SITE_VERIFICATION = "g7j8/rPFXfhyrq5q0QQV7EsYWv4=";

export const TELEGRAM_BOT_UA = "TelegramBot (like TwitterBot)";

export function isTelegramCrawler(ua: string | undefined): boolean {
  return (ua ?? "").trim() === TELEGRAM_BOT_UA;
}

export type TelegramIvOpts = {
  title: string;
  htmlContent: string; // renderMarkdown() output (sanitized)
  description: string;
  ogImage: string;
  canonicalUrl: string;
  createdAt: number;
  channel?: string; // "@name" → "join channel" button in IV
};

// Reshape our reader HTML into what teletype's IV template handles well. The
// input is our own sanitized renderer output, so the regexes below only have
// to know our markup, not arbitrary HTML.
export function toInstantViewHtml(src: string): string {
  let h = src;
  // Heading "#" anchors.
  h = h.replace(/<a href="#[^"]*" class="header-anchor">#<\/a>\s*/g, "");
  // Editor/browser-only attributes.
  h = h.replace(/\s+data-source-line="\d+"/g, "");
  h = h.replace(/\s+(?:loading|decoding|referrerpolicy)="[^"]*"/g, "");
  h = h.replace(/(<img [^>]*?)\s*\/>/g, "$1>");
  // Tables are wrapped for horizontal scroll; IV wants the bare <table>.
  h = h.replace(/<div class="table-wrap">(<table>[\s\S]*?<\/table>)<\/div>/g, "$1");
  // ```carousel → a run of figures (IV groups consecutive figures into a slideshow).
  h = h.replace(/<div class="carousel">[\s\S]*?<\/div><\/div><\/div>/g, (block) =>
    (block.match(/<img [^>]*>/g) ?? []).map((img) => `<figure>${img}</figure>`).join(""),
  );
  // Stand-alone image in a paragraph → figure.
  h = h.replace(/<p>(<img [^>]*>)<\/p>/g, "<figure>$1</figure>");
  // Code blocks: drop highlight spans, keep the language.
  h = h.replace(/<pre><code class="hljs(?: language-([\w-]+))?">([\s\S]*?)<\/code><\/pre>/g, (_m, lang: string | undefined, body: string) => {
    const plain = body.replace(/<\/?span[^>]*>/g, "");
    return `<pre${lang ? ` data-language="${escape(lang)}"` : ""}><code>${plain}</code></pre>`;
  });
  // Task-list checkboxes → text marks.
  h = h.replace(/<input type="checkbox" disabled="disabled" checked="checked" \/>/g, "☑");
  h = h.replace(/<input type="checkbox" disabled="disabled" \/>/g, "☐");
  // Nested lists: teletype's template flattens them, so nesting silently
  // disappears. Flatten them ourselves instead, marking each level with "— "
  // (and a number for nested ordered lists) so the hierarchy stays readable.
  // Innermost lists go first; deeper levels accumulate one marker per level.
  for (let guard = 0; guard < 20; guard++) {
    const before = h;
    h = h.replace(
      /\s*<(ul|ol)>((?:(?!<ul>|<ol>)[\s\S])*?)<\/\1>\s*<\/li>/g,
      (_m, tag: string, inner: string) => {
        let n = 0;
        const items = inner.replace(/<li>/g, () => `<li>— ${tag === "ol" ? `${++n}. ` : ""}`);
        return `</li>${items.trim()}`;
      },
    );
    if (h === before) break;
  }
  // Footnote back-arrows are noise without in-page navigation.
  h = h.replace(/\s*<a href="#fnref\d+" class="footnote-backref">↩︎<\/a>/g, "");
  return h;
}

export function telegramIvPage(opts: TelegramIvOpts): string {
  const meta: Array<[string, string]> = [
    ["tg:site_verification", TELETYPE_SITE_VERIFICATION],
    ["og:type", "article"],
    ["og:site_name", "pencil.md"],
    ["og:title", opts.title],
    ["og:description", opts.description],
    ["og:image", opts.ogImage],
    ["og:url", opts.canonicalUrl],
    ["article:published_time", new Date(opts.createdAt).toISOString()],
  ];
  if (opts.channel) meta.push(["telegram:channel", opts.channel]);
  const head = meta.map(([k, v]) => `<meta property="${escape(k)}" content="${escape(v)}" />`).join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escape(opts.title)}</title>
<link rel="canonical" href="${escape(opts.canonicalUrl)}" />
${head}
</head>
<body class="single single-post">
<div id="content" class="site-content article">
<article class="article__content">
<div class="entry-content">
${toInstantViewHtml(opts.htmlContent)}
</div><!-- .entry-content -->
<footer class="entry-footer"></footer>
</article>
</div>
</body>
</html>
`;
}
