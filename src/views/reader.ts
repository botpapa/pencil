import { html, raw, layout } from "./layout.js";

export type ReaderViewOpts = {
  slug: string;
  title: string;
  htmlContent: string; // already sanitized
  description: string;
  ogImage: string;
  canonicalUrl: string;
  createdAt: number;
  isOwner: boolean;
  indexable: boolean;
  showPagesLink?: boolean;
};

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function readerPage(opts: ReaderViewOpts): string {
  // Owner-only floating chip row. Non-owners get a clean reader page with no
  // editorial chrome — copy-link lives next to edit so it acts as an "author
  // toolkit" rather than a generic share affordance.
  const corner = opts.isOwner
    ? raw(html`
        <div class="corner-actions">
          <button id="copy-link-btn" class="icon-btn" type="button" aria-label="copy link to this page" title="copy link">
            <svg class="icon-link" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1 1"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1-1"/></svg>
            <svg class="icon-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
            <span class="copied-text">copied</span>
          </button>
          <a class="icon-btn" href="/${opts.slug}/stats" aria-label="settings" title="settings (stats + indexing)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </a>
          <a class="btn btn--primary" href="/${opts.slug}/edit">edit</a>
        </div>
      `)
    : "";
  const body = html`
    <article class="reader">
      <h1 class="title">${opts.title || "untitled"}</h1>
      <div class="meta">
        published ${fmtDate(opts.createdAt)}
      </div>
      <div class="prose">${raw(opts.htmlContent)}</div>
    </article>
    ${corner}
  `;

  return layout({
    title: `${opts.title || "untitled"} — pencil.md`,
    description: opts.description,
    ogImage: opts.ogImage,
    canonicalUrl: opts.canonicalUrl,
    bodyClass: "page-reader",
    bodyData: { slug: opts.slug },
    scripts: ["/client/reader.js"],
    body: raw(body),
    noIndex: !opts.indexable,
    showPagesLink: opts.showPagesLink,
  });
}
