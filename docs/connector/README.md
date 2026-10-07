# pencil.md connector — submission kit

Everything needed to list the pencil.md MCP server in the **Claude connector
directory** and the **ChatGPT plugin directory**. The server itself is live at
`https://pencil.md/mcp`; this folder is the paperwork.

Both portals require the submitter's own account (Claude Pro/Max/Team owner;
OpenAI org owner), so the final "Submit" click is manual. Everything else is
prepared here.

## 0. Preflight (run before either submission)

```bash
curl -s https://pencil.md/.well-known/oauth-protected-resource/mcp | jq .
curl -s https://pencil.md/.well-known/oauth-authorization-server | jq .
curl -si -X POST https://pencil.md/mcp -H 'Content-Type: application/json' \
  -H 'MCP-Protocol-Version: 2026-07-28' -H 'Mcp-Method: server/discover' \
  -d '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}'
# → 401 with WWW-Authenticate: Bearer … resource_metadata="https://pencil.md/.well-known/oauth-protected-resource/mcp"
```

Then do one real end-to-end connect from each host (see §3) and keep the
screen recording — OpenAI asks for a video walkthrough.

## 1. Claude connector directory

Portal: <https://claude.ai/directory/manage> → **Submit new** → **MCP
connector**. Docs: <https://claude.com/docs/connectors/building/submission>.

| Field | Value |
| --- | --- |
| Server name | `pencil.md` |
| One-liner (≤200) | Publish markdown pages and canvas drawings from Claude, share the link, keep editing. |
| Description (≤2000) | see `claude-listing.md` |
| Categories | Productivity; Writing; Design / Whiteboarding (pick what the form offers) |
| MCP server URL | `https://pencil.md/mcp` |
| Auth type | `oauth_cimd` + `oauth_dcr` (both supported; server advertises `client_id_metadata_document_supported: true`) |
| Documentation URL | `https://pencil.md/connect` |
| Privacy policy | `https://pencil.md/privacy` |
| Terms | `https://pencil.md/terms` |
| Support contact | `hello@pencil.md` |
| Icon | `openai-plugin/assets/logo.png` (512×512 PNG; Anthropic publishes no size spec) |
| Company | pencil.md (open source, MIT) — website `https://pencil.md`, repo `https://github.com/botpapa/pencil` |
| Test account | **None needed.** pencil.md has no accounts: the OAuth consent screen works in any browser and creates an anonymous identity on "allow". State this verbatim in the test-credentials field, plus the walkthrough in `test-cases.md`. |
| Data handling | Calls our own first-party API only; no third-party data; no health data; no sponsored content. Pages are public by link unless password-protected (declare this). |

Review notes: every tool carries `title`, `readOnlyHint`/`destructiveHint`/
`idempotentHint`/`openWorldHint` and a `securitySchemes` entry; read tools
are separate from write tools; errors are specific and actionable; no
conversation data is requested; no image generation (images are only hosted).

## 2. ChatGPT plugin directory

Portal: <https://platform.openai.com/plugins>. Docs:
<https://developers.openai.com/plugins/deploy/submission>.

1. **Domain verification** — the portal issues a challenge token for
   `pencil.md`. Set it on the Worker and redeploy:
   ```bash
   cd /home/pencil
   npx wrangler secret put OPENAI_APPS_CHALLENGE --config wrangler.local.jsonc   # paste the token
   curl https://pencil.md/.well-known/openai-apps-challenge                      # must echo it
   ```
2. **Developer identity verification** in the Platform dashboard (manual).
3. **Build the ZIP** (plugin root must contain `plugin.json`, `mcp.json`, `assets/`):
   ```bash
   cd docs/connector/openai-plugin && zip -r ../pencil-md-plugin.zip plugin.json mcp.json assets
   ```
4. Upload the ZIP → fix any automated findings → MCP server step: URL
   `https://pencil.md/mcp`, auth **OAuth**. ChatGPT uses CIMD
   (`client_id = https://chatgpt.com/oauth/client.json`) automatically; if the
   portal shows a callback-ID-specific redirect
   (`https://chatgpt.com/connector/oauth/{id}`) nothing changes on our side —
   the redirect URI comes from ChatGPT's own metadata document. No predefined
   client credentials are required.
5. **Review materials**: 5 positive + 3 negative test cases → `test-cases.md`;
   video walkthrough (record the §3 flow); test account → "not applicable, no
   accounts; consent screen creates an anonymous identity"; release notes →
   "Initial release: publish/edit markdown pages, upload images, create/edit
   canvas drawings, browser sign-in link."
6. Attestations → submit → pick publish time.

Listing fields are already in `openai-plugin/plugin.json`
(`extensions.com.openai.interface`). Logo 512×512, composer icon 256×256.

## 3. Manual end-to-end check (also the video script)

1. In Claude: Settings → Connectors → Add custom connector → URL
   `https://pencil.md/mcp` → Connect. The pencil.md consent screen opens →
   **allow** → back in Claude, the connector shows 14 tools.
2. Ask: *"Publish a short page titled Hello from Claude with a heading and a
   list, then give me the link."* → Claude calls `create_page` → open the link.
3. Ask: *"Add a second section to that page."* → `update_page`; reload.
4. Ask: *"Make a drawing with a title and two boxes connected by an arrow."*
   → `create_drawing` → open `draw.pencil.md/<slug>`.
5. Ask: *"Give me a sign-in link so I can edit these in my browser."* →
   `get_browser_login_link` → open it → click **sign in here** → `/pages`
   lists the page; the editor opens.
6. Disconnect the connector; any further tool call returns 401 → Claude asks
   to reconnect.

Repeat in ChatGPT (Settings → Apps & Connectors → developer mode → add
`https://pencil.md/mcp`, OAuth).

## 4. Operations

- Rate limit at the edge (Cloudflare → WAF → Rate limiting rules):
  `/oauth/*` POST — 50 req / 10 s / IP. `/mcp` is **not** IP-limited: Claude
  and ChatGPT egress from a handful of shared IPs.
- Tokens: access 1 h, refresh 90 d (rotated on use). Revoking either token
  kills the grant. Expired rows are garbage-collected lazily on token issue.
- To revoke a misbehaving client entirely:
  `wrangler d1 execute pencil-md --remote --config wrangler.local.jsonc --command "UPDATE oauth_tokens SET revoked=1 WHERE client_id='…'"`.
- Logs: `wrangler tail pencil-md --config wrangler.local.jsonc` — tool
  failures log as `mcp tool failure` with method + tool name only.
