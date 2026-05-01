import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

// Pull the pencil_uid Set-Cookie value off a response and re-emit it as a
// Cookie header for follow-up requests, so we can simulate "the same browser".
function extractUidCookie(res: Response): string | null {
  const set = res.headers.get("Set-Cookie") ?? "";
  const m = /pencil_uid=([^;]+)/.exec(set);
  return m ? `pencil_uid=${m[1]}` : null;
}

describe("public API", () => {
  it("creates, reads, updates a page using the cookie owner", async () => {
    const create = await SELF.fetch("https://x/api/v1/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Hello", content: "# hi\n\nbody" }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      slug: string;
      url: string;
      edit_url: string;
      edit_token?: string;
    };
    expect(created.slug).toMatch(/^[A-Za-z0-9]{8}$/);
    expect(created.url).toContain(`/${created.slug}`);
    expect(created.edit_url).toContain(`/${created.slug}/edit`);
    // The signed cookie value is also surfaced in the JSON for stateless
    // clients that can't (or don't want to) maintain a cookie jar.
    expect(typeof created.edit_token).toBe("string");

    const cookie = extractUidCookie(create);
    expect(cookie).not.toBeNull();

    const read = await SELF.fetch(`https://x/api/v1/pages/${created.slug}`);
    expect(read.status).toBe(200);
    const got = (await read.json()) as {
      slug: string;
      title: string;
      content: string;
      views: number;
    };
    expect(got.slug).toBe(created.slug);
    expect(got.title).toBe("Hello");
    expect(got.content).toBe("# hi\n\nbody");
    expect(got.views).toBe(0);

    // Replay the cookie to update.
    const update = await SELF.fetch(`https://x/api/v1/pages/${created.slug}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie!,
      },
      body: JSON.stringify({ content: "# updated" }),
    });
    expect(update.status).toBe(200);
    const updated = (await update.json()) as { slug: string; updated_at: number };
    expect(updated.slug).toBe(created.slug);
    expect(typeof updated.updated_at).toBe("number");

    const reread = await SELF.fetch(`https://x/api/v1/pages/${created.slug}`);
    const got2 = (await reread.json()) as { content: string };
    expect(got2.content).toBe("# updated");
  });

  it("rejects PUT from a different browser cookie", async () => {
    const c = await SELF.fetch("https://x/api/v1/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x", content: "body" }),
    });
    const created = (await c.json()) as { slug: string };
    // Fresh cookie-less request → server mints a different uid → owner mismatch → 403.
    const r = await SELF.fetch(`https://x/api/v1/pages/${created.slug}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "nope" }),
    });
    expect(r.status).toBe(403);
  });

  it("rejects PUT with a tampered cookie", async () => {
    const c = await SELF.fetch("https://x/api/v1/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x", content: "body" }),
    });
    const created = (await c.json()) as { slug: string };
    const cookie = extractUidCookie(c) ?? "";
    // Garble the signature → verifyCookie returns null → fresh uid → mismatch.
    const tampered = cookie.replace(/.$/, (ch) => (ch === "A" ? "B" : "A"));
    const r = await SELF.fetch(`https://x/api/v1/pages/${created.slug}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: tampered,
      },
      body: JSON.stringify({ content: "nope" }),
    });
    expect(r.status).toBe(403);
  });

  it("POST /api/v1/pages returns an edit_token (signed cookie value)", async () => {
    const r = await SELF.fetch("https://x/api/v1/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x", content: "body" }),
    });
    expect(r.status).toBe(201);
    const j = (await r.json()) as { edit_token?: string };
    expect(typeof j.edit_token).toBe("string");
    expect(j.edit_token!.split(".").length).toBe(2); // <uid>.<hmac>
  });

  it("PUT /api/v1/pages/:slug accepts edit_token in body (no cookie needed)", async () => {
    // Create with browser A
    const c = await SELF.fetch("https://x/api/v1/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x", content: "body" }),
    });
    const { slug, edit_token } = (await c.json()) as { slug: string; edit_token: string };

    // Update from a "fresh" client with no cookie at all, body-only credential.
    const r = await SELF.fetch(`https://x/api/v1/pages/${slug}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edit_token, content: "updated" }),
    });
    expect(r.status).toBe(200);
    const after = await SELF.fetch(`https://x/api/v1/pages/${slug}`);
    expect(((await after.json()) as { content: string }).content).toBe("updated");
  });

  it("PUT rejects bogus edit_token in body", async () => {
    const c = await SELF.fetch("https://x/api/v1/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x", content: "body" }),
    });
    const { slug } = (await c.json()) as { slug: string };
    const r = await SELF.fetch(`https://x/api/v1/pages/${slug}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edit_token: "not.a-real-token", content: "x" }),
    });
    expect(r.status).toBe(403);
  });

  it("rejects oversize content (413)", async () => {
    const big = "a".repeat(129 * 1024);
    const r = await SELF.fetch("https://x/api/v1/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "big", content: big }),
    });
    expect(r.status).toBe(413);
  });

  it("rejects oversize POST via Content-Length header before parsing", async () => {
    // 200 KB raw body; the Content-Length gate should reject without ever
    // calling c.req.json(). We verify by sending malformed JSON: if the gate
    // worked, we get 413 (size error); if it didn't, we'd get 400 (parse).
    const big = "a".repeat(200 * 1024);
    const r = await SELF.fetch("https://x/api/v1/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: big, // not JSON — would parse-fail if we got that far
    });
    expect(r.status).toBe(413);
  });

  it("rejects oversize PUT via Content-Length gate", async () => {
    const c = await SELF.fetch("https://x/api/v1/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x", content: "body" }),
    });
    const { slug, edit_token } = (await c.json()) as { slug: string; edit_token: string };
    const big = "a".repeat(200 * 1024);
    const r = await SELF.fetch(`https://x/api/v1/pages/${slug}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edit_token, content: big }),
    });
    expect(r.status).toBe(413);
  });

  it("rejects non-string content", async () => {
    const r = await SELF.fetch("https://x/api/v1/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x" }),
    });
    expect(r.status).toBe(400);
  });

  it("returns 404 for missing slug", async () => {
    const r = await SELF.fetch("https://x/api/v1/pages/aaaaaaaa");
    expect(r.status).toBe(404);
  });

  it("returns 404 for invalid slug shape", async () => {
    const r = await SELF.fetch("https://x/api/v1/pages/!!!");
    expect(r.status).toBe(404);
  });

  it("API docs page renders with the request origin in URLs", async () => {
    const r = await SELF.fetch("https://example.test/api");
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("https://example.test/api/v1");
    expect(html).not.toContain("YOUR-DEPLOYMENT");
  });

  it("CORS allows cross-origin", async () => {
    const r = await SELF.fetch("https://x/api/v1/pages/aaaaaaaa", {
      method: "OPTIONS",
      headers: {
        Origin: "https://other.example",
        "Access-Control-Request-Method": "GET",
      },
    });
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("browser routes", () => {
  it("GET / returns the home page", async () => {
    const r = await SELF.fetch("https://x/");
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toMatch(/text\/html/);
    const t = await r.text();
    // Distraction-free editor: home page is the empty editor (no hero, no topbar).
    expect(t).not.toContain("write something worth keeping");
    expect(t).not.toContain('class="topbar"');
    expect(t).toContain('id="md-input"');
    expect(t).toContain('id="preview-toggle"');
    expect(t).toContain("/client/editor.js");
    // Floating action group replaced the old titlebar; copy-link/view buttons gone.
    expect(t).not.toContain("editor-titlebar");
    expect(t).not.toContain('id="copy-link"');
    expect(t).not.toContain("hide preview");
    expect(t).toContain("editor-actions");
    expect(t).toContain("preview: off");
  });

  it("sets HMAC-signed pencil_uid cookie", async () => {
    const r = await SELF.fetch("https://x/");
    const set = r.headers.get("Set-Cookie") ?? "";
    expect(set).toMatch(/pencil_uid=/);
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Lax/i);
    expect(set).toMatch(/Secure/i);
  });

  it("sets strict CSP on HTML responses", async () => {
    const r = await SELF.fetch("https://x/");
    const csp = r.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(r.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  it("returns 404 for invalid slug", async () => {
    const r = await SELF.fetch("https://x/!!!");
    expect(r.status).toBe(404);
  });

  it("creates page via form POST and redirects straight to the reader", async () => {
    const fd = new FormData();
    fd.set("title", "form created");
    fd.set("content", "hello world");
    const r = await SELF.fetch("https://x/", {
      method: "POST",
      body: fd,
      redirect: "manual",
    });
    expect(r.status).toBe(303);
    const loc = r.headers.get("Location") ?? "";
    expect(loc).toMatch(/^\/[A-Za-z0-9]{8}$/);
  });

  it("editor route requires owner cookie; redirects otherwise", async () => {
    // Create as one "browser".
    const create = await SELF.fetch("https://x/api/v1/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x", content: "body" }),
    });
    const { slug } = (await create.json()) as { slug: string };
    // Visit /:slug/edit with a fresh (no) cookie -> redirect.
    const r = await SELF.fetch(`https://x/${slug}/edit`, { redirect: "manual" });
    expect(r.status).toBe(303);
    expect(r.headers.get("Location")).toContain(`/${slug}`);
  });

  it("PUT /:slug rejects a different browser cookie", async () => {
    const create = await SELF.fetch("https://x/api/v1/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x", content: "body" }),
    });
    const { slug } = (await create.json()) as { slug: string };
    const r = await SELF.fetch(`https://x/${slug}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "nope" }),
    });
    expect(r.status).toBe(403);
  });

  it("PUT /:slug accepts the same browser cookie", async () => {
    const create = await SELF.fetch("https://x/api/v1/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x", content: "body" }),
    });
    const { slug } = (await create.json()) as { slug: string };
    const cookie = extractUidCookie(create);
    expect(cookie).not.toBeNull();
    const r = await SELF.fetch(`https://x/${slug}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie!,
      },
      body: JSON.stringify({ content: "fresh" }),
    });
    expect(r.status).toBe(200);
  });

  it("stats page 404s for non-owner", async () => {
    const create = await SELF.fetch("https://x/api/v1/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x", content: "body" }),
    });
    const { slug } = (await create.json()) as { slug: string };
    const r = await SELF.fetch(`https://x/${slug}/stats`);
    expect(r.status).toBe(404);
  });

  it("API docs page has no topbar header", async () => {
    const r = await SELF.fetch("https://x/api");
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).not.toContain('class="topbar"');
    expect(html).not.toContain("<header");
  });

  it("404 page has no topbar header", async () => {
    const r = await SELF.fetch("https://x/aaaaaaaa");
    expect(r.status).toBe(404);
    const html = await r.text();
    expect(html).not.toContain('class="topbar"');
    expect(html).not.toContain("<header");
  });

  it("stats page has no topbar header (owner cookie)", async () => {
    const create = await SELF.fetch("https://x/api/v1/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x", content: "body" }),
    });
    const { slug } = (await create.json()) as { slug: string };
    const cookie = extractUidCookie(create);
    expect(cookie).not.toBeNull();
    const r = await SELF.fetch(`https://x/${slug}/stats`, {
      headers: { Cookie: cookie! },
    });
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).not.toContain('class="topbar"');
    expect(html).not.toContain("<header");
  });

  it("preview endpoint rejects oversize via Content-Length", async () => {
    // PREVIEW_MAX_BYTES is 64 KB; send 80 KB.
    const big = "a".repeat(80 * 1024);
    const r = await SELF.fetch("https://x/api/preview", {
      method: "POST",
      headers: { "Content-Type": "text/markdown" },
      body: big,
    });
    expect(r.status).toBe(413);
  });

  it("preview endpoint accepts payloads under the 64 KB cap", async () => {
    const ok = "a".repeat(60 * 1024);
    const r = await SELF.fetch("https://x/api/preview", {
      method: "POST",
      headers: { "Content-Type": "text/markdown" },
      body: ok,
    });
    expect(r.status).toBe(200);
  });

  it("preview endpoint returns sanitized HTML", async () => {
    const r = await SELF.fetch("https://x/api/preview", {
      method: "POST",
      headers: { "Content-Type": "text/markdown" },
      body: "# hi\n\n[bad](javascript:alert(1))",
    });
    expect(r.status).toBe(200);
    const t = await r.text();
    expect(t).toContain("<h1");
    // No javascript: scheme anywhere in an actual href.
    expect(t).not.toMatch(/href=["'][^"']*javascript:/i);
    // No <a> tag should have been emitted for the unsafe link.
    expect(t).not.toMatch(/<a\s+[^>]*href=["']javascript:/i);
  });
});

describe("indexing + about + corner-actions", () => {
  it("reader emits noindex by default", async () => {
    const c = await SELF.fetch("https://x/api/v1/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x", content: "body" }),
    });
    const { slug } = (await c.json()) as { slug: string };
    const r = await SELF.fetch(`https://x/${slug}`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('name="robots" content="noindex,nofollow"');
  });

  it("indexing toggle round-trip via /:slug/settings/indexable", async () => {
    const c = await SELF.fetch("https://x/api/v1/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x", content: "body" }),
    });
    const { slug } = (await c.json()) as { slug: string };
    const cookie = extractUidCookie(c)!;

    // Flip to enabled.
    const fd = new FormData();
    fd.set("indexable", "1");
    const t = await SELF.fetch(`https://x/${slug}/settings/indexable`, {
      method: "POST",
      headers: { Cookie: cookie },
      body: fd,
      redirect: "manual",
    });
    expect(t.status).toBe(303);
    expect(t.headers.get("Location")).toContain(`/${slug}/stats`);

    // Reader should now lack the noindex tag.
    const r = await SELF.fetch(`https://x/${slug}`);
    const html = await r.text();
    expect(html).not.toContain('name="robots" content="noindex,nofollow"');
  });

  it("indexing toggle rejects non-owner cookie", async () => {
    const c = await SELF.fetch("https://x/api/v1/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x", content: "body" }),
    });
    const { slug } = (await c.json()) as { slug: string };
    const fd = new FormData();
    fd.set("indexable", "1");
    // No cookie → fresh uid → 403.
    const t = await SELF.fetch(`https://x/${slug}/settings/indexable`, {
      method: "POST",
      body: fd,
    });
    expect(t.status).toBe(403);
  });

  it("about page is indexable and has SEO meta", async () => {
    const r = await SELF.fetch("https://example.test/about");
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("About pencil.md");
    expect(html).not.toContain('name="robots" content="noindex'); // indexable
    expect(html).toContain('rel="canonical" href="https://example.test/about"');
  });

  it("footer has about link", async () => {
    const r = await SELF.fetch("https://x/");
    const html = await r.text();
    expect(html).toMatch(/<footer[^>]*>[^<]*<[^>]*>?[\s\S]*?\/about/);
  });

  it("reader corner-actions includes settings button for owner only", async () => {
    const c = await SELF.fetch("https://x/api/v1/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x", content: "body" }),
    });
    const { slug } = (await c.json()) as { slug: string };
    const cookie = extractUidCookie(c)!;

    // Owner sees settings link.
    const owner = await SELF.fetch(`https://x/${slug}`, { headers: { Cookie: cookie } });
    const ownerHtml = await owner.text();
    expect(ownerHtml).toContain(`href="/${slug}/stats"`);
    expect(ownerHtml).toMatch(/aria-label="settings"/);

    // Anonymous viewer does not.
    const anon = await SELF.fetch(`https://x/${slug}`);
    const anonHtml = await anon.text();
    expect(anonHtml).not.toContain(`href="/${slug}/stats"`);
  });
});

describe("view counter", () => {
  // Polls the views endpoint until it changes (or times out). Necessary
  // because the increment runs in waitUntil and SELF.fetch doesn't expose
  // a way to await that ctx.
  async function readViews(slug: string): Promise<number> {
    const r = await SELF.fetch(`https://x/api/v1/pages/${slug}`);
    return ((await r.json()) as { views: number }).views;
  }
  async function waitForViews(slug: string, target: number, ms = 1000): Promise<number> {
    const deadline = Date.now() + ms;
    let v = await readViews(slug);
    while (v !== target && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      v = await readViews(slug);
    }
    return v;
  }

  it("increments on cross-browser GET", async () => {
    const create = await SELF.fetch("https://x/api/v1/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "v", content: "body" }),
    });
    const { slug } = (await create.json()) as { slug: string };

    expect(await readViews(slug)).toBe(0);

    await SELF.fetch(`https://x/${slug}`, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/Safari" },
    });
    expect(await waitForViews(slug, 1)).toBe(1);
  });

  it("does not increment for bot UA", async () => {
    const create = await SELF.fetch("https://x/api/v1/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "v", content: "body" }),
    });
    const { slug } = (await create.json()) as { slug: string };
    await SELF.fetch(`https://x/${slug}`, {
      headers: { "User-Agent": "Slackbot-LinkExpanding 1.0" },
    });
    // Give it generous time to confirm increment did NOT happen.
    await new Promise((r) => setTimeout(r, 300));
    expect(await readViews(slug)).toBe(0);
  });
});
