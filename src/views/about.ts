import { html, raw, layout } from "./layout.js";
import { renderMarkdown } from "../lib/markdown.js";

// We deliberately render the H1 ("About pencil.md") outside of markdown so
// markdown-it's linkify doesn't turn the literal text "pencil.md" into an
// autolink (it treats ".md" as a TLD). The body is markdown so the rest of
// the page still gets the prose treatment (headings, lists, links).
const ABOUT_BODY_MD = (origin: string) => `
**pencil.md** is a free, open-source markdown publishing service. Paste
markdown, get a permanent shareable URL — no account, no signup, no paywall.

## How it works

Open the home page, type or paste markdown, click publish. You get a short
URL like \`pencil.md/abc12345\`. Share it anywhere. Your browser cookie marks
you as the owner so you can edit later. The same credential is also returned
by the public API as \`edit_token\` for stateless clients and AI agents.

## Why

- Free forever. No upsells.
- Open source (MIT). Self-hostable on Cloudflare Workers in minutes.
- No signup. Cookie-only ownership.
- AI-friendly. Free public API for agents to publish and update pages.
- Privacy-respecting. No third-party scripts, no analytics, no fonts from a CDN.
- Strict security. Sanitized markdown, layered XSS defense, signed cookies, HSTS-ready.

## Good for

Long-form notes, drafts, change-logs, post-mortems, quick docs, public
artifacts from AI agents — anything you'd post on a gist with friendlier
rendering.

## Open source

Source: [github.com/botpapa/pencil](https://github.com/botpapa/pencil).
API docs: [${origin}/api](${origin}/api).
`;

const ABOUT_DESCRIPTION =
  "pencil.md is a free, open-source markdown publishing service. Paste markdown, get a shareable URL — no signup, no paywall.";

export function aboutPage(origin: string): string {
  const rendered = renderMarkdown(ABOUT_BODY_MD(origin));
  const body = html`
    <article class="docs prose">
      <h1 id="about-pencil-md">About pencil.md</h1>
      ${raw(rendered)}
    </article>
  `;
  return layout({
    title: "About — pencil.md",
    description: ABOUT_DESCRIPTION,
    canonicalUrl: `${origin}/about`,
    bodyClass: "page-about",
    body: raw(body),
  });
}
