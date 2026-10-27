export type Bindings = {
  DB: D1Database;
  OG_CACHE: R2Bucket;
  IMAGES: R2Bucket;
  ASSETS: Fetcher;
  // chat.pencil.md: one Durable Object per chat room (src/chat/room.ts).
  CHAT: DurableObjectNamespace<import("./chat/room.js").ChatRoom>;
  COOKIE_SECRET: string;
  APP_NAME: string;
  // Optional: ChatGPT plugin directory domain-verification token, served at
  // /.well-known/openai-apps-challenge.
  OPENAI_APPS_CHALLENGE?: string;
  // Optional: hash of our (unapproved) Telegram Instant View template. When
  // set, pages get a t.me/iv?url=…&rhash=… link that opens as Instant View
  // without Telegram having approved the template. See docs/telegram-instant-view.md.
  TELEGRAM_IV_RHASH?: string;
  // Optional: "@channel" shown as a join button in Instant View pages.
  TELEGRAM_CHANNEL?: string;
};

export type Variables = {
  ownerId: string;
  isNewOwner: boolean;
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: Variables;
};

export type PageRow = {
  slug: string;
  title: string;
  content: string;
  owner_id: string;
  views: number;
  created_at: number;
  updated_at: number;
  indexable: number;
  // Self-describing PBKDF2 string (`pbkdf2$iters$salt$hash`), or null when the
  // page is public.
  password_hash: string | null;
};

// Summary row for the owner's pages list — no content/owner_id, plus a derived
// `protected` flag so the list can badge locked pages without leaking hashes.
export type PageSummary = {
  slug: string;
  title: string;
  views: number;
  created_at: number;
  updated_at: number;
  protected: number;
};

export const MAX_CONTENT_BYTES = 512 * 1024;
export const MAX_TITLE_LENGTH = 200;
export const MAX_PASSWORD_LENGTH = 128;

// ---------- draw.pencil.md ----------

export type DrawingRow = {
  slug: string;
  title: string;
  scene: string; // JSON
  thumb_key: string | null;
  owner_id: string;
  views: number;
  created_at: number;
  updated_at: number;
  password_hash: string | null;
};

export type DrawingSummary = {
  slug: string;
  title: string;
  views: number;
  created_at: number;
  updated_at: number;
  protected: number;
};

// Scene JSON cap (canvases are bigger than markdown; images live in R2, not
// inlined). Pasted images are capped separately.
export const MAX_SCENE_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

// ---------- chat.pencil.md ----------

// A message carries the same text budget as a page; images are uploaded one by
// one under the same 5 MB cap the editors use.
export const CHAT_MAX_MEMBERS = 100;
export const CHAT_MAX_BYTES = 100 * 1024 * 1024;
// A persistent chat never expires, so it gets a tenth of the space.
export const CHAT_PERSISTENT_MAX_BYTES = 10 * 1024 * 1024;
export const CHAT_TTL_MS = 24 * 60 * 60 * 1000;
export const CHAT_MAX_IMAGES_PER_MESSAGE = 10;
export const CHAT_MAX_NICKNAME = 32;
