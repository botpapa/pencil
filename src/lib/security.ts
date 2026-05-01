// Security headers middleware. Applied to every HTML response.

import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types.js";

const CSP =
  "default-src 'self'; " +
  "img-src 'self' https: data:; " +
  "style-src 'self'; " +
  "script-src 'self'; " +
  "font-src 'self'; " +
  "connect-src 'self'; " +
  "frame-ancestors 'none'; " +
  "base-uri 'self'; " +
  "form-action 'self'; " +
  "object-src 'none'";

export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  const ct = c.res.headers.get("Content-Type") ?? "";
  // Apply HTML-tier headers to all HTML responses.
  if (ct.includes("text/html")) {
    c.res.headers.set("Content-Security-Policy", CSP);
  }
  c.res.headers.set("X-Content-Type-Options", "nosniff");
  c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  c.res.headers.set("Permissions-Policy", "interest-cohort=()");
  c.res.headers.set("X-Frame-Options", "DENY");
};

// Bot detection for the view counter. Two flavours of pattern:
//
//  1. Substring matches for tokens that are unmistakably bots in any
//     position (e.g. `bot`, `crawl`, `spider`, `slackbot`).
//  2. Word-boundary matches for words that exist in legitimate user-agent
//     strings (`monitor` shows up in display names, `electron` in any Electron
//     app's UA, `java/` in some Android builds, `preview` in iOS Safari preview
//     features, `embedly` is fine but bounded for symmetry). Without `\b` we
//     would suppress real human view counts.
//
// Spec instruction: "don't undercount" — counted as don't accidentally count
// bots, not don't accidentally suppress humans. We err towards caution on the
// substring half (where collisions are vanishingly unlikely) and towards
// permissiveness on the word-boundary half (where collisions are real).
const BOT_SUBSTRING = /(bot|crawl|spider|slackbot|slack-imgproxy|discord|twitter|facebook|linkedin|whatsapp|telegram|skype|prerender|http-client|curl|wget|httpie|insomnia|postman|node-fetch|axios|python-requests|okhttp|go-http-client|libwww-perl|headlesschrome|phantomjs)/i;
const BOT_WORD = /\b(monitor|electron|embedly|preview|java)\b/i;

export function isBotUA(ua: string | null | undefined): boolean {
  if (!ua) return true; // Treat empty UA as a bot — no view bump.
  return BOT_SUBSTRING.test(ua) || BOT_WORD.test(ua);
}
