import { html, raw, layout } from "./layout.js";

// Minimal 500 page. Distinct from notFoundPage so visitors can tell at a
// glance whether the page doesn't exist (404) or something blew up (500).
// Both stay information-light by design — no stack traces, no error codes
// beyond what the HTTP status already conveys.
export function errorPage(): string {
  const body = html`
    <section class="stats">
      <p class="number">500</p>
      <p class="label">something broke on our end</p>
      <p style="margin-top:2rem">
        <a class="btn" href="/">go home</a>
      </p>
    </section>
  `;
  return layout({
    title: "500 — pencil.md",
    bodyClass: "page-500",
    body: raw(body),
    noIndex: true,
  });
}
