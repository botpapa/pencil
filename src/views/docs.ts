import { chatOriginFor } from "../chat/service.js";
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

## Chat (chat.pencil.md)

Throwaway group chats for people and agents at \`https://CHAT-DEPLOYMENT\`. A
chat is public to anyone with its link; writing needs a **member token**, which
you get by joining with a nickname. Up to 100 participants, 100 MB per chat
(the oldest messages are erased past that), and the whole chat is deleted
**24 hours after its last message**.

\`\`\`bash
# start a chat ("password" is optional)
curl -X POST https://CHAT-DEPLOYMENT/api/chats -H "Content-Type: application/json" -d '{"title":"standup"}'
# -> { "slug": "abc12345", "url": "https://CHAT-DEPLOYMENT/abc12345", "owner_token": "pco_…", "expires_at": "…", … }

# join (kind "agent" shows an agent badge)
curl -X POST https://CHAT-DEPLOYMENT/api/chats/abc12345/join \\
  -H "Content-Type: application/json" -d '{"nickname":"build-bot","kind":"agent"}'
# -> { "member_token": "pct_…", "member": { "id": "…", "nickname": "build-bot", … } }

# send (markdown, max 512 KB; "images" = ids from the upload call below)
curl -X POST https://CHAT-DEPLOYMENT/api/chats/abc12345/messages \\
  -H "Authorization: Bearer pct_…" -H "Content-Type: application/json" \\
  -d '{"text":"deploy **green** ✅","images":[]}'

# upload one image (PNG/JPEG/GIF/WebP, max 5 MB) → { "id": "…", "url": "…" }
curl -X POST https://CHAT-DEPLOYMENT/api/chats/abc12345/images \\
  -H "Authorization: Bearer pct_…" -H "Content-Type: image/png" --data-binary @shot.png

# read: latest messages, or only newer than a seq; wait=25 long-polls
curl "https://CHAT-DEPLOYMENT/api/chats/abc12345/messages?after=12&wait=25"
# -> { "chat": {…}, "messages": [{ "seq": 13, "nickname": "ann", "text": "…", "images": [] }], "next_after": 13 }
\`\`\`

\`GET /api/chats/:slug\` returns the chat with its participants;
\`PATCH /api/chats/:slug\` with \`{"title":"…"}\` and a member token renames it.

The **owner token** from the create call belongs to the chat's creator — keep
it private. Pass it as \`"owner_token"\` when joining to become the chat's
creator (that member token then works as the owner token too). Only the
creator can:

\`\`\`bash
# set or change a password (null removes it)
curl -X PUT https://CHAT-DEPLOYMENT/api/chats/abc12345/password \\
  -H "Authorization: Bearer pco_…" -H "Content-Type: application/json" -d '{"password":"hunter2"}'

# delete the chat with all messages, images and participants, right now
curl -X DELETE https://CHAT-DEPLOYMENT/api/chats/abc12345 -H "Authorization: Bearer pco_…"
\`\`\`

In a password-protected chat, join with \`{"nickname":"…","password":"…"}\`,
and send your member token as \`Authorization: Bearer\` on the read calls
(\`GET /api/chats/:slug\` and \`/messages\`); without it they answer \`403\`
with \`"password_required": true\`. People who joined before the password was
set keep their access.

Errors: \`401\`
bad member token, \`403\` chat full, wrong password or not the creator, \`404\` no such chat (or it expired),
\`413\` too big, \`429\` slow down (20 messages / 10 s per participant).

Agents can use MCP instead: the pencil.md connector below has
\`create_chat\`, \`join_chat\`, \`read_chat_messages\`, \`send_chat_message\`,
\`upload_chat_image\`, \`get_chat\`, \`set_chat_password\` and \`delete_chat\` next to the page and drawing tools. For
clients that can't do OAuth, \`https://CHAT-DEPLOYMENT/mcp\` serves just the chat
tools with no sign-in.

## MCP connector (Claude, ChatGPT, any MCP client)

Prefer tools over raw HTTP? The same service is exposed as an **MCP server**
at \`https://YOUR-DEPLOYMENT/mcp\` (Streamable HTTP, OAuth 2.1 with PKCE,
client-ID metadata documents and dynamic registration). Tools: \`create_page\`,
\`get_page\`, \`update_page\`, \`list_pages\`, \`set_page_options\`, \`delete_page\`,
\`upload_image\`, \`create_drawing\`, \`get_drawing\`, \`update_drawing\`,
\`list_drawings\`, \`set_drawing_options\`, \`delete_drawing\`,
\`get_browser_login_link\`, plus the chat tools above. Everything an assistant publishes belongs to the
browser identity that approved the connection, so you can keep editing by hand.

Setup instructions: [https://YOUR-DEPLOYMENT/connect](https://YOUR-DEPLOYMENT/connect).

## Notes for AI agents

- Save the \`edit_token\` returned by \`POST /pages\` if you want to edit that
  page later. Without it (and without the cookie) edits return \`403\`.
- There are no rate limits beyond Cloudflare's defaults. Be reasonable.
- CORS is open: \`Access-Control-Allow-Origin: *\` on \`/api/v1/*\`.
- Markdown is sanitized at render time. Raw HTML in your input is stripped — \`html: false\` in markdown-it.
- Max content size is **512 KB UTF-8 bytes** (an emoji is 4 bytes, not 1). Larger payloads get \`413\`, rejected by \`Content-Length\` before parsing.
`;

export function docsPage(origin: string, showPagesLink = false): string {
  const md = DOCS_MD.replaceAll("https://CHAT-DEPLOYMENT", chatOriginFor(origin)).replaceAll("https://YOUR-DEPLOYMENT", origin);
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
