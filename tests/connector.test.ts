import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
import { sniffImage } from "../src/lib/image.js";

const ORIGIN = "https://pencil.md";
const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function uidCookie(res: Response): string {
  const m = /pencil_uid=([^;]+)/.exec(res.headers.get("Set-Cookie") ?? "");
  if (!m) throw new Error("no pencil_uid cookie");
  return `pencil_uid=${m[1]}`;
}

function b64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

async function register(extra: Record<string, unknown> = {}) {
  const res = await SELF.fetch(`${ORIGIN}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Test Host", redirect_uris: ["https://host.example/cb"], token_endpoint_auth_method: "none", ...extra }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { client_id: string; client_secret?: string };
}

// Full browser-side consent: GET the screen with (or without) a cookie, then
// POST allow with the signed txn. Returns the code and the cookie that owns it.
async function consent(client_id: string, opts: { scope?: string; cookie?: string; action?: string; state?: string; challenge: string }) {
  const q = new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: "https://host.example/cb",
    code_challenge: opts.challenge,
    code_challenge_method: "S256",
    state: opts.state ?? "xyz",
    resource: `${ORIGIN}/mcp`,
    ...(opts.scope ? { scope: opts.scope } : {}),
  });
  const page = await SELF.fetch(`${ORIGIN}/oauth/authorize?${q}`, { headers: opts.cookie ? { Cookie: opts.cookie } : {} });
  expect(page.status).toBe(200);
  const cookie = opts.cookie ?? uidCookie(page);
  const html = await page.text();
  expect(html).toContain("Test Host");
  const txn = /name="txn" value="([^"]+)"/.exec(html)![1]!;
  const post = await SELF.fetch(`${ORIGIN}/oauth/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    body: new URLSearchParams({ txn, action: opts.action ?? "allow" }),
    redirect: "manual",
  });
  // 200 + meta refresh (not a 302): CSP form-action would block a cross-origin redirect.
  expect(post.status).toBe(200);
  const done = await post.text();
  const refresh = /<meta http-equiv="refresh" content="0;url=([^"]+)">/.exec(done)![1]!;
  const href = /<a id="continue" href="([^"]+)">/.exec(done)![1]!;
  expect(refresh).toBe(href);
  const loc = new URL(href.replaceAll("&amp;", "&"));
  return { loc, cookie };
}

async function token(body: Record<string, string>) {
  const res = await SELF.fetch(`${ORIGIN}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

// Shortcut: a fully connected client. Returns bearer + the owning cookie.
async function connect(scope?: string) {
  const { client_id } = await register();
  const { verifier, challenge } = await pkce();
  const { loc, cookie } = await consent(client_id, { challenge, scope });
  const t = await token({ grant_type: "authorization_code", client_id, code: loc.searchParams.get("code")!, redirect_uri: "https://host.example/cb", code_verifier: verifier, resource: `${ORIGIN}/mcp` });
  expect(t.status).toBe(200);
  return { access: t.json.access_token as string, refresh: t.json.refresh_token as string, client_id, cookie };
}

let rpcId = 0;
const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "t", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} };

async function rpc(access: string | null, method: string, params: Record<string, unknown> = {}, headerOverrides: Record<string, string | undefined> = {}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2026-07-28",
    "Mcp-Method": method,
  };
  if (typeof params.name === "string") headers["Mcp-Name"] = params.name;
  if (access) headers.Authorization = `Bearer ${access}`;
  for (const [k, v] of Object.entries(headerOverrides)) {
    if (v === undefined) delete headers[k];
    else headers[k] = v;
  }
  const res = await SELF.fetch(`${ORIGIN}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params: { ...params, _meta: META } }) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? (JSON.parse(text) as { result?: Record<string, unknown>; error?: { code: number; message: string; data?: unknown } }) : null };
}

async function call(access: string, name: string, args: Record<string, unknown> = {}) {
  const r = await rpc(access, "tools/call", { name, arguments: args });
  expect(r.status).toBe(200);
  const result = r.body!.result as { content: { text: string }[]; structuredContent?: Record<string, unknown>; isError: boolean; resultType: string };
  expect(result.resultType).toBe("complete");
  return result;
}

describe("connector — discovery", () => {
  it("serves RFC 9728 + RFC 8414 metadata with CIMD, PKCE S256 and iss support", async () => {
    const prm = (await (await SELF.fetch(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>;
    expect(prm.resource).toBe(`${ORIGIN}/mcp`);
    expect(prm.authorization_servers).toEqual([ORIGIN]);
    const as = (await (await SELF.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(as.issuer).toBe(ORIGIN);
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.client_id_metadata_document_supported).toBe(true);
    expect(as.authorization_response_iss_parameter_supported).toBe(true);
    expect(as.token_endpoint_auth_methods_supported).toContain("none");
    expect(as.registration_endpoint).toBe(`${ORIGIN}/oauth/register`);
  });

  it("answers 401 with a resource_metadata pointer when there is no bearer", async () => {
    const r = await rpc(null, "server/discover");
    expect(r.status).toBe(401);
    const www = r.headers.get("WWW-Authenticate")!;
    expect(www).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
    expect(www).toContain('error="invalid_token"');
  });

  it("rejects GET on the MCP endpoint with 405 (stateless)", async () => {
    const res = await SELF.fetch(`${ORIGIN}/mcp`);
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toContain("POST");
  });

  it("serves /connect, /privacy and /terms", async () => {
    for (const p of ["/connect", "/privacy", "/terms"]) {
      const res = await SELF.fetch(`${ORIGIN}${p}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/html");
    }
  });
});

describe("connector — OAuth", () => {
  it("dynamic registration rejects non-https redirect URIs but accepts loopback", async () => {
    const bad = await SELF.fetch(`${ORIGIN}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }) });
    expect(bad.status).toBe(400);
    const ok = await SELF.fetch(`${ORIGIN}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://localhost/callback"] }) });
    expect(ok.status).toBe(201);
  });

  it("issues a secret for confidential clients and requires it at the token endpoint", async () => {
    const c = await register({ token_endpoint_auth_method: "client_secret_post" });
    expect(typeof c.client_secret).toBe("string");
    const { verifier, challenge } = await pkce();
    const { loc } = await consent(c.client_id, { challenge });
    const noSecret = await token({ grant_type: "authorization_code", client_id: c.client_id, code: loc.searchParams.get("code")!, redirect_uri: "https://host.example/cb", code_verifier: verifier });
    expect(noSecret.status).toBe(401);
    expect(noSecret.json.error).toBe("invalid_client");
  });

  it("returns iss + state on allow, access_denied on deny", async () => {
    const { client_id } = await register();
    const { challenge } = await pkce();
    const allow = await consent(client_id, { challenge, state: "s1" });
    expect(allow.loc.searchParams.get("iss")).toBe(ORIGIN);
    expect(allow.loc.searchParams.get("state")).toBe("s1");
    expect(allow.loc.searchParams.get("code")).toMatch(/^pca_/);
    const deny = await consent(client_id, { challenge, action: "deny" });
    expect(deny.loc.searchParams.get("error")).toBe("access_denied");
    expect(deny.loc.searchParams.get("code")).toBeNull();
  });

  it("rejects a wrong PKCE verifier and a replayed code", async () => {
    const { client_id } = await register();
    const { verifier, challenge } = await pkce();
    const { loc } = await consent(client_id, { challenge });
    const code = loc.searchParams.get("code")!;
    const wrong = await token({ grant_type: "authorization_code", client_id, code, redirect_uri: "https://host.example/cb", code_verifier: "x".repeat(43) });
    expect(wrong.status).toBe(400);
    expect(wrong.json.error).toBe("invalid_grant");
    // The code was consumed by the failed attempt — a replay must fail too.
    const replay = await token({ grant_type: "authorization_code", client_id, code, redirect_uri: "https://host.example/cb", code_verifier: verifier });
    expect(replay.status).toBe(400);
  });

  it("rejects an unknown resource indicator", async () => {
    const { client_id } = await register();
    const { challenge } = await pkce();
    const q = new URLSearchParams({ response_type: "code", client_id, redirect_uri: "https://host.example/cb", code_challenge: challenge, code_challenge_method: "S256", resource: "https://other.example/mcp" });
    const res = await SELF.fetch(`${ORIGIN}/oauth/authorize?${q}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("Location")!).searchParams.get("error")).toBe("invalid_target");
  });

  it("rotates refresh tokens and refuses the old one", async () => {
    const { refresh, client_id } = await connect();
    const r1 = await token({ grant_type: "refresh_token", client_id, refresh_token: refresh });
    expect(r1.status).toBe(200);
    expect(r1.json.refresh_token).not.toBe(refresh);
    const r2 = await token({ grant_type: "refresh_token", client_id, refresh_token: refresh });
    expect(r2.status).toBe(400);
    expect(r2.json.error).toBe("invalid_grant");
    // The rotated pair works.
    const ok = await rpc(r1.json.access_token as string, "tools/list");
    expect(ok.status).toBe(200);
  });

  it("revocation kills the whole grant", async () => {
    const { access, refresh, client_id } = await connect();
    const rev = await SELF.fetch(`${ORIGIN}/oauth/revoke`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id, token: refresh }) });
    expect(rev.status).toBe(200);
    expect((await rpc(access, "tools/list")).status).toBe(401);
  });

  it("consent POST from a different browser (cookie) than the GET is rejected", async () => {
    const { client_id } = await register();
    const { challenge } = await pkce();
    const q = new URLSearchParams({ response_type: "code", client_id, redirect_uri: "https://host.example/cb", code_challenge: challenge, code_challenge_method: "S256" });
    const page = await SELF.fetch(`${ORIGIN}/oauth/authorize?${q}`);
    const txn = /name="txn" value="([^"]+)"/.exec(await page.text())![1]!;
    const other = await SELF.fetch(`${ORIGIN}/`); // mint a different identity
    const post = await SELF.fetch(`${ORIGIN}/oauth/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: uidCookie(other) },
      body: new URLSearchParams({ txn, action: "allow" }),
      redirect: "manual",
    });
    expect(post.status).toBe(400);
  });
});

describe("connector — MCP transport", () => {
  it("server/discover + tools/list follow the 2026-07-28 shape", async () => {
    const { access } = await connect();
    const d = await rpc(access, "server/discover");
    expect(d.status).toBe(200);
    expect(d.body!.result!.resultType).toBe("complete");
    expect(d.body!.result!.supportedVersions).toContain("2026-07-28");
    expect(d.body!.result!.cacheScope).toBe("public");
    const l = await rpc(access, "tools/list");
    const tools = l.body!.result!.tools as { name: string; annotations: Record<string, boolean>; securitySchemes: unknown[] }[];
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["create_page", "update_page", "upload_image", "create_drawing", "get_browser_login_link"]));
    expect(typeof l.body!.result!.ttlMs).toBe("number");
    for (const t of tools) {
      expect(typeof t.annotations.readOnlyHint).toBe("boolean");
      expect(typeof t.annotations.destructiveHint).toBe("boolean");
      expect(t.securitySchemes).toHaveLength(1);
    }
  });

  it("enforces header/body agreement and version support", async () => {
    const { access } = await connect();
    const mismatch = await rpc(access, "tools/list", {}, { "Mcp-Method": "tools/call" });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body!.error!.code).toBe(-32020);
    const missing = await rpc(access, "tools/list", {}, { "MCP-Protocol-Version": undefined });
    expect(missing.status).toBe(400);
    expect(missing.body!.error!.code).toBe(-32020);
    const res = await SELF.fetch(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${access}`, "MCP-Protocol-Version": "2099-01-01", "Mcp-Method": "tools/list" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2099-01-01" } } }),
    });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: { code: number; data: { supported: string[] } } };
    expect(j.error.code).toBe(-32022);
    expect(j.error.data.supported).toContain("2026-07-28");
    const unknown = await rpc(access, "nope/method");
    expect(unknown.status).toBe(404);
    expect(unknown.body!.error!.code).toBe(-32601);
  });

  it("serves legacy initialize clients on the same endpoint", async () => {
    const { access } = await connect();
    const h = { "Content-Type": "application/json", Authorization: `Bearer ${access}`, "MCP-Protocol-Version": "2025-06-18" };
    const init = await SELF.fetch(`${ORIGIN}/mcp`, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "legacy", version: "0" } } }) });
    expect(init.status).toBe(200);
    expect(init.headers.get("Mcp-Session-Id")).toBeNull();
    const j = (await init.json()) as { result: { protocolVersion: string; serverInfo: { name: string }; resultType?: string } };
    expect(j.result.protocolVersion).toBe("2025-06-18");
    expect(j.result.serverInfo.name).toBe("pencil.md");
    expect(j.result.resultType).toBeUndefined();
    const notif = await SELF.fetch(`${ORIGIN}/mcp`, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    expect(notif.status).toBe(202);
    const list = await SELF.fetch(`${ORIGIN}/mcp`, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
    const lj = (await list.json()) as { result: { tools: unknown[] } };
    expect(lj.result.tools.length).toBeGreaterThan(5);
  });
});

describe("connector — tools", () => {
  it("create_page publishes a page owned by the authorising browser", async () => {
    const { access, cookie } = await connect();
    const r = await call(access, "create_page", { title: "From Claude", content: "# hello\n\nworld" });
    expect(r.isError).toBe(false);
    const data = r.structuredContent as { slug: string; url: string };
    expect(data.url).toBe(`${ORIGIN}/${data.slug}`);
    expect(r.content[0]!.text).toContain(data.url);
    // Public reader works…
    const reader = await SELF.fetch(data.url);
    expect(reader.status).toBe(200);
    expect(await reader.text()).toContain("world");
    // …and the browser that clicked "allow" can open the editor.
    const edit = await SELF.fetch(`${data.url}/edit`, { headers: { Cookie: cookie }, redirect: "manual" });
    expect(edit.status).toBe(200);
    // and sees it in its list via the tool
    const list = await call(access, "list_pages");
    expect((list.structuredContent as { pages: { slug: string }[] }).pages.map((p) => p.slug)).toContain(data.slug);
  });

  it("get / update / options / delete round-trip, with ownership checks", async () => {
    const a = await connect();
    const b = await connect();
    const created = (await call(a.access, "create_page", { title: "t", content: "v1" })).structuredContent as { slug: string; url: string };
    const got = await call(b.access, "get_page", { slug: created.url });
    expect((got.structuredContent as { content: string; owned_by_you: boolean }).content).toBe("v1");
    expect((got.structuredContent as { owned_by_you: boolean }).owned_by_you).toBe(false);
    const stranger = await call(b.access, "update_page", { slug: created.slug, content: "hacked" });
    expect(stranger.isError).toBe(true);
    const upd = await call(a.access, "update_page", { slug: created.slug, content: "v2" });
    expect(upd.isError).toBe(false);
    expect((await (await SELF.fetch(`${ORIGIN}/api/v1/pages/${created.slug}`)).json() as { content: string }).content).toBe("v2");
    const locked = await call(a.access, "set_page_options", { slug: created.slug, password: "pw" });
    expect(locked.isError).toBe(false);
    expect((await call(b.access, "get_page", { slug: created.slug })).isError).toBe(true);
    expect((await call(b.access, "get_page", { slug: created.slug, password: "pw" })).isError).toBe(false);
    expect((await call(a.access, "get_page", { slug: created.slug })).isError).toBe(false); // owner needs no password
    expect((await call(b.access, "delete_page", { slug: created.slug })).isError).toBe(true);
    expect((await call(a.access, "delete_page", { slug: created.slug })).isError).toBe(false);
    expect((await SELF.fetch(`${ORIGIN}/api/v1/pages/${created.slug}`)).status).toBe(404);
  });

  it("upload_image + create_drawing publish a canvas with the image, and update appends", async () => {
    const { access, cookie } = await connect();
    const up = await call(access, "upload_image", { image_base64: PNG_1x1, alt: "dot" });
    expect(up.isError).toBe(false);
    const img = up.structuredContent as { markdown_url: string; canvas_url: string; width: number; height: number };
    expect(img.width).toBe(1);
    expect(img.canvas_url).toMatch(/^\/img\/.+\.png$/);
    expect(img.markdown_url).toBe(`${ORIGIN}${img.canvas_url}`);
    // Consume the bodies: an open R2 read stream trips the isolated-storage check.
    const served = await SELF.fetch(img.markdown_url);
    expect(served.status).toBe(200);
    expect((await served.arrayBuffer()).byteLength).toBeGreaterThan(0);
    const servedDraw = await SELF.fetch(`https://draw.pencil.md${img.canvas_url}`);
    expect(servedDraw.status).toBe(200);
    await servedDraw.arrayBuffer();

    const d = await call(access, "create_drawing", {
      title: "Board",
      elements: [
        { type: "text", x: 0, y: 0, md: "# Plan\nstep one", fontSize: 24 },
        { type: "shape", shape: "arrow", x: 0, y: 120, w: 200, h: 0, color: "#2B5C8A" },
        { type: "image", x: 220, y: 100, w: 100, h: 100, url: img.markdown_url },
      ],
    });
    expect(d.isError).toBe(false);
    const dd = d.structuredContent as { slug: string; url: string; element_count: number };
    expect(dd.url).toBe(`https://draw.pencil.md/${dd.slug}`);
    expect(dd.element_count).toBe(3);
    const reader = await SELF.fetch(dd.url);
    expect(reader.status).toBe(200);
    expect(await reader.text()).toContain("scene-data");
    const edit = await SELF.fetch(`${dd.url}/edit`, { headers: { Cookie: cookie }, redirect: "manual" });
    expect(edit.status).toBe(200);

    const appended = await call(access, "update_drawing", { slug: dd.url, append_elements: [{ type: "stroke", points: [[0, 0], [5, 5]] }] });
    expect(appended.isError).toBe(false);
    const got = await call(access, "get_drawing", { slug: dd.slug });
    expect((got.structuredContent as { elements: unknown[] }).elements).toHaveLength(4);
    const list = await call(access, "list_drawings");
    expect((list.structuredContent as { drawings: { slug: string }[] }).drawings[0]!.slug).toBe(dd.slug);
  });

  it("rejects external image URLs and malformed elements with actionable errors", async () => {
    const { access } = await connect();
    const ext = await call(access, "create_drawing", { elements: [{ type: "image", x: 0, y: 0, w: 1, h: 1, url: "https://evil.example/t.gif" }] });
    expect(ext.isError).toBe(true);
    expect(ext.content[0]!.text).toContain("upload_image");
    const bad = await call(access, "create_drawing", { elements: [{ type: "shape", shape: "hexagon", x: 0, y: 0, w: 1, h: 1 }] });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain("rect|ellipse|line|arrow");
    const unknown = await rpc(access, "tools/call", { name: "nope", arguments: {} });
    expect(unknown.body!.error!.code).toBe(-32602);
  });

  it("read-only scope cannot write", async () => {
    const { access } = await connect("read");
    const r = await call(access, "create_page", { content: "x" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("write");
    expect((await call(access, "list_pages")).isError).toBe(false);
  });

  it("get_browser_login_link signs a fresh browser in as the connector identity", async () => {
    const { access } = await connect();
    const page = (await call(access, "create_page", { title: "mine", content: "x" })).structuredContent as { slug: string };
    const link = (await call(access, "get_browser_login_link")).structuredContent as { url: string };
    expect(link.url).toMatch(new RegExp(`^${ORIGIN}/connect/claim/pcl_`));
    const confirm = await SELF.fetch(link.url);
    expect(confirm.status).toBe(200);
    const claim = await SELF.fetch(link.url, { method: "POST", redirect: "manual" });
    expect(claim.status).toBe(303);
    const cookie = uidCookie(claim);
    const edit = await SELF.fetch(`${ORIGIN}/${page.slug}/edit`, { headers: { Cookie: cookie }, redirect: "manual" });
    expect(edit.status).toBe(200);
    // one-time
    expect((await SELF.fetch(link.url, { method: "POST", redirect: "manual" })).status).toBe(404);
    expect((await SELF.fetch(link.url)).status).toBe(404);
  });
});

describe("image sniffing", () => {
  it("reads PNG dimensions and rejects junk", () => {
    const png = Uint8Array.from(atob(PNG_1x1), (c) => c.charCodeAt(0));
    expect(sniffImage(png)).toEqual({ mime: "image/png", width: 1, height: 1 });
    expect(sniffImage(new TextEncoder().encode("<svg onload=alert(1)></svg>"))).toBeNull();
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x10, 0x00, 0x08, 0x00, 0, 0, 0, 0]);
    expect(sniffImage(gif)).toEqual({ mime: "image/gif", width: 16, height: 8 });
  });
});
