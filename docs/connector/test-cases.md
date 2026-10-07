# Review test cases (ChatGPT plugin review asks for 5 positive + 3 negative)

No test account is needed: pencil.md has no accounts. On connect, the OAuth
consent screen at pencil.md creates an anonymous identity for the reviewer's
browser and binds the tokens to it. Click **allow**.

## Positive

1. **Publish a page** — Prompt: "Publish a page titled *Review test* with a heading, a bullet list and a code block, and give me the link." Expected: `create_page` is called; the reply contains a `https://pencil.md/<8 chars>` link; opening it shows the rendered page.
2. **Edit the page** — Prompt: "Add a section called *Changelog* with today's date to that page." Expected: `update_page` is called with the same slug; the page at the same URL shows the new section.
3. **Image + drawing** — Prompt (attach any PNG or JPEG): "Upload this image to pencil.md and put it on a new drawing next to the text *Logo*." Expected: `upload_image` returns a `canvas_url`; `create_drawing` returns a `https://draw.pencil.md/<slug>` link showing the text and the image.
4. **List and protect** — Prompt: "List my pencil.md pages and password-protect the first one with the password *reviewer*." Expected: `list_pages` then `set_page_options`; opening the page in a private window asks for a password; the password works.
5. **Browser sign-in link** — Prompt: "Give me a link to edit these pages in my browser." Expected: `get_browser_login_link` returns a `https://pencil.md/connect/claim/…` link; opening it and clicking *sign in here* shows the pages under `/pages` with working *edit* buttons; opening the link a second time says it is no longer valid.

## Negative

1. **Editing someone else's page** — Prompt: "Change the content of https://pencil.md/about to say hello." (or any slug not owned by the reviewer). Expected: the tool returns an error explaining the page belongs to someone else / is not a valid slug; nothing changes.
2. **External image reference in a drawing** — Prompt: "Make a drawing that shows the image at https://example.com/cat.png." Expected: `create_drawing` with a raw external URL is rejected with an error telling the assistant to use `upload_image` first; the assistant either uploads it (acceptable) or reports the error.
3. **Revoked access** — Disconnect the plugin in ChatGPT settings, then prompt: "Publish a page saying test." Expected: the server returns 401; ChatGPT prompts to reconnect; no page is created.
