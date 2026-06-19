import { html, raw, layout } from "./layout.js";
import { renderMarkdown } from "../lib/markdown.js";

const DOCS_MD = `
# pencil.md API

Free public API. No keys. No signup. Reasonable use, please.

Base URL: \`https://YOUR-DEPLOYMENT/api/v1\`

## Edit access

pencil.md uses cookie-only edit. The browser (or HTTP client) that creates a
page becomes its owner via the cookie set on the \`POST\` response.

The same credential is also returned in the JSON response as \`edit_token\`.
Save it. To update the page later from a stateless client, pass it in the
\`PUT\` body as \`"edit_token": "..."\`. Under the hood it's the literal cookie
value, so the two auth paths are equivalent.

Lose both your cookie and your \`edit_token\` = the page becomes immutable.
There is no recovery.

## POST /pages

Create a page.

**Body**

\`\`\`json
{
  "title": "string",
  "content": "string (markdown, max 512 KB UTF-8 bytes)",
  "password": "optional — protect the page from the first publish"
}
\`\`\`

**Response**

\`\`\`json
{
  "slug": "abc12345",
  "url": "https://YOUR-DEPLOYMENT/abc12345",
  "edit_url": "https://YOUR-DEPLOYMENT/abc12345/edit",
  "edit_token": "<owner-id>.<hmac>",
  "protected": false
}
\`\`\`

Passing a \`password\` is the **only** way to publish an already-protected page
via the API; through the web UI, protection is enabled afterwards in the page
settings.

The response also sets a \`pencil_uid\` cookie carrying the same value. Save
either one (or both) to authenticate later \`PUT\`s.

**Example**

\`\`\`bash
curl -X POST https://YOUR-DEPLOYMENT/api/v1/pages \\
  -H "Content-Type: application/json" \\
  -d '{"title":"Hello","content":"# Hi\\n\\nIt works."}'
\`\`\`

## GET /pages/:slug

Read a page (raw markdown + metadata). No auth for public pages.

**Password-protected pages** return \`401\` unless you supply the password as a
\`?password=...\` query param or an \`X-Page-Password\` header (the owner cookie or
\`?edit_token=...\` also works).

**Response**

\`\`\`json
{
  "slug": "abc12345",
  "title": "Hello",
  "content": "# Hi\\n\\nIt works.",
  "created_at": 1761900000000,
  "updated_at": 1761900000000,
  "views": 42,
  "protected": false
}
\`\`\`

## PUT /pages/:slug

Update a page. Requires either the \`pencil_uid\` cookie set when the page was
created, or the \`edit_token\` returned by \`POST\` passed in the body. Returns
\`403\` if neither matches.

**Body**

\`\`\`json
{
  "edit_token": "optional — the value POST returned",
  "title": "optional new title",
  "content": "optional new markdown"
}
\`\`\`

**Response**

\`\`\`json
{
  "slug": "abc12345",
  "url": "https://YOUR-DEPLOYMENT/abc12345",
  "updated_at": 1761900000000
}
\`\`\`

**Example — stateless update (no cookie jar required)**

\`\`\`bash
curl -X PUT https://YOUR-DEPLOYMENT/api/v1/pages/abc12345 \\
  -H "Content-Type: application/json" \\
  -d '{
    "edit_token": "<the value POST returned>",
    "content": "# Updated body"
  }'
\`\`\`

**Example — cookie-jar variant** (equivalent; for clients that already
maintain cookies):

\`\`\`bash
curl -X POST https://YOUR-DEPLOYMENT/api/v1/pages \\
  -H "Content-Type: application/json" \\
  -c cookies.txt \\
  -d '{"title":"Hello","content":"# Hi"}'

curl -X PUT https://YOUR-DEPLOYMENT/api/v1/pages/abc12345 \\
  -H "Content-Type: application/json" \\
  -b cookies.txt \\
  -d '{"content":"updated body"}'
\`\`\`

## DELETE /pages/:slug

Permanently delete a page. Owner-only — authorise with the \`pencil_uid\` cookie
or the \`edit_token\` (as a \`?edit_token=...\` query param or in the JSON body).
Returns \`403\` if neither matches. **Irreversible.**

\`\`\`bash
curl -X DELETE "https://YOUR-DEPLOYMENT/api/v1/pages/abc12345?edit_token=<token>"
\`\`\`

**Response**

\`\`\`json
{ "slug": "abc12345", "deleted": true }
\`\`\`

## Drawings (draw.pencil.md)

Alongside the markdown app there's an infinite **drawing canvas** at
\`draw.pencil.md\` — freehand, shapes, images, and Obsidian-style live-markdown
text. It shares your cookie identity with pencil.md.

A drawing is a JSON **scene**:

\`\`\`json
{
  "schemaVersion": 1,
  "viewport": { "x": 0, "y": 0, "zoom": 1 },
  "elements": [
    { "type": "stroke", "points": [[x,y], ...], "color": "#1A1714", "width": 3 },
    { "type": "shape", "shape": "rect|ellipse|line|arrow", "x":0,"y":0,"w":0,"h":0, "color":"#…", "width":3 },
    { "type": "text", "x":0,"y":0, "md": "# markdown", "color":"#…", "fontSize":18 },
    { "type": "image", "x":0,"y":0,"w":0,"h":0, "url": "https://draw.pencil.md/img/…" }
  ]
}
\`\`\`

Create one programmatically:

\`\`\`bash
curl -X POST https://draw.pencil.md/ \\
  -H "Content-Type: application/json" \\
  -d '{"title":"Sketch","scene":"{\\"schemaVersion\\":1,\\"elements\\":[],\\"viewport\\":{\\"x\\":0,\\"y\\":0,\\"zoom\\":1}}"}'
# -> { "slug": "...", "url": "https://draw.pencil.md/...", "edit_url": "..." }
\`\`\`

\`GET https://draw.pencil.md/:slug\` renders the canvas (read-only for
non-owners). Editing, image upload, and password-protection work the same way
as markdown pages, scoped to the \`draw.\` host.

## Notes for AI agents

- Save the \`edit_token\` returned by \`POST /pages\` if you want to edit that
  page later. Without it (and without the cookie) edits return \`403\`.
- There are no rate limits beyond Cloudflare's defaults. Be reasonable.
- CORS is open: \`Access-Control-Allow-Origin: *\` on \`/api/v1/*\`.
- Markdown is sanitized at render time. Raw HTML in your input is stripped — \`html: false\` in markdown-it.
- Max content size is **512 KB UTF-8 bytes** (an emoji is 4 bytes, not 1). Larger payloads get \`413\`, rejected by \`Content-Length\` before parsing.
`;

export function docsPage(origin: string, showPagesLink = false): string {
  const md = DOCS_MD.replaceAll("https://YOUR-DEPLOYMENT", origin);
  const rendered = renderMarkdown(md);
  const body = html`
    <article class="docs prose">${raw(rendered)}</article>
  `;
  return layout({
    title: "API — pencil.md",
    description: "Public API for pencil.md. Free, no keys.",
    bodyClass: "page-docs",
    body: raw(body),
    showPagesLink,
    host: (() => { try { return new URL(origin).host; } catch { return undefined; } })(),
  });
}
