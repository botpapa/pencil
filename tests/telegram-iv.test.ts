import { describe, it, expect } from "vitest";
import {
  SELF,
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import app from "../src/index.js";
import { telegramIvUrl } from "../src/lib/http.js";

// Same worker, but with the IV hash configured — bindings in vitest config are
// shared, so we call the app directly with a patched env instead.
const ivEnv = { ...env, TELEGRAM_IV_RHASH: "deadbeef0123" };
async function ivFetch(url: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(url, init), ivEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("telegramIvUrl", () => {
  it("builds the t.me/iv link from a hash", () => {
    expect(telegramIvUrl("https://pencil.md/abcdefgh", "a1b2c3d4e5f6")).toBe(
      "https://t.me/iv?url=https%3A%2F%2Fpencil.md%2Fabcdefgh&rhash=a1b2c3d4e5f6",
    );
  });
  it("returns null for missing or malformed hashes", () => {
    expect(telegramIvUrl("https://pencil.md/x", undefined)).toBeNull();
    expect(telegramIvUrl("https://pencil.md/x", "")).toBeNull();
    expect(telegramIvUrl("https://pencil.md/x", "not a hash!")).toBeNull();
  });
});

describe("/:slug/tg with TELEGRAM_IV_RHASH", () => {
  it("redirects public pages and 404s protected ones", async () => {
    const pub = await SELF.fetch("https://x/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "IV", content: "# hi" }),
    });
    const { slug } = (await pub.json()) as { slug: string };
    const res = await ivFetch(`https://x/${slug}/tg`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      `https://t.me/iv?url=https%3A%2F%2Fx%2F${slug}&rhash=deadbeef0123`,
    );

    const setCookie = pub.headers.get("Set-Cookie") ?? "";
    const m = /pencil_uid=([^;]+)/.exec(setCookie);
    const cookie = `pencil_uid=${m![1]}`;
    const stats = await ivFetch(`https://x/${slug}/stats`, {
      headers: { Cookie: cookie },
    });
    expect(await stats.text()).toContain("rhash=deadbeef0123");

    const form = new URLSearchParams({ password: "secret" });
    const lock = await SELF.fetch(`https://x/${slug}/settings/password`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
      redirect: "manual",
    });
    expect(lock.status).toBe(303);
    const locked = await ivFetch(`https://x/${slug}/tg`, {
      redirect: "manual",
    });
    expect(locked.status).toBe(404);
  });
});
