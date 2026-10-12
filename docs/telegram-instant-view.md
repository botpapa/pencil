# Telegram Instant View for pencil.md pages

Two mechanisms, both live in the worker. The first is the one that matters.

## 1. Crawler bait page (default, no setup)

Telegram's link crawler identifies itself as `TelegramBot (like TwitterBot)`.
Instant View normally needs a Telegram-approved template for the domain, but
teletype.in's approved template is keyed on a meta tag, not a domain:

```html
<meta property="tg:site_verification" content="g7j8/rPFXfhyrq5q0QQV7EsYWv4=">
```

Any page carrying that tag plus teletype's article markup
(`#content.site-content.article > article.article__content > .entry-content`)
gets Instant View on **any** domain. The reader route serves exactly that to
the crawler (`src/views/telegram.ts`), and the normal page to everyone else.
So plain `https://pencil.md/<slug>` links open as Instant View when posted
anywhere in Telegram. Nothing to configure.

- Protected pages are never served to the crawler (it can't unlock them, and
  the bait page must not leak content).
- `https://pencil.md/<slug>?tg-instantview=1` shows a human what the crawler
  gets. Useful when checking markup changes.
- Telegram caches the crawl result per URL. To re-test after a change, post
  the link with throwaway query junk (`?v=2`).
- Instant View is not available on Telegram Desktop for Linux.
- Markup transforms applied for the crawler: `#` heading anchors removed,
  table wrappers unwrapped, `carousel` fences → consecutive `<figure>`s
  (Telegram groups them into a slideshow), stand-alone images → `<figure>`,
  highlight spans stripped from code (language kept), task-list checkboxes →
  ☑/☐, footnote back-arrows removed.
- Optional var `TELEGRAM_CHANNEL` (`@name`) adds a "join channel" button.

Source of the trick: <https://habr.com/ru/articles/807129/>,
<https://github.com/petrows/wp-tg-instantview>,
<https://gist.github.com/fishchev/ed2ca15d5ffd9594d41498a4bf9ba12e>.

## 2. Own template via `rhash` (fallback, optional)

Only needed if Telegram ever breaks the teletype trick. A template created in
the IV editor works **immediately, without approval**, for links of the form
```
https://t.me/iv?url=<page url>&rhash=<template hash>
```

The `rhash` identifies your (unapproved) template. Anyone who opens such a
link gets the Instant View; the plain `https://pencil.md/<slug>` link keeps
opening in the browser until Telegram approves the template (which we don't
need to wait for).

### One-time setup (owner, ~5 min)

1. Open <https://instantview.telegram.org/my/>, log in with Telegram.
2. Enter `https://pencil.md/<any slug>` as the source URL, open the template
   editor and paste the contents of [`instant-view/pencil.md.iv`](instant-view/pencil.md.iv).
   Check the preview on a few pages (tables, code, images, a carousel, footnotes),
   fix anything that looks off, then **Save**.
3. Press **View in Telegram**. The link Telegram gives you ends with
   `&rhash=<hex>`. Copy that hex.
4. Put it into the worker config (`wrangler.local.jsonc`, not committed):

   ```jsonc
   "vars": { "APP_NAME": "pencil.md", "TELEGRAM_IV_RHASH": "<hex>" }
   ```

   and deploy (`npm run deploy:prod`).

Submitting the template for review (the "Submit template" button) is optional;
if Telegram ever approves it, bare pencil.md links start opening as IV too.

### What the worker does once `TELEGRAM_IV_RHASH` is set

- `GET /<slug>/tg` redirects to the `t.me/iv?url=…&rhash=…` link for that page.
  Share this URL in Telegram and the page opens as Instant View. Protected
  pages are excluded (Telegram's fetcher can't get past the password screen).
- The page settings screen (`/<slug>/stats`) shows the Telegram link so the
  owner can copy it.
- The MCP connector returns `telegram_url` alongside `url` from `create_page`,
  `get_page`, `update_page` and `list_pages`, so an agent can hand the
  IV-ready link straight to the user.

Without the variable all of the above is simply absent — nothing else changes.

### Template notes

- The template applies only to pages whose `<body>` has `page-reader`, so the
  editor, pages list, settings and password screens never get an IV.
- `published_date` is parsed from the "published Oct 11, 2026" meta line.
- Code fences lose highlight spans but keep the language (`data-language`).
- `carousel` fences become IV slideshows; task-list checkboxes are dropped
  (text stays); footnotes get in-page anchors.
- When the reader markup changes (`src/views/reader.ts`, `src/lib/markdown.ts`),
  re-check the template in the IV editor.
