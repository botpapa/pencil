import { html, raw, layout } from "./layout.js";

export function statsPage(
  slug: string,
  title: string,
  views: number,
  createdAt: number,
  indexable: boolean,
): string {
  const enabled = indexable;
  const body = html`
    <section class="stats">
      <p class="number">${String(views.toLocaleString())}</p>
      <p class="label">views &middot; <a href="/${slug}">${title || "untitled"}</a></p>
      <p class="label" style="margin-top:2rem">since ${new Date(createdAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}</p>

      <form method="POST" action="/${slug}/settings/indexable" class="indexing-form" style="margin-top:3rem">
        <p class="label">search engine indexing: <strong>${enabled ? "enabled" : "disabled"}</strong></p>
        <button type="submit" name="indexable" value="${enabled ? "0" : "1"}" class="btn">
          ${enabled ? "disable" : "enable"} indexing
        </button>
      </form>
    </section>
  `;
  return layout({
    title: `${title || "untitled"} — stats`,
    bodyClass: "page-stats",
    body: raw(body),
    noIndex: true,
  });
}

export function notFoundPage(): string {
  const body = html`
    <section class="stats">
      <p class="number">404</p>
      <p class="label">no such page</p>
      <p style="margin-top:2rem"><a class="btn" href="/">go write one</a></p>
    </section>
  `;
  return layout({
    title: "404 — pencil.md",
    bodyClass: "page-404",
    body: raw(body),
    noIndex: true,
  });
}
