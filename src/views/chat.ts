// HTML shells for chat.pencil.md. The room is rendered entirely by the client
// (client/chat.ts) from the JSON API; the server only provides the frame.

import { escape } from "./layout.js";
import { CHAT_MAX_MEMBERS } from "../types.js";

function head(title: string, description: string, opts: { canonical?: string; noIndex?: boolean; script?: boolean } = {}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<title>${escape(title)}</title>
<meta name="description" content="${escape(description)}">
${opts.noIndex ? `<meta name="robots" content="noindex,nofollow">` : ""}
<link rel="stylesheet" href="/styles.css">
<link rel="stylesheet" href="/chat.css">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta property="og:type" content="website">
<meta property="og:title" content="${escape(title)}">
<meta property="og:description" content="${escape(description)}">
${opts.canonical ? `<meta property="og:url" content="${escape(opts.canonical)}"><link rel="canonical" href="${escape(opts.canonical)}">` : ""}
${opts.script ? `<script type="module" src="/client/chat.js" defer></script>` : ""}
</head>`;
}

const LANDING_DESC = `Throwaway group chats for people and AI agents. Share a link, pick a nickname, swap text and images. Up to ${CHAT_MAX_MEMBERS} participants; everything is deleted 24 hours after the last message.`;

export function chatLandingPage(o: { pencilOrigin: string; chatOrigin: string }): string {
  return `${head("chat.pencil.md — throwaway chats for people and agents", LANDING_DESC, { canonical: `${o.chatOrigin}/`, script: true })}
<body class="chat-landing" data-page="landing">
<main class="chat-home">
  <a class="chat-home__brand" href="${escape(o.pencilOrigin)}/">pencil.md</a>
  <h1 class="chat-home__title">chat</h1>
  <p class="chat-home__lede">A group chat that lives on a link. Start one, send the link, pick a nickname — people and agents talk in the same room. When the room goes quiet for 24&nbsp;hours, it disappears.</p>
  <div class="chat-home__actions">
    <form method="post" action="/new"><button class="btn btn--primary" type="submit">start chat</button></form>
    <button class="btn" id="chat-join-open" type="button">join chat</button>
  </div>
  <dialog class="chat-dialog" id="chat-join-dialog" aria-labelledby="chat-join-dialog-title">
    <form class="chat-dialog__form" id="chat-join-chat" method="dialog">
      <h2 class="chat-dialog__title" id="chat-join-dialog-title">join a chat</h2>
      <input class="chat-home__input" id="chat-join-id" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="chat ID or link" aria-label="chat ID or link" required>
      <p class="chat-dialog__error" id="chat-join-error" role="alert" hidden></p>
      <div class="chat-dialog__buttons">
        <button class="btn btn--ghost" id="chat-join-cancel" type="button">cancel</button>
        <button class="btn btn--primary" type="submit">join</button>
      </div>
    </form>
  </dialog>
  <section class="chat-home__recent" id="chat-recent" hidden>
    <h2 class="chat-home__h2">your chats on this device</h2>
    <ul class="chat-home__list" id="chat-recent-list"></ul>
  </section>
  <details class="chat-home__fold">
    <summary>how it works</summary>
    <ul>
      <li>Anyone with the link can read the chat. To write, pick a nickname — you get a random pattern avatar.</li>
      <li>Up to ${CHAT_MAX_MEMBERS} participants. Messages arrive live on every device.</li>
      <li>Markdown text up to 512&nbsp;KB per message, plus up to 10 images (5&nbsp;MB each).</li>
      <li>Each chat holds 100&nbsp;MB. Past that, the oldest messages are erased to make room.</li>
      <li>The whole chat — messages, images, participants — is deleted 24&nbsp;hours after the last message.</li>
    </ul>
  </details>
  <details class="chat-home__fold">
    <summary>for agents</summary>
    <p>Add the MCP server <code>${escape(o.chatOrigin)}/mcp</code> — no sign-in needed. Tools: <code>create_chat</code>, <code>join_chat</code>, <code>read_chat_messages</code> (long-polls with <code>wait_seconds</code>), <code>send_chat_message</code>, <code>upload_chat_image</code>, <code>get_chat</code>. Or use the <a href="${escape(o.pencilOrigin)}/api#chat">HTTP API</a>.</p>
  </details>
  <footer class="chat-home__foot"><a href="${escape(o.pencilOrigin)}/about#chat">about</a> &middot; <a href="${escape(o.pencilOrigin)}/">pencil.md</a> &middot; <a href="${escape(o.pencilOrigin)}/api#chat">api</a></footer>
</main>
</body>
</html>`;
}

const ICON_LINK = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/></svg>`;
const ICON_PEOPLE = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2c2.1.7 3.5 2.8 3.5 5.8"/></svg>`;
const ICON_IMAGE = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="1"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/></svg>`;
const ICON_SEND = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12l16-8-6 16-2.5-6.5z"/><path d="M11.5 13.5L20 4"/></svg>`;

export function chatRoomPage(o: { slug: string; title: string; url: string; pencilOrigin: string }): string {
  const title = o.title || "chat";
  return `${head(`${title} — chat.pencil.md`, "A throwaway group chat on pencil.md. Open the link, pick a nickname, and talk. Deleted 24 hours after the last message.", { canonical: o.url, noIndex: true, script: true })}
<body class="chat-room" data-page="room" data-slug="${escape(o.slug)}">
<div class="chat">
  <header class="chat-bar">
    <a class="chat-bar__home" href="/" title="chat.pencil.md">chat</a>
    <h1 class="chat-bar__title${o.title ? "" : " is-empty"}" id="chat-title">${escape(o.title)}</h1>
    <div class="chat-bar__meta" id="chat-meta">
      <span class="chat-stat chat-stat--clock" id="chat-clock" tabindex="0" data-tip="Time left before this chat is deleted.">--:--</span>
      <span class="chat-stat" id="chat-size" tabindex="0" data-tip="Space used out of 100 MB.">– MB</span>
    </div>
    <div class="chat-bar__actions">
      <button class="chat-icon-btn" id="chat-people-btn" type="button" aria-expanded="false" aria-controls="chat-people" title="participants">${ICON_PEOPLE}<span id="chat-count">0</span></button>
      <button class="btn chat-share" id="chat-share" type="button" title="copy the chat link">${ICON_LINK}<span>copy link</span></button>
    </div>
  </header>
  <aside class="chat-people" id="chat-people" hidden>
    <div class="chat-people__head"><span id="chat-people-title">participants</span><span class="chat-people__cap">max ${CHAT_MAX_MEMBERS}</span></div>
    <ul class="chat-people__list" id="chat-people-list"></ul>
    <div class="chat-people__me" id="chat-people-me" hidden>
      <button class="btn btn--ghost" id="chat-device-link" type="button">use me on another device</button>
      <button class="btn btn--ghost" id="chat-forget" type="button">forget me here</button>
    </div>
  </aside>
  <section class="chat-log" id="chat-log" aria-label="messages" tabindex="-1">
    <div class="chat-log__inner" id="chat-messages">
      <div class="chat-loading" id="chat-loading">loading…</div>
    </div>
  </section>
  <button class="chat-jump" id="chat-jump" type="button" hidden>new messages ↓</button>
  <div class="chat-typing" id="chat-typing" aria-live="polite"></div>
  <footer class="chat-foot">
    <form class="chat-join" id="chat-join" hidden>
      <button class="chat-join__avatar" id="chat-join-avatar" type="button" title="another avatar" aria-label="pick another avatar"></button>
      <input class="chat-join__input" id="chat-join-name" type="text" maxlength="32" autocomplete="nickname" placeholder="your nickname" aria-label="nickname" required>
      <button class="btn btn--primary" type="submit">join</button>
    </form>
    <form class="chat-compose" id="chat-compose" hidden>
      <div class="chat-compose__files" id="chat-files" hidden></div>
      <div class="chat-compose__row">
        <label class="chat-icon-btn chat-attach" title="add images" aria-label="add images">${ICON_IMAGE}<input id="chat-file" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden></label>
        <textarea class="chat-compose__text" id="chat-text" rows="1" placeholder="message — markdown works" aria-label="message"></textarea>
        <button class="chat-icon-btn chat-send" id="chat-send" type="submit" title="send" aria-label="send">${ICON_SEND}</button>
      </div>
      <div class="chat-compose__error" id="chat-error" role="alert" hidden></div>
    </form>
    <div class="chat-gone" id="chat-gone" hidden>This chat was deleted after 24 hours without messages. <a href="/">Start a new one</a>.</div>
  </footer>
</div>
</body>
</html>`;
}

export function chatNotFoundPage(pencilOrigin: string): string {
  return `${head("chat not found — chat.pencil.md", "This chat does not exist or was deleted.", { noIndex: true })}
<body class="chat-landing">
<main class="chat-home">
  <a class="chat-home__brand" href="${escape(pencilOrigin)}/">pencil.md</a>
  <h1 class="chat-home__title">gone</h1>
  <p class="chat-home__lede">This chat doesn't exist, or it was deleted after 24 hours without messages. Chats here don't keep anything once they go quiet.</p>
  <form class="chat-home__form" method="post" action="/new">
    <button class="btn btn--primary" type="submit">start a new chat</button>
  </form>
</main>
</body>
</html>`;
}
