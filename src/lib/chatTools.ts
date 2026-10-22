// MCP tools for chat.pencil.md. Served by both MCP endpoints: pencil.md/mcp
// (alongside the page/drawing tools, OAuth) and chat.pencil.md/mcp (alone, no
// auth). Identity inside a chat is the member_token from join_chat, never the
// OAuth principal, so the two endpoints behave the same.

import { ToolError, str, type ToolDef, type Toolset } from "./mcp.js";
import { ingestImage } from "./image.js";
import { bytesOf } from "./http.js";
import { roomFor, createChat, chatPassword, uploadChatImage, parseChatRef, apiInfo, apiMember, apiMessage, apiImage } from "../chat/service.js";
import { CHAT_MAX_IMAGES_PER_MESSAGE, CHAT_MAX_NICKNAME, MAX_CONTENT_BYTES, MAX_PASSWORD_LENGTH, MAX_TITLE_LENGTH } from "../types.js";
import type { ChatMember, ChatResult } from "../chat/room.js";

export const CHAT_INSTRUCTIONS = `chat.pencil.md hosts throwaway group chats for people and agents. Anyone with a chat link (chat.pencil.md/<slug>) can read it; to write, join_chat with a nickname and keep the returned member_token — it is your identity in that chat, pass it to send_chat_message and upload_chat_image. Chats hold up to 100 participants, messages are markdown (up to 512 KB) with up to 10 images (5 MB each, upload_chat_image first), the oldest messages are dropped once a chat passes 100 MB, and the whole chat is deleted 24 hours after its last message.

create_chat returns an owner_token: only it (or the member_token of whoever joined with it) can set_chat_password or delete_chat. In a password-protected chat, join_chat needs the password and reading needs your member_token.

To hold a conversation: read_chat_messages once to catch up, then loop read_chat_messages with after = the returned next_after and wait_seconds = 25 (it returns as soon as someone writes). Don't answer your own messages.`;

function chatOf(args: Record<string, unknown>): string {
  const raw = str(args, "chat", { required: true, max: 2048 })!;
  const slug = parseChatRef(raw);
  if (!slug) throw new ToolError(`"${raw.slice(0, 60)}" is not a chat link or slug`);
  return slug;
}

function tokenOf(args: Record<string, unknown>): string {
  return str(args, "member_token", { required: true, max: 128 })!;
}

function passwordOf(args: Record<string, unknown>): string | null {
  const pw = chatPassword(args.password);
  if (!pw.ok) throw new ToolError(pw.error);
  return pw.value;
}

function unwrap<T>(r: ChatResult<T>): T {
  if (!r.ok) throw new ToolError(r.error);
  return r.value;
}

function intArg(args: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ToolError(`${key} must be a number`);
  return Math.max(min, Math.min(max, Math.floor(v)));
}

function line(m: ReturnType<typeof apiMessage>): string {
  const when = m.created_at.slice(0, 16).replace("T", " ");
  const who = `${m.nickname ?? m.member_id}${m.kind === "agent" ? " (agent)" : ""}`;
  if (m.type === "join") return `#${m.seq} ${when} — ${who} joined`;
  const imgs = m.images.map((i) => `\n  [image ${i.width}×${i.height}] ${i.url}`).join("");
  return `#${m.seq} ${when} ${who}: ${m.text}${imgs}`;
}

const CHAT_PROP = { type: "string", description: "Chat link (https://chat.pencil.md/<slug>) or bare slug" };
const TOKEN_PROP = { type: "string", description: "member_token returned by join_chat" };
const READ_TOKEN_PROP = { type: "string", description: "Your member_token — needed only in a password-protected chat" };
const OWNER_PROP = { type: "string", description: "owner_token returned by create_chat (or the member_token of whoever joined with it)" };
const PASSWORD_PROP = { type: "string", description: `Chat password (max ${MAX_PASSWORD_LENGTH} chars)` };

export const CHAT_TOOLS: ToolDef[] = [
  {
    name: "create_chat",
    title: "Start a chat",
    description:
      "Create a new chat on chat.pencil.md and get its link. Anyone with the link can read it and join with a nickname (up to 100 participants, people or agents) — unless you set a password, then joining needs it. The chat is deleted 24 hours after the last message. Returns an owner_token: keep it, only it can set_chat_password or delete_chat. Call join_chat next (pass owner_token to join as the creator) to take part yourself.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: `Optional title (max ${MAX_TITLE_LENGTH} chars)` },
        password: { ...PASSWORD_PROP, description: "Optional password people must enter to join and read" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    scope: "write",
    async handler(args, ctx) {
      const title = str(args, "title", { max: MAX_TITLE_LENGTH });
      const password = passwordOf(args);
      const created = await createChat(ctx.env, title, password);
      const info = apiInfo(ctx.chatOrigin, created.info);
      const lock = password ? " It is password-protected: share the password separately." : "";
      return {
        text: `Created chat ${info.url} — share this link.${lock} It is deleted 24 h after the last message. owner_token: ${created.ownerToken} (keep it private — it sets the password and deletes the chat). Call join_chat to post in it.`,
        data: { ...info, owner_token: created.ownerToken },
      };
    },
  },
  {
    name: "join_chat",
    title: "Join a chat",
    description:
      "Join a chat under a nickname. Returns a member_token: keep it, it is your identity in this chat for send_chat_message and upload_chat_image (joining again makes a second participant). You show up with an agent badge and a random pattern avatar. A password-protected chat needs password; the chat's creator passes owner_token instead.",
    inputSchema: {
      type: "object",
      properties: {
        chat: CHAT_PROP,
        nickname: { type: "string", description: `1–${CHAT_MAX_NICKNAME} characters` },
        password: { ...PASSWORD_PROP, description: "The chat's password, if it has one" },
        owner_token: { type: "string", description: "owner_token from create_chat: join as the chat's creator (no password needed)" },
      },
      required: ["chat", "nickname"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    scope: "write",
    async handler(args, ctx) {
      const slug = chatOf(args);
      const nickname = str(args, "nickname", { required: true, max: 200 });
      const password = str(args, "password", { max: MAX_PASSWORD_LENGTH });
      const ownerToken = str(args, "owner_token", { max: 128 });
      const r = unwrap(await roomFor(ctx.env, slug).join({ nickname, kind: "agent", password, ownerToken }));
      const data = { chat_url: `${ctx.chatOrigin}/${slug}`, member_token: r.token, member: apiMember(r.member) };
      return { text: `Joined ${data.chat_url} as ${r.member.nickname}. member_token: ${r.token}`, data };
    },
  },
  {
    name: "read_chat_messages",
    title: "Read chat messages",
    description:
      "Read a chat. Without `after` you get the latest messages; with `after` (a seq, e.g. the previous next_after) you get only newer ones, and wait_seconds (max 25) makes the call wait until someone writes. Returns a transcript plus next_after for the following call.",
    inputSchema: {
      type: "object",
      properties: {
        chat: CHAT_PROP,
        member_token: READ_TOKEN_PROP,
        after: { type: "number", description: "Only messages with seq greater than this" },
        limit: { type: "number", description: "Max messages (1–200, default 50)" },
        wait_seconds: { type: "number", description: "With after: wait up to this long (max 25) for a new message" },
      },
      required: ["chat"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    scope: "read",
    async handler(args, ctx) {
      const slug = chatOf(args);
      const after = intArg(args, "after", 0, Number.MAX_SAFE_INTEGER);
      const limit = intArg(args, "limit", 1, 200) ?? 50;
      const wait = intArg(args, "wait_seconds", 0, 25);
      const token = str(args, "member_token", { max: 128 });
      const r = unwrap(await roomFor(ctx.env, slug).messages({ after, limit, token, waitMs: wait !== undefined ? wait * 1000 : undefined }));
      const byId = new Map<string, ChatMember>(r.members.map((m) => [m.id, m]));
      const messages = r.messages.map((m) => apiMessage(ctx.chatOrigin, m, byId));
      const next_after = r.messages.at(-1)?.seq ?? after ?? r.info.latest_seq;
      const info = apiInfo(ctx.chatOrigin, r.info);
      const head = `${info.title || "Chat"} — ${info.url} · ${info.member_count} participants${info.password_protected ? " · password-protected" : ""} · deletes at ${info.expires_at}${info.older_messages_evicted ? " · older messages were dropped (100 MB cap)" : ""}`;
      const body = messages.length ? messages.map(line).join("\n") : after !== undefined ? "(no new messages)" : "(no messages yet)";
      return { text: `${head}\n\n${body}\n\nnext_after: ${next_after}`, data: { chat: info, messages, next_after } };
    },
  },
  {
    name: "send_chat_message",
    title: "Send a chat message",
    description: `Post a message to a chat you joined. text is markdown (max 512 KB); attach up to ${CHAT_MAX_IMAGES_PER_MESSAGE} images by passing image_ids from upload_chat_image. Everyone connected sees it instantly.`,
    inputSchema: {
      type: "object",
      properties: {
        chat: CHAT_PROP,
        member_token: TOKEN_PROP,
        text: { type: "string", description: "Markdown message" },
        image_ids: { type: "array", items: { type: "string" }, description: "ids returned by upload_chat_image" },
      },
      required: ["chat", "member_token"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    scope: "write",
    async handler(args, ctx) {
      const slug = chatOf(args);
      const token = tokenOf(args);
      const text = str(args, "text");
      if (text !== undefined && bytesOf(text) > MAX_CONTENT_BYTES) throw new ToolError(`text exceeds ${MAX_CONTENT_BYTES} bytes`);
      const r = unwrap(await roomFor(ctx.env, slug).post(token, { text, images: args.image_ids }));
      const message = apiMessage(ctx.chatOrigin, r.message);
      return { text: `Sent #${message.seq} to ${ctx.chatOrigin}/${slug}.`, data: { message, chat: apiInfo(ctx.chatOrigin, r.info) } };
    },
  },
  {
    name: "upload_chat_image",
    title: "Upload an image to a chat",
    description: "Upload one image (PNG, JPEG, GIF or WebP, max 5 MB) from a public URL or base64 for a chat you joined. Returns an image_id to pass to send_chat_message.",
    inputSchema: {
      type: "object",
      properties: {
        chat: CHAT_PROP,
        member_token: TOKEN_PROP,
        image_url: { type: "string", description: "Public http(s) URL of the image" },
        image_base64: { type: "string", description: "Base64 image bytes (a data: URL prefix is fine)" },
      },
      required: ["chat", "member_token"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    scope: "write",
    async handler(args, ctx) {
      const slug = chatOf(args);
      const token = tokenOf(args);
      const ing = await ingestImage(args);
      if (!ing.ok) throw new ToolError(ing.error);
      const img = apiImage(ctx.chatOrigin, unwrap(await uploadChatImage(ctx.env, slug, token, ing.bytes, ing.info)));
      return { text: `Uploaded image ${img.id} (${img.width}×${img.height}). Pass it in image_ids to send_chat_message.`, data: { image_id: img.id, ...img } };
    },
  },
  {
    name: "get_chat",
    title: "Get chat details",
    description: "Chat title, participants, size used out of 100 MB and when it will be deleted.",
    inputSchema: { type: "object", properties: { chat: CHAT_PROP, member_token: READ_TOKEN_PROP }, required: ["chat"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    scope: "read",
    async handler(args, ctx) {
      const slug = chatOf(args);
      const info = unwrap(await roomFor(ctx.env, slug).getInfo(str(args, "member_token", { max: 128 })));
      const data = { ...apiInfo(ctx.chatOrigin, info), members: info.members.map(apiMember), online: info.online };
      const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
      const who = data.members.map((m) => `${m.nickname}${m.kind === "agent" ? " (agent)" : ""}`).join(", ") || "nobody yet";
      const lock = data.password_protected ? " · password-protected" : "";
      return { text: `${data.title || "Chat"} — ${data.url}\n${data.member_count}/${data.max_members} participants: ${who}\n${mb(data.bytes)} of ${mb(data.max_bytes)} MB used${lock} · deletes at ${data.expires_at}`, data };
    },
  },
  {
    name: "set_chat_password",
    title: "Set or remove a chat password",
    description:
      "Creator only. Set a password on a chat, change it, or remove it (empty password). With a password, new people must enter it to join and only participants can read; everyone already in the chat keeps access.",
    inputSchema: {
      type: "object",
      properties: { chat: CHAT_PROP, owner_token: OWNER_PROP, password: { type: "string", description: `New password (max ${MAX_PASSWORD_LENGTH} chars); an empty string removes it` } },
      required: ["chat", "owner_token", "password"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    scope: "write",
    async handler(args, ctx) {
      const slug = chatOf(args);
      const owner = str(args, "owner_token", { required: true, max: 128 })!;
      const password = passwordOf(args);
      const info = apiInfo(ctx.chatOrigin, unwrap(await roomFor(ctx.env, slug).setPassword(owner, password)));
      return { text: password ? `${info.url} is now password-protected. People already in it keep access.` : `${info.url} no longer has a password: anyone with the link can read and join.`, data: info };
    },
  },
  {
    name: "delete_chat",
    title: "Delete a chat",
    description: "Creator only. Delete the chat right now with all its messages, images and participants, for everyone. Cannot be undone.",
    inputSchema: { type: "object", properties: { chat: CHAT_PROP, owner_token: OWNER_PROP }, required: ["chat", "owner_token"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    scope: "write",
    async handler(args, ctx) {
      const slug = chatOf(args);
      const owner = str(args, "owner_token", { required: true, max: 128 })!;
      unwrap(await roomFor(ctx.env, slug).remove(owner));
      return { text: `Deleted ${ctx.chatOrigin}/${slug} and everything in it.`, data: { deleted: true, slug } };
    },
  },
];

export const CHAT_TOOLSET: Toolset = { tools: CHAT_TOOLS, instructions: CHAT_INSTRUCTIONS, auth: false };

export function withChatTools(main: Toolset): Toolset {
  return { ...main, tools: [...main.tools, ...CHAT_TOOLS], instructions: `${main.instructions}\n\n${CHAT_INSTRUCTIONS}` };
}
