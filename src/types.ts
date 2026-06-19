export type Bindings = {
  DB: D1Database;
  OG_CACHE: R2Bucket;
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
