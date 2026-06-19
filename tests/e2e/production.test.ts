// Opt-in end-to-end suite. Runs against the live deployment at
// E2E_BASE_URL (default: https://pencil.md) using plain fetch. No cloudflare:test,
// no D1 emulation — exercises the real CDN routes + Worker + D1 + R2 stack.
//
// Every page created here has a title beginning with "e2e:" so the rows can
// be deleted later. See README "End-to-end tests against a deployment".

import { describe, it, expect, beforeAll } from "vitest";

const BASE = (process.env.E2E_BASE_URL ?? "https://pencil.md").replace(/\/$/, "");
const TAG = "e2e";
const ISO = new Date().toISOString().replace(/[:.]/g, "-");

function tagTitle(label: string): string {
  return `${TAG}: ${label} ${ISO}`;
}

// Capture slugs the suite creates so a final test can log them. The runner
// itself reports failures; this lets a human spot-check or delete after.
const createdSlugs: string[] = [];

type CreateResponse = {
  slug: string;
  url: string;
  edit_url: string;
  edit_token: string;
};

async function createPage(body: { title: string; content: string }, init: RequestInit = {}): Promise<{ res: Response; json: CreateResponse }> {
  const res = await fetch(`${BASE}/api/v1/pages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    body: JSON.stringify(body),
    ...init,
  });
  const json = (await res.json()) as CreateResponse;
  if (res.status === 201 && json?.slug) createdSlugs.push(json.slug);
  return { res, json };
}

describe("A. health, static, meta", () => {
  it("GET /health returns the canonical JSON", async () => {
    const r = await fetch(`${BASE}/health`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as { ok: boolean; app: string };
    expect(j).toEqual({ ok: true, app: "pencil.md" });
  });

  it.each([
    "/styles.css",
    "/favicon.svg",
    "/robots.txt",
    "/client/editor.js",
    "/client/reader.js",
  ])("static asset %s is served", async (path) => {
    const r = await fetch(`${BASE}${path}`);
    expect(r.status, `${path} ${r.status}`).toBe(200);
  });

  it("GET /api renders docs with the request origin substituted", async () => {
    const r = await fetch(`${BASE}/api`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain(`${BASE}/api/v1`);
    expect(html).toContain("POST /pages");
  });

  it("GET /about is indexable, has canonical, contains expected copy", async () => {
    const r = await fetch(`${BASE}/about`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("About pencil.md");
    expect(html).not.toContain("noindex");
    expect(html).toContain(`rel="canonical" href="${BASE}/about"`);
  });

  it("GET / serves the empty editor with footer about link and no topbar", async () => {
    const r = await fetch(`${BASE}/`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('id="md-input"');
    expect(html).toContain('href="/about"');
    expect(html).not.toContain('class="topbar"');
  });

  it("OPTIONS preflight on /api/v1/pages allows any origin", async () => {
    const r = await fetch(`${BASE}/api/v1/pages/aaaaaaaa`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://other.example",
        "Access-Control-Request-Method": "GET",
      },
    });
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("HTML responses carry strict CSP + nosniff + referrer-policy", async () => {
    const r = await fetch(`${BASE}/about`);
    const csp = r.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(r.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });
});

describe("B. page lifecycle (POST → GET → reader → OG → PUT)", () => {
  let slug = "";
  let editToken = "";

  const initialContent =
    "# Hello\n\nA **bold** paragraph plus inline `code`.\n\n## Sub\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";

  beforeAll(async () => {
    const { res, json } = await createPage({
      title: tagTitle("lifecycle"),
      content: initialContent,
    });
    expect(res.status, `create ${res.status}`).toBe(201);
    expect(json.slug).toMatch(/^[A-Za-z0-9]{8}$/);
    expect(json.url).toContain(`/${json.slug}`);
    expect(json.edit_url).toContain(`/${json.slug}/edit`);
    expect(typeof json.edit_token).toBe("string");
    expect(json.edit_token.split(".").length).toBe(2);
    slug = json.slug;
    editToken = json.edit_token;
  });

  it("GET /api/v1/pages/:slug returns the page we POSTed", async () => {
    const r = await fetch(`${BASE}/api/v1/pages/${slug}`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as { slug: string; content: string; views: number };
    expect(j.slug).toBe(slug);
    expect(j.content).toBe(initialContent);
    expect(j.views).toBeGreaterThanOrEqual(0);
  });

  it("GET /:slug renders the reader with anchors, table-wrap, noindex meta", async () => {
    const r = await fetch(`${BASE}/${slug}`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('name="robots" content="noindex,nofollow"');
    expect(html).toContain('class="header-anchor"');
    const anchors = html.match(/class="header-anchor"/g) ?? [];
    expect(anchors.length).toBe(2);
    // `table-wrap` div carries a `data-source-line` attribute when the
    // markdown pipeline tags block tokens, so match the opening tag without
    // requiring a literal `>` immediately after the class.
    expect(html).toMatch(/<div class="table-wrap"[^>]*>/);
    expect(html).toContain("Hello");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("published");
    expect(html).not.toContain("· updated");
  });

  it("GET /og/:slug.png returns a real PNG larger than 1 KB", async () => {
    const r = await fetch(`${BASE}/og/${slug}.png`);
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toBe("image/png");
    const buf = await r.arrayBuffer();
    expect(buf.byteLength).toBeGreaterThan(1024);
  });

  it("PUT /api/v1/pages/:slug with edit_token updates content", async () => {
    const updated = "# Updated\n\nvia edit_token";
    const r = await fetch(`${BASE}/api/v1/pages/${slug}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edit_token: editToken, content: updated }),
    });
    expect(r.status, `put ${r.status}`).toBe(200);

    const after = await fetch(`${BASE}/api/v1/pages/${slug}`);
    expect(((await after.json()) as { content: string }).content).toBe(updated);
  });

  it("PUT without edit_token or owner cookie is rejected with 403", async () => {
    const r = await fetch(`${BASE}/api/v1/pages/${slug}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "should not stick" }),
    });
    expect(r.status).toBe(403);
  });
});

describe("C. indexing toggle round-trip (owner cookie)", () => {
  // Tiny cookie jar — only need pencil_uid for owner-tied actions.
  const jar = new Map<string, string>();
  function cookieHeader(): string {
    return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  function capture(res: Response): void {
    const set = res.headers.get("Set-Cookie");
    if (!set) return;
    const m = /pencil_uid=([^;]+)/.exec(set);
    if (m && m[1]) jar.set("pencil_uid", m[1]);
  }

  let slug = "";

  beforeAll(async () => {
    const res = await fetch(`${BASE}/api/v1/pages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: tagTitle("index toggle"), content: "# x" }),
    });
    expect(res.status).toBe(201);
    capture(res);
    const j = (await res.json()) as CreateResponse;
    slug = j.slug;
    createdSlugs.push(slug);
    expect(jar.get("pencil_uid")).toBeTruthy();
  });

  it("reader emits noindex by default", async () => {
    const r = await fetch(`${BASE}/${slug}`);
    const html = await r.text();
    expect(html).toContain('name="robots" content="noindex,nofollow"');
  });

  it("POST /:slug/settings/indexable with cookie redirects to /stats", async () => {
    const fd = new FormData();
    fd.set("indexable", "1");
    const r = await fetch(`${BASE}/${slug}/settings/indexable`, {
      method: "POST",
      headers: { Cookie: cookieHeader() },
      body: fd,
      redirect: "manual",
    });
    expect(r.status).toBe(303);
    expect(r.headers.get("Location")).toContain(`/${slug}/stats`);
  });

  it("after toggle the reader no longer emits noindex", async () => {
    const r = await fetch(`${BASE}/${slug}`);
    const html = await r.text();
    expect(html).not.toContain('name="robots" content="noindex,nofollow"');
  });

  it("indexable toggle without cookie is rejected with 403", async () => {
    const fd = new FormData();
    fd.set("indexable", "1");
    const r = await fetch(`${BASE}/${slug}/settings/indexable`, {
      method: "POST",
      body: fd,
    });
    expect(r.status).toBe(403);
  });
});

describe("D. limits + 404 / 500 differentiation", () => {
  it("POST /api/v1/pages with 600 KB body is rejected with 413", async () => {
    const body = "a".repeat(600 * 1024);
    const r = await fetch(`${BASE}/api/v1/pages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(r.status).toBe(413);
  });

  it("POST /api/preview with 300 KB body is rejected with 413", async () => {
    const body = "a".repeat(300 * 1024);
    const r = await fetch(`${BASE}/api/preview`, {
      method: "POST",
      headers: { "Content-Type": "text/markdown" },
      body,
    });
    expect(r.status).toBe(413);
  });

  it("POST /api/preview with 30 KB body returns rendered HTML", async () => {
    const body = "# heading\n\n" + "lorem ipsum ".repeat(2400); // ~30 KB
    const r = await fetch(`${BASE}/api/preview`, {
      method: "POST",
      headers: { "Content-Type": "text/markdown" },
      body,
    });
    expect(r.status, `preview ${r.status}`).toBe(200);
    const html = await r.text();
    expect(html).toContain("<h1");
  });

  it("GET /!!! returns a 404 page (not 500)", async () => {
    const r = await fetch(`${BASE}/!!!`);
    expect(r.status).toBe(404);
    const html = await r.text();
    expect(html).toContain("404");
    expect(html).not.toContain("500");
  });
});

describe("Z. summary", () => {
  it("logs slugs created during this run for cleanup", () => {
    // Stable, machine-greppable line for whoever runs the suite.
    // eslint-disable-next-line no-console
    console.log(`[e2e] created slugs: ${createdSlugs.join(", ") || "(none)"}`);
    expect(createdSlugs.length).toBeGreaterThanOrEqual(0);
  });
});
