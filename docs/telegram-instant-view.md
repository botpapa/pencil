# Telegram Instant View for pencil.md pages

Telegram renders a page as Instant View (IV) when it has a template for the
domain. Templates normally have to be submitted and approved by Telegram, but
there is a sanctioned shortcut: a template you create in the IV editor works
**immediately, without approval**, for links of the form

```
https://t.me/iv?url=<page url>&rhash=<template hash>
```

The `rhash` identifies your (unapproved) template. Anyone who opens such a
link gets the Instant View; the plain `https://pencil.md/<slug>` link keeps
opening in the browser until Telegram approves the template (which we don't
need to wait for).

## One-time setup (owner, ~5 min)

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

## What the worker does once `TELEGRAM_IV_RHASH` is set

- `GET /<slug>/tg` redirects to the `t.me/iv?url=…&rhash=…` link for that page.
  Share this URL in Telegram and the page opens as Instant View. Protected
  pages are excluded (Telegram's fetcher can't get past the password screen).
- The page settings screen (`/<slug>/stats`) shows the Telegram link so the
  owner can copy it.
- The MCP connector returns `telegram_url` alongside `url` from `create_page`,
  `get_page`, `update_page` and `list_pages`, so an agent can hand the
  IV-ready link straight to the user.

Without the variable all of the above is simply absent — nothing else changes.

## Template notes

- The template applies only to pages whose `<body>` has `page-reader`, so the
  editor, pages list, settings and password screens never get an IV.
- `published_date` is parsed from the "published Oct 11, 2026" meta line.
- Code fences lose highlight spans but keep the language (`data-language`).
- `carousel` fences become IV slideshows; task-list checkboxes are dropped
  (text stays); footnotes get in-page anchors.
- When the reader markup changes (`src/views/reader.ts`, `src/lib/markdown.ts`),
  re-check the template in the IV editor.
