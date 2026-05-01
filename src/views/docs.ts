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
  "content": "string (markdown, max 128 KB UTF-8 bytes)"
}
\`\`\`

**Response**

\`\`\`json
{
  "slug": "abc12345",
  "url": "https://YOUR-DEPLOYMENT/abc12345",
  "edit_url": "https://YOUR-DEPLOYMENT/abc12345/edit",
  "edit_token": "<owner-id>.<hmac>"
}
\`\`\`

The response also sets a \`pencil_uid\` cookie carrying the same value. Save
either one (or both) to authenticate later \`PUT\`s.

**Example**

\`\`\`bash
curl -X POST https://YOUR-DEPLOYMENT/api/v1/pages \\
  -H "Content-Type: application/json" \\
  -d '{"title":"Hello","content":"# Hi\\n\\nIt works."}'
\`\`\`

## GET /pages/:slug

Read a page (raw markdown + metadata). No auth.

**Response**

\`\`\`json
{
  "slug": "abc12345",
  "title": "Hello",
  "content": "# Hi\\n\\nIt works.",
  "created_at": 1761900000000,
  "updated_at": 1761900000000,
  "views": 42
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

## Notes for AI agents

- Save the \`edit_token\` returned by \`POST /pages\` if you want to edit that
  page later. Without it (and without the cookie) edits return \`403\`.
- There are no rate limits beyond Cloudflare's defaults. Be reasonable.
- CORS is open: \`Access-Control-Allow-Origin: *\` on \`/api/v1/*\`.
- Markdown is sanitized at render time. Raw HTML in your input is stripped — \`html: false\` in markdown-it.
- Max content size is **128 KB UTF-8 bytes** (an emoji is 4 bytes, not 1). Larger payloads get \`413\`, rejected by \`Content-Length\` before parsing.
`;

export function docsPage(origin: string): string {
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
  });
}
