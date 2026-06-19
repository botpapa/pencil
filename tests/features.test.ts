import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

// Re-emit a Set-Cookie value as a Cookie header to simulate "the same browser".
function cookie(res: Response, name: string): string | null {
  const set = res.headers.get("Set-Cookie") ?? "";
  const m = new RegExp(`${name}=([^;]+)`).exec(set);
  return m ? `${name}=${m[1]}` : null;
}

// Create a page through the browser JSON path; returns slug + the owner cookie.
async function createPage(
  body: Record<string, unknown>,
  cookieHeader?: string,
): Promise<{ slug: string; ownerCookie: string }> {
  const res = await SELF.fetch("https://x/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  const j = (await res.json()) as { slug: string };
  const oc = cookieHeader ?? cookie(res, "pencil_uid");
  return { slug: j.slug, ownerCookie: oc! };
}

describe("pages list + footer link", () => {
  it("lists only the owner's pages and shows the footer link", async () => {
    const a = await createPage({ title: "First", content: "# one" });
    await createPage({ title: "Second", content: "# two" }, a.ownerCookie);

    const list = await SELF.fetch("https://x/pages", {
      headers: { Cookie: a.ownerCookie },
    });
    expect(list.status).toBe(200);
    const html = await list.text();
    expect(html).toContain("First");
    expect(html).toContain("Second");

    // Footer "pages" link appears on the home page for an owner with pages.
    const home = await SELF.fetch("https://x/", { headers: { Cookie: a.ownerCookie } });
    expect(await home.text()).toContain('href="/pages"');

    // A different browser sees neither the pages nor the link.
    const other = await SELF.fetch("https://x/pages");
    const otherHtml = await other.text();
    expect(otherHtml).not.toContain("First");
    const otherHome = await SELF.fetch("https://x/");
    expect(await otherHome.text()).not.toContain('href="/pages"');
  });
});

describe("delete", () => {
  it("owner can delete via the UI; the page is then gone", async () => {
    const { slug, ownerCookie } = await createPage({ title: "Doomed", content: "bye" });
    const del = await SELF.fetch(`https://x/${slug}/delete`, {
      method: "POST",
      headers: { Cookie: ownerCookie },
      redirect: "manual",
    });
    expect(del.status).toBe(303);
    const read = await SELF.fetch(`https://x/${slug}`);
    expect(read.status).toBe(404);
  });

  it("non-owner cannot delete", async () => {
    const { slug } = await createPage({ title: "Safe", content: "stay" });
    const del = await SELF.fetch(`https://x/${slug}/delete`, {
      method: "POST",
      redirect: "manual",
    });
    expect(del.status).toBe(403);
    expect((await SELF.fetch(`https://x/${slug}`)).status).toBe(200);
  });

  it("owner can delete via the API with edit_token", async () => {
    const create = await SELF.fetch("https://x/api/v1/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "api", content: "x" }),
    });
    const { slug, edit_token } = (await create.json()) as { slug: string; edit_token: string };
    const del = await SELF.fetch(`https://x/api/v1/pages/${slug}?edit_token=${encodeURIComponent(edit_token)}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    expect((await SELF.fetch(`https://x/api/v1/pages/${slug}`)).status).toBe(404);
  });
});

describe("password protection — API", () => {
  it("locks GET until the password (or owner) is supplied", async () => {
    const create = await SELF.fetch("https://x/api/v1/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "secret", content: "classified", password: "hunter2" }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { slug: string; protected: boolean };
    expect(created.protected).toBe(true);
    const ownerCookie = cookie(create, "pencil_uid")!;
    const slug = created.slug;

    // No password → 401, no content.
    const locked = await SELF.fetch(`https://x/api/v1/pages/${slug}`);
    expect(locked.status).toBe(401);
    expect(await locked.text()).not.toContain("classified");

    // Wrong password → 401.
    expect((await SELF.fetch(`https://x/api/v1/pages/${slug}?password=nope`)).status).toBe(401);

    // Correct password (query) → 200 with content.
    const okQuery = await SELF.fetch(`https://x/api/v1/pages/${slug}?password=hunter2`);
    expect(okQuery.status).toBe(200);
    expect((await okQuery.json() as { content: string }).content).toBe("classified");

    // Correct password (header) → 200.
    const okHeader = await SELF.fetch(`https://x/api/v1/pages/${slug}`, {
      headers: { "X-Page-Password": "hunter2" },
    });
    expect(okHeader.status).toBe(200);

    // Owner cookie bypasses the password.
    const okOwner = await SELF.fetch(`https://x/api/v1/pages/${slug}`, {
      headers: { Cookie: ownerCookie },
    });
    expect(okOwner.status).toBe(200);
  });
});

describe("password protection — web", () => {
  it("gates the reader, unlocks with the right password, and the owner bypasses", async () => {
    const { slug, ownerCookie } = await createPage({ title: "Diary", content: "# private" });

    // Enable a password via settings.
    const setPw = await SELF.fetch(`https://x/${slug}/settings/password`, {
      method: "POST",
      headers: {
        Cookie: ownerCookie,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ password: "letmein" }).toString(),
      redirect: "manual",
    });
    expect(setPw.status).toBe(303);

    // A different browser is gated.
    const gated = await SELF.fetch(`https://x/${slug}`);
    expect(gated.status).toBe(401);
    const gatedHtml = await gated.text();
    expect(gatedHtml).toContain("password protected");
    expect(gatedHtml).not.toContain("private");

    // Owner still sees content (bypass).
    const ownerView = await SELF.fetch(`https://x/${slug}`, { headers: { Cookie: ownerCookie } });
    expect(ownerView.status).toBe(200);

    // Wrong password → still 401.
    const wrong = await SELF.fetch(`https://x/${slug}/unlock`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: "wrong" }).toString(),
      redirect: "manual",
    });
    expect(wrong.status).toBe(401);

    // Correct password → 303 + access cookie; replay it to read the content.
    const unlock = await SELF.fetch(`https://x/${slug}/unlock`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: "letmein" }).toString(),
      redirect: "manual",
    });
    expect(unlock.status).toBe(303);
    const pwCookie = cookie(unlock, `pencil_pw_${slug}`);
    expect(pwCookie).not.toBeNull();
    const unlocked = await SELF.fetch(`https://x/${slug}`, { headers: { Cookie: pwCookie! } });
    expect(unlocked.status).toBe(200);

    // Remove the password → public again.
    const removePw = await SELF.fetch(`https://x/${slug}/settings/password`, {
      method: "POST",
      headers: { Cookie: ownerCookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ remove: "1" }).toString(),
      redirect: "manual",
    });
    expect(removePw.status).toBe(303);
    expect((await SELF.fetch(`https://x/${slug}`)).status).toBe(200);
  });
});
