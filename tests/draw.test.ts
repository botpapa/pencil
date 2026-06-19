import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

// The draw app is served when the request host starts with "draw." — drive it
// by addressing draw.localhost.
const DRAW = "https://draw.localhost";

function cookie(res: Response, name: string): string | null {
  const set = res.headers.get("Set-Cookie") ?? "";
  const m = new RegExp(`${name}=([^;]+)`).exec(set);
  return m ? `${name}=${m[1]}` : null;
}
const scene = (elements: unknown[] = []) =>
  JSON.stringify({ schemaVersion: 1, viewport: { x: 0, y: 0, zoom: 1 }, elements });

async function create(body: Record<string, unknown>, cookieHeader?: string) {
  return SELF.fetch(`${DRAW}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
    body: JSON.stringify(body),
  });
}

describe("draw — host routing + create/read", () => {
  it("creates and reads a drawing", async () => {
    const res = await create({ title: "Board", scene: scene([{ type: "stroke", points: [[0, 0], [10, 10]], color: "#1A1714", width: 3 }]) });
    expect(res.status).toBe(201);
    const j = (await res.json()) as { slug: string };
    expect(j.slug).toMatch(/^[A-Za-z0-9]{8}$/);
    const read = await SELF.fetch(`${DRAW}/${j.slug}`);
    expect(read.status).toBe(200);
    expect((await read.text())).toContain("scene-data");
  });
});

describe("draw — security", () => {
  it("rejects scenes with external image URLs", async () => {
    const res = await create({ title: "x", scene: scene([{ type: "image", url: "https://evil.example/track.gif", x: 0, y: 0, w: 10, h: 10 }]) });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/image/);
  });

  it("rejects javascript: image URLs", async () => {
    const res = await create({ title: "x", scene: scene([{ type: "image", url: "javascript:alert(1)", x: 0, y: 0, w: 10, h: 10 }]) });
    expect(res.status).toBe(400);
  });

  it("accepts an image element that references an issued /img/ key", async () => {
    const res = await create({ title: "x", scene: scene([{ type: "image", url: "/img/abc-123.png", x: 0, y: 0, w: 10, h: 10 }]) });
    expect(res.status).toBe(201);
  });

  it("rejects an invalid scene shape", async () => {
    const res = await create({ title: "x", scene: JSON.stringify({ schemaVersion: 1, elements: "nope" }) });
    expect(res.status).toBe(400);
  });

  it("does not allow a non-owner to update a drawing", async () => {
    const c1 = await create({ title: "mine", scene: scene() });
    const { slug } = (await c1.json()) as { slug: string };
    // fresh request → different (new) owner cookie → 403
    const upd = await SELF.fetch(`${DRAW}/${slug}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "hijack" }),
    });
    expect(upd.status).toBe(403);
  });

  it("owner can update; reader reflects it", async () => {
    const c1 = await create({ title: "v1", scene: scene() });
    const owner = cookie(c1, "pencil_uid")!;
    const { slug } = (await c1.json()) as { slug: string };
    const upd = await SELF.fetch(`${DRAW}/${slug}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: owner },
      body: JSON.stringify({ title: "v2" }),
    });
    expect(upd.status).toBe(200);
  });

  it("rejects unsupported image upload types", async () => {
    const res = await SELF.fetch(`${DRAW}/api/images`, {
      method: "POST",
      headers: { "Content-Type": "text/html" },
      body: "<x>",
    });
    expect(res.status).toBe(415);
  });

  it("password-protects the reader (full lockdown)", async () => {
    const c1 = await create({ title: "secret", scene: scene([{ type: "text", x: 0, y: 0, md: "classified", color: "#1A1714", fontSize: 18 }]), password: "hunter2" });
    const { slug } = (await c1.json()) as { slug: string };
    const locked = await SELF.fetch(`${DRAW}/${slug}`);
    expect(locked.status).toBe(401);
    expect(await locked.text()).not.toContain("classified");
  });
});
