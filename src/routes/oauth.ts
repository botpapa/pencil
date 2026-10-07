// OAuth 2.1 endpoints for the MCP connector, plus discovery documents and the
// one-time browser login link. Mounted on the main host at:
//
//   GET  /.well-known/oauth-authorization-server[/mcp]
//   GET  /.well-known/oauth-protected-resource[/mcp]
//   POST /oauth/register           dynamic client registration (RFC 7591)
//   GET  /oauth/authorize          consent screen (needs the owner cookie)
//   POST /oauth/authorize          allow / deny
//   POST /oauth/token              authorization_code (PKCE) + refresh_token
//   POST /oauth/revoke             RFC 7009
//   GET  /connect/claim/:code      "sign this browser in" confirmation
//   POST /connect/claim/:code      sets the owner cookie, redirects to /pages

import { Hono } from "hono";
import { cors } from "hono/cors";
import { setCookie } from "hono/cookie";
import { ensureOwnerCookie, signCookie } from "../lib/auth.js";
import { ownerHasPages } from "../lib/db.js";
import { rejectIfOversize } from "../lib/limits.js";
import { originUrl } from "../lib/http.js";
import {
  authorizationServerMetadata,
  protectedResourceMetadata,
  registerClient,
  resolveClient,
  clientRedirectUris,
  redirectUriMatches,
  authenticateClient,
  parseScope,
  isValidCodeChallenge,
  verifyPkce,
  issueCode,
  consumeCode,
  issueTokens,
  rotateRefreshToken,
  revokeToken,
  consumeLoginLink,
  peekLoginLink,
  b64url,
} from "../lib/oauth.js";
import { consentPage, consentErrorPage, claimPage, redirectPage } from "../views/connect.js";
import type { AppEnv } from "../types.js";

const app = new Hono<AppEnv>();

const MAX_OAUTH_BODY = 16 * 1024;
const TXN_TTL_MS = 10 * 60 * 1000;

// Token-ish endpoints are called server-to-server by MCP hosts but some
// browser-based MCP clients (e.g. the MCP Inspector) call them cross-origin.
const openCors = cors({
  origin: "*",
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Authorization", "Content-Type", "MCP-Protocol-Version"],
  maxAge: 86400,
});

const noStore = { "Cache-Control": "no-store", Pragma: "no-cache" };

function oauthError(c: { json: (b: unknown, s: 400 | 401 | 403) => Response }, error: string, description: string, status: 400 | 401 | 403 = 400): Response {
  return c.json({ error, error_description: description }, status);
}

// ---------- discovery ----------

for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/mcp"]) {
  app.use(path, openCors);
  app.get(path, (c) => c.json(authorizationServerMetadata(originUrl(c)), 200, { "Cache-Control": "public, max-age=3600" }));
}
for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
  app.use(path, openCors);
  app.get(path, (c) => c.json(protectedResourceMetadata(originUrl(c)), 200, { "Cache-Control": "public, max-age=3600" }));
}

// ---------- dynamic client registration ----------

app.use("/oauth/register", openCors);
app.post("/oauth/register", async (c) => {
  const tooBig = rejectIfOversize(c, MAX_OAUTH_BODY);
  if (tooBig) return tooBig;
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return oauthError(c, "invalid_client_metadata", "body must be JSON");
  }
  if (typeof body !== "object" || body === null) return oauthError(c, "invalid_client_metadata", "body must be an object");
  const r = await registerClient(c.env.DB, body);
  if (!r.ok) return oauthError(c, r.error, r.description);
  const { client, client_secret } = r;
  return c.json(
    {
      client_id: client.client_id,
      ...(client_secret ? { client_secret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(client.created_at / 1000),
      client_name: client.client_name,
      redirect_uris: clientRedirectUris(client),
      token_endpoint_auth_method: client.token_endpoint_auth_method,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...(client.client_uri ? { client_uri: client.client_uri } : {}),
      ...(client.logo_uri ? { logo_uri: client.logo_uri } : {}),
    },
    201,
    noStore,
  );
});

// ---------- authorization (consent) ----------

type AuthzRequest = {
  client_id: string;
  redirect_uri: string;
  scope: string;
  state: string;
  code_challenge: string;
  resource: string | null;
};

// Validate the front-channel request. Errors that can't be safely redirected
// (unknown client / bad redirect_uri) are rendered; the rest go back to the
// client per RFC 6749 §4.1.2.1.
async function parseAuthzRequest(
  c: import("hono").Context<AppEnv>,
  q: Record<string, string | undefined>,
): Promise<{ ok: true; req: AuthzRequest; clientName: string } | { ok: false; response: Response }> {
  const client = await resolveClient(c.env.DB, q.client_id ?? "");
  if (!client) return { ok: false, response: c.html(consentErrorPage("Unknown app", "This app is not registered with pencil.md. Try adding the connector again."), 400) };
  const uris = clientRedirectUris(client);
  const redirect = q.redirect_uri ?? (uris.length === 1 ? uris[0]! : "");
  if (!redirect || !redirectUriMatches(client, redirect)) {
    return { ok: false, response: c.html(consentErrorPage("Bad redirect", "The redirect address doesn't match what this app registered."), 400) };
  }
  const back = (error: string, description: string): Response => {
    const u = new URL(redirect);
    u.searchParams.set("iss", originUrl(c));
    u.searchParams.set("error", error);
    u.searchParams.set("error_description", description);
    if (q.state) u.searchParams.set("state", q.state);
    return c.redirect(u.toString(), 302);
  };
  if (q.response_type !== "code") return { ok: false, response: back("unsupported_response_type", "only response_type=code is supported") };
  if (!isValidCodeChallenge(q.code_challenge)) return { ok: false, response: back("invalid_request", "code_challenge (S256) is required") };
  if ((q.code_challenge_method ?? "S256") !== "S256") return { ok: false, response: back("invalid_request", "only S256 is supported") };
  const scope = parseScope(q.scope);
  if (scope === null) return { ok: false, response: back("invalid_scope", "unknown scope") };
  const state = (q.state ?? "").slice(0, 1024);
  let resource: string | null = null;
  if (q.resource) {
    if (q.resource !== `${originUrl(c)}/mcp`) return { ok: false, response: back("invalid_target", "unknown resource") };
    resource = q.resource;
  }
  return { ok: true, req: { client_id: client.client_id, redirect_uri: redirect, scope, state, code_challenge: q.code_challenge, resource }, clientName: client.client_name };
}

// The consent form carries the request back signed, bound to the approving
// owner and a short expiry, so a forged POST can't mint a code.
async function signTxn(secret: string, ownerId: string, req: AuthzRequest, exp: number): Promise<string> {
  const payload = JSON.stringify({ ...req, owner: ownerId, exp });
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${b64url(new TextEncoder().encode(payload))}.${b64url(sig)}`;
}

async function verifyTxn(secret: string, ownerId: string, txn: string): Promise<AuthzRequest | null> {
  if (typeof txn !== "string" || txn.length > 8192) return null;
  const dot = txn.lastIndexOf(".");
  if (dot < 1) return null;
  let payload: string;
  try {
    payload = new TextDecoder().decode(Uint8Array.from(atob(txn.slice(0, dot).replaceAll("-", "+").replaceAll("_", "/")), (ch) => ch.charCodeAt(0)));
  } catch {
    return null;
  }
  let parsed: AuthzRequest & { owner: string; exp: number };
  try {
    parsed = JSON.parse(payload) as typeof parsed;
  } catch {
    return null;
  }
  if (parsed.owner !== ownerId || typeof parsed.exp !== "number" || parsed.exp < Date.now()) return null;
  const { owner, exp, ...req } = parsed;
  const expected = await signTxn(secret, owner, req, exp);
  if (expected.length !== txn.length) return null;
  let diff = 0;
  for (let i = 0; i < txn.length; i++) diff |= txn.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0 ? req : null;
}

app.get("/oauth/authorize", async (c) => {
  const parsed = await parseAuthzRequest(c, c.req.query());
  if (!parsed.ok) return parsed.response;
  await ensureOwnerCookie(c);
  const ownerId = c.get("ownerId");
  const hasPages = await ownerHasPages(c.env.DB, ownerId);
  const txn = await signTxn(c.env.COOKIE_SECRET, ownerId, parsed.req, Date.now() + TXN_TTL_MS);
  return c.html(
    consentPage({
      clientName: parsed.clientName,
      scope: parsed.req.scope,
      redirectHost: new URL(parsed.req.redirect_uri).host,
      txn,
      hasPages,
      isNewOwner: c.get("isNewOwner"),
    }),
    200,
    noStore,
  );
});

app.post("/oauth/authorize", async (c) => {
  const tooBig = rejectIfOversize(c, MAX_OAUTH_BODY, "text");
  if (tooBig) return tooBig;
  await ensureOwnerCookie(c);
  const ownerId = c.get("ownerId");
  const form = await c.req.formData();
  const req = await verifyTxn(c.env.COOKIE_SECRET, ownerId, String(form.get("txn") ?? ""));
  if (!req) return c.html(consentErrorPage("Expired", "This approval screen expired or was opened in a different browser. Go back to the app and try connecting again."), 400);
  const u = new URL(req.redirect_uri);
  u.searchParams.set("iss", originUrl(c)); // RFC 9207
  if (req.state) u.searchParams.set("state", req.state);
  const client = await resolveClient(c.env.DB, req.client_id);
  const clientName = client?.client_name ?? "the app";
  if (form.get("action") !== "allow") {
    u.searchParams.set("error", "access_denied");
    u.searchParams.set("error_description", "the user declined");
    return c.html(redirectPage(u.toString(), clientName, false), 200, noStore);
  }
  const code = await issueCode(c.env.DB, {
    client_id: req.client_id,
    owner_id: ownerId,
    redirect_uri: req.redirect_uri,
    scope: req.scope,
    code_challenge: req.code_challenge,
    resource: req.resource,
  });
  u.searchParams.set("code", code);
  // 200 + meta refresh rather than 302 — see redirectPage().
  return c.html(redirectPage(u.toString(), clientName, true), 200, noStore);
});

// ---------- token ----------

async function readTokenForm(c: import("hono").Context<AppEnv>): Promise<Record<string, string> | null> {
  const ct = c.req.header("Content-Type") ?? "";
  try {
    if (ct.includes("application/json")) {
      const j = (await c.req.json()) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(j)) if (typeof v === "string") out[k] = v;
      return out;
    }
    const form = await c.req.formData();
    const out: Record<string, string> = {};
    form.forEach((v, k) => {
      if (typeof v === "string") out[k] = v;
    });
    return out;
  } catch {
    return null;
  }
}

// client_id/secret may come from HTTP Basic (client_secret_basic) or the body
// (client_secret_post / none).
function clientCredentials(c: import("hono").Context<AppEnv>, form: Record<string, string>): { id: string; secret: string | null } {
  const auth = c.req.header("Authorization") ?? "";
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(auth.trim());
  if (m) {
    try {
      const decoded = atob(m[1]!);
      const i = decoded.indexOf(":");
      if (i > 0) return { id: decodeURIComponent(decoded.slice(0, i)), secret: decodeURIComponent(decoded.slice(i + 1)) };
    } catch {
      /* fall through to body */
    }
  }
  let id = form.client_id ?? "";
  if (!id && form.client_assertion) {
    // private_key_jwt clients may omit client_id; it is the assertion's `iss`.
    try {
      const payload = form.client_assertion.split(".")[1] ?? "";
      const json = JSON.parse(atob(payload.replaceAll("-", "+").replaceAll("_", "/"))) as { iss?: unknown };
      if (typeof json.iss === "string") id = json.iss;
    } catch {
      /* leave empty → invalid_client */
    }
  }
  return { id, secret: form.client_secret ?? null };
}

app.use("/oauth/token", openCors);
app.post("/oauth/token", async (c) => {
  const tooBig = rejectIfOversize(c, MAX_OAUTH_BODY);
  if (tooBig) return tooBig;
  const form = await readTokenForm(c);
  if (!form) return oauthError(c, "invalid_request", "malformed body");
  const cred = clientCredentials(c, form);
  const client = await resolveClient(c.env.DB, cred.id);
  if (!client) return c.json({ error: "invalid_client", error_description: "unknown client" }, 401, { "WWW-Authenticate": 'Basic realm="pencil.md"', ...noStore });
  if (!(await authenticateClient(client, cred.secret, { client_assertion: form.client_assertion, client_assertion_type: form.client_assertion_type, token_endpoint: `${originUrl(c)}/oauth/token`, issuer: originUrl(c) }))) {
    return c.json({ error: "invalid_client", error_description: "client authentication failed" }, 401, { "WWW-Authenticate": 'Basic realm="pencil.md"', ...noStore });
  }

  if (form.grant_type === "authorization_code") {
    const row = await consumeCode(c.env.DB, form.code ?? "");
    if (!row || row.client_id !== client.client_id) return oauthError(c, "invalid_grant", "code is invalid, expired or already used");
    if (form.redirect_uri !== undefined && form.redirect_uri !== row.redirect_uri) return oauthError(c, "invalid_grant", "redirect_uri mismatch");
    if (!(await verifyPkce(form.code_verifier, row.code_challenge))) return oauthError(c, "invalid_grant", "PKCE verification failed");
    if (form.resource && form.resource !== `${originUrl(c)}/mcp`) return oauthError(c, "invalid_target", "unknown resource");
    const t = await issueTokens(c.env.DB, { client_id: client.client_id, owner_id: row.owner_id, scope: row.scope });
    return c.json({ access_token: t.access_token, token_type: "Bearer", expires_in: t.expires_in, refresh_token: t.refresh_token, scope: t.scope }, 200, noStore);
  }

  if (form.grant_type === "refresh_token") {
    const scope = form.scope === undefined ? null : parseScope(form.scope);
    if (form.scope !== undefined && scope === null) return oauthError(c, "invalid_scope", "unknown scope");
    const t = await rotateRefreshToken(c.env.DB, form.refresh_token ?? "", client.client_id, scope);
    if (!t) return oauthError(c, "invalid_grant", "refresh token is invalid, expired or already used");
    return c.json({ access_token: t.access_token, token_type: "Bearer", expires_in: t.expires_in, refresh_token: t.refresh_token, scope: t.scope }, 200, noStore);
  }

  return oauthError(c, "unsupported_grant_type", "use authorization_code or refresh_token");
});

// ---------- revocation ----------

app.use("/oauth/revoke", openCors);
app.post("/oauth/revoke", async (c) => {
  const tooBig = rejectIfOversize(c, MAX_OAUTH_BODY);
  if (tooBig) return tooBig;
  const form = await readTokenForm(c);
  if (!form) return oauthError(c, "invalid_request", "malformed body");
  const cred = clientCredentials(c, form);
  const client = await resolveClient(c.env.DB, cred.id);
  if (!client || !(await authenticateClient(client, cred.secret, { client_assertion: form.client_assertion, client_assertion_type: form.client_assertion_type, token_endpoint: `${originUrl(c)}/oauth/token`, issuer: originUrl(c) }))) {
    return c.json({ error: "invalid_client" }, 401, noStore);
  }
  await revokeToken(c.env.DB, form.token ?? "", client.client_id);
  // RFC 7009: 200 even for unknown tokens.
  return c.body(null, 200, noStore);
});

// ---------- one-time browser login ----------

app.get("/connect/claim/:code", async (c) => {
  const code = c.req.param("code");
  const valid = await peekLoginLink(c.env.DB, code);
  return c.html(claimPage(code, valid), valid ? 200 : 404, noStore);
});

app.post("/connect/claim/:code", async (c) => {
  const ownerId = await consumeLoginLink(c.env.DB, c.req.param("code"));
  if (!ownerId) return c.html(claimPage(c.req.param("code"), false), 404, noStore);
  const signed = await signCookie(ownerId, c.env.COOKIE_SECRET);
  const host = (c.req.header("host") ?? "").split(":")[0]!.toLowerCase();
  const domain = host === "pencil.md" || host.endsWith(".pencil.md") ? ".pencil.md" : undefined;
  setCookie(c, "pencil_uid", signed, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 400,
    ...(domain ? { domain } : {}),
  });
  return c.redirect("/pages", 303);
});

export default app;
