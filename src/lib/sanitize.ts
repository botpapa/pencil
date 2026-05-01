// Strict allowlist sanitizer per spec section 5.
// Defense in depth: even though markdown-it runs with html: false and our
// renderer overrides validate URLs, every output is also passed through
// sanitize-html to enforce the tag/attr allowlist exactly.

import sanitizeHtml from "sanitize-html";

const SAFE_HREF = /^(https?:\/\/|mailto:|#)/i;
const SAFE_IMG_SRC = /^https?:\/\//i;

export function isSafeHref(href: string | undefined | null): boolean {
  if (!href) return false;
  return SAFE_HREF.test(href.trim());
}

export function isSafeImgSrc(src: string | undefined | null): boolean {
  if (!src) return false;
  return SAFE_IMG_SRC.test(src.trim());
}

const ALLOWED_TAGS = [
  "p",
  "a",
  "ul",
  "ol",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
  "code",
  "em",
  "strong",
  "del",
  "hr",
  "br",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "img",
  "input",
  "sup",
  "sub",
  "mark",
  "s", // strikethrough (rewritten to <del> by transformTags)
  "strike",
  "span", // for hljs token spans + footnote backrefs
  "section", // for markdown-it-footnote
  "div", // for table-of-contents wrapper
  "nav", // for ToC nav
];

const sanitizeOpts: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: {
    // Allow the scroll-sync source-line marker on every allowed tag. The
    // attribute is only emitted by our own renderer (markdown-it runs with
    // html: false, so it can't enter via author input). transformTags that
    // rebuild attribs from scratch (a/img/input/code/span) will drop it,
    // which is fine — those are inline elements and the source_line_attr
    // rule only tags top-level block tokens anyway.
    "*": ["data-source-line"],
    a: ["href", "rel", "target", "class", "id"],
    img: ["src", "alt", "title", "loading", "referrerpolicy", "decoding"],
    h1: ["id"],
    h2: ["id"],
    h3: ["id"],
    h4: ["id"],
    h5: ["id"],
    h6: ["id"],
    code: ["class"],
    span: ["class"],
    div: ["class"],
    section: ["class"],
    nav: ["class"],
    th: ["colspan", "rowspan", "align"],
    td: ["colspan", "rowspan", "align"],
    input: ["type", "checked", "disabled"],
    li: ["id", "class"],
    sup: ["class"],
    sub: ["class"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesAppliedToAttributes: ["href", "src"],
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
  transformTags: {
    a: (tagName, attribs) => {
      const href = attribs.href;
      if (!href || !isSafeHref(href)) {
        // Return as a span — sanitize-html will keep child text but lose link.
        return { tagName: "span", attribs: {} };
      }
      const isExternal = /^https?:\/\//i.test(href);
      const out: Record<string, string> = { href };
      if (attribs.id) out.id = attribs.id;
      if (isExternal) {
        out.rel = "noopener noreferrer nofollow ugc";
        out.target = "_blank";
      } else if (attribs.rel) {
        out.rel = attribs.rel;
      }
      if (attribs.class && /^(footnote-(ref|backref)|header-anchor)$/.test(attribs.class)) {
        out.class = attribs.class;
      }
      return { tagName: "a", attribs: out };
    },
    img: (_tagName, attribs) => {
      const src = attribs.src;
      if (!src || !isSafeImgSrc(src)) {
        // Drop image entirely.
        return { tagName: "span", attribs: {} };
      }
      return {
        tagName: "img",
        attribs: {
          src,
          alt: attribs.alt ?? "",
          ...(attribs.title ? { title: attribs.title } : {}),
          loading: "lazy",
          referrerpolicy: "no-referrer",
          decoding: "async",
        },
      };
    },
    input: (_tagName, attribs) => {
      // Only allow disabled task-list checkboxes.
      if ((attribs.type ?? "").toLowerCase() !== "checkbox") {
        return { tagName: "span", attribs: {} };
      }
      const out: Record<string, string> = {
        type: "checkbox",
        disabled: "disabled",
      };
      if (attribs.checked != null) out.checked = "checked";
      return { tagName: "input", attribs: out };
    },
    s: () => ({ tagName: "del", attribs: {} }),
    strike: () => ({ tagName: "del", attribs: {} }),
    code: (_tagName, attribs) => {
      const cls = attribs.class ?? "";
      // Only keep `language-*`, `hljs`, and `hljs language-*`.
      const safe = cls
        .split(/\s+/)
        .filter((c) => c === "hljs" || /^language-[A-Za-z0-9_+-]+$/.test(c))
        .join(" ");
      const out: Record<string, string> = {};
      if (safe) out.class = safe;
      return { tagName: "code", attribs: out };
    },
    span: (_tagName, attribs) => {
      const cls = attribs.class ?? "";
      // Allow hljs tokens (hljs-*) and footnote backref class.
      const safe = cls
        .split(/\s+/)
        .filter((c) => /^hljs(-[A-Za-z0-9_-]+)?$/.test(c) || c === "footnote-backref")
        .join(" ");
      const out: Record<string, string> = {};
      if (safe) out.class = safe;
      return { tagName: "span", attribs: out };
    },
  },
};

export function sanitizeHtmlOutput(dirty: string): string {
  return sanitizeHtml(dirty, sanitizeOpts);
}
