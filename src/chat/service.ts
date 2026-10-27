// Chat operations shared by the REST API (routes/chat.ts) and the MCP tools
// (lib/chatTools.ts): room lookup, creation, image upload, and turning room
// paths into absolute URLs for API consumers.

import { isValidSlug, newSlug } from "../lib/slug.js";
import { sniffImage, type SniffedImage } from "../lib/image.js";
import { normalizeTitle } from "../lib/http.js";
import type { ChatImage, ChatInfo, ChatMember, ChatMessage, ChatResult } from "./room.js";
import { MAX_PASSWORD_LENGTH } from "../types.js";
import type { Bindings } from "../types.js";

export function roomFor(env: Bindings, slug: string) {
  return env.CHAT.get(env.CHAT.idFromName(slug));
}

// chat.pencil.md ↔ pencil.md, chat.localhost:8787 ↔ localhost:8787.
export function chatOriginFor(origin: string): string {
  try {
    const u = new URL(origin);
    if (u.hostname.startsWith("chat.")) return u.origin;
    const host = u.host.replace(/^(draw|chat)\./, "");
    return `${u.protocol}//chat.${host}`;
  } catch {
    return "https://chat.pencil.md";
  }
}

// Accept a bare slug or any chat URL (https://chat.pencil.md/<slug>[/…]).
export function parseChatRef(raw: string): string | null {
  let s = raw.trim();
  if (/^https?:\/\//i.test(s)) {
    try {
      s = new URL(s).pathname.split("/").filter(Boolean)[0] ?? "";
    } catch {
      return null;
    }
  }
  return isValidSlug(s) ? s : null;
}

// A chat password: undefined/null/"" = none, otherwise 1–128 characters.
export function chatPassword(v: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (v === undefined || v === null || v === "") return { ok: true, value: null };
  if (typeof v !== "string") return { ok: false, error: "password must be a string" };
  if (v.length > MAX_PASSWORD_LENGTH) return { ok: false, error: `password must be at most ${MAX_PASSWORD_LENGTH} characters` };
  return { ok: true, value: v };
}

// The owner token comes back once, here; only the creator holds it.
export async function createChat(env: Bindings, title: unknown, password?: string | null, persistent = false): Promise<{ info: ChatInfo; ownerToken: string }> {
  const t = typeof title === "string" ? normalizeTitle(title) : "";
  for (let i = 0; i < 8; i++) {
    const slug = newSlug();
    const created = await roomFor(env, slug).create(slug, t, password ?? undefined, persistent);
    if (created) return created;
  }
  throw new Error("chat slug allocation failed");
}

// Store a sniffed image in R2 and register it with the room as an upload the
// member can attach to their next message. The member check runs first so a
// stranger can't fill R2.
export async function uploadChatImage(
  env: Bindings,
  slug: string,
  token: string,
  bytes: Uint8Array,
  info?: SniffedImage | null,
): Promise<ChatResult<ChatImage>> {
  const sniffed = info ?? sniffImage(bytes);
  if (!sniffed) return { ok: false, status: 400, error: "unsupported image format (use PNG, JPEG, GIF or WebP)" };
  const room = roomFor(env, slug);
  const pre = await room.canUpload(token);
  if (!pre.ok) return pre;
  const ext = sniffed.mime.split("/")[1]!.replace("jpeg", "jpg");
  const name = `${newSlug()}${newSlug()}.${ext}`;
  const key = `chat/${slug}/${name}`;
  await env.IMAGES.put(key, bytes, { httpMetadata: { contentType: sniffed.mime } });
  const res = await room.registerUpload(token, { name, mime: sniffed.mime, width: sniffed.width, height: sniffed.height, bytes: bytes.byteLength });
  if (!res.ok) await env.IMAGES.delete(key).catch(() => {});
  return res;
}

// ---------- API shapes (absolute URLs, no internal paths) ----------

export function apiImage(chatOrigin: string, i: ChatImage) {
  return { id: i.name, url: chatOrigin + i.path, mime: i.mime, width: i.width, height: i.height, bytes: i.bytes };
}

export function apiMessage(chatOrigin: string, m: ChatMessage, members?: Map<string, ChatMember>) {
  const author = members?.get(m.member_id);
  return {
    seq: m.seq,
    type: m.type,
    member_id: m.member_id,
    ...(author ? { nickname: author.nickname, kind: author.kind } : {}),
    text: m.text,
    images: m.images.map((i) => apiImage(chatOrigin, i)),
    created_at: new Date(m.created_at).toISOString(),
  };
}

export function apiMember(m: ChatMember) {
  return { id: m.id, nickname: m.nickname, kind: m.kind, avatar: { pattern: m.pattern, hue: m.hue }, joined_at: new Date(m.joined_at).toISOString() };
}

export function apiInfo(chatOrigin: string, i: ChatInfo) {
  return {
    slug: i.slug,
    url: `${chatOrigin}/${i.slug}`,
    title: i.title,
    created_at: new Date(i.created_at).toISOString(),
    last_message_at: new Date(i.last_message_at).toISOString(),
    expires_at: i.expires_at === null ? null : new Date(i.expires_at).toISOString(),
    persistent: i.persistent,
    bytes: i.bytes,
    max_bytes: i.max_bytes,
    member_count: i.member_count,
    max_members: i.max_members,
    latest_seq: i.latest_seq,
    oldest_seq: i.oldest_seq,
    older_messages_evicted: i.evicted,
    password_protected: i.locked,
    owner_member_id: i.owner_member_id,
  };
}
