import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    test: {
      setupFiles: ["./tests/setup.ts"],
      // The opt-in production suite under tests/e2e/** uses plain fetch and
      // its own config (`vitest.e2e.config.ts`); keep it out of `npm test`.
      exclude: ["**/node_modules/**", "**/dist/**", "tests/e2e/**"],
      poolOptions: {
        workers: {
          isolatedStorage: true,
          singleWorker: true,
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            bindings: {
              COOKIE_SECRET: "test-cookie-secret-not-for-production-use-only",
              APP_NAME: "pencil.md",
              TEST_MIGRATIONS: migrations,
            },
          },
        },
      },
    },
  };
});
