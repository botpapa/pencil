export type Bindings = {
  DB: D1Database;
  OG_CACHE: R2Bucket;
  IMAGES: R2Bucket;
  ASSETS: Fetcher;
  COOKIE_SECRET: string;
  APP_NAME: string;
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
