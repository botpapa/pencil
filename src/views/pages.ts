import { html, raw, layout } from "./layout.js";
import type { PageSummary } from "../types.js";

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function pagesListPage(pages: PageSummary[], host?: string): string {
  const empty = pages.length === 0;
  const list = pages
    .map(
      (p) => html`
        <li class="page-row">
          <a class="page-title" href="/${p.slug}">${p.title || "untitled"}</a>
          <span class="page-meta">
            ${p.protected ? raw(`<span class="lock" title="password protected">🔒</span> `) : ""}${fmtDate(p.created_at)} &middot; ${String(p.views.toLocaleString())} ${p.views === 1 ? "view" : "views"}
          </span>
          <a class="page-edit" href="/${p.slug}/edit">edit</a>
        </li>
      `,
    )
    .join("");

  const body = html`
    <section class="pages">
      <h1 class="pages-heading">your pages</h1>
      <p class="label">stored on this browser &middot; <a href="/">new page</a></p>
      ${empty
        ? raw(`<p class="placeholder" style="margin-top:2rem"><em>no pages yet. <a href="/">write one</a>.</em></p>`)
        : raw(`<ul class="pages-list">${list}</ul>`)}
    </section>
  `;

  return layout({
    title: "your pages — pencil.md",
    bodyClass: "page-pages",
    body: raw(body),
    noIndex: true,
    showPagesLink: !empty,
    host,
  });
}
