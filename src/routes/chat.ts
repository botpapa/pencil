// Routes for chat.pencil.md (mounted when the request host starts with "chat.").
//
//   GET  /                         landing: start a chat
//   POST /new                      form → create → 303 to the room
//   GET  /:slug                    the room (client: client/chat.ts)
//   GET  /:slug/ws                 WebSocket → the room's Durable Object
//   GET  /:slug/img/:name          chat images from R2
//   POST /api/chats                create (JSON)
//   GET  /api/chats/:slug          info + members
//   PATCH /api/chats/:slug         rename (Bearer member token)
//   POST /api/chats/:slug/join     pick a nickname → member token
//   GET  /api/chats/:slug/messages history / long-poll (?after=&wait=)
//   POST /api/chats/:slug/messages send (Bearer member token)
//   POST /api/chats/:slug/images   upload one image (Bearer member token)
//   POST /mcp                      MCP server with the chat tools, no auth
//
// Reading is public to anyone with the link, like pages; writing needs the
// member token handed out by join.

import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { rejectIfOversize } from "../lib/limits.js";
import { ingestImage } from "../lib/image.js";
import { isValidSlug } from "../lib/slug.js";
import { normalizeTitle } from "../lib/http.js";
import { chatLandingPage, chatRoomPage, chatNotFoundPage } from "../views/chat.js";
import { roomFor, createChat, uploadChatImage, apiInfo, apiMember, apiMessage, apiImage, chatOriginFor } from "../chat/service.js";
import mcp from "./mcp.js";
import { MAX_CONTENT_BYTES, MAX_IMAGE_BYTES } from "../types.js";
import type { AppEnv } from "../types.js";
import type { ChatErrorStatus, ChatMember } from "../chat/room.js";

const app = new Hono<AppEnv>();

// Same CSP as the rest of the site plus the room's own WebSocket origin
// (Safari doesn't treat wss: as covered by 'self').
app.use("*", async (c, next) => {
  await next();
  if (!(c.res.headers.get("Content-Type") ?? "").includes("text/html")) return;
  const u = new URL(c.req.url);
  const ws = `${u.protocol === "https:" ? "wss" : "ws"}://${u.host}`;
  c.res.headers.set(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' https: data: blob:; style-src 'self'; script-src 'self'; font-src 'self'; " +
      `connect-src 'self' ${ws}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`,
  );
});

app.use("/api/*", cors({ origin: "*", allowMethods: ["GET", "POST", "PATCH", "OPTIONS"], allowHeaders: ["Authorization", "Content-Type"], maxAge: 86400 }));

function chatOrigin(c: Context<AppEnv>): string {
  return chatOriginFor(new URL(c.req.url).origin);
}

function pencilOrigin(c: Context<AppEnv>): string {
  const u = new URL(c.req.url);
  return `${u.protocol}//${u.host.replace(/^chat\./, "")}`;
}

function bearer(c: Context<AppEnv>, body?: Record<string, unknown>): string {
  const m = /^Bearer\s+(\S+)$/i.exec(c.req.header("Authorization") ?? "");
  if (m) return m[1]!;
  return typeof body?.member_token === "string" ? body.member_token : "";
}

function err(c: Context<AppEnv>, status: ChatErrorStatus | 411, error: string) {
  return c.json({ error }, status);
}

async function readJson(c: Context<AppEnv>): Promise<Record<string, unknown> | null> {
  try {
    const v = await c.req.json();
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function intParam(v: string | undefined): number | undefined {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

// ---------- pages ----------

app.get("/", (c) => c.html(chatLandingPage({ pencilOrigin: pencilOrigin(c), chatOrigin: chatOrigin(c) })));

app.post("/new", async (c) => {
  const tooBig = rejectIfOversize(c, 16 * 1024, "text");
  if (tooBig) return tooBig;
  // Chats start untitled; participants name them from inside the room.
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const info = await createChat(c.env, (form as Record<string, unknown>).title);
  return c.redirect(`/${info.slug}`, 303);
});

// The docs live on the main host.
app.get("/api", (c) => c.redirect(`${pencilOrigin(c)}/api#chat`, 302));

// ---------- API ----------

app.post("/api/chats", async (c) => {
  const tooBig = rejectIfOversize(c, 16 * 1024);
  if (tooBig) return tooBig;
  const body = (await readJson(c)) ?? {};
  const info = await createChat(c.env, body.title);
  return c.json(apiInfo(chatOrigin(c), info), 201);
});

app.get("/api/chats/:slug", async (c) => {
  const slug = c.req.param("slug");
  if (!isValidSlug(slug)) return err(c, 404, "chat not found");
  const info = await roomFor(c.env, slug).getInfo();
  if (!info) return err(c, 404, "chat not found (it may have expired)");
  return c.json({ ...apiInfo(chatOrigin(c), info), members: info.members.map(apiMember), online: info.online });
});

app.patch("/api/chats/:slug", async (c) => {
  const slug = c.req.param("slug");
  if (!isValidSlug(slug)) return err(c, 404, "chat not found");
  const tooBig = rejectIfOversize(c, 4 * 1024);
  if (tooBig) return tooBig;
  const body = await readJson(c);
  if (!body) return err(c, 400, "invalid JSON");
  if (typeof body.title !== "string") return err(c, 400, "title must be a string");
  const r = await roomFor(c.env, slug).rename(bearer(c, body), normalizeTitle(body.title));
  if (!r.ok) return err(c, r.status, r.error);
  return c.json(apiInfo(chatOrigin(c), r.value));
});

app.post("/api/chats/:slug/join", async (c) => {
  const slug = c.req.param("slug");
  if (!isValidSlug(slug)) return err(c, 404, "chat not found");
  const tooBig = rejectIfOversize(c, 4 * 1024);
  if (tooBig) return tooBig;
  const body = await readJson(c);
  if (!body) return err(c, 400, "invalid JSON");
  const r = await roomFor(c.env, slug).join({ nickname: body.nickname, kind: body.kind, avatar: body.avatar });
  if (!r.ok) return err(c, r.status, r.error);
  return c.json({ member_token: r.value.token, member: apiMember(r.value.member) }, 201);
});

// Who does this member token belong to? (The client checks a remembered or
// hand-over token before trusting it.)
app.get("/api/chats/:slug/me", async (c) => {
  const slug = c.req.param("slug");
  if (!isValidSlug(slug)) return err(c, 404, "chat not found");
  const r = await roomFor(c.env, slug).whoami(bearer(c));
  if (!r.ok) return err(c, r.status, r.error);
  return c.json({ member: apiMember(r.value) });
});

app.get("/api/chats/:slug/messages", async (c) => {
  const slug = c.req.param("slug");
  if (!isValidSlug(slug)) return err(c, 404, "chat not found");
  const after = intParam(c.req.query("after"));
  const before = intParam(c.req.query("before"));
  const limit = intParam(c.req.query("limit"));
  const wait = intParam(c.req.query("wait"));
  const format = c.req.query("format") === "client" ? "client" : "api";
  const r = await roomFor(c.env, slug).messages({ after, before, limit, format, waitMs: wait !== undefined ? wait * 1000 : undefined });
  if (!r.ok) return err(c, r.status, r.error);
  const origin = chatOrigin(c);
  const byId = new Map<string, ChatMember>(r.value.members.map((m) => [m.id, m]));
  // `format=client` keeps the room's internal shape (paths + rendered HTML) for
  // the browser client; everyone else gets the documented API shape.
  if (format === "client") {
    return c.json({ messages: r.value.messages, members: r.value.members, info: r.value.info }, 200, { "Cache-Control": "no-store" });
  }
  const messages = r.value.messages.map((m) => apiMessage(origin, m, byId));
  const last = r.value.messages.at(-1)?.seq ?? after ?? r.value.info.latest_seq;
  return c.json({ chat: apiInfo(origin, r.value.info), messages, next_after: last }, 200, { "Cache-Control": "no-store" });
});

app.post("/api/chats/:slug/messages", async (c) => {
  const slug = c.req.param("slug");
  if (!isValidSlug(slug)) return err(c, 404, "chat not found");
  const tooBig = rejectIfOversize(c, MAX_CONTENT_BYTES * 2 + 16 * 1024);
  if (tooBig) return tooBig;
  const body = await readJson(c);
  if (!body) return err(c, 400, "invalid JSON");
  const format = c.req.query("format") === "client" ? "client" : "api";
  const r = await roomFor(c.env, slug).post(bearer(c, body), { text: body.text, images: body.images }, format);
  if (!r.ok) return err(c, r.status, r.error);
  const origin = chatOrigin(c);
  if (format === "client") return c.json({ message: r.value.message, info: r.value.info }, 201);
  return c.json({ message: apiMessage(origin, r.value.message), chat: apiInfo(origin, r.value.info) }, 201);
});

// One image per request: raw body with an image Content-Type, a multipart
// "image" file, or JSON {image_url | image_base64}.
app.post("/api/chats/:slug/images", async (c) => {
  const slug = c.req.param("slug");
  if (!isValidSlug(slug)) return err(c, 404, "chat not found");
  const tooBig = rejectIfOversize(c, Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 64 * 1024);
  if (tooBig) return tooBig;
  const ct = (c.req.header("Content-Type") ?? "").toLowerCase();
  let bytes: Uint8Array;
  let token = bearer(c);
  if (ct.startsWith("application/json")) {
    const body = await readJson(c);
    if (!body) return err(c, 400, "invalid JSON");
    token = bearer(c, body);
    const ing = await ingestImage(body);
    if (!ing.ok) return err(c, 400, ing.error);
    bytes = ing.bytes;
  } else if (ct.startsWith("multipart/form-data")) {
    const form = await c.req.parseBody().catch(() => null);
    const file = form?.image;
    if (!(file instanceof File)) return err(c, 400, 'multipart body needs an "image" file');
    bytes = new Uint8Array(await file.arrayBuffer());
  } else {
    bytes = new Uint8Array(await c.req.arrayBuffer());
  }
  if (bytes.byteLength === 0) return err(c, 400, "image is empty");
  if (bytes.byteLength > MAX_IMAGE_BYTES) return err(c, 413, "image exceeds 5 MB");
  const r = await uploadChatImage(c.env, slug, token, bytes);
  if (!r.ok) return err(c, r.status, r.error);
  return c.json({ ...apiImage(chatOrigin(c), r.value), path: r.value.path }, 201);
});

// ---------- MCP (no auth: the member token is the credential) ----------

app.route("/", mcp);

// ---------- room ----------

app.get("/:slug/ws", async (c) => {
  const slug = c.req.param("slug");
  if (!isValidSlug(slug)) return c.text("not found", 404);
  return roomFor(c.env, slug).fetch(c.req.raw);
});

app.get("/:slug/img/:name", async (c) => {
  const slug = c.req.param("slug");
  const name = c.req.param("name");
  if (!isValidSlug(slug) || !/^[A-Za-z0-9]{16}\.(png|jpg|gif|webp)$/.test(name)) return c.text("not found", 404);
  const obj = await c.env.IMAGES.get(`chat/${slug}/${name}`);
  if (!obj) return c.text("not found", 404);
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream",
      // Names are random and never reused; the room deletes them on expiry.
      "Cache-Control": "public, max-age=86400, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

app.get("/:slug", async (c) => {
  const slug = c.req.param("slug");
  if (!isValidSlug(slug)) return c.html(chatNotFoundPage(pencilOrigin(c)), 404);
  const info = await roomFor(c.env, slug).getInfo();
  if (!info) return c.html(chatNotFoundPage(pencilOrigin(c)), 404);
  return c.html(chatRoomPage({ slug, title: info.title, url: `${chatOrigin(c)}/${slug}`, pencilOrigin: pencilOrigin(c) }), 200, {
    "Cache-Control": "no-store",
  });
});

app.notFound((c) => {
  if (new URL(c.req.url).pathname.startsWith("/api")) return c.json({ error: "not found" }, 404);
  return c.html(chatNotFoundPage(pencilOrigin(c)), 404);
});

export default app;
