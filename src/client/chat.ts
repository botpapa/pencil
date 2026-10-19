// chat.pencil.md client: the landing page's "your chats" list and the room.
//
// The room loads history over HTTP, then listens on a WebSocket for live
// events (message / member / presence / typing / evicted / expired). Sending
// and image uploads go over HTTP so every limit is enforced in one place.
// Identity is a member token kept in localStorage per chat.

import { avatarSvg, AVATAR_PATTERNS, type Avatar } from "../lib/avatar.js";

type Member = { id: string; nickname: string; kind: "human" | "agent"; pattern: string; hue: number; joined_at: number };
type Image = { name: string; path: string; mime: string; width: number; height: number; bytes: number };
type Message = { seq: number; type: "message" | "join"; member_id: string; text: string; html: string; images: Image[]; created_at: number };
type Info = {
  slug: string;
  title: string;
  expires_at: number;
  bytes: number;
  max_bytes: number;
  member_count: number;
  max_members: number;
  oldest_seq: number;
  latest_seq: number;
  evicted: boolean;
};
type Saved = { token: string; member_id: string; title: string; expires_at: number };

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

// ---------- small helpers ----------

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function esc(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function randomAvatar(): Avatar {
  const r = new Uint32Array(2);
  crypto.getRandomValues(r);
  return { pattern: AVATAR_PATTERNS[r[0]! % AVATAR_PATTERNS.length]!, hue: r[1]! % 360 };
}

function mb(n: number): string {
  const v = n / 1024 / 1024;
  return v < 10 ? v.toFixed(1) : String(Math.round(v));
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

async function api<T>(path: string, init: RequestInit = {}): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  try {
    const res = await fetch(path, init);
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) return { ok: false, status: res.status, error: data.error ?? `HTTP ${res.status}` };
    return { ok: true, data };
  } catch {
    return { ok: false, status: 0, error: "network error — check your connection" };
  }
}

// ---------- landing ----------

function landing(): void {
  const store = loadStore();
  const now = Date.now();
  const live = Object.entries(store).filter(([, v]) => v.expires_at > now);
  if (live.length !== Object.keys(store).length) saveStore(Object.fromEntries(live));
  if (!live.length) return;
  const list = $("chat-recent-list");
  live.sort((a, b) => b[1].expires_at - a[1].expires_at);
  list.innerHTML = live
    .map(([slug, v]) => `<li><a href="/${esc(slug)}">${esc(v.title || slug)}</a><span>deletes in ${esc(timeLeft(v.expires_at - now))} if quiet</span></li>`)
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
  let ws: WebSocket | null = null;
  let wsRetry = 0;
  let gone = false;
  let loadingOlder = false;
  let unread = 0;
  const baseTitle = document.title;
  const typingUntil = new Map<string, number>();

  // ----- identity bootstrap: #as=<token> hands an identity to this device -----
  const hashToken = /^#as=([A-Za-z0-9_-]{8,128})$/.exec(location.hash)?.[1];
  if (hashToken) history.replaceState(null, "", location.pathname);

  const saved = loadStore()[slug];
  const remember = (token: string, member_id: string) => {
    me = { token, member_id };
    const s = loadStore();
    s[slug] = { token, member_id, title: info?.title ?? "", expires_at: info?.expires_at ?? Date.now() + 86_400_000 };
    saveStore(s);
  };

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
    const body = m.html ? `<div class="msg__text prose">${m.html}</div>` : "";
    return `${day}<article class="msg${cont ? " msg--cont" : ""}${mine}" data-seq="${m.seq}"><div class="msg__avatar">${cont || !who ? "" : avatarSvg(who, 36)}</div><div class="msg__main">${head}${body}${imgs}</div></article>`;
  }

  function evictedNote(): string {
    return info?.evicted && messages[0]?.seq === info.oldest_seq ? `<div class="chat-sys chat-sys--note">older messages were erased to keep this chat under 100 MB</div>` : "";
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
      document.title = `(${unread}) ${baseTitle}`;
    }
  }

  function renderMeta(): void {
    if (!info) return;
    const left = info.expires_at - Date.now();
    $("chat-meta").innerHTML = `<span title="Chats keep up to ${mb(info.max_bytes)} MB; the oldest messages are erased past that.">${mb(info.bytes)} / ${mb(info.max_bytes)} MB</span><span title="The chat and everything in it is deleted 24 hours after the last message.">deletes in ${esc(timeLeft(left))} if quiet</span>`;
    $("chat-count").textContent = String(info.member_count);
  }

  function renderPeople(): void {
    const all = [...members.values()].sort((a, b) => Number(online.has(b.id)) - Number(online.has(a.id)) || a.joined_at - b.joined_at);
    $("chat-people-title").textContent = `${members.size} participant${members.size === 1 ? "" : "s"} · ${online.size} online`;
    $("chat-people-list").innerHTML = all
      .map(
        (m) =>
          `<li class="${online.has(m.id) ? "is-online" : ""}">${avatarSvg(m, 24)}<span class="chat-people__name">${esc(m.nickname)}${me?.member_id === m.id ? " <em>(you)</em>" : ""}</span>${m.kind === "agent" ? `<span class="msg__badge">agent</span>` : ""}<span class="chat-people__dot" title="${online.has(m.id) ? "online" : "offline"}"></span></li>`,
      )
      .join("");
    $("chat-people-me").hidden = !me;
  }

  function renderTyping(): void {
    const now = Date.now();
    const names = [...typingUntil.entries()].filter(([id, t]) => t > now && id !== me?.member_id).map(([id]) => nameOf(id)?.nickname ?? "someone");
    typingBox.textContent = names.length === 0 ? "" : names.length === 1 ? `${names[0]} is typing…` : names.length < 4 ? `${names.join(", ")} are typing…` : "several people are typing…";
  }

  function showComposer(): void {
    joinForm.hidden = true;
    compose.hidden = gone;
    renderPeople();
  }

  function showJoin(): void {
    compose.hidden = true;
    joinForm.hidden = gone;
    rollAvatar();
  }

  function markGone(): void {
    gone = true;
    forgetChat(slug);
    joinForm.hidden = true;
    compose.hidden = true;
    $("chat-gone").hidden = false;
    $("chat-meta").textContent = "deleted";
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
    const btn = joinForm.querySelector<HTMLButtonElement>("button[type=submit]")!;
    btn.disabled = true;
    const r = await api<{ member_token: string; member: { id: string; nickname: string; kind: Member["kind"]; avatar: Avatar; joined_at: string } }>(`/api/chats/${slug}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname, avatar: joinAvatar, kind: "human" }),
    });
    btn.disabled = false;
    if (!r.ok) {
      if (r.status === 404) return markGone();
      return toast(r.error);
    }
    const m = r.data.member;
    members.set(m.id, { id: m.id, nickname: m.nickname, kind: m.kind, pattern: m.avatar.pattern, hue: m.avatar.hue, joined_at: Date.parse(m.joined_at) });
    remember(r.data.member_token, m.id);
    wsSend({ type: "auth", token: r.data.member_token });
    showComposer();
    renderAll();
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
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  text.addEventListener("keydown", (e) => {
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
        forgetChat(slug);
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
    if (await copy(location.origin + location.pathname)) toast("link copied — anyone with it can read and join");
  });
  const peopleBtn = $("chat-people-btn");
  const people = $("chat-people");
  peopleBtn.addEventListener("click", () => {
    people.hidden = !people.hidden;
    peopleBtn.setAttribute("aria-expanded", String(!people.hidden));
    if (!people.hidden) renderPeople();
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
    forgetChat(slug);
    me = null;
    wsSend({ type: "auth", token: "" });
    people.hidden = true;
    showJoin();
    renderAll();
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
    if (loadingOlder || !first || !info || first.seq <= info.oldest_seq) return;
    loadingOlder = true;
    const r = await api<{ messages: Message[]; members: Member[]; info: Info }>(`/api/chats/${slug}/messages?format=client&before=${first.seq}&limit=100`);
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
    const after = messages.at(-1)?.seq ?? 0;
    const r = await api<{ messages: Message[]; members: Member[]; info: Info }>(`/api/chats/${slug}/messages?format=client&after=${after}&limit=200`);
    if (!r.ok) {
      if (r.status === 404) markGone();
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
      if (me) wsSend({ type: "auth", token: me.token });
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
        case "expired":
          markGone();
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
      document.title = baseTitle;
      connect();
    }
  });
  setInterval(() => {
    renderMeta();
    renderTyping();
  }, 30_000);

  // ----- boot -----

  void (async () => {
    const r = await api<{ messages: Message[]; members: Member[]; info: Info }>(`/api/chats/${slug}/messages?format=client&limit=100`);
    if (!r.ok) {
      $("chat-loading").textContent = r.status === 404 ? "" : r.error;
      if (r.status === 404) markGone();
      return;
    }
    info = r.data.info;
    for (const m of r.data.members) members.set(m.id, m);
    messages = r.data.messages;

    const token = hashToken ?? saved?.token;
    if (token) {
      const who = await api<{ member: { id: string } }>(`/api/chats/${slug}/me`, { headers: { Authorization: `Bearer ${token}` } });
      if (who.ok) remember(token, who.data.member.id);
      else if (who.status === 401) {
        forgetChat(slug);
        if (hashToken) toast("that personal link is no longer valid");
      }
    }
    renderAll();
    renderMeta();
    if (me) showComposer();
    else showJoin();
    syncSend();
    toBottom();
    connect();
  })();
}

const page = document.body.dataset.page;
if (page === "landing") landing();
else if (page === "room" && document.body.dataset.slug) room(document.body.dataset.slug);
