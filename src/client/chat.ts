// chat.pencil.md client: the landing page's "your chats" list and the room.
//
// The room loads history over HTTP, then listens on a WebSocket for live
// events (message / member / presence / typing / evicted / expired). Sending
// and image uploads go over HTTP so every limit is enforced in one place.
// Identity is a member token kept in localStorage per chat, next to the owner
// token when this browser created the chat (it arrives as #own=… once).

import { avatarSvg, AVATAR_PATTERNS, type Avatar } from "../lib/avatar.js";

type Member = { id: string; nickname: string; kind: "human" | "agent"; pattern: string; hue: number; joined_at: number };
type Image = { name: string; path: string; mime: string; width: number; height: number; bytes: number };
type Message = { seq: number; type: "message" | "join"; member_id: string; text: string; html: string; images: Image[]; created_at: number };
type Info = {
  slug: string;
  title: string;
  expires_at: number | null; // null = persistent
  bytes: number;
  max_bytes: number;
  member_count: number;
  max_members: number;
  oldest_seq: number;
  latest_seq: number;
  evicted: boolean;
  locked: boolean;
  persistent: boolean;
  owner_member_id: string | null;
};
type Saved = { token?: string; member_id?: string; owner?: string; title: string; expires_at: number | null };
type ApiFail = { ok: false; status: number; error: string; passwordRequired: boolean };

const STORE_KEY = "pencil-chat:v1";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 10;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

// ---------- local identity ----------

function loadStore(): Record<string, Saved> {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}") as Record<string, Saved>;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
function saveStore(s: Record<string, Saved>): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    /* private mode — identity lasts for this tab only */
  }
}
function forgetChat(slug: string): void {
  const s = loadStore();
  delete s[slug];
  saveStore(s);
}
// Drop the member identity but keep the owner token: the creator can still
// manage the chat and join again as its owner.
function forgetMember(slug: string): void {
  const s = loadStore();
  const v = s[slug];
  if (!v) return;
  if (v.owner) s[slug] = { owner: v.owner, title: v.title, expires_at: v.expires_at };
  else delete s[slug];
  saveStore(s);
}

// ---------- small helpers ----------

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function esc(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function reEsc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function randomAvatar(): Avatar {
  const r = new Uint32Array(2);
  crypto.getRandomValues(r);
  return { pattern: AVATAR_PATTERNS[r[0]! % AVATAR_PATTERNS.length]!, hue: r[1]! % 360 };
}

function mb(n: number): string {
  const v = n / 1024 / 1024;
  if (v === 0) return "0";
  return v < 10 ? v.toFixed(1) : String(Math.round(v));
}

const PERSISTENT_TIP = "Persistent: kept until its creator deletes it. Holds 10 MB; past that, the oldest messages are erased to make room.";

function clockOf(ms: number): string {
  const left = Math.max(0, ms);
  return `${String(Math.floor(left / 3_600_000)).padStart(2, "0")}:${String(Math.floor((left % 3_600_000) / 60_000)).padStart(2, "0")}`;
}

function timeLeft(ms: number): string {
  if (ms <= 0) return "any moment";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h} h ${m} min` : `${Math.max(1, m)} min`;
}

function hhmm(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "today";
  if (d.toDateString() === y.toDateString()) return "yesterday";
  return d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

function toast(msg: string): void {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1800);
}

async function api<T>(path: string, init: RequestInit = {}): Promise<{ ok: true; data: T } | ApiFail> {
  try {
    const res = await fetch(path, init);
    const data = (await res.json().catch(() => ({}))) as T & { error?: string; password_required?: boolean };
    if (!res.ok) return { ok: false, status: res.status, error: data.error ?? `HTTP ${res.status}`, passwordRequired: data.password_required === true };
    return { ok: true, data };
  } catch {
    return { ok: false, status: 0, error: "network error — check your connection", passwordRequired: false };
  }
}

// ---------- landing ----------

// A chat ID is the 8-character slug; a pasted link works too.
function chatSlugFrom(raw: string): string | null {
  let s = raw.trim();
  if (/^(https?:\/\/|chat\.)/i.test(s)) {
    try {
      s = new URL(/^https?:/i.test(s) ? s : `https://${s}`).pathname.split("/").filter(Boolean)[0] ?? "";
    } catch {
      return null;
    }
  }
  return /^[2-9a-km-zA-HJ-NP-Z]{8}$/.test(s) ? s : null;
}

function joinDialog(): void {
  const dialog = $<HTMLDialogElement>("chat-join-dialog");
  const form = $<HTMLFormElement>("chat-join-chat");
  const input = $<HTMLInputElement>("chat-join-id");
  const error = $("chat-join-error");
  const showError = (msg: string) => {
    error.textContent = msg;
    error.hidden = false;
  };
  $("chat-join-open").addEventListener("click", () => {
    error.hidden = true;
    input.value = "";
    dialog.showModal();
    input.focus();
  });
  $("chat-join-cancel").addEventListener("click", () => dialog.close());
  // Click on the backdrop closes it.
  dialog.addEventListener("click", (e) => e.target === dialog && dialog.close());
  input.addEventListener("input", () => (error.hidden = true));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const slug = chatSlugFrom(input.value);
    if (!slug) return showError("that doesn't look like a chat ID — it's the 8 characters after chat.pencil.md/");
    const r = await api(`/api/chats/${slug}`);
    if (r.ok || r.passwordRequired) return location.assign(`/${slug}`);
    showError(r.status === 404 ? "no such chat — it may have been deleted after 24 quiet hours" : r.error);
  });
}

function landing(): void {
  joinDialog();
  const store = loadStore();
  const now = Date.now();
  const live = Object.entries(store).filter(([, v]) => v.expires_at === null || v.expires_at > now);
  if (live.length !== Object.keys(store).length) saveStore(Object.fromEntries(live));
  if (!live.length) return;
  const list = $("chat-recent-list");
  // Persistent chats first, then the ones with the most time left.
  live.sort((a, b) => (b[1].expires_at ?? Infinity) - (a[1].expires_at ?? Infinity));
  list.innerHTML = live
    .map(([slug, v]) => {
      const left = v.expires_at === null ? null : v.expires_at - now;
      const tip = left === null ? PERSISTENT_TIP : `Deleted in ${timeLeft(left)} unless someone writes. Every new message resets it to 24 hours.`;
      const name = v.title ? `<span class="chat-home__list-title">${esc(v.title)}</span>` : `<span class="chat-home__list-title is-untitled">untitled · ${esc(slug)}</span>`;
      return `<li><a href="/${esc(slug)}">${name}<span class="chat-stat" data-tip="${esc(tip)}" aria-label="${esc(tip)}">${left === null ? "∞" : clockOf(left)}</span></a></li>`;
    })
    .join("");
  $("chat-recent").hidden = false;
}

// ---------- room ----------

function room(slug: string): void {
  const log = $("chat-log");
  const list = $("chat-messages");
  const joinForm = $<HTMLFormElement>("chat-join");
  const compose = $<HTMLFormElement>("chat-compose");
  const text = $<HTMLTextAreaElement>("chat-text");
  const sendBtn = $<HTMLButtonElement>("chat-send");
  const fileInput = $<HTMLInputElement>("chat-file");
  const filesBox = $("chat-files");
  const errBox = $("chat-error");
  const jump = $<HTMLButtonElement>("chat-jump");
  const typingBox = $("chat-typing");

  const members = new Map<string, Member>();
  let messages: Message[] = [];
  let info: Info | null = null;
  let online = new Set<string>();
  let me: { token: string; member_id: string } | null = null;
  let locked = false; // password-protected and we're not in it: nothing to show
  let ws: WebSocket | null = null;
  let wsRetry = 0;
  let gone = false;
  let loadingOlder = false;
  let unread = 0;
  const baseTitle = () => `${info?.title || "chat"} — chat.pencil.md`;
  const typingUntil = new Map<string, number>();

  // ----- identity bootstrap: #as=<token> hands an identity to this device,
  // #own=<token> is the owner token right after "start chat" -----
  const hashToken = /^#as=([A-Za-z0-9_-]{8,128})$/.exec(location.hash)?.[1];
  const hashOwner = /^#own=([A-Za-z0-9_-]{8,128})$/.exec(location.hash)?.[1];
  if (hashToken || hashOwner) history.replaceState(null, "", location.pathname);

  const saved = loadStore()[slug];
  const ownerToken = hashOwner ?? saved?.owner;
  const persist = () => {
    const s = loadStore();
    s[slug] = { ...(me ?? {}), ...(ownerToken ? { owner: ownerToken } : {}), title: info?.title ?? "", expires_at: info ? info.expires_at : Date.now() + 86_400_000 };
    saveStore(s);
  };
  // Keep "your chats" on the landing page in step with the room (persistent
  // chats have no expiry, and every message moves it).
  const refreshSaved = () => {
    if (!info || !(me || ownerToken)) return;
    const v = loadStore()[slug];
    if (v && (v.expires_at !== info.expires_at || v.title !== info.title)) persist();
  };
  const remember = (token: string, member_id: string) => {
    me = { token, member_id };
    persist();
  };
  if (hashOwner) persist();

  // Reads carry whatever identity we have: a password-protected chat only
  // answers members and its owner.
  const cred = () => me?.token ?? ownerToken ?? "";
  const authHeaders = (): Record<string, string> => (cred() ? { Authorization: `Bearer ${cred()}` } : {});
  const isOwner = () => !!ownerToken || (!!me && !!info && info.owner_member_id === me.member_id);

  // ----- rendering -----

  function nameOf(id: string): Member | undefined {
    return members.get(id);
  }

  function authorHtml(m: Member | undefined): string {
    if (!m) return `<span class="msg__name">someone</span>`;
    const badge = m.kind === "agent" ? `<span class="msg__badge">agent</span>` : "";
    return `<span class="msg__name">${esc(m.nickname)}</span>${badge}`;
  }

  function messageHtml(m: Message, prev: Message | undefined): string {
    const day = !prev || new Date(prev.created_at).toDateString() !== new Date(m.created_at).toDateString() ? `<div class="chat-day"><span>${esc(dayLabel(m.created_at))}</span></div>` : "";
    const who = nameOf(m.member_id);
    if (m.type === "join") {
      return `${day}<div class="chat-sys" data-seq="${m.seq}">${who ? avatarSvg(who, 16) : ""}${authorHtml(who)} joined <time>${hhmm(m.created_at)}</time></div>`;
    }
    const cont = !day && prev && prev.type === "message" && prev.member_id === m.member_id && m.created_at - prev.created_at < 5 * 60_000;
    const mine = me && me.member_id === m.member_id ? " msg--mine" : "";
    const head = cont
      ? ""
      : `<div class="msg__head">${authorHtml(who)}<time datetime="${new Date(m.created_at).toISOString()}">${hhmm(m.created_at)}</time></div>`;
    const imgs = m.images.length
      ? `<div class="msg__images msg__images--${Math.min(m.images.length, 3)}">${m.images
          .map((i) => `<a href="${esc(i.path)}" target="_blank" rel="noopener"><img src="${esc(i.path)}" width="${i.width || ""}" height="${i.height || ""}" loading="lazy" alt=""></a>`)
          .join("")}</div>`
      : "";
    const body = m.html ? `<div class="msg__text prose">${mentionize(m.html)}</div>` : "";
    return `${day}<article class="msg${cont ? " msg--cont" : ""}${mine}" data-seq="${m.seq}"><div class="msg__avatar">${cont || !who ? "" : avatarSvg(who, 36)}</div><div class="msg__main">${head}${body}${imgs}</div></article>`;
  }

  // @mentions are plain text: highlight "@nickname" for anyone in the member
  // list (longest name first, since nicknames may contain spaces), skipping
  // code and links. A mention of you gets its own colour.
  const WORD = "[\\p{L}\\p{N}_]";
  function mentionize(html: string): string {
    if (!html.includes("@") || !members.size) return html;
    const names = [...new Set([...members.values()].map((m) => m.nickname))].sort((a, b) => b.length - a.length);
    const re = new RegExp(`(?<!${WORD})@(${names.map(reEsc).join("|")})(?!${WORD})`, "giu");
    const mine = me ? members.get(me.member_id)?.nickname.toLowerCase() : undefined;
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT);
    const hits: Text[] = [];
    while (walker.nextNode()) {
      const t = walker.currentNode as Text;
      if (t.data.includes("@") && !t.parentElement?.closest("code, pre, a")) hits.push(t);
    }
    if (!hits.length) return html;
    for (const t of hits) {
      const frag = document.createDocumentFragment();
      let last = 0;
      for (const m of t.data.matchAll(re)) {
        frag.appendChild(document.createTextNode(t.data.slice(last, m.index)));
        const span = document.createElement("span");
        span.className = m[1]!.toLowerCase() === mine ? "mention mention--me" : "mention";
        span.textContent = m[0];
        frag.appendChild(span);
        last = m.index! + m[0].length;
      }
      if (!last) continue;
      frag.appendChild(document.createTextNode(t.data.slice(last)));
      t.replaceWith(frag);
    }
    return tpl.innerHTML;
  }

  function evictedNote(): string {
    return info?.evicted && messages[0]?.seq === info.oldest_seq ? `<div class="chat-sys chat-sys--note">older messages were erased to keep this chat under ${mb(info.max_bytes)} MB</div>` : "";
  }

  function renderAll(): void {
    let h = evictedNote();
    if (!messages.length) h += `<div class="chat-empty">No messages yet. Send the link to whoever should be here.</div>`;
    messages.forEach((m, i) => (h += messageHtml(m, messages[i - 1])));
    list.innerHTML = h;
  }

  function nearBottom(): boolean {
    return log.scrollHeight - log.scrollTop - log.clientHeight < 120;
  }
  function toBottom(): void {
    log.scrollTop = log.scrollHeight;
    jump.hidden = true;
  }

  function addMessages(incoming: Message[]): void {
    const fresh = incoming.filter((m) => !messages.some((x) => x.seq === m.seq));
    if (!fresh.length) return;
    const stick = nearBottom();
    const appendOnly = fresh.every((m) => m.seq > (messages.at(-1)?.seq ?? 0));
    if (appendOnly && messages.length) {
      fresh.sort((a, b) => a.seq - b.seq);
      for (const m of fresh) {
        list.insertAdjacentHTML("beforeend", messageHtml(m, messages.at(-1)));
        messages.push(m);
      }
      list.querySelector(".chat-empty")?.remove();
    } else {
      messages = [...messages, ...fresh].sort((a, b) => a.seq - b.seq);
      renderAll();
    }
    const fromOthers = fresh.filter((m) => m.type === "message" && m.member_id !== me?.member_id);
    for (const m of fromOthers) typingUntil.delete(m.member_id);
    renderTyping();
    if (stick || fresh.some((m) => m.member_id === me?.member_id && m.type === "message")) toBottom();
    else if (fromOthers.length) jump.hidden = false;
    if (document.hidden && fromOthers.length) {
      unread += fromOthers.length;
      document.title = `(${unread}) ${baseTitle()}`;
    }
  }

  function renderMeta(): void {
    if (!info) return;
    const clock = $("chat-clock");
    const size = $("chat-size");
    if (info.expires_at === null) {
      clock.textContent = "∞";
      clock.dataset.tip = PERSISTENT_TIP;
    } else {
      const left = Math.max(0, info.expires_at - Date.now());
      clock.textContent = clockOf(left);
      clock.dataset.tip = `Time left before this chat and everything in it is deleted (${timeLeft(left)}). Every new message resets it to 24 hours.`;
    }
    size.textContent = `${mb(info.bytes)} / ${mb(info.max_bytes)} MB`;
    size.dataset.tip = `Space used by messages and images. A chat holds ${mb(info.max_bytes)} MB; past that, the oldest messages are erased to make room.`;
    clock.setAttribute("aria-label", clock.dataset.tip);
    size.setAttribute("aria-label", size.dataset.tip);
    $("chat-count").textContent = String(info.member_count);
    renderOwner();
    refreshSaved();
  }

  function renderOwner(): void {
    $("chat-lock").hidden = gone || !(locked || info?.locked);
    $("chat-settings-btn").hidden = !info || gone || locked || !isOwner();
  }

  function renderPeople(): void {
    const all = [...members.values()].sort((a, b) => Number(online.has(b.id)) - Number(online.has(a.id)) || a.joined_at - b.joined_at);
    $("chat-people-title").textContent = `${members.size} participant${members.size === 1 ? "" : "s"} · ${online.size} online`;
    $("chat-people-list").innerHTML = all
      .map(
        (m) =>
          `<li class="${online.has(m.id) ? "is-online" : ""}">${avatarSvg(m, 24)}<span class="chat-people__name">${esc(m.nickname)}${me?.member_id === m.id ? " <em>(you)</em>" : ""}</span>${m.kind === "agent" ? `<span class="msg__badge">agent</span>` : ""}${info?.owner_member_id === m.id ? `<span class="msg__badge">creator</span>` : ""}<span class="chat-people__dot" title="${online.has(m.id) ? "online" : "offline"}"></span></li>`,
      )
      .join("");
    $("chat-people-me").hidden = !me;
  }

  function renderTyping(): void {
    const now = Date.now();
    const names = [...typingUntil.entries()].filter(([id, t]) => t > now && id !== me?.member_id).map(([id]) => nameOf(id)?.nickname ?? "someone");
    typingBox.textContent = names.length === 0 ? "" : names.length === 1 ? `${names[0]} is typing…` : names.length < 4 ? `${names.join(", ")} are typing…` : "several people are typing…";
  }

  // ----- title: any participant can name the chat -----

  const titleEl = $("chat-title");
  let editingTitle = false;

  function renderTitle(): void {
    if (editingTitle) return;
    const t = info?.title ?? "";
    const editable = !!me && !gone;
    titleEl.textContent = t || (editable ? "add a title" : "");
    titleEl.classList.toggle("is-empty", !t);
    titleEl.classList.toggle("is-editable", editable);
    if (editable) {
      titleEl.tabIndex = 0;
      titleEl.setAttribute("role", "button");
      titleEl.title = "rename this chat";
    } else {
      titleEl.removeAttribute("tabindex");
      titleEl.removeAttribute("role");
      titleEl.removeAttribute("title");
    }
    if (!unread) document.title = baseTitle();
  }

  function editTitle(): void {
    if (!me || gone || editingTitle || !info) return;
    editingTitle = true;
    const input = document.createElement("input");
    input.className = "chat-bar__title-input";
    input.maxLength = 200;
    input.value = info.title;
    input.placeholder = "name this chat";
    input.setAttribute("aria-label", "chat title");
    titleEl.replaceChildren(input);
    titleEl.classList.remove("is-empty");
    input.focus();
    input.select();
    let done = false;
    const finish = async (save: boolean) => {
      if (done) return;
      done = true;
      const next = input.value.trim();
      if (save && me && info && next !== info.title) {
        const r = await api<{ title: string }>(`/api/chats/${slug}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${me.token}` },
          body: JSON.stringify({ title: next }),
        });
        if (r.ok) {
          info = { ...info, title: r.data.title };
          remember(me.token, me.member_id);
        } else toast(r.error);
      }
      editingTitle = false;
      renderTitle();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void finish(true);
      } else if (e.key === "Escape") void finish(false);
    });
    input.addEventListener("blur", () => void finish(true));
  }
  titleEl.addEventListener("click", editTitle);
  titleEl.addEventListener("keydown", (e) => {
    if (e.target === titleEl && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      editTitle();
    }
  });

  function showComposer(): void {
    renderTitle();
    joinForm.hidden = true;
    compose.hidden = gone;
    renderPeople();
  }

  function showJoin(): void {
    compose.hidden = true;
    joinForm.hidden = gone;
    const pass = $<HTMLInputElement>("chat-join-pass");
    pass.hidden = !locked;
    pass.required = locked;
    rollAvatar();
  }

  // Password-protected and we're neither a member nor the owner: show only
  // the join form with a password field.
  function showLocked(): void {
    locked = true;
    me = null;
    info = null;
    messages = [];
    members.clear();
    list.innerHTML = `<div class="chat-empty chat-locked">This chat is password-protected. Pick a nickname and enter the password to join.</div>`;
    titleEl.textContent = "";
    titleEl.classList.remove("is-editable");
    $("chat-size").textContent = "– MB";
    $("chat-clock").textContent = "--:--";
    $("chat-count").textContent = "–";
    $("chat-lock").hidden = false;
    $("chat-people-me").hidden = true;
    people.hidden = true;
    settings.close();
    renderOwner();
    showJoin();
  }

  function markGone(reason: "expired" | "deleted" = "expired"): void {
    // The socket's close follows the "deleted" event; keep the first reason.
    if (gone) return;
    gone = true;
    forgetChat(slug);
    joinForm.hidden = true;
    compose.hidden = true;
    $("chat-gone-text").textContent = reason === "deleted" ? "This chat was deleted by its creator." : "This chat was deleted after 24 hours without messages.";
    $("chat-gone").hidden = false;
    $("chat-clock").textContent = "00:00";
    $("chat-clock").dataset.tip = "This chat was deleted.";
    renderTitle();
    if (reason === "deleted") {
      messages = [];
      list.innerHTML = "";
    }
    settings.close();
    renderOwner();
    ws?.close();
  }

  // ----- join -----

  let joinAvatar = randomAvatar();
  function rollAvatar(): void {
    joinAvatar = randomAvatar();
    $("chat-join-avatar").innerHTML = avatarSvg(joinAvatar, 36);
  }
  $("chat-join-avatar").addEventListener("click", rollAvatar);

  joinForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>("chat-join-name");
    const nickname = input.value.trim();
    if (!nickname) return input.focus();
    const pass = $<HTMLInputElement>("chat-join-pass");
    if (locked && !pass.value) return pass.focus();
    const btn = joinForm.querySelector<HTMLButtonElement>("button[type=submit]")!;
    btn.disabled = true;
    const r = await api<{ member_token: string; member: { id: string; nickname: string; kind: Member["kind"]; avatar: Avatar; joined_at: string } }>(`/api/chats/${slug}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname, avatar: joinAvatar, kind: "human", ...(locked ? { password: pass.value } : {}), ...(ownerToken ? { owner_token: ownerToken } : {}) }),
    });
    btn.disabled = false;
    if (!r.ok) {
      if (r.status === 404) return markGone();
      if (r.passwordRequired && !locked) {
        // The password was set after this page loaded.
        showLocked();
        return toast("this chat now has a password");
      }
      if (r.passwordRequired) {
        pass.select();
        pass.focus();
      }
      return toast(r.error);
    }
    const m = r.data.member;
    pass.value = "";
    remember(r.data.member_token, m.id);
    wsSend({ type: "auth", token: r.data.member_token });
    if (locked) {
      locked = false;
      if (!(await loadHistory())) return;
    }
    members.set(m.id, { id: m.id, nickname: m.nickname, kind: m.kind, pattern: m.avatar.pattern, hue: m.avatar.hue, joined_at: Date.parse(m.joined_at) });
    showComposer();
    renderAll();
    renderMeta();
    toBottom();
    text.focus();
  });

  // ----- composer: images -----

  type Pending = { id?: string; el: HTMLElement; url: string };
  let pending: Pending[] = [];

  function syncSend(): void {
    const uploading = pending.some((p) => !p.id);
    sendBtn.disabled = uploading || (!text.value.trim() && pending.length === 0);
    filesBox.hidden = pending.length === 0;
  }

  function showError(msg: string): void {
    errBox.textContent = msg;
    errBox.hidden = false;
    setTimeout(() => (errBox.hidden = true), 5000);
  }

  function dropPending(p: Pending): void {
    pending = pending.filter((x) => x !== p);
    p.el.remove();
    URL.revokeObjectURL(p.url);
    syncSend();
  }

  async function addFiles(files: File[]): Promise<void> {
    if (!me) return;
    for (const f of files) {
      if (pending.length >= MAX_IMAGES) {
        showError(`up to ${MAX_IMAGES} images per message`);
        break;
      }
      if (!IMAGE_TYPES.includes(f.type)) {
        showError(`${f.name}: only PNG, JPEG, GIF and WebP`);
        continue;
      }
      if (f.size > MAX_IMAGE_BYTES) {
        showError(`${f.name}: images are limited to 5 MB`);
        continue;
      }
      const url = URL.createObjectURL(f);
      const el = document.createElement("div");
      el.className = "chat-file is-uploading";
      el.innerHTML = `<img src="${url}" alt=""><button type="button" class="chat-file__x" aria-label="remove image">×</button>`;
      filesBox.appendChild(el);
      const p: Pending = { el, url };
      pending.push(p);
      el.querySelector("button")!.addEventListener("click", () => dropPending(p));
      syncSend();
      const r = await api<{ id: string }>(`/api/chats/${slug}/images`, {
        method: "POST",
        headers: { "Content-Type": f.type, Authorization: `Bearer ${me.token}` },
        body: f,
      });
      if (!pending.includes(p)) continue; // removed while uploading
      if (!r.ok) {
        showError(r.error);
        dropPending(p);
        continue;
      }
      p.id = r.data.id;
      el.classList.remove("is-uploading");
      syncSend();
    }
  }

  fileInput.addEventListener("change", () => {
    void addFiles([...(fileInput.files ?? [])]);
    fileInput.value = "";
  });
  text.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      e.preventDefault();
      void addFiles(files);
    }
  });
  document.addEventListener("dragover", (e) => {
    if (me && e.dataTransfer?.types.includes("Files")) {
      e.preventDefault();
      document.body.classList.add("is-dropping");
    }
  });
  document.addEventListener("dragleave", (e) => {
    if (!e.relatedTarget) document.body.classList.remove("is-dropping");
  });
  document.addEventListener("drop", (e) => {
    document.body.classList.remove("is-dropping");
    if (!me || !e.dataTransfer?.files.length) return;
    e.preventDefault();
    void addFiles([...e.dataTransfer.files]);
  });

  // ----- composer: text -----

  function autosize(): void {
    text.style.height = "auto";
    text.style.height = `${Math.min(text.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }
  let lastTypingSent = 0;
  text.addEventListener("input", () => {
    autosize();
    syncSend();
    const now = Date.now();
    if (text.value && now - lastTypingSent > 2500) {
      lastTypingSent = now;
      wsSend({ type: "typing" });
    }
  });
  // ----- composer: @mention picker -----

  const mentionBox = $("chat-mention");
  let mentionHits: Member[] = [];
  let mentionSel = 0;
  let mentionAt = -1;
  let mentionDismissed = -1; // the "@" the user closed the picker on

  // The "@query" right before the caret, if the caret sits in one.
  function mentionQuery(): { at: number; q: string } | null {
    const pos = text.selectionStart;
    if (pos !== text.selectionEnd) return null;
    const before = text.value.slice(0, pos);
    const at = before.lastIndexOf("@");
    if (at < 0 || (at > 0 && new RegExp(WORD, "u").test(before[at - 1]!))) return null;
    const q = before.slice(at + 1);
    if (q.length > 32 || q.includes("\n")) return null;
    return { at, q };
  }

  function closeMention(): void {
    mentionBox.hidden = true;
    mentionHits = [];
    mentionAt = -1;
  }

  function renderMention(): void {
    const mq = me ? mentionQuery() : null;
    if (!mq || mq.at === mentionDismissed) return closeMention();
    const q = mq.q.toLowerCase();
    const hits = [...members.values()]
      .filter((m) => m.id !== me?.member_id && m.nickname.toLowerCase().includes(q))
      .sort(
        (a, b) =>
          Number(b.nickname.toLowerCase().startsWith(q)) - Number(a.nickname.toLowerCase().startsWith(q)) ||
          Number(online.has(b.id)) - Number(online.has(a.id)) ||
          a.nickname.localeCompare(b.nickname),
      )
      .slice(0, 8);
    // Already typed out in full: nothing left to pick.
    if (!hits.length || (hits.length === 1 && hits[0]!.nickname.toLowerCase() === q)) return closeMention();
    if (mq.at !== mentionAt || mentionSel >= hits.length) mentionSel = 0;
    mentionAt = mq.at;
    mentionHits = hits;
    mentionBox.innerHTML = hits
      .map(
        (m, i) =>
          `<li role="option" data-i="${i}" aria-selected="${i === mentionSel}">${avatarSvg(m, 20)}<span class="chat-people__name">${esc(m.nickname)}</span>${m.kind === "agent" ? `<span class="msg__badge">agent</span>` : ""}</li>`,
      )
      .join("");
    mentionBox.hidden = false;
  }

  function pickMention(i: number): void {
    const m = mentionHits[i];
    if (!m || mentionAt < 0) return;
    const pos = text.selectionStart;
    const ins = `@${m.nickname} `;
    text.setRangeText(ins, mentionAt, pos, "end");
    closeMention();
    autosize();
    syncSend();
    text.focus();
  }

  text.addEventListener("input", () => {
    if (mentionDismissed >= 0 && text.value[mentionDismissed] !== "@") mentionDismissed = -1;
    renderMention();
  });
  text.addEventListener("click", renderMention);
  text.addEventListener("keyup", (e) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) renderMention();
  });
  text.addEventListener("blur", closeMention);
  mentionBox.addEventListener("mousedown", (e) => {
    const li = (e.target as Element).closest?.("li[data-i]") as HTMLElement | null;
    if (!li) return;
    e.preventDefault(); // keep focus in the textarea
    pickMention(Number(li.dataset.i));
  });

  const coarse = window.matchMedia("(pointer: coarse)").matches;
  text.addEventListener("keydown", (e) => {
    if (!mentionBox.hidden && mentionHits.length && !e.isComposing) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        mentionSel = (mentionSel + (e.key === "ArrowDown" ? 1 : -1) + mentionHits.length) % mentionHits.length;
        mentionBox.querySelectorAll("li").forEach((li, i) => li.setAttribute("aria-selected", String(i === mentionSel)));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        return pickMention(mentionSel);
      }
      if (e.key === "Escape") {
        e.preventDefault();
        mentionDismissed = mentionAt;
        return closeMention();
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !coarse) {
      e.preventDefault();
      compose.requestSubmit();
    }
  });

  compose.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!me || sendBtn.disabled) return;
    const body = { text: text.value, images: pending.map((p) => p.id!) };
    if (!body.text.trim() && !body.images.length) return;
    sendBtn.disabled = true;
    const r = await api<{ message: Message; info: Info }>(`/api/chats/${slug}/messages?format=client`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${me.token}` },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      sendBtn.disabled = false;
      if (r.status === 404) return markGone();
      if (r.status === 401) {
        forgetMember(slug);
        me = null;
        showJoin();
        return toast("your identity in this chat is gone — join again");
      }
      return showError(r.error);
    }
    text.value = "";
    for (const p of pending) {
      p.el.remove();
      URL.revokeObjectURL(p.url);
    }
    pending = [];
    autosize();
    syncSend();
    info = r.data.info;
    renderMeta();
    addMessages([r.data.message]);
    remember(me.token, me.member_id);
    text.focus();
  });

  // ----- header actions -----

  $("chat-share").addEventListener("click", async () => {
    if (await copy(location.origin + location.pathname)) toast(info?.locked || locked ? "link copied — people also need the password" : "link copied — anyone with it can read and join");
  });
  const peopleBtn = $("chat-people-btn");
  const people = $("chat-people");
  peopleBtn.addEventListener("click", () => {
    people.hidden = !people.hidden;
    peopleBtn.setAttribute("aria-expanded", String(!people.hidden));
    if (!people.hidden) {
      // The header wraps to two rows on phones when the chat has a title.
      people.style.top = `${document.querySelector(".chat-bar")!.getBoundingClientRect().height}px`;
      renderPeople();
    }
  });
  document.addEventListener("click", (e) => {
    if (!people.hidden && !people.contains(e.target as Node) && !peopleBtn.contains(e.target as Node)) {
      people.hidden = true;
      peopleBtn.setAttribute("aria-expanded", "false");
    }
  });
  $("chat-device-link").addEventListener("click", async () => {
    if (!me) return;
    if (await copy(`${location.origin}${location.pathname}#as=${me.token}`)) toast("personal link copied — it posts as you, keep it private");
  });
  $("chat-forget").addEventListener("click", () => {
    forgetMember(slug);
    me = null;
    wsSend({ type: "auth", token: "" });
    people.hidden = true;
    showJoin();
    renderTitle();
    renderAll();
  });

  // ----- settings (creator only): password + delete -----

  const settings = $<HTMLDialogElement>("chat-settings");
  const passInput = $<HTMLInputElement>("chat-pass-input");
  const settingsErr = $("chat-settings-error");
  const deleteBtn = $<HTMLButtonElement>("chat-delete");
  let deleteArmed: ReturnType<typeof setTimeout> | undefined;
  const ownerCred = () => ownerToken ?? me?.token ?? "";

  function disarmDelete(): void {
    clearTimeout(deleteArmed);
    deleteArmed = undefined;
    deleteBtn.textContent = "delete chat";
  }

  function renderSettings(): void {
    const on = !!info?.locked;
    $("chat-pass-note").textContent = on
      ? "On. New people need it to read or join; everyone already here keeps access."
      : "Off — anyone with the link can read and join. With a password, only participants can read.";
    $("chat-pass-save").textContent = on ? "change" : "set";
    $("chat-pass-remove").hidden = !on;
    const kept = !!info?.persistent;
    $("chat-keep-note").textContent = kept
      ? "On — the chat stays until you delete it. It holds 10 MB; past that, the oldest messages and images are erased."
      : `Off — deleted 24 hours after the last message, holds 100 MB. Turning it on keeps it for good but caps it at 10 MB${info && info.bytes > 10 * 1048576 ? ` — this chat uses ${mb(info.bytes)} MB, so the oldest messages will be erased right away` : ""}.`;
    $("chat-keep-toggle").textContent = kept ? "let it expire" : "keep forever";
    settingsErr.hidden = true;
  }

  async function savePersistent(persistent: boolean): Promise<void> {
    const r = await api<Info & { password_protected: boolean; older_messages_evicted: boolean }>(`/api/chats/${slug}/persistent`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerCred()}` },
      body: JSON.stringify({ persistent }),
    });
    if (!r.ok) {
      if (r.status === 404) return markGone();
      return settingsError(r.error);
    }
    // The API speaks ISO dates; the live "settings" event carries the same
    // change in client shape and redraws the rest.
    if (info) info = { ...info, persistent: r.data.persistent, max_bytes: r.data.max_bytes, bytes: r.data.bytes, expires_at: r.data.expires_at === null ? null : Date.parse(String(r.data.expires_at)) };
    renderSettings();
    renderMeta();
    toast(persistent ? "chat kept for good — 10 MB max" : "chat expires again 24 h after the last message");
  }

  function settingsError(msg: string): void {
    settingsErr.textContent = msg;
    settingsErr.hidden = false;
  }

  async function savePassword(password: string | null): Promise<void> {
    const r = await api<Info & { password_protected: boolean }>(`/api/chats/${slug}/password`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerCred()}` },
      body: JSON.stringify({ password }),
    });
    if (!r.ok) {
      if (r.status === 404) return markGone();
      return settingsError(r.error);
    }
    if (info) info = { ...info, locked: r.data.password_protected };
    passInput.value = "";
    renderSettings();
    renderMeta();
    toast(password ? "password set — share it separately from the link" : "password removed");
  }

  $("chat-settings-btn").addEventListener("click", () => {
    disarmDelete();
    passInput.value = "";
    renderSettings();
    settings.showModal();
  });
  $("chat-settings-close").addEventListener("click", () => settings.close());
  settings.addEventListener("click", (e) => e.target === settings && settings.close());
  settings.addEventListener("close", disarmDelete);
  $<HTMLFormElement>("chat-pass-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (passInput.value) void savePassword(passInput.value);
  });
  $("chat-pass-remove").addEventListener("click", () => void savePassword(null));
  $("chat-keep-toggle").addEventListener("click", () => void savePersistent(!info?.persistent));
  deleteBtn.addEventListener("click", async () => {
    // Two clicks: the first arms the button for a few seconds.
    if (!deleteArmed) {
      deleteBtn.textContent = "click again to delete everything";
      deleteArmed = setTimeout(disarmDelete, 4000);
      return;
    }
    disarmDelete();
    deleteBtn.disabled = true;
    const r = await api(`/api/chats/${slug}`, { method: "DELETE", headers: { Authorization: `Bearer ${ownerCred()}` } });
    deleteBtn.disabled = false;
    if (!r.ok && r.status !== 404) return settingsError(r.error);
    markGone("deleted");
  });

  // ----- lightbox -----

  list.addEventListener("click", (e) => {
    const img = (e.target as Element).closest?.(".msg__images img, .msg__text img") as HTMLImageElement | null;
    if (!img) return;
    e.preventDefault();
    const box = document.createElement("div");
    box.className = "lightbox";
    box.innerHTML = `<img src="${esc(img.currentSrc || img.src)}" alt="">`;
    const close = () => {
      box.remove();
      document.removeEventListener("keydown", onKey);
    };
    const onKey = (k: KeyboardEvent) => {
      if (k.key === "Escape") close();
    };
    box.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    document.body.appendChild(box);
  });

  // ----- scrolling -----

  jump.addEventListener("click", toBottom);
  log.addEventListener("scroll", () => {
    if (nearBottom()) jump.hidden = true;
    if (log.scrollTop < 300) void loadOlder();
  });

  async function loadOlder(): Promise<void> {
    const first = messages[0];
    if (loadingOlder || locked || !first || !info || first.seq <= info.oldest_seq) return;
    loadingOlder = true;
    const r = await api<{ messages: Message[]; members: Member[]; info: Info }>(`/api/chats/${slug}/messages?format=client&before=${first.seq}&limit=100`, { headers: authHeaders() });
    loadingOlder = false;
    if (!r.ok || !r.data.messages.length) return;
    for (const m of r.data.members) members.set(m.id, m);
    info = r.data.info;
    const before = log.scrollHeight;
    messages = [...r.data.messages, ...messages.filter((m) => !r.data.messages.some((x) => x.seq === m.seq))].sort((a, b) => a.seq - b.seq);
    renderAll();
    log.scrollTop += log.scrollHeight - before;
  }

  // ----- live updates -----

  function wsSend(o: Record<string, unknown>): void {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o));
  }

  async function catchUp(): Promise<void> {
    if (locked) return;
    const after = messages.at(-1)?.seq ?? 0;
    const r = await api<{ messages: Message[]; members: Member[]; info: Info }>(`/api/chats/${slug}/messages?format=client&after=${after}&limit=200`, { headers: authHeaders() });
    if (!r.ok) {
      if (r.status === 404) markGone();
      else if (r.passwordRequired) showLocked();
      return;
    }
    for (const m of r.data.members) members.set(m.id, m);
    info = r.data.info;
    renderMeta();
    addMessages(r.data.messages);
  }

  let pingTimer: ReturnType<typeof setInterval> | undefined;
  function connect(): void {
    if (gone || (ws && ws.readyState <= WebSocket.OPEN)) return;
    const sock = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/${slug}/ws`);
    ws = sock;
    sock.addEventListener("open", () => {
      wsRetry = 0;
      if (cred()) wsSend({ type: "auth", token: cred() });
      void catchUp();
      clearInterval(pingTimer);
      pingTimer = setInterval(() => sock.readyState === WebSocket.OPEN && sock.send("ping"), 30_000);
    });
    sock.addEventListener("message", (e) => {
      if (e.data === "pong") return;
      let ev: { type: string; [k: string]: unknown };
      try {
        ev = JSON.parse(String(e.data)) as typeof ev;
      } catch {
        return;
      }
      switch (ev.type) {
        case "message":
          info = ev.info as Info;
          renderMeta();
          addMessages([ev.message as Message]);
          break;
        case "title":
          info = ev.info as Info;
          if (me) remember(me.token, me.member_id);
          renderTitle();
          renderMeta();
          break;
        case "member": {
          const m = ev.member as Member;
          members.set(m.id, m);
          if (!people.hidden) renderPeople();
          break;
        }
        case "presence":
          online = new Set(ev.online as string[]);
          if (!people.hidden) renderPeople();
          break;
        case "typing":
          typingUntil.set(ev.member_id as string, Date.now() + 4000);
          renderTyping();
          setTimeout(renderTyping, 4100);
          break;
        case "evicted": {
          info = ev.info as Info;
          const through = ev.through as number;
          messages = messages.filter((m) => m.seq > through);
          renderAll();
          renderMeta();
          break;
        }
        case "settings": {
          const next = ev.info as Info;
          if (locked && !next.locked) {
            // Password removed: the chat is open to read again.
            locked = false;
            void loadHistory().then((ok) => ok && (me ? showComposer() : showJoin()));
            break;
          }
          info = next;
          renderMeta();
          if (settings.open) renderSettings();
          break;
        }
        case "locked":
          showLocked();
          break;
        case "expired":
          markGone();
          break;
        case "deleted":
          markGone("deleted");
          break;
      }
    });
    sock.addEventListener("close", (e) => {
      clearInterval(pingTimer);
      if (ws === sock) ws = null;
      if (e.code === 4404) return markGone();
      if (gone) return;
      const delay = Math.min(15_000, 1000 * 2 ** wsRetry++);
      setTimeout(connect, delay);
    });
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      unread = 0;
      document.title = baseTitle();
      connect();
    }
  });
  setInterval(() => {
    renderMeta();
    renderTyping();
  }, 15_000);

  // ----- boot -----

  // Latest page of history. False when there's nothing to show: the chat is
  // gone, locked to us (the locked view is up) or the request failed.
  async function loadHistory(): Promise<boolean> {
    const r = await api<{ messages: Message[]; members: Member[]; info: Info }>(`/api/chats/${slug}/messages?format=client&limit=100`, { headers: authHeaders() });
    if (!r.ok) {
      if (r.status === 404) markGone();
      else if (r.passwordRequired) showLocked();
      else list.innerHTML = `<div class="chat-loading">${esc(r.error)}</div>`;
      return false;
    }
    info = r.data.info;
    for (const m of r.data.members) members.set(m.id, m);
    messages = r.data.messages;
    renderAll();
    renderMeta();
    renderTitle();
    toBottom();
    return true;
  }

  void (async () => {
    const token = hashToken ?? saved?.token;
    if (token) {
      const who = await api<{ member: { id: string } }>(`/api/chats/${slug}/me`, { headers: { Authorization: `Bearer ${token}` } });
      if (who.ok) remember(token, who.data.member.id);
      else if (who.status === 404) return markGone();
      else if (who.status === 401) {
        forgetMember(slug);
        if (hashToken) toast("that personal link is no longer valid");
      }
    }
    if (await loadHistory()) {
      if (me) showComposer();
      else showJoin();
    }
    syncSend();
    connect();
  })();
}

const page = document.body.dataset.page;
if (page === "landing") landing();
else if (page === "room" && document.body.dataset.slug) room(document.body.dataset.slug);
