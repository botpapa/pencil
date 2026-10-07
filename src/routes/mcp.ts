// MCP endpoint: POST /mcp (Streamable HTTP, stateless, JSON responses only).
//
// Dual-era: a request whose params._meta carries
// "io.modelcontextprotocol/protocolVersion" is served per revision 2026-07-28
// (header/body validation, server/discover, resultType, cache hints); anything
// else is served per the legacy initialize-handshake revisions (2025-11-25
// and earlier). No sessions are minted in either case.
//
// Every message needs a bearer token; without one the response is a 401 with
// the RFC 9728 pointer so hosts (Claude, ChatGPT, Claude Code…) start OAuth.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { verifyBearer, type Principal } from "../lib/oauth.js";
import { rejectIfOversize } from "../lib/limits.js";
import { originUrl } from "../lib/http.js";
import { dispatch, drawOriginFor, RpcError, MODERN_VERSIONS, LEGACY_VERSIONS, SUPPORTED_VERSIONS, PROTOCOL_VERSION_META, type RpcId } from "../lib/mcp.js";
import type { AppEnv } from "../types.js";

const app = new Hono<AppEnv>();

// Body cap: a page (512 KB) or a base64 image (5 MB × 4/3) plus envelope.
const MAX_MCP_BODY = 8 * 1024 * 1024;

app.use(
  "/mcp",
  cors({
    origin: "*",
    allowMethods: ["POST", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type", "Accept", "MCP-Protocol-Version", "Mcp-Method", "Mcp-Name", "Mcp-Session-Id"],
    exposeHeaders: ["WWW-Authenticate"],
    maxAge: 86400,
  }),
);

function rpcError(id: RpcId, code: number, message: string, data?: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });
}

function unauthorized(origin: string, description: string): Response {
  const www = `Bearer error="invalid_token", error_description="${description}", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="read write"`;
  return json(rpcError(null, -32001, description), 401, { "WWW-Authenticate": www });
}

// Decode the Base64 sentinel form of Mcp-Name / Mcp-Param-* header values.
function decodeHeaderValue(v: string): string {
  if (v.startsWith("=?base64?") && v.endsWith("?=")) {
    try {
      return new TextDecoder().decode(Uint8Array.from(atob(v.slice(9, -2)), (ch) => ch.charCodeAt(0)));
    } catch {
      return v;
    }
  }
  return v;
}

for (const m of ["GET", "DELETE", "PUT", "PATCH"] as const) {
  app.on(m, "/mcp", (c) =>
    json(rpcError(null, -32000, "This MCP endpoint is stateless: send each JSON-RPC message as a POST."), 405, { Allow: "POST, OPTIONS" }),
  );
}

app.post("/mcp", async (c) => {
  const origin = originUrl(c);
  const tooBig = rejectIfOversize(c, MAX_MCP_BODY);
  if (tooBig) return tooBig;

  let msg: unknown;
  try {
    msg = await c.req.json();
  } catch {
    return json(rpcError(null, -32700, "Parse error: body must be a single JSON-RPC message"), 400);
  }
  if (Array.isArray(msg)) return json(rpcError(null, -32600, "Batches are not supported; send one message per POST"), 400);
  if (!msg || typeof msg !== "object") return json(rpcError(null, -32600, "Invalid Request"), 400);
  const req = msg as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id: RpcId = typeof req.id === "string" || typeof req.id === "number" ? req.id : null;
  const isNotification = req.id === undefined;
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") return json(rpcError(id, -32600, "Invalid Request: jsonrpc must be \"2.0\" and method a string"), 400);
  const method = req.method;
  const params = req.params && typeof req.params === "object" && !Array.isArray(req.params) ? (req.params as Record<string, unknown>) : {};
  const meta = params._meta && typeof params._meta === "object" ? (params._meta as Record<string, unknown>) : {};
  const bodyVersion = meta[PROTOCOL_VERSION_META];
  const headerVersion = c.req.header("MCP-Protocol-Version");

  // ---------- era + validation ----------
  let era: "modern" | "legacy";
  let legacyVersion = "2025-11-25";
  if (typeof bodyVersion === "string") {
    era = "modern";
    if (!headerVersion) return json(rpcError(id, -32020, "Header mismatch: MCP-Protocol-Version header is required"), 400);
    if (headerVersion !== bodyVersion) return json(rpcError(id, -32020, `Header mismatch: MCP-Protocol-Version header value '${headerVersion.slice(0, 32)}' does not match body value '${bodyVersion.slice(0, 32)}'`), 400);
    if (!(MODERN_VERSIONS as readonly string[]).includes(bodyVersion)) {
      return json(rpcError(id, -32022, "Unsupported protocol version", { supported: [...SUPPORTED_VERSIONS], requested: bodyVersion.slice(0, 32) }), 400);
    }
    if (!isNotification) {
      const hm = c.req.header("Mcp-Method");
      if (hm === undefined) return json(rpcError(id, -32020, "Header mismatch: Mcp-Method header is required"), 400);
      if (hm !== method) return json(rpcError(id, -32020, `Header mismatch: Mcp-Method header value '${hm.slice(0, 64)}' does not match body value '${method.slice(0, 64)}'`), 400);
      if (method === "tools/call" || method === "resources/read" || method === "prompts/get") {
        const want = method === "resources/read" ? params.uri : params.name;
        const hn = c.req.header("Mcp-Name");
        if (hn === undefined) return json(rpcError(id, -32020, "Header mismatch: Mcp-Name header is required"), 400);
        if (typeof want !== "string" || decodeHeaderValue(hn) !== want) return json(rpcError(id, -32020, `Header mismatch: Mcp-Name header value '${hn.slice(0, 64)}' does not match body value '${String(want).slice(0, 64)}'`), 400);
      }
    }
  } else {
    era = "legacy";
    // Legacy clients name the version in initialize.params or the header.
    const want = typeof params.protocolVersion === "string" ? params.protocolVersion : headerVersion;
    if (want && (LEGACY_VERSIONS as readonly string[]).includes(want)) legacyVersion = want;
    if (headerVersion && !(SUPPORTED_VERSIONS as readonly string[]).includes(headerVersion)) {
      return json(rpcError(id, -32022, "Unsupported protocol version", { supported: [...SUPPORTED_VERSIONS], requested: headerVersion.slice(0, 32) }), 400);
    }
  }

  // ---------- auth ----------
  const principal: Principal | null = await verifyBearer(c.env.DB, c.req.header("Authorization"));
  if (!principal) return unauthorized(origin, "Authentication required: connect pencil.md to continue");

  // ---------- notifications ----------
  if (isNotification) return new Response(null, { status: 202 });

  // ---------- dispatch ----------
  const ctx = { env: c.env, principal, origin, drawOrigin: drawOriginFor(origin), waitUntil: (p: Promise<unknown>) => c.executionCtx.waitUntil(p) };
  try {
    const result = await dispatch(method, params, ctx, era, legacyVersion);
    return json({ jsonrpc: "2.0", id, result }, 200);
  } catch (err) {
    if (err instanceof RpcError) return json(rpcError(id, err.code, err.message, err.data), err.httpStatus);
    console.error("mcp tool failure", { method, name: typeof params.name === "string" ? params.name : undefined, err: err instanceof Error ? err.message : String(err) });
    return json(rpcError(id, -32603, "Internal error"), 200);
  }
});

export default app;
