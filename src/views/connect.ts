// Pages for the MCP connector: OAuth consent, the one-time browser login
// confirmation, the /connect landing page, and the privacy / terms pages the
// connector directories require.

import { html, raw, layout, drawUrl } from "./layout.js";
import { renderMarkdown } from "../lib/markdown.js";

const SCOPE_LABELS: Record<string, string> = {
  read: "Read your pages and drawings (including password-protected ones you own)",
  write: "Publish, edit and delete pages and drawings, and upload images",
};

export function consentPage(p: {
  clientName: string;
  scope: string;
  redirectHost: string;
  txn: string;
  hasPages: boolean;
  isNewOwner: boolean;
}): string {
  const scopes = p.scope.split(" ");
  const body = html`
    <section class="consent">
      <p class="label">connect to pencil.md</p>
      <h1 class="consent-heading">Allow <strong>${p.clientName}</strong> to use pencil.md as you?</h1>
      <p class="consent-sub">It will be able to:</p>
      <ul class="consent-scopes">
        ${scopes.map((s) => raw(`<li>${SCOPE_LABELS[s] ?? s}</li>`))}
      </ul>
      <p class="consent-note">
        ${p.isNewOwner
          ? "This browser has no pencil.md identity yet, so a fresh one is being created now. Everything the app publishes will belong to it and will appear under “my pages” in this browser."
          : p.hasPages
            ? "Pages and drawings the app publishes will belong to this browser’s identity and appear next to your existing pages under “my pages”. You can edit them here like any other page."
            : "Pages and drawings the app publishes will belong to this browser’s identity and appear under “my pages”. You can edit them here like any other page."}
      </p>
      <p class="consent-note">You will be sent back to <code>${p.redirectHost}</code>. You can disconnect at any time from the app’s connector settings.</p>
      <form method="POST" action="/oauth/authorize" class="consent-form">
        <input type="hidden" name="txn" value="${p.txn}" />
        <button class="btn btn--primary" type="submit" name="action" value="allow">allow</button>
        <button class="btn" type="submit" name="action" value="deny">deny</button>
      </form>
    </section>
  `;
  return layout({
    title: `Connect ${p.clientName} — pencil.md`,
    bodyClass: "page-consent",
    body: raw(body),
    noIndex: true,
  });
}

export function consentErrorPage(heading: string, message: string): string {
  const body = html`
    <section class="consent">
      <p class="label">connect to pencil.md</p>
      <h1 class="consent-heading">${heading}</h1>
      <p class="consent-note">${message}</p>
      <p class="consent-note"><a href="/connect">About the pencil.md connector →</a></p>
    </section>
  `;
  return layout({ title: `${heading} — pencil.md`, bodyClass: "page-consent", body: raw(body), noIndex: true });
}

export function claimPage(code: string, valid: boolean): string {
  const body = valid
    ? html`
        <section class="consent">
          <p class="label">sign in to pencil.md</p>
          <h1 class="consent-heading">Use your connector identity in this browser?</h1>
          <p class="consent-note">
            This signs the current browser in as the pencil.md identity your AI assistant publishes with,
            so you can edit those pages and drawings here. If this browser already owns pages, it will
            switch to the connector identity and the old pages will no longer be editable here (they
            stay online).
          </p>
          <p class="consent-note">The link works once and expires in 15 minutes.</p>
          <form method="POST" action="/connect/claim/${code}" class="consent-form">
            <button class="btn btn--primary" type="submit">sign in here</button>
            <a class="btn" href="/">cancel</a>
          </form>
        </section>
      `
    : html`
        <section class="consent">
          <p class="label">sign in to pencil.md</p>
          <h1 class="consent-heading">This link is no longer valid</h1>
          <p class="consent-note">Login links work once and expire after 15 minutes. Ask your assistant for a new one.</p>
        </section>
      `;
  return layout({ title: "Sign in — pencil.md", bodyClass: "page-consent", body: raw(body), noIndex: true });
}

// ---------- /connect landing ----------

const CONNECT_MD = (origin: string, draw: string) => `
Add pencil.md to Claude or ChatGPT and your assistant can **publish markdown pages
and drawings, share the links, and keep editing them** — without you leaving the
chat. Everything it publishes belongs to your browser identity, so you can open
any page here and edit it by hand too.

## What the connector can do

- Publish a markdown page and return a shareable link (\`${origin}/abc12345\`).
- Read, update, rename, password-protect, or delete pages you own.
- Upload images (from a URL or inline) and place them in pages or on a canvas.
- Create and edit **drawings** on the infinite canvas at [${draw.replace("https://", "").replace("http://", "")}](${draw}):
  text in live markdown, shapes, arrows, freehand strokes and images.
- List everything you have published.
- Hand you a one-time link that signs any browser in as the same identity, so
  you can edit agent-made pages on another device.

## Add it to Claude

1. In Claude, open **Settings → Connectors** and choose **Add custom connector**
   (or find **pencil.md** in the connector directory).
2. Enter the server URL: \`${origin}/mcp\`
3. Claude opens a pencil.md approval screen. Click **allow**.

Works in the Claude apps and in Claude Code (\`claude mcp add --transport http pencil ${origin}/mcp\`).

## Add it to ChatGPT

1. In ChatGPT, open **Settings → Apps & Connectors** (developer mode lets you
   add it before the directory listing is live) and choose **Create / Add**.
2. Enter the MCP server URL: \`${origin}/mcp\` and pick **OAuth**.
3. ChatGPT opens the pencil.md approval screen. Click **allow**.

## Any other MCP client

The server speaks MCP over Streamable HTTP at \`${origin}/mcp\` with OAuth 2.1
(PKCE, dynamic client registration). Discovery documents:

- \`${origin}/.well-known/oauth-protected-resource/mcp\`
- \`${origin}/.well-known/oauth-authorization-server\`

## How identity works

pencil.md has no accounts. When you click **allow**, the tokens are tied to the
same cookie identity your browser already uses. If you connect from a browser
that has never visited pencil.md, a fresh identity is created for it. To edit
agent-published pages from another browser, ask your assistant for a *browser
login link* — it is valid once, for 15 minutes.

Disconnect any time from the app’s connector settings; the tokens are revoked
on our side. See the [privacy policy](${origin}/privacy) and [terms](${origin}/terms).
`;

export function connectPage(origin: string, showPagesLink = false): string {
  const host = (() => {
    try {
      return new URL(origin).host;
    } catch {
      return undefined;
    }
  })();
  const rendered = renderMarkdown(CONNECT_MD(origin, drawUrl(host)));
  const body = html`
    <article class="docs prose">
      <h1 id="connect">pencil.md for Claude &amp; ChatGPT</h1>
      ${raw(rendered)}
    </article>
  `;
  return layout({
    title: "Connect Claude & ChatGPT — pencil.md",
    description: "Add pencil.md to Claude or ChatGPT: your assistant publishes markdown pages and drawings, shares the links, and edits them later.",
    canonicalUrl: `${origin}/connect`,
    bodyClass: "page-connect",
    body: raw(body),
    showPagesLink,
    host,
  });
}

// ---------- privacy + terms ----------

const PRIVACY_MD = (origin: string) => `
*Last updated: 7 October 2026*

pencil.md is a free markdown and drawing publishing service. This policy covers
the website, the public API, and the Claude / ChatGPT connector (the MCP server
at \`${origin}/mcp\`).

## What we store

- **Pages and drawings you publish**: title, content, creation and update
  times, a view counter, and (if you set one) a password hash. Pages are public
  to anyone with the link unless you protect them with a password.
- **Images you upload**: stored in object storage and served at a public URL.
- **An anonymous identity**: a random ID in a signed cookie (\`pencil_uid\`).
  It marks which browser owns which pages. It contains no personal data.
- **Connector credentials**: when you connect an AI assistant, we store the
  app's registration, and hashed access/refresh tokens tied to your anonymous
  identity. We never see your Claude or ChatGPT account details.

## What we don't do

- No accounts, no email addresses, no names.
- No analytics, no third-party scripts, no advertising, no tracking pixels.
- We do not sell or share data. Content is only read by our servers to render
  and serve it.
- We do not read your conversations with your assistant. The assistant sends
  us only the content it is publishing or the page it is asking for.

## Connector data flow

When an assistant calls a connector tool, we receive the tool input (for
example, the markdown of a page) and return the result (for example, the
link). Nothing is retained beyond the published content itself and standard
short-lived request logs used for abuse prevention.

Disconnecting the app from Claude or ChatGPT revokes its tokens. Pages it
published remain online until you delete them.

## Infrastructure

The service runs on Cloudflare Workers, D1 and R2. Cloudflare may process
request metadata (IP address, user agent) under its own privacy policy for
security and performance.

## Your rights

Delete any page or drawing you own from its page, or ask your assistant to
delete it. For anything else, contact us at the address below.

## Contact

[hello@pencil.md](mailto:hello@pencil.md)
`;

const TERMS_MD = (origin: string) => `
*Last updated: 7 October 2026*

By using pencil.md, its API, or the Claude / ChatGPT connector you agree to the
following.

## The service

pencil.md lets you publish markdown pages and drawings and share them by link.
It is provided free of charge, as-is, without warranty of any kind. We may
change or discontinue features at any time.

## Your content

You keep all rights to what you publish. You are responsible for it. Do not
publish content that is illegal, infringes others' rights, contains malware,
or is spam, harassment, or sexual content involving minors. We remove such
content and may block the identity that published it.

## Access and ownership

Ownership of a page is tied to an anonymous browser identity and, for the
connector, to the tokens issued when you clicked **allow**. If you lose the
cookie and any edit credentials, the page becomes read-only. Keep your own
copies of anything important.

## Connector

The connector acts on your behalf inside Claude, ChatGPT, or another MCP
client. Actions your assistant takes (publishing, editing, deleting) are your
actions. Disconnect the app to revoke its access.

## Fair use

Use the service reasonably. We may rate-limit or block abusive traffic.

## Liability

To the maximum extent permitted by law, pencil.md and its operators are not
liable for any loss arising from use of the service.

## Contact

[hello@pencil.md](mailto:hello@pencil.md)
`;

export function privacyPage(origin: string, showPagesLink = false): string {
  const host = (() => {
    try {
      return new URL(origin).host;
    } catch {
      return undefined;
    }
  })();
  const body = html`
    <article class="docs prose">
      <h1 id="privacy">Privacy policy</h1>
      ${raw(renderMarkdown(PRIVACY_MD(origin)))}
    </article>
  `;
  return layout({
    title: "Privacy — pencil.md",
    description: "What pencil.md stores and what it never does.",
    canonicalUrl: `${origin}/privacy`,
    bodyClass: "page-privacy",
    body: raw(body),
    showPagesLink,
    host,
  });
}

export function termsPage(origin: string, showPagesLink = false): string {
  const host = (() => {
    try {
      return new URL(origin).host;
    } catch {
      return undefined;
    }
  })();
  const body = html`
    <article class="docs prose">
      <h1 id="terms">Terms of service</h1>
      ${raw(renderMarkdown(TERMS_MD(origin)))}
    </article>
  `;
  return layout({
    title: "Terms — pencil.md",
    description: "Terms of service for pencil.md and its connector.",
    canonicalUrl: `${origin}/terms`,
    bodyClass: "page-terms",
    body: raw(body),
    showPagesLink,
    host,
  });
}
