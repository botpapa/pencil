// Markdown -> sanitized HTML pipeline.
// Layered defense:
//   1. markdown-it with html: false — no raw HTML survives parsing.
//   2. Custom renderer overrides validate href/src and add safe rel/target/loading.
//   3. Final pass through sanitize-html allowlist (lib/sanitize.ts).

import MarkdownIt from "markdown-it";
import anchor from "markdown-it-anchor";
import footnote from "markdown-it-footnote";
import taskLists from "markdown-it-task-lists";
import mark from "markdown-it-mark";
import toc from "markdown-it-toc-done-right";
import hljs from "highlight.js/lib/core";

// Curated language set per spec section 5 (~25 languages).
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import bash from "highlight.js/lib/languages/bash";
import shell from "highlight.js/lib/languages/shell";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import json from "highlight.js/lib/languages/json";
import yaml from "highlight.js/lib/languages/yaml";
import sql from "highlight.js/lib/languages/sql";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import ruby from "highlight.js/lib/languages/ruby";
import swift from "highlight.js/lib/languages/swift";
import kotlin from "highlight.js/lib/languages/kotlin";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import ini from "highlight.js/lib/languages/ini";
import diff from "highlight.js/lib/languages/diff";
import plaintext from "highlight.js/lib/languages/plaintext";

import { sanitizeHtmlOutput, isSafeHref, isSafeImgSrc } from "./sanitize.js";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("jsx", javascript);
hljs.registerLanguage("tsx", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("py", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("go", go);
hljs.registerLanguage("java", java);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("shell", shell);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("css", css);
hljs.registerLanguage("json", json);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("md", markdown);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("php", php);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("rb", ruby);
hljs.registerLanguage("swift", swift);
hljs.registerLanguage("kotlin", kotlin);
hljs.registerLanguage("kt", kotlin);
hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("toml", ini);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("text", plaintext);
hljs.registerLanguage("plaintext", plaintext);

function highlight(code: string, lang: string): string {
  const safeLang = lang && hljs.getLanguage(lang) ? lang : "plaintext";
  try {
    return hljs.highlight(code, { language: safeLang, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function makeRenderer(): MarkdownIt {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: true,
    breaks: false,
    highlight: (code, lang) => {
      const langClass = lang && hljs.getLanguage(lang) ? `language-${lang}` : "language-plaintext";
      const highlighted = highlight(code, lang);
      return `<pre><code class="hljs ${langClass}">${highlighted}</code></pre>`;
    },
  });

  md.use(anchor, {
    slugify: (s: string) =>
      s
        .toLowerCase()
        .trim()
        .replace(/[^\w\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "") || "section",
    permalink: anchor.permalink.linkInsideHeader({
      symbol: "#",
      placement: "before",
      ariaHidden: false,
      class: "header-anchor",
    }),
  });
  md.use(footnote);
  md.use(taskLists, { enabled: false, lineNumber: false });
  md.use(mark);
  md.use(toc, {
    listType: "ul",
    containerClass: "toc",
    placeholder: "[[toc]]",
  });

  // Tag every top-level block token with its 0-based source line so the
  // editor can sync scroll between the textarea and the rendered preview.
  // Inline tokens (level > 0) and tokens without a tag are skipped — only
  // block elements end up with the attribute, which keeps the surface
  // small and aligned with what the scroll-anchor code looks for.
  md.core.ruler.push("source_line_attr", (state) => {
    for (const token of state.tokens) {
      if (token.level === 0 && token.map && token.tag) {
        token.attrSet("data-source-line", String(token.map[0]));
      }
    }
  });

  // Override link renderer to enforce URL safety. Markdown-it's default
  // already encodes the href; we additionally validate scheme.
  const defaultLinkOpen =
    md.renderer.rules.link_open ||
    function (tokens, idx, opts, _env, self) {
      return self.renderToken(tokens, idx, opts);
    };
  md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
    const token = tokens[idx];
    if (!token) return defaultLinkOpen(tokens, idx, opts, env, self);
    const hrefIdx = token.attrIndex("href");
    const href = hrefIdx >= 0 ? token.attrs?.[hrefIdx]?.[1] : null;
    if (!isSafeHref(href)) {
      // Replace with a span_open marker so the matching link_close becomes
      // a closing span. We mutate the token in-place.
      token.tag = "span";
      token.attrs = null;
      // Find matching link_close and rename it too.
      let depth = 1;
      for (let i = idx + 1; i < tokens.length; i++) {
        const t = tokens[i];
        if (!t) continue;
        if (t.type === "link_open") depth++;
        else if (t.type === "link_close") {
          depth--;
          if (depth === 0) {
            t.tag = "span";
            t.attrs = null;
            break;
          }
        }
      }
      return self.renderToken(tokens, idx, opts);
    }
    if (/^https?:\/\//i.test(href ?? "")) {
      token.attrSet("rel", "noopener noreferrer nofollow ugc");
      token.attrSet("target", "_blank");
    }
    return self.renderToken(tokens, idx, opts);
  };

  // Wrap every rendered table in a horizontally-scrollable container so wide
  // tables don't push the viewport sideways on narrow screens. The table
  // itself keeps `display: table` and its natural cell widths; the wrapper
  // owns the overflow. Forward the source-line attr (set by source_line_attr
  // above) onto the wrapper div so scroll sync can target it.
  md.renderer.rules.table_open = (tokens, idx) => {
    const token = tokens[idx];
    const line = token?.attrGet("data-source-line");
    const lineAttr = line ? ` data-source-line="${line}"` : "";
    return `<div class="table-wrap"${lineAttr}><table>`;
  };
  md.renderer.rules.table_close = () => `</table></div>`;

  md.renderer.rules.image = (tokens, idx, _opts, _env, _self) => {
    const token = tokens[idx];
    if (!token) return "";
    const srcIdx = token.attrIndex("src");
    const src = srcIdx >= 0 ? token.attrs?.[srcIdx]?.[1] : null;
    if (!isSafeImgSrc(src)) return "";
    const altText = token.children
      ? token.children.map((c) => c.content).join("")
      : token.content;
    const titleIdx = token.attrIndex("title");
    const title = titleIdx >= 0 ? token.attrs?.[titleIdx]?.[1] : null;
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    return `<img src="${escapeHtml(src!)}" alt="${escapeHtml(altText)}"${titleAttr} loading="lazy" referrerpolicy="no-referrer" decoding="async">`;
  };

  return md;
}

const md = makeRenderer();

export function renderMarkdown(source: string): string {
  const dirty = md.render(source);
  return sanitizeHtmlOutput(dirty);
}

// Strip all markdown formatting for OG image / meta description.
export function plaintextExcerpt(source: string, maxChars = 160): string {
  const stripped = source
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped.length <= maxChars) return stripped;
  return stripped.slice(0, maxChars - 1).trimEnd() + "\u2026";
}
