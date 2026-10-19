import { applyD1Migrations, env } from "cloudflare:test";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    OG_CACHE: R2Bucket;
    ASSETS: Fetcher;
    IMAGES: R2Bucket;
    CHAT: DurableObjectNamespace<import("../src/chat/room.js").ChatRoom>;
    COOKIE_SECRET: string;
    APP_NAME: string;
    TEST_MIGRATIONS: D1Migration[];
  }
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
