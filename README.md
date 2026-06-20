# pencil.md

> Paste markdown, get a link. No signup, no tracking.

`pencil.md` is an open-source telegra.ph alternative for markdown.

Write something, publish it, share the link. If you keep the edit key, you can
change it later.

[![License: MIT](https://img.shields.io/badge/license-MIT-black.svg)](./LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/runtime-Cloudflare%20Workers-f38020.svg)](https://workers.cloudflare.com/)
[![No tracking](https://img.shields.io/badge/tracking-none-1a1714.svg)](#features)

## Features

- Markdown editor with live preview and local drafts.
- Clean reader pages with syntax highlighting and heading anchors.
- **Infinite drawing canvas** at `draw.pencil.md` — freehand, shapes, images,
  and Obsidian-style live-markdown text, with the same save/share/edit flow.
- No account system. Edit access uses a signed cookie or `edit_token`.
- Sanitized markdown, strict CSP, no inline scripts.
- Public API for scripts, agents, and CLI tools.
- Built for self-hosting on Cloudflare.

## How It Works

```text
paste markdown -> publish -> get a URL
```

Pages are public. Editing requires the owner cookie or the `edit_token` returned
by the API. Lose both and the page becomes read-only.

## Draw (infinite canvas)

`draw.pencil.md` is a sibling app served by the same Worker (matched by the
`draw.` hostname). It's a vanilla infinite canvas:

- Draw freehand or drop rectangles, ellipses, lines, and arrows in five colours.
- Switch to text mode (⌘/Ctrl+Enter, or the on-screen button) and click anywhere
  to type. Text renders as **live markdown** — headings, bold/italic, code,
  lists, quotes, and links reveal their syntax only on the line you're editing,
  Obsidian-style.
- Paste images, pan/zoom (pinch on touch), select to move/resize, undo/redo.
- Save, share, edit, password-protect, and delete — same as a markdown page.

A drawing is stored as a JSON scene (`{ schemaVersion, elements[], viewport }`)
in the `drawings` table; pasted images and the share thumbnail live in R2.
Identity is shared with `pencil.md` via a cookie scoped to the apex domain.

### Scene format (creating drawings via the API)

Create a drawing with `POST https://draw.pencil.md/` and a JSON body
`{ title, scene, thumb? }`, where `scene` is the **stringified** JSON of
`{ schemaVersion: 1, viewport: { x, y, zoom }, elements: [...] }`. Each element:

```jsonc
{ "id": "a", "type": "stroke", "points": [[x,y],…], "color": "#1A1714", "width": 3, "dash": "solid" }
{ "id": "b", "type": "shape", "shape": "rect|ellipse|line|arrow",
  "x": 0, "y": 0, "w": 160, "h": 90, "color": "#2B5C8A", "width": 4, "dash": "dashed", "fill": false }
{ "id": "c", "type": "text", "x": 0, "y": 0, "md": "# Title", "color": "#1A1714", "fontSize": 24 }
{ "id": "d", "type": "image", "x": 0, "y": 0, "w": 200, "h": 120, "url": "/img/abc.png" }
```

Layout rules agents must account for (there is **no auto-layout**):

- **Absolute coordinates**, one infinite plane. Elements **paint in array order** —
  later elements sit on top. You are responsible for not overlapping things.
- **Text never wraps.** Each `\n` in `md` is its own line; the block grows to its
  widest line. Insert your own line breaks.
- **`fontSize` is the *base* size.** Markdown headings scale it: `#` ≈ **1.9×**,
  `##` ≈ **1.5×**, `###` ≈ **1.25×**. Line height is **1.5×** the (scaled) size.
  So a `# Heading` at `fontSize: 40` occupies ≈ `40 × 1.9 × 1.5 ≈ 114px` of height —
  budget vertical space accordingly before placing the next element.
- `md` supports the same live markdown as the editor (headings, `**bold**`,
  `*italic*`, `` `code` ``, `~~strike~~`, `==mark==`, `> quote`, `- list`, links).
- `color` is any hex; `dash` is `solid` | `dashed` | `dotted`; `fill` applies to
  `rect`/`ellipse`. Images must reference an issued `/img/…` key (upload via
  `POST /api/images`); external URLs are rejected.
- `viewport` is how the drawing opens (pan `x`/`y` + `zoom`).
- `thumb` (optional) is a `data:image/png;base64,…` used as the share/OG image;
  the editor renders it from the canvas, so it mirrors heading scaling and fills.

## Self-Host In 5 Minutes

You need a Cloudflare account, Node 20+, and `wrangler` through npm.

```bash
git clone https://github.com/botpapa/pencil
cd pencil
npm install

# 1. Authenticate with Cloudflare.
npx wrangler login

# 2. Provision storage.
npx wrangler d1 create pencil-md
# Copy the returned database_id into wrangler.jsonc d1_databases[0].database_id
npx wrangler r2 bucket create pencil-og        # cached OG images
npx wrangler r2 bucket create pencil-draw-img  # draw canvas images + thumbnails

# 3. Set the cookie-signing secret.
openssl rand -base64 32 | npx wrangler secret put COOKIE_SECRET

# 4. Apply migrations.
npm run db:migrate

# 5. Build and deploy.
npm run deploy
```

Open `/` and start writing. `/health` should return `{"ok":true,"app":"pencil.md"}`.

To serve the drawing canvas, add `draw.<your-domain>` as a custom-domain route
in your Wrangler config (it runs from the same Worker). Locally it's reachable
at `http://draw.localhost:8787` with no extra setup.

## Local Development

```bash
cp .dev.vars.example .dev.vars
# Generate COOKIE_SECRET with: openssl rand -base64 32

npm run db:migrate:local
npm run dev
```

The dev server runs at `http://localhost:8787`.

```bash
npm run build        # bundle client assets
npm run test         # run Vitest suite
npm run typecheck    # run TypeScript checks
npm run deploy       # build and deploy to Cloudflare
```

## API

```text
POST   /api/v1/pages         create a page
GET    /api/v1/pages/:slug   read a page
PUT    /api/v1/pages/:slug   update a page
```

See `/api` on a running deployment for examples.

## Stack

```text
Cloudflare Workers + Hono
D1 for pages and drawings
R2 for cached OG images and canvas images
Vanilla TypeScript client (markdown + canvas)
markdown-it + sanitize-html
```

## Security

- Raw HTML is disabled in `markdown-it`.
- Link and image URLs are validated before rendering.
- Output is passed through `sanitize-html` with a strict allowlist.
- Rendered pages use a strict CSP with no `unsafe-inline` scripts.
- Edit ownership is stored in an HMAC-signed cookie.
- Tampered edit credentials are rejected.
- Obvious bots and owner views are skipped by the view counter.
- Drawing scenes are size-capped and only reference same-origin (`/img/…`)
  images — a shared scene can't point a viewer's browser at arbitrary URLs.

### Rate limiting

Creation and password endpoints are intentionally unauthenticated (no signup),
so protect them at the edge with [Cloudflare Rate Limiting](https://developers.cloudflare.com/waf/rate-limiting-rules/)
rules rather than in the Worker. Recommended rules:

| Path | Method | Suggested limit |
| --- | --- | --- |
| `/:slug/unlock` (both apps) | POST | 10 / minute / IP |
| `draw.*/api/images` | POST | 30 / hour / IP |
| `/` and `draw.*/` (create) | POST | 60 / hour / IP |

In-Worker, uploads and bodies are already size-capped (`MAX_IMAGE_BYTES`,
`MAX_SCENE_BYTES`) and require a `Content-Length`; the rate rules above bound
*volume* and brute-force.

## Contributing

Pull requests are welcome. Keep it small, readable, and privacy-friendly.

```bash
npm install
npm test
npm run typecheck
```

### End-to-end tests against a deployment

`tests/e2e/production.test.ts` exercises a live deployment via real `fetch`. It
is opt-in (separate config, never run by `npm test`).

```bash
npm run e2e:prod                              # hits https://pencil.md
E2E_BASE_URL=https://staging.example npm run e2e
```

Each run creates a handful of pages whose titles begin with `e2e:`. To clean
them out:

```bash
wrangler d1 execute pencil-md --remote \
  --command "DELETE FROM pages WHERE title LIKE 'e2e:%'"
```

- Keep rendered pages free of third-party scripts.
- Do not add tracking.
- Keep the editor bundle under 50 KB gzipped.
- Keep the reader bundle under 5 KB gzipped.
- Add XSS coverage for new markdown behavior.

## License

MIT.
