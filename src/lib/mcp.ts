// MCP server core for the pencil.md connector: JSON-RPC dispatch (dual-era:
// the stateless 2026-07-28 revision with per-request `_meta`, plus the legacy
// `initialize` handshake for 2025-xx clients) and the tool set.
//
// Transport-level concerns (HTTP method, headers, bearer auth) live in
// routes/mcp.ts; this module only sees parsed JSON-RPC messages.

import { getPage, updatePage, deletePage, listPagesByOwner, setPasswordHash, setIndexable } from "./db.js";
import { getDrawing, createDrawingWithUniqueSlug, updateDrawing, deleteDrawing, listDrawingsByOwner, setDrawingPassword } from "./drawdb.js";
import { createPageWithUniqueSlug, isValidSlug, newSlug } from "./slug.js";
import { hashPassword, verifyPassword } from "./password.js";
import { validateScene } from "./scene.js";
import { ingestImage, storeImage } from "./image.js";
import { issueLoginLink, hasScope, LOGIN_LINK_TTL_MS, type Principal } from "./oauth.js";
import { bytesOf, normalizeTitle } from "./http.js";
import { drawUrl } from "../views/layout.js";
import { MAX_CONTENT_BYTES, MAX_TITLE_LENGTH, MAX_PASSWORD_LENGTH, MAX_SCENE_BYTES } from "../types.js";
import type { Bindings } from "../types.js";

export const SERVER_INFO = { name: "pencil.md", version: "1.0.0" };
export const MODERN_VERSIONS = ["2026-07-28"] as const;
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];
export const PROTOCOL_VERSION_META = "io.modelcontextprotocol/protocolVersion";

export const INSTRUCTIONS = `pencil.md publishes markdown pages (pencil.md/<slug>) and infinite-canvas drawings (draw.pencil.md/<slug>) and returns shareable links. There are no accounts: everything you publish belongs to the user's pencil.md browser identity, so the user can also open "my pages" on pencil.md and edit by hand.

Workflow: create_page → share the returned url. To change it later, call update_page with the slug. Use list_pages / list_drawings to find things you or the user published earlier. Use upload_image to host an image, then reference the returned markdown_url in a page or the returned canvas_url in a drawing image element. Drawings have NO auto-layout: you place every element at absolute coordinates; text never wraps (insert \\n yourself); a '# heading' at fontSize F is about 1.9×F tall per line, '##' 1.5×, '###' 1.25×, with 1.5× line height. Keep pages under 512 KB and images under 5 MB. Pages are public to anyone with the link unless password-protected. When the user wants to edit agent-made pages on another device, call get_browser_login_link and give them the link.`;

// ---------- JSON-RPC types ----------

export type RpcId = string | number | null;
export type RpcRequest = { jsonrpc?: unknown; id?: RpcId; method?: unknown; params?: unknown };

export class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
    public httpStatus: number = 200,
  ) {
    super(message);
  }
}

export class ToolError extends Error {}

export type ToolContext = {
  env: Bindings;
  principal: Principal;
  origin: string; // https://pencil.md
  drawOrigin: string; // https://draw.pencil.md
  waitUntil: (p: Promise<unknown>) => void;
};

type JsonSchema = Record<string, unknown>;

type ToolDef = {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  scope: "read" | "write";
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<{ text: string; data?: Record<string, unknown> }>;
};

// ---------- argument helpers ----------

function str(args: Record<string, unknown>, key: string, opts: { required?: boolean; max?: number } = {}): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) {
    if (opts.required) throw new ToolError(`${key} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new ToolError(`${key} must be a string`);
  if (opts.max !== undefined && v.length > opts.max) throw new ToolError(`${key} exceeds ${opts.max} characters`);
  return v;
}

function bool(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new ToolError(`${key} must be true or false`);
  return v;
}

// Accept a bare slug or any pencil.md / draw.pencil.md URL for it.
function slugOf(args: Record<string, unknown>, key = "slug"): string {
  const raw = str(args, key, { required: true, max: 2048 })!.trim();
  let s = raw;
  if (/^https?:\/\//i.test(raw)) {
    try {
      s = new URL(raw).pathname.split("/").filter(Boolean)[0] ?? "";
    } catch {
      s = "";
    }
  }
  if (!isValidSlug(s)) throw new ToolError(`"${raw.slice(0, 60)}" is not a valid page slug or pencil.md URL`);
  return s;
}

function contentOf(args: Record<string, unknown>, key: string, required: boolean): string | undefined {
  const v = str(args, key, { required });
  if (v === undefined) return undefined;
  if (!v.trim()) throw new ToolError(`${key} must not be empty`);
  if (bytesOf(v) > MAX_CONTENT_BYTES) throw new ToolError(`${key} exceeds ${MAX_CONTENT_BYTES} bytes`);
  return v;
}

function passwordOf(args: Record<string, unknown>): string | undefined {
  const v = str(args, "password", { max: MAX_PASSWORD_LENGTH });
  return v === "" ? undefined : v;
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString();
}

// ---------- drawing elements ----------

const SHAPES = new Set(["rect", "ellipse", "line", "arrow"]);
const DASHES = new Set(["solid", "dashed", "dotted"]);
const HEX = /^#[0-9a-fA-F]{3,8}$/;

function num(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ToolError(`${what} must be a finite number`);
  return v;
}

// Normalise agent-supplied elements into the editor's scene format, filling
// defaults and ids so the canvas can load and edit the result.
function normaliseElements(raw: unknown, canvasPrefix: string): Record<string, unknown>[] {
  if (!Array.isArray(raw)) throw new ToolError("elements must be an array");
  if (raw.length > 5000) throw new ToolError("too many elements (max 5000)");
  return raw.map((el, i) => {
    if (!el || typeof el !== "object") throw new ToolError(`elements[${i}] must be an object`);
    const e = el as Record<string, unknown>;
    const id = typeof e.id === "string" && e.id ? e.id.slice(0, 32) : `${newSlug()}`;
    const color = typeof e.color === "string" && HEX.test(e.color) ? e.color : "#1A1714";
    const dash = typeof e.dash === "string" && DASHES.has(e.dash) ? e.dash : "solid";
    switch (e.type) {
      case "text": {
        const md = typeof e.md === "string" ? e.md : typeof e.text === "string" ? e.text : null;
        if (md === null) throw new ToolError(`elements[${i}] (text) needs "md"`);
        return { id, type: "text", x: num(e.x, `elements[${i}].x`), y: num(e.y, `elements[${i}].y`), md, color, fontSize: typeof e.fontSize === "number" ? Math.max(8, Math.min(200, e.fontSize)) : 20 };
      }
      case "shape": {
        if (typeof e.shape !== "string" || !SHAPES.has(e.shape)) throw new ToolError(`elements[${i}] (shape) needs shape = rect|ellipse|line|arrow`);
        return { id, type: "shape", shape: e.shape, x: num(e.x, `elements[${i}].x`), y: num(e.y, `elements[${i}].y`), w: num(e.w, `elements[${i}].w`), h: num(e.h, `elements[${i}].h`), color, width: typeof e.width === "number" ? e.width : 3, dash, fill: e.fill === true };
      }
      case "stroke": {
        if (!Array.isArray(e.points) || e.points.length < 2) throw new ToolError(`elements[${i}] (stroke) needs at least 2 points`);
        const points = e.points.map((p, j) => {
          if (!Array.isArray(p) || p.length !== 2) throw new ToolError(`elements[${i}].points[${j}] must be [x, y]`);
          return [num(p[0], "x"), num(p[1], "y")];
        });
        return { id, type: "stroke", points, color, width: typeof e.width === "number" ? e.width : 3, dash };
      }
      case "image": {
        let url = typeof e.url === "string" ? e.url : "";
        // Accept absolute https://draw.pencil.md/img/… or https://pencil.md/img/…; the scene stores the relative key.
        if (/^https?:\/\//i.test(url)) {
          try {
            const u = new URL(url);
            if (u.pathname.startsWith("/img/")) url = u.pathname;
          } catch {
            /* fall through — validateScene rejects */
          }
        }
        if (!url.startsWith("/img/")) throw new ToolError(`elements[${i}] (image) url must be an image uploaded via upload_image (${canvasPrefix}/img/…)`);
        return { id, type: "image", x: num(e.x, `elements[${i}].x`), y: num(e.y, `elements[${i}].y`), w: num(e.w, `elements[${i}].w`), h: num(e.h, `elements[${i}].h`), url };
      }
      default:
        throw new ToolError(`elements[${i}].type must be text, shape, stroke or image`);
    }
  });
}

function buildScene(elements: Record<string, unknown>[], viewport: unknown): string {
  let vp = { x: 0, y: 0, zoom: 1 };
  if (viewport && typeof viewport === "object") {
    const v = viewport as Record<string, unknown>;
    vp = { x: typeof v.x === "number" ? v.x : 0, y: typeof v.y === "number" ? v.y : 0, zoom: typeof v.zoom === "number" && v.zoom > 0 ? v.zoom : 1 };
  }
  const scene = JSON.stringify({ schemaVersion: 1, viewport: vp, elements });
  if (bytesOf(scene) > MAX_SCENE_BYTES) throw new ToolError(`scene exceeds ${MAX_SCENE_BYTES} bytes`);
  const v = validateScene(scene);
  if (!v.ok) throw new ToolError(v.error);
  return scene;
}

const ELEMENT_SCHEMA: JsonSchema = {
  type: "object",
  description:
    "One canvas element. type=text: {x,y,md,color?,fontSize?} (md is live markdown; no wrapping, use \\n). type=shape: {shape:rect|ellipse|line|arrow,x,y,w,h,color?,width?,dash?,fill?}. type=stroke: {points:[[x,y],…],color?,width?,dash?}. type=image: {x,y,w,h,url} where url comes from upload_image.",
  properties: {
    type: { type: "string", enum: ["text", "shape", "stroke", "image"] },
    id: { type: "string" },
    x: { type: "number" },
    y: { type: "number" },
    w: { type: "number" },
    h: { type: "number" },
    md: { type: "string" },
    fontSize: { type: "number" },
    shape: { type: "string", enum: ["rect", "ellipse", "line", "arrow"] },
    points: { type: "array", items: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 } },
    url: { type: "string" },
    color: { type: "string", description: "hex colour, e.g. #1A1714 (ink), #2B5C8A (blue), #B23A3A (red), #2E7D4F (green), #B8860B (amber)" },
    width: { type: "number" },
    dash: { type: "string", enum: ["solid", "dashed", "dotted"] },
    fill: { type: "boolean" },
  },
  required: ["type"],
};

const VIEWPORT_SCHEMA: JsonSchema = {
  type: "object",
  description: "How the drawing opens: pan offset and zoom. Default {x:0,y:0,zoom:1}.",
  properties: { x: { type: "number" }, y: { type: "number" }, zoom: { type: "number" } },
};

// ---------- tools ----------

function pageResult(ctx: ToolContext, slug: string, extra: Record<string, unknown> = {}) {
  return { slug, url: `${ctx.origin}/${slug}`, edit_url: `${ctx.origin}/${slug}/edit`, ...extra };
}
function drawingResult(ctx: ToolContext, slug: string, extra: Record<string, unknown> = {}) {
  return { slug, url: `${ctx.drawOrigin}/${slug}`, edit_url: `${ctx.drawOrigin}/${slug}/edit`, ...extra };
}

async function ownedPage(ctx: ToolContext, slug: string) {
  const page = await getPage(ctx.env.DB, slug);
  if (!page) throw new ToolError(`page ${slug} does not exist`);
  if (page.owner_id !== ctx.principal.owner_id) throw new ToolError(`page ${slug} belongs to someone else — only its owner can change it`);
  return page;
}
async function ownedDrawing(ctx: ToolContext, slug: string) {
  const d = await getDrawing(ctx.env.DB, slug);
  if (!d) throw new ToolError(`drawing ${slug} does not exist`);
  if (d.owner_id !== ctx.principal.owner_id) throw new ToolError(`drawing ${slug} belongs to someone else — only its owner can change it`);
  return d;
}

function bustOg(ctx: ToolContext, slug: string): void {
  ctx.waitUntil(ctx.env.OG_CACHE.delete(`og/${slug}.png`).catch(() => {}));
}

export const TOOLS: ToolDef[] = [
  {
    name: "create_page",
    title: "Publish a markdown page",
    description:
      "Publish markdown as a public page on pencil.md and get a shareable link. Supports GitHub-flavoured markdown, tables, task lists, footnotes, syntax-highlighted code, images (![alt](url)) and ```carousel fences containing image URLs for a swipeable gallery. Returns the url to share and the slug for later edits. Set password to restrict viewing.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: `Page title (max ${MAX_TITLE_LENGTH} chars). Optional but recommended.` },
        content: { type: "string", description: "Markdown body (max 512 KB)." },
        password: { type: "string", description: "Optional. If set, viewers must enter this password." },
      },
      required: ["content"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    scope: "write",
    async handler(args, ctx) {
      const title = normalizeTitle(str(args, "title", { max: MAX_TITLE_LENGTH }) ?? "");
      const content = contentOf(args, "content", true)!;
      const password = passwordOf(args);
      const { slug } = await createPageWithUniqueSlug(ctx.env.DB, {
        title,
        content,
        owner_id: ctx.principal.owner_id,
        password_hash: password ? await hashPassword(password) : null,
      });
      const data = pageResult(ctx, slug, { title, protected: Boolean(password) });
      return { text: `Published "${title || slug}" at ${data.url}${password ? " (password protected)" : ""}. Slug: ${slug}.`, data };
    },
  },
  {
    name: "get_page",
    title: "Read a page",
    description: "Fetch a pencil.md page's title and markdown by slug or URL. Works for any public page; for a password-protected page you must own it or pass the password.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "8-character slug or full pencil.md URL." },
        password: { type: "string", description: "Password for a protected page you don't own." },
      },
      required: ["slug"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    scope: "read",
    async handler(args, ctx) {
      const slug = slugOf(args);
      const page = await getPage(ctx.env.DB, slug);
      if (!page) throw new ToolError(`page ${slug} does not exist`);
      const mine = page.owner_id === ctx.principal.owner_id;
      if (page.password_hash != null && !mine) {
        const pw = passwordOf(args);
        if (!pw || !(await verifyPassword(pw, page.password_hash))) throw new ToolError(`page ${slug} is password protected — pass the correct password`);
      }
      const data = pageResult(ctx, slug, {
        title: page.title,
        content: page.content,
        owned_by_you: mine,
        protected: page.password_hash != null,
        views: page.views,
        created_at: fmtDate(page.created_at),
        updated_at: fmtDate(page.updated_at),
      });
      return { text: `# ${page.title || "(untitled)"}\n(${data.url}${mine ? ", yours" : ""})\n\n${page.content}`, data };
    },
  },
  {
    name: "update_page",
    title: "Edit a page",
    description: "Replace the title and/or markdown of a page you published. Pass the full new content (not a diff). The URL stays the same.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "8-character slug or full pencil.md URL." },
        title: { type: "string" },
        content: { type: "string", description: "Full replacement markdown." },
      },
      required: ["slug"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    scope: "write",
    async handler(args, ctx) {
      const slug = slugOf(args);
      await ownedPage(ctx, slug);
      const patch: { title?: string; content?: string } = {};
      const title = str(args, "title", { max: MAX_TITLE_LENGTH });
      if (title !== undefined) patch.title = normalizeTitle(title);
      const content = contentOf(args, "content", false);
      if (content !== undefined) patch.content = content;
      if (patch.title === undefined && patch.content === undefined) throw new ToolError("pass title and/or content");
      const updatedAt = await updatePage(ctx.env.DB, slug, patch);
      bustOg(ctx, slug);
      const data = pageResult(ctx, slug, { updated_at: fmtDate(updatedAt) });
      return { text: `Updated ${data.url}.`, data };
    },
  },
  {
    name: "list_pages",
    title: "List my pages",
    description: "List the markdown pages owned by the connected user, newest first, with URLs, view counts and protection status.",
    inputSchema: { type: "object", additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    scope: "read",
    async handler(_args, ctx) {
      const rows = await listPagesByOwner(ctx.env.DB, ctx.principal.owner_id);
      const pages = rows.map((r) => ({ slug: r.slug, title: r.title, url: `${ctx.origin}/${r.slug}`, edit_url: `${ctx.origin}/${r.slug}/edit`, views: r.views, protected: Boolean(r.protected), created_at: fmtDate(r.created_at), updated_at: fmtDate(r.updated_at) }));
      const text = pages.length === 0 ? "No pages yet." : pages.map((p) => `- ${p.title || "(untitled)"} — ${p.url}${p.protected ? " 🔒" : ""} (${p.views} views, updated ${p.updated_at.slice(0, 10)})`).join("\n");
      return { text, data: { pages } };
    },
  },
  {
    name: "set_page_options",
    title: "Change page options",
    description: "Set or remove a page's password, or allow/disallow search-engine indexing (pages are noindex by default).",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        password: { type: "string", description: "New password. Omit to leave unchanged." },
        remove_password: { type: "boolean", description: "true to make the page public again." },
        indexable: { type: "boolean", description: "true to let search engines index the page." },
      },
      required: ["slug"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    scope: "write",
    async handler(args, ctx) {
      const slug = slugOf(args);
      await ownedPage(ctx, slug);
      const changes: string[] = [];
      if (bool(args, "remove_password")) {
        await setPasswordHash(ctx.env.DB, slug, null);
        changes.push("password removed");
      } else {
        const pw = passwordOf(args);
        if (pw) {
          await setPasswordHash(ctx.env.DB, slug, await hashPassword(pw));
          changes.push("password set");
        }
      }
      const idx = bool(args, "indexable");
      if (idx !== undefined) {
        await setIndexable(ctx.env.DB, slug, idx ? 1 : 0);
        changes.push(idx ? "indexing allowed" : "indexing disallowed");
      }
      if (changes.length === 0) throw new ToolError("nothing to change: pass password, remove_password or indexable");
      bustOg(ctx, slug);
      const page = await getPage(ctx.env.DB, slug);
      const data = pageResult(ctx, slug, { protected: page?.password_hash != null, indexable: page?.indexable === 1 });
      return { text: `${data.url}: ${changes.join(", ")}.`, data };
    },
  },
  {
    name: "delete_page",
    title: "Delete a page",
    description: "Permanently delete a page you published. This cannot be undone.",
    inputSchema: { type: "object", properties: { slug: { type: "string" } }, required: ["slug"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    scope: "write",
    async handler(args, ctx) {
      const slug = slugOf(args);
      await ownedPage(ctx, slug);
      await deletePage(ctx.env.DB, slug);
      bustOg(ctx, slug);
      return { text: `Deleted page ${slug}.`, data: { slug, deleted: true } };
    },
  },
  {
    name: "upload_image",
    title: "Upload an image",
    description:
      "Host an image on pencil.md from a URL or base64 data (PNG, JPEG, GIF or WebP, max 5 MB). Returns markdown_url to embed in a page as ![alt](markdown_url), canvas_url to use as the url of a drawing image element, and the pixel width/height so you can size the element.",
    inputSchema: {
      type: "object",
      properties: {
        image_url: { type: "string", description: "Public http(s) URL of the image to copy." },
        image_base64: { type: "string", description: "Base64 (or data: URL) of the image bytes. Use instead of image_url." },
        alt: { type: "string", description: "Optional alt text, echoed back in a ready-made markdown snippet." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    scope: "write",
    async handler(args, ctx) {
      const got = await ingestImage({ image_url: args.image_url, image_base64: args.image_base64 });
      if (!got.ok) throw new ToolError(got.error);
      const { name } = await storeImage(ctx.env.IMAGES, ctx.principal.owner_id, got.bytes, got.info);
      const alt = (str(args, "alt", { max: 200 }) ?? "").replace(/[\[\]]/g, "");
      const markdown_url = `${ctx.origin}/img/${name}`;
      const canvas_url = `/img/${name}`;
      const data = { markdown_url, canvas_url, width: got.info.width, height: got.info.height, mime: got.info.mime, bytes: got.bytes.byteLength, markdown: `![${alt}](${markdown_url})` };
      return { text: `Uploaded ${got.info.mime} ${got.info.width}×${got.info.height}. Markdown: ![${alt}](${markdown_url}). Canvas element url: ${canvas_url}.`, data };
    },
  },
  {
    name: "create_drawing",
    title: "Publish a drawing",
    description:
      "Create a drawing on the infinite canvas at draw.pencil.md from a list of elements (live-markdown text, rect/ellipse/line/arrow shapes, freehand strokes, uploaded images) and get a shareable link. There is no auto-layout: you choose absolute x/y for everything; later elements paint on top. Text does not wrap — break lines with \\n. A '# heading' at fontSize 40 is ≈114 px tall per line.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        elements: { type: "array", items: ELEMENT_SCHEMA },
        viewport: VIEWPORT_SCHEMA,
        password: { type: "string", description: "Optional viewer password." },
      },
      required: ["elements"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    scope: "write",
    async handler(args, ctx) {
      const title = normalizeTitle(str(args, "title", { max: MAX_TITLE_LENGTH }) ?? "");
      const elements = normaliseElements(args.elements, ctx.drawOrigin);
      const scene = buildScene(elements, args.viewport);
      const password = passwordOf(args);
      const { slug } = await createDrawingWithUniqueSlug(ctx.env.DB, {
        title,
        scene,
        thumb_key: null,
        owner_id: ctx.principal.owner_id,
        password_hash: password ? await hashPassword(password) : null,
      });
      const data = drawingResult(ctx, slug, { title, element_count: elements.length, protected: Boolean(password) });
      return { text: `Published drawing "${title || slug}" at ${data.url} (${elements.length} elements). Slug: ${slug}.`, data };
    },
  },
  {
    name: "get_drawing",
    title: "Read a drawing",
    description: "Fetch a drawing's title, elements and viewport by slug or URL.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string" }, password: { type: "string", description: "Password for a protected drawing you don't own." } },
      required: ["slug"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    scope: "read",
    async handler(args, ctx) {
      const slug = slugOf(args);
      const d = await getDrawing(ctx.env.DB, slug);
      if (!d) throw new ToolError(`drawing ${slug} does not exist`);
      const mine = d.owner_id === ctx.principal.owner_id;
      if (d.password_hash != null && !mine) {
        const pw = passwordOf(args);
        if (!pw || !(await verifyPassword(pw, d.password_hash))) throw new ToolError(`drawing ${slug} is password protected — pass the correct password`);
      }
      let scene: { elements?: unknown; viewport?: unknown } = {};
      try {
        scene = JSON.parse(d.scene) as typeof scene;
      } catch {
        /* unreadable scene — return empty */
      }
      const elements = Array.isArray(scene.elements) ? scene.elements : [];
      const viewport = scene.viewport ?? { x: 0, y: 0, zoom: 1 };
      const data = drawingResult(ctx, slug, { title: d.title, elements, viewport, owned_by_you: mine, protected: d.password_hash != null, views: d.views, updated_at: fmtDate(d.updated_at) });
      return { text: `Drawing "${d.title || slug}" (${data.url}): ${elements.length} elements.\n${JSON.stringify({ elements, viewport })}`, data };
    },
  },
  {
    name: "update_drawing",
    title: "Edit a drawing",
    description: "Change a drawing you published: replace all elements, append elements to the existing ones, rename it, or change the viewport. Read it first with get_drawing if you need existing element positions.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        title: { type: "string" },
        elements: { type: "array", items: ELEMENT_SCHEMA, description: "Full replacement list of elements." },
        append_elements: { type: "array", items: ELEMENT_SCHEMA, description: "Elements to add on top of the existing ones (ignored if elements is given)." },
        viewport: VIEWPORT_SCHEMA,
      },
      required: ["slug"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    scope: "write",
    async handler(args, ctx) {
      const slug = slugOf(args);
      const d = await ownedDrawing(ctx, slug);
      const patch: { title?: string; scene?: string; thumb_key?: string | null } = {};
      const title = str(args, "title", { max: MAX_TITLE_LENGTH });
      if (title !== undefined) patch.title = normalizeTitle(title);
      let current: { elements?: unknown[]; viewport?: unknown } = {};
      try {
        current = JSON.parse(d.scene) as typeof current;
      } catch {
        current = {};
      }
      let elements: Record<string, unknown>[] | null = null;
      if (args.elements !== undefined) elements = normaliseElements(args.elements, ctx.drawOrigin);
      else if (args.append_elements !== undefined) elements = [...((current.elements ?? []) as Record<string, unknown>[]), ...normaliseElements(args.append_elements, ctx.drawOrigin)];
      if (elements !== null || args.viewport !== undefined) {
        patch.scene = buildScene(elements ?? ((current.elements ?? []) as Record<string, unknown>[]), args.viewport ?? current.viewport);
        // The share thumbnail was rendered from the old scene; drop it rather than lie.
        if (d.thumb_key) {
          ctx.waitUntil(ctx.env.IMAGES.delete(d.thumb_key).catch(() => {}));
          patch.thumb_key = null;
        }
      }
      if (Object.keys(patch).length === 0) throw new ToolError("pass title, elements, append_elements or viewport");
      const updatedAt = await updateDrawing(ctx.env.DB, slug, patch);
      const data = drawingResult(ctx, slug, { updated_at: fmtDate(updatedAt), element_count: elements ? elements.length : (current.elements ?? []).length });
      return { text: `Updated drawing ${data.url}.`, data };
    },
  },
  {
    name: "list_drawings",
    title: "List my drawings",
    description: "List the drawings owned by the connected user, newest first.",
    inputSchema: { type: "object", additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    scope: "read",
    async handler(_args, ctx) {
      const rows = await listDrawingsByOwner(ctx.env.DB, ctx.principal.owner_id);
      const drawings = rows.map((r) => ({ slug: r.slug, title: r.title, url: `${ctx.drawOrigin}/${r.slug}`, edit_url: `${ctx.drawOrigin}/${r.slug}/edit`, views: r.views, protected: Boolean(r.protected), created_at: fmtDate(r.created_at), updated_at: fmtDate(r.updated_at) }));
      const text = drawings.length === 0 ? "No drawings yet." : drawings.map((p) => `- ${p.title || "(untitled)"} — ${p.url}${p.protected ? " 🔒" : ""} (${p.views} views)`).join("\n");
      return { text, data: { drawings } };
    },
  },
  {
    name: "set_drawing_options",
    title: "Change drawing options",
    description: "Set or remove a drawing's viewer password.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string" }, password: { type: "string" }, remove_password: { type: "boolean" } },
      required: ["slug"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    scope: "write",
    async handler(args, ctx) {
      const slug = slugOf(args);
      await ownedDrawing(ctx, slug);
      if (bool(args, "remove_password")) {
        await setDrawingPassword(ctx.env.DB, slug, null);
        return { text: `${ctx.drawOrigin}/${slug}: password removed.`, data: drawingResult(ctx, slug, { protected: false }) };
      }
      const pw = passwordOf(args);
      if (!pw) throw new ToolError("pass password or remove_password");
      await setDrawingPassword(ctx.env.DB, slug, await hashPassword(pw));
      return { text: `${ctx.drawOrigin}/${slug}: password set.`, data: drawingResult(ctx, slug, { protected: true }) };
    },
  },
  {
    name: "delete_drawing",
    title: "Delete a drawing",
    description: "Permanently delete a drawing you published. This cannot be undone.",
    inputSchema: { type: "object", properties: { slug: { type: "string" } }, required: ["slug"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    scope: "write",
    async handler(args, ctx) {
      const slug = slugOf(args);
      const d = await ownedDrawing(ctx, slug);
      await deleteDrawing(ctx.env.DB, slug);
      if (d.thumb_key) ctx.waitUntil(ctx.env.IMAGES.delete(d.thumb_key).catch(() => {}));
      return { text: `Deleted drawing ${slug}.`, data: { slug, deleted: true } };
    },
  },
  {
    name: "get_browser_login_link",
    title: "Get a browser sign-in link",
    description:
      "Mint a one-time link (valid 15 minutes) that signs whichever browser opens it in as the connected user's pencil.md identity, so they can edit pages and drawings published here from any device. Give the link to the user; do not open it yourself.",
    inputSchema: { type: "object", additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    scope: "write",
    async handler(_args, ctx) {
      const code = await issueLoginLink(ctx.env.DB, ctx.principal.owner_id);
      const url = `${ctx.origin}/connect/claim/${code}`;
      return { text: `Open this link in the browser you want to sign in (one use, expires in ${LOGIN_LINK_TTL_MS / 60000} minutes): ${url}`, data: { url, expires_in_seconds: LOGIN_LINK_TTL_MS / 1000 } };
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function toolList(): Record<string, unknown>[] {
  return TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: { title: t.title, ...t.annotations },
    securitySchemes: [{ type: "oauth2", scopes: [t.scope] }],
    _meta: {
      securitySchemes: [{ type: "oauth2", scopes: [t.scope] }],
      "openai/toolInvocation/invoking": t.annotations.readOnlyHint ? "Reading from pencil.md…" : "Working in pencil.md…",
      "openai/toolInvocation/invoked": t.annotations.readOnlyHint ? "Read from pencil.md" : "Done in pencil.md",
    },
  }));
}

export async function callTool(name: unknown, args: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
  const tool = typeof name === "string" ? TOOL_BY_NAME.get(name) : undefined;
  if (!tool) throw new RpcError(-32602, `Unknown tool: ${String(name).slice(0, 64)}`);
  const a = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  if (!hasScope(ctx.principal.scope, tool.scope)) {
    return {
      content: [{ type: "text", text: `This connection was authorised without the "${tool.scope}" scope. Reconnect pencil.md to grant it.` }],
      isError: true,
      _meta: { "mcp/www_authenticate": [`Bearer resource_metadata="${ctx.origin}/.well-known/oauth-protected-resource/mcp", error="insufficient_scope", scope="${tool.scope}"`] },
    };
  }
  try {
    const r = await tool.handler(a, ctx);
    return { content: [{ type: "text", text: r.text }], ...(r.data ? { structuredContent: r.data } : {}), isError: false };
  } catch (err) {
    if (err instanceof ToolError) return { content: [{ type: "text", text: err.message }], isError: true };
    throw err;
  }
}

// ---------- dispatch ----------

export const CAPABILITIES = { tools: { listChanged: false } };

export type Dispatch =
  | { kind: "result"; result: Record<string, unknown> }
  | { kind: "notification" };

export async function dispatch(
  method: string,
  params: Record<string, unknown>,
  ctx: ToolContext,
  era: "modern" | "legacy",
  legacyVersion: string,
): Promise<Record<string, unknown>> {
  const modern = era === "modern";
  switch (method) {
    case "server/discover":
      if (!modern) throw new RpcError(-32601, "Method not found", undefined, 404);
      return {
        resultType: "complete",
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: CAPABILITIES,
        _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO },
        instructions: INSTRUCTIONS,
        ttlMs: 3_600_000,
        cacheScope: "public",
      };
    case "initialize":
      if (modern) throw new RpcError(-32601, "Method not found", undefined, 404);
      return { protocolVersion: legacyVersion, capabilities: CAPABILITIES, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS };
    case "ping":
      return modern ? { resultType: "complete" } : {};
    case "tools/list":
      return modern ? { resultType: "complete", tools: toolList(), ttlMs: 300_000, cacheScope: "public" } : { tools: toolList() };
    case "tools/call": {
      const r = await callTool(params.name, params.arguments, ctx);
      return modern ? { resultType: "complete", ...r } : r;
    }
    case "prompts/list":
      return modern ? { resultType: "complete", prompts: [], ttlMs: 3_600_000, cacheScope: "public" } : { prompts: [] };
    case "resources/list":
      return modern ? { resultType: "complete", resources: [], ttlMs: 3_600_000, cacheScope: "public" } : { resources: [] };
    case "resources/templates/list":
      return modern ? { resultType: "complete", resourceTemplates: [], ttlMs: 3_600_000, cacheScope: "public" } : { resourceTemplates: [] };
    default:
      throw new RpcError(-32601, `Method not found: ${method.slice(0, 64)}`, undefined, modern ? 404 : 200);
  }
}

export function drawOriginFor(origin: string): string {
  try {
    return drawUrl(new URL(origin).host);
  } catch {
    return "https://draw.pencil.md";
  }
}
