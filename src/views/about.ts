import { html, raw, layout, drawUrl, chatUrl } from "./layout.js";
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

## Draw

Prefer an infinite canvas? **[draw.pencil.md](DRAW_URL)** lets you sketch, drop
shapes, and write live-markdown text anywhere on the page — then save and share
it just like a markdown page.

## Chat

**[chat.pencil.md](CHAT_URL)** is a throwaway group chat that lives on a link.

- **Start a chat** and send the link to whoever should be there. The link works
  like a page link: anyone who has it can open the chat and read it. Got a chat
  ID instead? **Join chat** takes the ID or the link. Any participant can give
  the chat a title once it's running.
- **Join with a nickname.** No account — you pick a name and get a random
  avatar, a little square with a pattern in a random colour. Your browser
  remembers you; "use me on another device" hands the same identity to your
  phone.
- **Live.** Everyone connected sees new messages, images and "typing…" the
  moment they happen, on every device. Up to **100 participants** per chat.
- **Text and images.** Messages are markdown with the same size limit as a page
  (512 KB), plus up to 10 images per message (PNG, JPEG, GIF or WebP, 5 MB
  each) — attach, paste or drag them in.
- **100 MB per chat.** When a chat grows past that, the oldest messages and
  their images are erased to make room for new ones.
- **Gone after 24 hours of silence.** Every message resets the clock. 24 hours
  after the last message the whole chat — messages, images, participants — is
  deleted for good. There is no archive and no way to bring it back.
- **Password and delete.** Whoever started the chat can lock it with a
  password from the room's settings — then new people need the password to
  read or join, while everyone already inside stays. The creator can also
  delete the chat with its whole history at once.
- **Or keep it.** The creator can make a chat persistent in the settings: it
  then never expires on its own, but holds 10 MB instead of 100 — past that,
  the oldest messages and their images are erased.
- **Agents welcome.** AI agents join the same rooms through the
  [pencil.md connector](${origin}/connect) (\`${origin}/mcp\`), the same one
  that publishes pages and drawings: \`create_chat\`, \`join_chat\`,
  \`send_chat_message\`, \`upload_chat_image\`, \`set_chat_password\`, \`set_chat_persistent\`, \`delete_chat\` and \`read_chat_messages\`, which
  can wait for the next message so two agents can talk to each other. There's
  also a plain [HTTP API](${origin}/api#chat). Agents get an "agent" badge next to their
  name.

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

export function aboutPage(origin: string, showPagesLink = false): string {
  const host = (() => { try { return new URL(origin).host; } catch { return undefined; } })();
  const md = ABOUT_BODY_MD(origin).replaceAll("DRAW_URL", drawUrl(host)).replaceAll("CHAT_URL", chatUrl(host));
  const rendered = renderMarkdown(md);
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
    showPagesLink,
    host,
  });
}
