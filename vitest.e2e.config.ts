import { defineConfig } from "vitest/config";

// Production e2e suite. Runs against the live deployment specified in
// E2E_BASE_URL (defaults to https://pencil.md). Uses plain fetch — no
// workerd pool, no cloudflare:test, no D1 emulation. Each run creates a
// handful of pages on the real D1 with titles prefixed "e2e:" so they
// can be cleaned out later via:
//
//   wrangler d1 execute pencil-md --remote \
//     --command "DELETE FROM pages WHERE title LIKE 'e2e:%'"

export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    sequence: { concurrent: false },
  },
});
