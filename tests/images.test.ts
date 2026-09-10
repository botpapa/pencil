import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

// Image upload + serving on the main (pages) host — backs the editor's
// "/add-image" slash command. Mirrors the draw host's endpoint.

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

async function upload(contentType: string, body: BodyInit = PNG) {
  return SELF.fetch("https://x/api/images", {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
  });
}

describe("pages — image upload", () => {
  it("uploads a png and serves it back", async () => {
    const res = await upload("image/png");
    expect(res.status).toBe(201);
    const j = (await res.json()) as { url: string; key: string };
    expect(j.url).toMatch(/^https:\/\/x\/img\/[A-Za-z0-9._-]+\.png$/);
    expect(j.key).toMatch(/^img\//);

    const read = await SELF.fetch(j.url);
    expect(read.status).toBe(200);
    expect(read.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(PNG);
  });

  it("maps image/jpeg to a .jpg key", async () => {
    const res = await upload("image/jpeg");
    expect(res.status).toBe(201);
    const j = (await res.json()) as { url: string };
    expect(j.url).toMatch(/\.jpg$/);
  });

  it("rejects unsupported content types", async () => {
    const res = await upload("image/svg+xml", "<svg/>");
    expect(res.status).toBe(415);
  });

  it("rejects oversize uploads by Content-Length", async () => {
    const res = await SELF.fetch("https://x/api/images", {
      method: "POST",
      headers: { "Content-Type": "image/png", "Content-Length": String(10 * 1024 * 1024) },
      body: PNG,
    });
    expect(res.status).toBe(413);
  });

  it("404s on missing or invalid image names", async () => {
    expect((await SELF.fetch("https://x/img/nope.png")).status).toBe(404);
    expect((await SELF.fetch("https://x/img/..%2Fsecret")).status).toBe(404);
  });
});
