import { html, raw, layout } from "./layout.js";

export function unlockPage(slug: string, opts: { error?: boolean } = {}): string {
  const body = html`
    <section class="unlock">
      <p class="lock-icon" aria-hidden="true">🔒</p>
      <h1 class="unlock-heading">password protected</h1>
      <p class="label">enter the password to view this page.</p>
      <form class="unlock-form" method="POST" action="/${slug}/unlock">
        <input
          class="unlock-input"
          type="password"
          name="password"
          autocomplete="current-password"
          aria-label="password"
          placeholder="password"
          autofocus
          required
        />
        <button class="btn btn--primary" type="submit">unlock</button>
      </form>
      ${opts.error
        ? raw(`<p class="unlock-error" role="alert">wrong password — try again.</p>`)
        : ""}
    </section>
  `;
  return layout({
    title: "password protected — pencil.md",
    bodyClass: "page-unlock",
    body: raw(body),
    noIndex: true,
  });
}
