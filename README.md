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
npx wrangler r2 bucket create pencil-og

# 3. Set the cookie-signing secret.
openssl rand -base64 32 | npx wrangler secret put COOKIE_SECRET

# 4. Apply migrations.
npm run db:migrate

# 5. Build and deploy.
npm run deploy
```

Open `/` and start writing. `/health` should return `{"ok":true,"app":"pencil.md"}`.

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
D1 for pages
R2 for cached OG images
Vanilla TypeScript client
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
