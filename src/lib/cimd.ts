// OAuth Client ID Metadata Documents (CIMD): the client_id is an HTTPS URL
// that serves a JSON document describing the client (redirect URIs, name,
// auth method). Claude and ChatGPT both prefer this over dynamic registration
// — e.g. https://chatgpt.com/oauth/client.json — so no per-connection
// registration row is needed. Documents are cached at the edge for an hour.
//
// Also verifies `private_key_jwt` client assertions (RS256 / ES256 against
// the document's jwks_uri), which ChatGPT's CIMD document declares.

import type { OAuthClient } from "./oauth.js";

const DOC_MAX_BYTES = 64 * 1024;
const CACHE_TTL_SECONDS = 3600;

export function isCimdClientId(clientId: string): boolean {
  if (clientId.length > 512) return false;
  let u: URL;
  try {
    u = new URL(clientId);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.hostname === "localhost" || /^(\d+\.){3}\d+$/.test(u.hostname) || u.hostname.startsWith("[")) return false;
  if (u.username || u.password || u.hash) return false;
  // Must have a non-root path (spec: a document, not a bare origin).
  return u.pathname.length > 1;
}

type CimdDoc = {
  client_id?: unknown;
  client_name?: unknown;
  client_uri?: unknown;
  logo_uri?: unknown;
  redirect_uris?: unknown;
  token_endpoint_auth_method?: unknown;
  token_endpoint_auth_methods_supported?: unknown;
  jwks_uri?: unknown;
  jwks?: unknown;
};

async function fetchJson(url: string): Promise<unknown | null> {
  const cache = (caches as unknown as { default: Cache }).default;
  const req = new Request(url, { headers: { Accept: "application/json" } });
  let res = await cache.match(req).catch(() => undefined);
  if (!res) {
    try {
      res = await fetch(req, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
    } catch {
      return null;
    }
    if (!res.ok) return null;
    const len = Number.parseInt(res.headers.get("Content-Length") ?? "0", 10);
    if (len > DOC_MAX_BYTES) return null;
    const text = await res.text();
    if (text.length > DOC_MAX_BYTES) return null;
    res = new Response(text, { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}` } });
    try {
      await cache.put(req, res.clone());
    } catch {
      /* cache unavailable (tests) — fine */
    }
  }
  try {
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

// Resolve a CIMD client_id to the same shape as a registered client, so the
// authorize/token endpoints don't care which registration style was used.
export async function resolveCimdClient(clientId: string): Promise<(OAuthClient & { jwks_uri: string | null }) | null> {
  if (!isCimdClientId(clientId)) return null;
  const doc = (await fetchJson(clientId)) as CimdDoc | null;
  if (!doc || typeof doc !== "object") return null;
  if (doc.client_id !== clientId) return null;
  const uris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris.filter((u): u is string => typeof u === "string") : [];
  if (uris.length === 0) return null;
  // Pick an auth method we can verify: prefer `none` when the client allows
  // it, else private_key_jwt when a JWKS is published.
  const supported = Array.isArray(doc.token_endpoint_auth_methods_supported)
    ? doc.token_endpoint_auth_methods_supported.filter((m): m is string => typeof m === "string")
    : typeof doc.token_endpoint_auth_method === "string"
      ? [doc.token_endpoint_auth_method]
      : ["none"];
  const jwksUri = typeof doc.jwks_uri === "string" && doc.jwks_uri.startsWith("https://") ? doc.jwks_uri : null;
  let method: string;
  if (supported.includes("none")) method = "none";
  else if (supported.includes("private_key_jwt") && jwksUri) method = "private_key_jwt";
  else return null;
  return {
    client_id: clientId,
    client_secret_hash: null,
    client_name: typeof doc.client_name === "string" ? doc.client_name.slice(0, 120) : new URL(clientId).hostname,
    redirect_uris: JSON.stringify(uris),
    token_endpoint_auth_method: method,
    client_uri: typeof doc.client_uri === "string" ? doc.client_uri : null,
    logo_uri: typeof doc.logo_uri === "string" ? doc.logo_uri : null,
    created_at: 0,
    jwks_uri: jwksUri,
  };
}

// ---------- private_key_jwt ----------

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  let t = s.replaceAll("-", "+").replaceAll("_", "/");
  const pad = t.length % 4;
  if (pad) t += "=".repeat(4 - pad);
  const bin = atob(t);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

type Jwk = JsonWebKey & { kid?: string; alg?: string; kty?: string };

export async function verifyClientAssertion(
  assertion: string,
  clientId: string,
  jwksUri: string,
  tokenEndpoint: string,
  issuer: string,
): Promise<boolean> {
  if (typeof assertion !== "string" || assertion.length > 8192) return false;
  const parts = assertion.split(".");
  if (parts.length !== 3) return false;
  let header: { alg?: string; kid?: string };
  let claims: { iss?: unknown; sub?: unknown; aud?: unknown; exp?: unknown };
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0]!))) as typeof header;
    claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1]!))) as typeof claims;
  } catch {
    return false;
  }
  if (claims.iss !== clientId || claims.sub !== clientId) return false;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(tokenEndpoint) && !aud.includes(issuer) && !aud.includes(`${issuer}/`)) return false;
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) return false;
  const alg = header.alg;
  if (alg !== "RS256" && alg !== "ES256") return false;

  const jwks = (await fetchJson(jwksUri)) as { keys?: Jwk[] } | null;
  const keys = Array.isArray(jwks?.keys) ? jwks!.keys! : [];
  const candidates = keys.filter((k) => (header.kid ? k.kid === header.kid : true));
  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const sig = b64urlToBytes(parts[2]!);
  for (const jwk of candidates) {
    try {
      const key =
        alg === "RS256"
          ? await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"])
          : await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      const ok =
        alg === "RS256"
          ? await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, data)
          : await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, data);
      if (ok) return true;
    } catch {
      /* try next key */
    }
  }
  return false;
}
