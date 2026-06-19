import { html, raw, layout } from "./layout.js";

export type StatsViewOpts = {
  slug: string;
  title: string;
  views: number;
  createdAt: number;
  indexable: boolean;
  protected: boolean;
  showPagesLink?: boolean;
  host?: string;
};

export function statsPage(opts: StatsViewOpts): string {
  const { slug, title, views, createdAt, indexable, protected: isProtected } = opts;

  // Indexing — a direct inline toggle. Protected pages are noindex by force, so
  // we just state that instead of offering the toggle.
  const indexing = isProtected
    ? html`
        <div class="setting">
          <div class="row">
            <span class="k">search engine indexing</span>
            <span class="v"><span class="state">off</span></span>
          </div>
          <p class="row-note">protected pages are never indexed</p>
        </div>
      `
    : html`
        <form method="POST" action="/${slug}/settings/indexable" class="setting">
          <div class="row">
            <span class="k">search engine indexing</span>
            <span class="v">
              <span class="state${indexable ? " on" : ""}">${indexable ? "enabled" : "disabled"}</span>
              <button type="submit" name="indexable" value="${indexable ? "0" : "1"}" class="setting-action">${indexable ? "disable" : "enable"}</button>
            </span>
          </div>
        </form>
      `;

  // The password field, revealed inside a row's <details> panel (no JS).
  const passwordField = (label: string, placeholder: string) => html`
    <form method="POST" action="/${slug}/settings/password" class="pw-form">
      <input
        type="password"
        name="password"
        class="pw-input"
        autocomplete="new-password"
        placeholder="${placeholder}"
        aria-label="${placeholder}"
        required
      />
      <button type="submit" class="btn">${label}</button>
    </form>
  `;

  // Password row: the whole line is the <details> summary; clicking it reveals
  // the field panel below. When protected, the panel also offers "remove".
  const password = isProtected
    ? html`
        <details class="setting">
          <summary class="row">
            <span class="k">password protection</span>
            <span class="v"><span class="state on">on</span><span class="setting-action">change</span></span>
          </summary>
          <div class="row-reveal">
            ${raw(passwordField("change", "new password"))}
            <form method="POST" action="/${slug}/settings/password" class="row-remove">
              <input type="hidden" name="remove" value="1" />
              <button type="submit" class="setting-action danger-link">remove password</button>
            </form>
          </div>
        </details>
      `
    : html`
        <details class="setting">
          <summary class="row">
            <span class="k">password protection</span>
            <span class="v"><span class="state">off</span><span class="setting-action">enable</span></span>
          </summary>
          <div class="row-reveal">${raw(passwordField("set password", "set a password"))}</div>
        </details>
      `;

  const body = html`
    <section class="stats">
      <p class="number">${String(views.toLocaleString())}</p>
      <p class="label">views &middot; <a href="/${slug}">${title || "untitled"}</a></p>
      <p class="label" style="margin-top:1rem">since ${new Date(createdAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}</p>

      <div class="settings">
        ${raw(indexing)}
        ${raw(password)}

        <details class="setting">
          <summary class="row">
            <span class="k">delete page</span>
            <span class="v"><span class="setting-action danger-link">delete</span></span>
          </summary>
          <div class="row-reveal">
            <p class="row-note">permanent &middot; this can't be undone</p>
            <form method="POST" action="/${slug}/delete">
              <button type="submit" class="btn btn--danger">yes, delete forever</button>
            </form>
          </div>
        </details>
      </div>
    </section>
  `;
  return layout({
    title: `${title || "untitled"} — settings`,
    bodyClass: "page-stats",
    body: raw(body),
    noIndex: true,
    showPagesLink: opts.showPagesLink,
    host: opts.host,
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
