// One Durable Object per chat.pencil.md room, addressed by idFromName(slug).
//
// State lives in the object's own SQLite storage: the room row, members
// (token hashes, never tokens), messages with their pre-rendered HTML, and
// images uploaded but not yet attached to a message. Image bytes live in R2
// under chat/<slug>/; the object deletes them when it evicts or expires.
//
// Lifecycle:
// - create() writes the schema; nothing else ever writes to an object whose
//   room doesn't exist, so probing random slugs leaves no storage behind.
// - Every message moves the alarm to last message + 24 h. alarm() then wipes
//   R2, closes sockets and calls deleteAll(): the room is gone for good.
// - When a new message would push the room past 100 MB, the oldest messages
//   (and their images) are deleted until it fits.
//
// - The creator gets an owner token from create(). Only it — or the member
//   who joined with it — can set a password or delete the chat (remove()
//   wipes everything at once, like the alarm).
// - With a password set, joining needs it and reading needs membership:
//   messages, info and live events go only to members and the owner. People
//   already in the chat keep their access when a password is added.
//
// Realtime goes out over hibernatable WebSockets (browsers) and a long-poll
// on messages() (agents). Sending always goes through RPC so one code path
// enforces the limits.

import { DurableObject } from "cloudflare:workers";
import { customAlphabet } from "nanoid";
import { renderMarkdown } from "../lib/markdown.js";
import { normaliseAvatar } from "../lib/avatar.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import {
  CHAT_MAX_BYTES,
  CHAT_MAX_IMAGES_PER_MESSAGE,
  CHAT_MAX_MEMBERS,
  CHAT_MAX_NICKNAME,
  CHAT_TTL_MS,
  MAX_CONTENT_BYTES,
  MAX_TITLE_LENGTH,
} from "../types.js";
import type { Bindings } from "../types.js";

export type ChatMember = {
  id: string;
  nickname: string;
  kind: "human" | "agent";
  pattern: string;
  hue: number;
  joined_at: number;
};

export type ChatImage = { name: string; path: string; mime: string; width: number; height: number; bytes: number };

export type ChatMessage = {
  seq: number;
  type: "message" | "join";
  member_id: string;
  text: string;
  html: string;
  images: ChatImage[];
  created_at: number;
};

export type ChatInfo = {
  slug: string;
  title: string;
  created_at: number;
  last_message_at: number;
  expires_at: number;
  bytes: number;
  max_bytes: number;
  member_count: number;
  max_members: number;
  // Lowest seq still stored; anything below it was evicted to stay under the
  // byte cap (or never existed). 0 when the room has no messages.
  oldest_seq: number;
  latest_seq: number;
  evicted: boolean;
  locked: boolean; // password set
  owner_member_id: string | null; // the participant who created the chat, once they joined
};

// Browsers get rendered HTML, API clients the markdown source — never both,
// which keeps RPC payloads and WebSocket frames half the size.
export type ChatFormat = "client" | "api";

export type ChatErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 429;
// `password_required` marks refusals that the right password would lift, so
// clients can tell them from "chat full" and friends.
export type ChatFail = { ok: false; status: ChatErrorStatus; error: string; code?: "password_required" };
export type ChatResult<T> = { ok: true; value: T } | ChatFail;

export type UploadMeta = { name: string; mime: string; width: number; height: number; bytes: number };

type RoomRow = {
  slug: string;
  title: string;
  created_at: number;
  last_message_at: number;
  bytes: number;
  evicted_through: number;
  owner_hash: string | null;
  owner_member_id: string | null;
  password_hash: string | null;
};
// owner: the socket authenticated with the owner token (creator not joined yet).
type Attachment = { mid: string | null; owner?: boolean };
type Access = { member: ChatMember | null; owner: boolean };

const ROOM_COLS = "slug, title, created_at, last_message_at, bytes, evicted_through, owner_hash, owner_member_id, password_hash";
const LOCKED = "this chat is password-protected — join it with the password";

const memberIdGen = customAlphabet("23456789abcdefghijkmnpqrstuvwxyz", 10);
const enc = new TextEncoder();

const MAX_SOCKETS = 500;
const MAX_WAIT_MS = 25_000;
const MAX_PAGE = 200;
// A history page stops growing past this many bytes of message content
// (always at least one message), so 512 KB messages can't blow up RPC.
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_UPLOADS = 30;
// Per member: 20 messages / 10 s and 30 image uploads / minute. Kept in
// memory — a hibernation wake-up resets the window, which is fine.
const MSG_WINDOW_MS = 10_000;
const MSG_PER_WINDOW = 20;
const UPLOAD_WINDOW_MS = 60_000;
const UPLOAD_PER_WINDOW = 30;
// Wrong passwords: 10 per client IP per 10 minutes.
const PW_WINDOW_MS = 10 * 60_000;
const PW_PER_WINDOW = 10;

function fail(status: ChatErrorStatus, error: string, code?: ChatFail["code"]): ChatFail {
  return code ? { ok: false, status, error, code } : { ok: false, status, error };
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newToken(prefix = "pct_"): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return prefix + btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function cleanNickname(v: unknown): string | null {
  if (typeof v !== "string") return null;
  // Collapse whitespace and drop control / bidi-override characters so a
  // nickname can't break the layout or spoof another line.
  const s = v.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, "").replace(/\s+/g, " ").trim();
  if (!s || [...s].length > CHAT_MAX_NICKNAME) return null;
  return s;
}

export class ChatRoom extends DurableObject<Bindings> {
  private sql: SqlStorage;
  private room: RoomRow | null | undefined; // undefined = not loaded yet
  private waiters = new Set<() => void>();
  private msgHits = new Map<string, number[]>();
  private uploadHits = new Map<string, number[]>();
  private passwordMisses = new Map<string, number[]>();
  private lastTyping = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Keepalive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // ---------- storage helpers ----------

  private load(): RoomRow | null {
    if (this.room !== undefined) return this.room;
    const has = this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'room'").toArray().length > 0;
    if (has) this.migrate();
    this.room = has ? ((this.sql.exec(`SELECT ${ROOM_COLS} FROM room WHERE id = 1`).toArray()[0] as RoomRow | undefined) ?? null) : null;
    return this.room;
  }

  // Rooms created before owners and passwords existed lack the columns; they
  // get them empty (no owner, no password).
  private migrate(): void {
    const cols = new Set(this.sql.exec("PRAGMA table_info(room)").toArray().map((c) => String(c.name)));
    for (const col of ["owner_hash", "owner_member_id", "password_hash"]) {
      if (!cols.has(col)) this.sql.exec(`ALTER TABLE room ADD COLUMN ${col} TEXT`);
    }
  }

  private memberCount(): number {
    return Number(this.sql.exec("SELECT COUNT(*) AS n FROM members").one().n);
  }

  private members(): ChatMember[] {
    return this.sql.exec("SELECT id, nickname, kind, pattern, hue, joined_at FROM members ORDER BY joined_at").toArray() as ChatMember[];
  }

  private async memberByToken(token: unknown): Promise<ChatMember | null> {
    if (typeof token !== "string" || token.length < 8 || token.length > 128) return null;
    const hash = await sha256Hex(token);
    return (this.sql.exec("SELECT id, nickname, kind, pattern, hue, joined_at FROM members WHERE token_hash = ?", hash).toArray()[0] as ChatMember | undefined) ?? null;
  }

  // Who is this token: a member, the owner (by owner token, or as the member
  // who joined with it), both, or nobody.
  private async access(token: unknown): Promise<Access> {
    if (typeof token !== "string" || token.length < 8 || token.length > 128) return { member: null, owner: false };
    const r = this.load();
    const hash = await sha256Hex(token);
    const member = (this.sql.exec("SELECT id, nickname, kind, pattern, hue, joined_at FROM members WHERE token_hash = ?", hash).toArray()[0] as ChatMember | undefined) ?? null;
    const owner = !!r && ((!!r.owner_hash && r.owner_hash === hash) || (!!member && member.id === r.owner_member_id));
    return { member, owner };
  }

  private canRead(r: RoomRow, a: Access): boolean {
    return !r.password_hash || !!a.member || a.owner;
  }

  private info(r: RoomRow): ChatInfo {
    const bounds = this.sql.exec("SELECT COALESCE(MIN(seq), 0) AS lo, COALESCE(MAX(seq), 0) AS hi FROM messages").one();
    return {
      slug: r.slug,
      title: r.title,
      created_at: r.created_at,
      last_message_at: r.last_message_at,
      expires_at: r.last_message_at + CHAT_TTL_MS,
      bytes: r.bytes,
      max_bytes: CHAT_MAX_BYTES,
      member_count: this.memberCount(),
      max_members: CHAT_MAX_MEMBERS,
      oldest_seq: Number(bounds.lo),
      latest_seq: Number(bounds.hi),
      evicted: r.evicted_through > 0,
      locked: !!r.password_hash,
      owner_member_id: r.owner_member_id,
    };
  }

  private rowToMessage(row: Record<string, SqlStorageValue>, format: ChatFormat): ChatMessage {
    const r = this.room!;
    const images = (JSON.parse(String(row.images)) as Omit<ChatImage, "path">[]).map((i) => ({ ...i, path: `/${r.slug}/img/${i.name}` }));
    return {
      seq: Number(row.seq),
      type: row.type as ChatMessage["type"],
      member_id: String(row.member_id),
      text: format === "api" ? String(row.text) : "",
      html: format === "client" ? String(row.html) : "",
      images,
      created_at: Number(row.created_at),
    };
  }

  private rateLimited(map: Map<string, number[]>, key: string, windowMs: number, max: number): boolean {
    const now = Date.now();
    const hits = (map.get(key) ?? []).filter((t) => now - t < windowMs);
    if (hits.length >= max) {
      map.set(key, hits);
      return true;
    }
    hits.push(now);
    map.set(key, hits);
    return false;
  }

  // ---------- RPC: lifecycle ----------

  // Returns the owner token once; only its hash is stored.
  async create(slug: string, title: string, password?: string): Promise<{ info: ChatInfo; ownerToken: string } | null> {
    // Hash first: nothing may await between the "slug taken" check and the
    // schema write.
    const ownerToken = newToken("pco_");
    const ownerHash = await sha256Hex(ownerToken);
    const passwordHash = password ? await hashPassword(password) : null;
    if (this.load()) return null; // slug taken
    const now = Date.now();
    this.sql.exec(`
      CREATE TABLE room (id INTEGER PRIMARY KEY CHECK (id = 1), slug TEXT NOT NULL, title TEXT NOT NULL,
        created_at INTEGER NOT NULL, last_message_at INTEGER NOT NULL, bytes INTEGER NOT NULL DEFAULT 0,
        evicted_through INTEGER NOT NULL DEFAULT 0, owner_hash TEXT, owner_member_id TEXT, password_hash TEXT);
      CREATE TABLE members (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, nickname TEXT NOT NULL,
        kind TEXT NOT NULL, pattern TEXT NOT NULL, hue INTEGER NOT NULL, joined_at INTEGER NOT NULL);
      CREATE TABLE messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, member_id TEXT NOT NULL,
        text TEXT NOT NULL, html TEXT NOT NULL, images TEXT NOT NULL, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE uploads (name TEXT PRIMARY KEY, member_id TEXT NOT NULL, mime TEXT NOT NULL, width INTEGER NOT NULL,
        height INTEGER NOT NULL, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL);
    `);
    this.sql.exec(
      "INSERT INTO room (id, slug, title, created_at, last_message_at, owner_hash, password_hash) VALUES (1, ?, ?, ?, ?, ?, ?)",
      slug,
      title.slice(0, MAX_TITLE_LENGTH),
      now,
      now,
      ownerHash,
      passwordHash,
    );
    this.room = undefined;
    await this.ctx.storage.setAlarm(now + CHAT_TTL_MS);
    return { info: this.info(this.load()!), ownerToken };
  }

  async getInfo(token?: string): Promise<ChatResult<ChatInfo & { members: ChatMember[]; online: string[] }>> {
    const r = this.load();
    if (!r) return fail(404, "chat not found (it may have expired)");
    if (r.password_hash && !this.canRead(r, await this.access(token))) return fail(403, LOCKED, "password_required");
    return { ok: true, value: { ...this.info(r), members: this.members(), online: this.online() } };
  }

  override async alarm(): Promise<void> {
    const r = this.load();
    if (!r) return;
    const due = r.last_message_at + CHAT_TTL_MS;
    if (Date.now() < due) {
      await this.ctx.storage.setAlarm(due);
      return;
    }
    await this.wipe(r, "expired");
  }

  // Delete the room for good: images, sockets, waiters, storage.
  private async wipe(r: RoomRow, reason: "expired" | "deleted"): Promise<void> {
    await this.purgeImages(r.slug);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(JSON.stringify({ type: reason }));
        ws.close(4404, `chat ${reason}`);
      } catch {
        /* already gone */
      }
    }
    this.room = null;
    for (const w of [...this.waiters]) w();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  // ---------- RPC: owner ----------

  private async ownerCheck(token: string): Promise<ChatResult<RoomRow>> {
    const r = this.load();
    if (!r) return fail(404, "chat not found (it may have expired)");
    const a = await this.access(token);
    if (a.owner) return { ok: true, value: r };
    return a.member ? fail(403, "only the chat's creator can do that") : fail(401, "invalid token — pass the owner_token from create_chat");
  }

  // Set (string) or remove (null) the password. Members keep their access;
  // sockets that aren't members get a "locked" event and nothing after it.
  async setPassword(token: string, password: string | null): Promise<ChatResult<ChatInfo>> {
    const own = await this.ownerCheck(token);
    if (!own.ok) return own;
    const hash = password ? await hashPassword(password) : null;
    this.sql.exec("UPDATE room SET password_hash = ? WHERE id = 1", hash);
    this.room = undefined;
    const info = this.info(this.load()!);
    if (info.locked) {
      for (const ws of this.ctx.getWebSockets()) {
        if (this.socketCanRead(ws)) continue;
        try {
          ws.send(JSON.stringify({ type: "locked" }));
        } catch {
          /* closing socket */
        }
      }
    }
    this.broadcast({ type: "settings", info });
    return { ok: true, value: info };
  }

  async remove(token: string): Promise<ChatResult<{ slug: string }>> {
    const own = await this.ownerCheck(token);
    if (!own.ok) return own;
    await this.wipe(own.value, "deleted");
    return { ok: true, value: { slug: own.value.slug } };
  }

  private async purgeImages(slug: string): Promise<void> {
    let cursor: string | undefined;
    do {
      const page = await this.env.IMAGES.list({ prefix: `chat/${slug}/`, cursor, limit: 1000 });
      const keys = page.objects.map((o) => o.key);
      if (keys.length) await this.env.IMAGES.delete(keys);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }

  // ---------- RPC: members ----------

  // Joining with the owner token makes this member the chat's owner (and
  // skips the password). `ip` keys the wrong-password limit.
  async join(input: { nickname: unknown; kind?: unknown; avatar?: unknown; password?: unknown; ownerToken?: unknown; ip?: string }): Promise<ChatResult<{ token: string; member: ChatMember }>> {
    const r = this.load();
    if (!r) return fail(404, "chat not found (it may have expired)");
    const nickname = cleanNickname(input.nickname);
    if (!nickname) return fail(400, `nickname must be 1–${CHAT_MAX_NICKNAME} characters`);
    const isOwner = typeof input.ownerToken === "string" && !!r.owner_hash && (await this.access(input.ownerToken)).owner;
    if (r.password_hash && !isOwner) {
      const pw = typeof input.password === "string" ? input.password : "";
      if (!pw) return fail(403, LOCKED, "password_required");
      const key = input.ip || "?";
      const now = Date.now();
      const misses = (this.passwordMisses.get(key) ?? []).filter((t) => now - t < PW_WINDOW_MS);
      if (misses.length >= PW_PER_WINDOW) return fail(429, "too many wrong passwords, try again in a few minutes");
      if (!(await verifyPassword(pw, r.password_hash))) {
        misses.push(now);
        this.passwordMisses.set(key, misses);
        return fail(403, "wrong password", "password_required");
      }
    }
    // Hash before the capacity check: nothing may await between the count
    // and the insert, or concurrent joins could overshoot the cap.
    const token = newToken();
    const tokenHash = await sha256Hex(token);
    if (!this.load()) return fail(404, "chat not found (it may have expired)");
    if (this.memberCount() >= CHAT_MAX_MEMBERS) return fail(403, `chat is full (${CHAT_MAX_MEMBERS} participants)`);
    const kind: ChatMember["kind"] = input.kind === "agent" ? "agent" : "human";
    const avatar = normaliseAvatar(input.avatar);
    const member: ChatMember = { id: memberIdGen(), nickname, kind, pattern: avatar.pattern, hue: avatar.hue, joined_at: Date.now() };
    this.sql.exec(
      "INSERT INTO members (id, token_hash, nickname, kind, pattern, hue, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      member.id,
      tokenHash,
      member.nickname,
      member.kind,
      member.pattern,
      member.hue,
      member.joined_at,
    );
    if (isOwner) {
      this.sql.exec("UPDATE room SET owner_member_id = ? WHERE id = 1", member.id);
      this.room = undefined;
    }
    // A zero-byte "joined" line so everyone sees who came in. It doesn't
    // count as a message for the 24 h expiry.
    const row = this.sql
      .exec("INSERT INTO messages (type, member_id, text, html, images, bytes, created_at) VALUES ('join', ?, '', '', '[]', 0, ?) RETURNING *", member.id, member.joined_at)
      .one();
    this.broadcast({ type: "member", member });
    this.broadcast({ type: "message", message: this.rowToMessage(row, "client"), info: this.info(this.load()!) });
    this.wake();
    return { ok: true, value: { token, member } };
  }

  async whoami(token: string): Promise<ChatResult<ChatMember>> {
    if (!this.load()) return fail(404, "chat not found (it may have expired)");
    const m = await this.memberByToken(token);
    return m ? { ok: true, value: m } : fail(401, "invalid member token — join the chat first");
  }

  // Any participant can name (or rename) the chat. It doesn't count as a
  // message, so it doesn't extend the 24 h expiry.
  async rename(token: string, title: string): Promise<ChatResult<ChatInfo>> {
    const r = this.load();
    if (!r) return fail(404, "chat not found (it may have expired)");
    const m = await this.memberByToken(token);
    if (!m) return fail(401, "invalid member token — join the chat first");
    if (this.rateLimited(this.msgHits, m.id, MSG_WINDOW_MS, MSG_PER_WINDOW)) return fail(429, "too many messages, slow down");
    r.title = title.slice(0, MAX_TITLE_LENGTH);
    this.sql.exec("UPDATE room SET title = ? WHERE id = 1", r.title);
    const info = this.info(r);
    this.broadcast({ type: "title", info });
    return { ok: true, value: info };
  }

  // ---------- RPC: images ----------

  // Pre-flight for an upload, so the worker doesn't push 5 MB into R2 for a
  // request that will be refused anyway.
  async canUpload(token: string): Promise<ChatResult<ChatMember>> {
    const who = await this.whoami(token);
    if (!who.ok) return who;
    const pending = Number(this.sql.exec("SELECT COUNT(*) AS n FROM uploads WHERE member_id = ?", who.value.id).one().n);
    if (pending >= MAX_PENDING_UPLOADS) return fail(429, "too many images waiting to be sent — send a message first");
    if (this.rateLimited(this.uploadHits, who.value.id, UPLOAD_WINDOW_MS, UPLOAD_PER_WINDOW)) return fail(429, "too many uploads, slow down");
    return who;
  }

  async registerUpload(token: string, meta: UploadMeta): Promise<ChatResult<ChatImage>> {
    const r = this.load();
    if (!r) return fail(404, "chat not found (it may have expired)");
    const m = await this.memberByToken(token);
    if (!m) return fail(401, "invalid member token — join the chat first");
    this.sql.exec(
      "INSERT INTO uploads (name, member_id, mime, width, height, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      meta.name,
      m.id,
      meta.mime,
      meta.width,
      meta.height,
      meta.bytes,
      Date.now(),
    );
    return { ok: true, value: { ...meta, path: `/${r.slug}/img/${meta.name}` } };
  }

  // ---------- RPC: messages ----------

  async post(token: string, input: { text?: unknown; images?: unknown }, format: ChatFormat = "api"): Promise<ChatResult<{ message: ChatMessage; info: ChatInfo }>> {
    const r = this.load();
    if (!r) return fail(404, "chat not found (it may have expired)");
    const m = await this.memberByToken(token);
    if (!m) return fail(401, "invalid member token — join the chat first");

    const text = input.text === undefined || input.text === null ? "" : input.text;
    if (typeof text !== "string") return fail(400, "text must be a string");
    const textBytes = enc.encode(text).length;
    if (textBytes > MAX_CONTENT_BYTES) return fail(413, `text exceeds ${MAX_CONTENT_BYTES} bytes`);
    const names = input.images === undefined || input.images === null ? [] : input.images;
    if (!Array.isArray(names) || names.some((n) => typeof n !== "string")) return fail(400, "images must be an array of image ids");
    const unique = [...new Set(names as string[])];
    if (unique.length > CHAT_MAX_IMAGES_PER_MESSAGE) return fail(400, `at most ${CHAT_MAX_IMAGES_PER_MESSAGE} images per message`);
    if (!text.trim() && unique.length === 0) return fail(400, "message is empty");

    const uploads: Omit<ChatImage, "path">[] = [];
    for (const name of unique) {
      const u = this.sql.exec("SELECT name, mime, width, height, bytes FROM uploads WHERE name = ? AND member_id = ?", name, m.id).toArray()[0];
      if (!u) return fail(400, `unknown image id "${name.slice(0, 40)}" — upload it first`);
      uploads.push({ name: String(u.name), mime: String(u.mime), width: Number(u.width), height: Number(u.height), bytes: Number(u.bytes) });
    }
    if (this.rateLimited(this.msgHits, m.id, MSG_WINDOW_MS, MSG_PER_WINDOW)) return fail(429, "too many messages, slow down");

    const html = text.trim() ? renderMarkdown(text) : "";
    const bytes = textBytes + uploads.reduce((n, u) => n + u.bytes, 0);
    const evictedThrough = this.makeRoom(bytes);

    const now = Date.now();
    const row = this.sql
      .exec(
        "INSERT INTO messages (type, member_id, text, html, images, bytes, created_at) VALUES ('message', ?, ?, ?, ?, ?, ?) RETURNING *",
        m.id,
        text,
        html,
        JSON.stringify(uploads),
        bytes,
        now,
      )
      .one();
    for (const u of uploads) this.sql.exec("DELETE FROM uploads WHERE name = ?", u.name);
    this.sql.exec("UPDATE room SET last_message_at = ?, bytes = bytes + ? WHERE id = 1", now, bytes);
    this.room = undefined;
    const fresh = this.load()!;
    await this.ctx.storage.setAlarm(now + CHAT_TTL_MS);

    const live = this.rowToMessage(row, "client");
    const message = format === "client" ? live : this.rowToMessage(row, "api");
    const info = this.info(fresh);
    if (evictedThrough) this.broadcast({ type: "evicted", through: evictedThrough, info });
    this.broadcast({ type: "message", message: live, info });
    this.wake();
    return { ok: true, value: { message, info } };
  }

  // Delete the oldest messages until `incoming` more bytes fit under the cap.
  // Returns the highest evicted seq, or 0 when nothing had to go.
  private makeRoom(incoming: number): number {
    const r = this.load()!;
    let total = r.bytes;
    if (total + incoming <= CHAT_MAX_BYTES) return 0;
    const doomedKeys: string[] = [];
    let through = 0;
    for (const row of this.sql.exec("SELECT seq, images, bytes FROM messages ORDER BY seq").toArray()) {
      if (total + incoming <= CHAT_MAX_BYTES) break;
      total -= Number(row.bytes);
      through = Number(row.seq);
      for (const i of JSON.parse(String(row.images)) as { name: string }[]) doomedKeys.push(`chat/${r.slug}/${i.name}`);
    }
    if (!through) return 0;
    this.sql.exec("DELETE FROM messages WHERE seq <= ?", through);
    this.sql.exec("UPDATE room SET bytes = ?, evicted_through = ? WHERE id = 1", Math.max(0, total), through);
    this.room = undefined;
    if (doomedKeys.length) {
      this.ctx.waitUntil(
        (async () => {
          for (let i = 0; i < doomedKeys.length; i += 1000) await this.env.IMAGES.delete(doomedKeys.slice(i, i + 1000));
        })().catch(() => {}),
      );
    }
    return through;
  }

  // History. `after` → ascending from after+1 (and, with waitMs, long-polls
  // until something arrives); `before` → the page just below it; neither →
  // the latest `limit` messages.
  async messages(opts: { after?: number; before?: number; limit?: number; waitMs?: number; format?: ChatFormat; token?: string }): Promise<ChatResult<{ messages: ChatMessage[]; info: ChatInfo; members: ChatMember[] }>> {
    const room = this.load();
    if (!room) return fail(404, "chat not found (it may have expired)");
    const who = room.password_hash || opts.token ? await this.access(opts.token) : { member: null, owner: false };
    if (!this.canRead(room, who)) return fail(403, LOCKED, "password_required");
    const limit = Math.max(1, Math.min(MAX_PAGE, Math.floor(opts.limit ?? 100)));
    const format = opts.format ?? "api";
    const col = format === "client" ? "html" : "text";
    // Walk outward from the anchor, stopping at the row or byte budget.
    const take = (cursor: Iterable<Record<string, SqlStorageValue>>): Record<string, SqlStorageValue>[] => {
      const out: Record<string, SqlStorageValue>[] = [];
      let budget = MAX_PAGE_BYTES;
      for (const row of cursor) {
        const size = String(row[col]).length;
        if (out.length > 0 && size > budget) break;
        budget -= size;
        out.push(row);
        if (out.length >= limit) break;
      }
      return out;
    };
    const run = (): ChatMessage[] => {
      if (opts.after !== undefined) {
        return take(this.sql.exec("SELECT * FROM messages WHERE seq > ? ORDER BY seq", opts.after)).map((x) => this.rowToMessage(x, format));
      }
      const rows =
        opts.before !== undefined
          ? take(this.sql.exec("SELECT * FROM messages WHERE seq < ? ORDER BY seq DESC", opts.before))
          : take(this.sql.exec("SELECT * FROM messages ORDER BY seq DESC"));
      return rows.reverse().map((x) => this.rowToMessage(x, format));
    };
    let list = run();
    const wait = Math.max(0, Math.min(MAX_WAIT_MS, Math.floor(opts.waitMs ?? 0)));
    if (list.length === 0 && opts.after !== undefined && wait > 0) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, wait);
        this.waiters.add(done);
      });
      const r = this.load();
      if (!r) return fail(404, "chat not found (it may have expired)");
      // The password may have been set while we waited.
      if (!this.canRead(r, who)) return fail(403, LOCKED, "password_required");
      list = run();
    }
    return { ok: true, value: { messages: list, info: this.info(this.load()!), members: this.members() } };
  }

  private wake(): void {
    for (const w of [...this.waiters]) w();
  }

  // ---------- WebSockets ----------

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("expected a websocket upgrade", { status: 426 });
    if (!this.load()) return new Response("chat not found", { status: 404 });
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) return new Response("too many connections", { status: 503 });
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ mid: null } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  // Client → server frames: {type:"auth", token} binds the socket to a member
  // (for presence + typing); {type:"typing"} fans out a typing hint. Messages
  // themselves are sent over HTTP so images and limits share one path.
  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== "string" || data.length > 1024) return;
    let msg: { type?: unknown; token?: unknown };
    try {
      msg = JSON.parse(data) as typeof msg;
    } catch {
      return;
    }
    const att = (ws.deserializeAttachment() as Attachment | null) ?? { mid: null };
    if (msg.type === "auth") {
      const a = await this.access(msg.token);
      ws.serializeAttachment({ mid: a.member?.id ?? null, owner: a.owner } satisfies Attachment);
      ws.send(JSON.stringify({ type: "auth", member_id: a.member?.id ?? null, owner: a.owner }));
      this.broadcastPresence();
    } else if (msg.type === "typing" && att.mid) {
      const now = Date.now();
      if (now - (this.lastTyping.get(att.mid) ?? 0) < 2000) return;
      this.lastTyping.set(att.mid, now);
      this.broadcast({ type: "typing", member_id: att.mid }, ws);
    }
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye");
    } catch {
      /* already closed */
    }
    this.broadcastPresence(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.broadcastPresence(ws);
  }

  private online(skip?: WebSocket): string[] {
    const ids = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === skip) continue;
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.mid) ids.add(a.mid);
    }
    return [...ids];
  }

  private broadcastPresence(skip?: WebSocket): void {
    this.broadcast({ type: "presence", online: this.online(skip) }, skip);
  }

  // In a password-protected chat, only members and the owner hear anything.
  private socketCanRead(ws: WebSocket): boolean {
    if (!this.load()?.password_hash) return true;
    const a = ws.deserializeAttachment() as Attachment | null;
    return !!a?.mid || !!a?.owner;
  }

  private broadcast(event: Record<string, unknown>, skip?: WebSocket): void {
    const data = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === skip || !this.socketCanRead(ws)) continue;
      try {
        ws.send(data);
      } catch {
        /* closing socket */
      }
    }
  }
}
