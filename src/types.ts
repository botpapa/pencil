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
};

export const MAX_CONTENT_BYTES = 128 * 1024;
export const MAX_TITLE_LENGTH = 200;
