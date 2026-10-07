// OAuth 2.1 authorization server for the MCP connector.
//
// Why an authorization server in a service with no accounts: Claude, ChatGPT
// and other MCP hosts need a durable per-user credential. pencil.md's notion
// of a user is the signed `pencil_uid` cookie, so the consent screen simply
// binds the issued tokens to the owner_id of the browser that approves them.
// Everything the agent publishes is then owned by that browser — it shows up
// in /pages and can be edited in the normal editor.
//
// Implements: RFC 7591 dynamic client registration, RFC 7636 PKCE (S256 only),
// RFC 8414 server metadata, RFC 9728 protected-resource metadata, RFC 7009
// revocation, refresh-token rotation. Tokens are opaque random strings stored
// hashed; one D1 lookup verifies a bearer.

import { customAlphabet } from "nanoid";
import { resolveCimdClient, isCimdClientId, verifyClientAssertion } from "./cimd.js";

const TOKEN_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const genToken = customAlphabet(TOKEN_ALPHABET, 43);
const genId = customAlphabet(TOKEN_ALPHABET, 24);

export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
export const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
export const AUTH_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const LOGIN_LINK_TTL_MS = 15 * 60 * 1000; // 15 minutes

export const SCOPES = ["read", "write"] as const;
export type Scope = (typeof SCOPES)[number];
export const DEFAULT_SCOPE = "read write";

export const AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic", "private_key_jwt"] as const;
// Methods a dynamically registered client may pick (private_key_jwt needs a
// JWKS, which only CIMD clients publish).
export const DCR_AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"] as const;

const enc = new TextEncoder();

export function b64url(bytes: Uint8Array | ArrayBuffer): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function sha256b64url(s: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

// Hash secrets/tokens before they touch D1 so a DB leak doesn't leak bearers.
export const hashToken = sha256b64url;

export function newOpaqueToken(prefix: string): string {
  return `${prefix}_${genToken()}`;
}

export function newId(): string {
  return genId();
}

// ---------- scopes ----------

export function parseScope(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_SCOPE;
  if (typeof raw !== "string") return null;
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return DEFAULT_SCOPE;
  for (const p of parts) if (!(SCOPES as readonly string[]).includes(p)) return null;
  return [...new Set(parts)].join(" ");
}

export function hasScope(scope: string, want: Scope): boolean {
  return scope.split(" ").includes(want);
}

// Refreshing may only narrow the original grant.
export function scopeSubset(requested: string, granted: string): boolean {
  const g = new Set(granted.split(" "));
  return requested.split(" ").every((s) => g.has(s));
}

// ---------- redirect URI policy ----------

// Exact-match registration, https only (plus loopback http for local MCP
// clients such as the MCP Inspector / Claude Code). No fragments, no wildcards.
export function isAcceptableRedirectUri(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") {
    return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  }
  return false;
}

// ---------- clients ----------

export type OAuthClient = {
  client_id: string;
  client_secret_hash: string | null;
  client_name: string;
  redirect_uris: string; // JSON array
  token_endpoint_auth_method: string;
  client_uri: string | null;
  logo_uri: string | null;
  created_at: number;
};

export async function getClient(db: D1Database, clientId: string): Promise<OAuthClient | null> {
  if (!clientId || clientId.length > 128) return null;
  const row = await db
    .prepare(
      "SELECT client_id, client_secret_hash, client_name, redirect_uris, token_endpoint_auth_method, client_uri, logo_uri, created_at FROM oauth_clients WHERE client_id = ?",
    )
    .bind(clientId)
    .first<OAuthClient>();
  return row ?? null;
}

// A client is either a registered row (client_id "pc_…") or a CIMD URL.
export type ResolvedClient = OAuthClient & { jwks_uri?: string | null };

export async function resolveClient(db: D1Database, clientId: string): Promise<ResolvedClient | null> {
  if (typeof clientId !== "string" || !clientId) return null;
  if (isCimdClientId(clientId)) return resolveCimdClient(clientId);
  return getClient(db, clientId);
}

// Exact match, except loopback redirects (RFC 8252 §7.3) where the port is
// chosen at runtime — Claude Code registers http://localhost/callback and
// then listens on an ephemeral port.
export function redirectUriMatches(client: OAuthClient, uri: string): boolean {
  const uris = clientRedirectUris(client);
  if (uris.includes(uri)) return true;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" || !(u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]")) return false;
  return uris.some((r) => {
    try {
      const ru = new URL(r);
      return ru.protocol === "http:" && ru.hostname === u.hostname && ru.pathname === u.pathname && ru.search === u.search;
    } catch {
      return false;
    }
  });
}

export function clientRedirectUris(client: OAuthClient): string[] {
  try {
    const arr = JSON.parse(client.redirect_uris) as unknown;
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export type RegisterResult =
  | { ok: true; client: OAuthClient; client_secret: string | null }
  | { ok: false; error: string; description: string };

export async function registerClient(
  db: D1Database,
  body: Record<string, unknown>,
): Promise<RegisterResult> {
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10) {
    return { ok: false, error: "invalid_redirect_uri", description: "redirect_uris must be a non-empty array" };
  }
  for (const u of uris) {
    if (typeof u !== "string" || u.length > 2048 || !isAcceptableRedirectUri(u)) {
      return { ok: false, error: "invalid_redirect_uri", description: `unacceptable redirect_uri: ${String(u).slice(0, 200)}` };
    }
  }
  const method =
    typeof body.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : "client_secret_basic";
  if (!(DCR_AUTH_METHODS as readonly string[]).includes(method)) {
    return { ok: false, error: "invalid_client_metadata", description: "unsupported token_endpoint_auth_method" };
  }
  const grantTypes = Array.isArray(body.grant_types) ? body.grant_types : ["authorization_code", "refresh_token"];
  for (const g of grantTypes) {
    if (g !== "authorization_code" && g !== "refresh_token") {
      return { ok: false, error: "invalid_client_metadata", description: `unsupported grant_type ${String(g)}` };
    }
  }
  const responseTypes = Array.isArray(body.response_types) ? body.response_types : ["code"];
  for (const r of responseTypes) {
    if (r !== "code") {
      return { ok: false, error: "invalid_client_metadata", description: `unsupported response_type ${String(r)}` };
    }
  }
  const name = typeof body.client_name === "string" && body.client_name.trim() ? body.client_name.trim().slice(0, 120) : "Unnamed app";
  const clientUri = safeHttpsUrl(body.client_uri);
  const logoUri = safeHttpsUrl(body.logo_uri);

  const client_id = `pc_${genId()}`;
  const secret = method === "none" ? null : newOpaqueToken("pcs");
  const client: OAuthClient = {
    client_id,
    client_secret_hash: secret ? await hashToken(secret) : null,
    client_name: name,
    redirect_uris: JSON.stringify(uris),
    token_endpoint_auth_method: method,
    client_uri: clientUri,
    logo_uri: logoUri,
    created_at: Date.now(),
  };
  await db
    .prepare(
      "INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, token_endpoint_auth_method, client_uri, logo_uri, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      client.client_id,
      client.client_secret_hash,
      client.client_name,
      client.redirect_uris,
      client.token_endpoint_auth_method,
      client.client_uri,
      client.logo_uri,
      client.created_at,
    )
    .run();
  return { ok: true, client, client_secret: secret };
}

function safeHttpsUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 2048) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

// Verify the client credential presented at the token endpoint according to
// the method it registered with. Public clients (`none`) must NOT present a
// secret that mismatches, but presenting none is fine.
export async function authenticateClient(
  client: ResolvedClient,
  presentedSecret: string | null,
  assertion?: { client_assertion?: string; client_assertion_type?: string; token_endpoint: string; issuer: string },
): Promise<boolean> {
  if (client.token_endpoint_auth_method === "none") return true;
  if (client.token_endpoint_auth_method === "private_key_jwt") {
    if (!assertion?.client_assertion || !client.jwks_uri) return false;
    if (assertion.client_assertion_type !== "urn:ietf:params:oauth:client-assertion-type:jwt-bearer") return false;
    return verifyClientAssertion(assertion.client_assertion, client.client_id, client.jwks_uri, assertion.token_endpoint, assertion.issuer);
  }
  if (!client.client_secret_hash || !presentedSecret) return false;
  if (presentedSecret.length > 256) return false;
  return (await hashToken(presentedSecret)) === client.client_secret_hash;
}

// ---------- PKCE ----------

const CODE_CHALLENGE_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const CODE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

export function isValidCodeChallenge(s: unknown): s is string {
  return typeof s === "string" && CODE_CHALLENGE_RE.test(s);
}

export async function verifyPkce(verifier: unknown, challenge: string): Promise<boolean> {
  if (typeof verifier !== "string" || !CODE_VERIFIER_RE.test(verifier)) return false;
  const computed = await sha256b64url(verifier);
  return computed === challenge;
}

// ---------- authorization codes ----------

export async function issueCode(
  db: D1Database,
  p: { client_id: string; owner_id: string; redirect_uri: string; scope: string; code_challenge: string; resource: string | null },
): Promise<string> {
  const code = newOpaqueToken("pca");
  await db
    .prepare(
      "INSERT INTO oauth_codes (code_hash, client_id, owner_id, redirect_uri, scope, code_challenge, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(await hashToken(code), p.client_id, p.owner_id, p.redirect_uri, p.scope, p.code_challenge, p.resource, Date.now() + AUTH_CODE_TTL_MS)
    .run();
  return code;
}

type CodeRow = {
  code_hash: string;
  client_id: string;
  owner_id: string;
  redirect_uri: string;
  scope: string;
  code_challenge: string;
  resource: string | null;
  expires_at: number;
  used: number;
};

// Atomically consume a code: the UPDATE only succeeds once, so a replayed
// code can never mint a second grant even under concurrent requests.
export async function consumeCode(db: D1Database, code: string): Promise<CodeRow | null> {
  if (typeof code !== "string" || code.length > 128) return null;
  const hash = await hashToken(code);
  const row = await db.prepare("SELECT * FROM oauth_codes WHERE code_hash = ?").bind(hash).first<CodeRow>();
  if (!row) return null;
  const res = await db
    .prepare("UPDATE oauth_codes SET used = 1 WHERE code_hash = ? AND used = 0 AND expires_at > ?")
    .bind(hash, Date.now())
    .run();
  if (!res.meta.changes) return null;
  return row;
}

// ---------- tokens ----------

export type TokenRow = {
  token_hash: string;
  kind: "access" | "refresh";
  grant_id: string;
  client_id: string;
  owner_id: string;
  scope: string;
  expires_at: number;
  created_at: number;
  revoked: number;
};

export type IssuedTokens = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  grant_id: string;
};

export async function issueTokens(
  db: D1Database,
  p: { client_id: string; owner_id: string; scope: string; grant_id?: string },
): Promise<IssuedTokens> {
  const grant_id = p.grant_id ?? newId();
  const access = newOpaqueToken("pat");
  const refresh = newOpaqueToken("prt");
  const now = Date.now();
  const stmt = db.prepare(
    "INSERT INTO oauth_tokens (token_hash, kind, grant_id, client_id, owner_id, scope, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  await db.batch([
    stmt.bind(await hashToken(access), "access", grant_id, p.client_id, p.owner_id, p.scope, now + ACCESS_TOKEN_TTL_MS, now),
    stmt.bind(await hashToken(refresh), "refresh", grant_id, p.client_id, p.owner_id, p.scope, now + REFRESH_TOKEN_TTL_MS, now),
    // Opportunistic GC: expired rows older than a day.
    db.prepare("DELETE FROM oauth_tokens WHERE expires_at < ?").bind(now - 24 * 60 * 60 * 1000),
    db.prepare("DELETE FROM oauth_codes WHERE expires_at < ?").bind(now - 24 * 60 * 60 * 1000),
    db.prepare("DELETE FROM login_links WHERE expires_at < ?").bind(now - 24 * 60 * 60 * 1000),
  ]);
  return { access_token: access, refresh_token: refresh, expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000), scope: p.scope, grant_id };
}

export async function lookupToken(db: D1Database, token: string, kind: "access" | "refresh"): Promise<TokenRow | null> {
  if (typeof token !== "string" || token.length === 0 || token.length > 128) return null;
  const row = await db
    .prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = ?")
    .bind(await hashToken(token), kind)
    .first<TokenRow>();
  if (!row || row.revoked || row.expires_at <= Date.now()) return null;
  return row;
}

// Rotate: retire the presented refresh token (single use) and mint a new pair
// under the same grant. Returns null if the token was already used/expired.
export async function rotateRefreshToken(
  db: D1Database,
  refreshToken: string,
  client_id: string,
  requestedScope: string | null,
): Promise<IssuedTokens | null> {
  const row = await lookupToken(db, refreshToken, "refresh");
  if (!row || row.client_id !== client_id) return null;
  const scope = requestedScope ?? row.scope;
  if (!scopeSubset(scope, row.scope)) return null;
  const res = await db
    .prepare("UPDATE oauth_tokens SET revoked = 1 WHERE token_hash = ? AND revoked = 0")
    .bind(row.token_hash)
    .run();
  if (!res.meta.changes) return null; // lost a race — token already rotated
  return issueTokens(db, { client_id, owner_id: row.owner_id, scope, grant_id: row.grant_id });
}

// RFC 7009: revoking either token kills the whole grant (access + refresh).
export async function revokeToken(db: D1Database, token: string, client_id: string): Promise<void> {
  if (typeof token !== "string" || token.length === 0 || token.length > 128) return;
  const hash = await hashToken(token);
  const row = await db
    .prepare("SELECT grant_id, client_id FROM oauth_tokens WHERE token_hash = ?")
    .bind(hash)
    .first<{ grant_id: string; client_id: string }>();
  if (!row || row.client_id !== client_id) return;
  await db.prepare("UPDATE oauth_tokens SET revoked = 1 WHERE grant_id = ?").bind(row.grant_id).run();
}

// ---------- bearer verification for /mcp ----------

export type Principal = { owner_id: string; scope: string; client_id: string; grant_id: string };

export async function verifyBearer(db: D1Database, authorization: string | undefined): Promise<Principal | null> {
  if (!authorization) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  if (!m) return null;
  const row = await lookupToken(db, m[1]!, "access");
  if (!row) return null;
  return { owner_id: row.owner_id, scope: row.scope, client_id: row.client_id, grant_id: row.grant_id };
}

// ---------- one-time browser login links ----------

export async function issueLoginLink(db: D1Database, owner_id: string): Promise<string> {
  const code = newOpaqueToken("pcl");
  await db
    .prepare("INSERT INTO login_links (code_hash, owner_id, expires_at) VALUES (?, ?, ?)")
    .bind(await hashToken(code), owner_id, Date.now() + LOGIN_LINK_TTL_MS)
    .run();
  return code;
}

export async function peekLoginLink(db: D1Database, code: string): Promise<boolean> {
  if (typeof code !== "string" || code.length > 128) return false;
  const row = await db
    .prepare("SELECT 1 AS one FROM login_links WHERE code_hash = ? AND used = 0 AND expires_at > ?")
    .bind(await hashToken(code), Date.now())
    .first<{ one: number }>();
  return row != null;
}

export async function consumeLoginLink(db: D1Database, code: string): Promise<string | null> {
  if (typeof code !== "string" || code.length > 128) return null;
  const hash = await hashToken(code);
  const row = await db
    .prepare("SELECT owner_id FROM login_links WHERE code_hash = ?")
    .bind(hash)
    .first<{ owner_id: string }>();
  if (!row) return null;
  const res = await db
    .prepare("UPDATE login_links SET used = 1 WHERE code_hash = ? AND used = 0 AND expires_at > ?")
    .bind(hash, Date.now())
    .run();
  return res.meta.changes ? row.owner_id : null;
}

// ---------- metadata documents ----------

export function authorizationServerMetadata(origin: string): Record<string, unknown> {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    scopes_supported: [...SCOPES],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [...AUTH_METHODS],
    token_endpoint_auth_signing_alg_values_supported: ["RS256", "ES256"],
    revocation_endpoint_auth_methods_supported: [...AUTH_METHODS],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${origin}/connect`,
    op_policy_uri: `${origin}/privacy`,
    op_tos_uri: `${origin}/terms`,
  };
}

export function protectedResourceMetadata(origin: string): Record<string, unknown> {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "pencil.md",
    resource_documentation: `${origin}/connect`,
    resource_policy_uri: `${origin}/privacy`,
    resource_tos_uri: `${origin}/terms`,
  };
}
