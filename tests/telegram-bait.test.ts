import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
import { toInstantViewHtml } from "../src/views/telegram.js";
import { renderMarkdown } from "../src/lib/markdown.js";

const UA = "TelegramBot (like TwitterBot)";

async function create(body: Record<string, unknown>): Promise<{ slug: string; cookie: string }> {
  const res = await SELF.fetch("https://x/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  const { slug } = (await res.json()) as { slug: string };
  const m = /pencil_uid=([^;]+)/.exec(res.headers.get("Set-Cookie") ?? "");
  return { slug, cookie: `pencil_uid=${m![1]}` };
}

describe("telegram instant view bait page", () => {
  it("serves the teletype-shaped page to the Telegram crawler only", async () => {
    const { slug } = await create({ title: "Bait", content: "# Bait\n\nhello **world**" });

    const bot = await SELF.fetch(`https://x/${slug}`, { headers: { "User-Agent": UA } });
    expect(bot.status).toBe(200);
    expect(bot.headers.get("Vary")).toContain("User-Agent");
    const html = await bot.text();
    expect(html).toContain('<meta property="tg:site_verification" content="g7j8/rPFXfhyrq5q0QQV7EsYWv4=" />');
    expect(html).toContain('<meta property="og:title" content="Bait" />');
    expect(html).toContain('<article class="article__content">');
    expect(html).toContain("<strong>world</strong>");
    expect(html).not.toContain("page-reader");

    const human = await SELF.fetch(`https://x/${slug}`, { headers: { "User-Agent": "Mozilla/5.0" } });
    const normal = await human.text();
    expect(normal).toContain("page-reader");
    expect(normal).not.toContain("tg:site_verification");

    const debug = await SELF.fetch(`https://x/${slug}?tg-instantview=1`, { headers: { "User-Agent": "Mozilla/5.0" } });
    expect(await debug.text()).toContain("tg:site_verification");
  });

  it("never serves protected pages to the crawler", async () => {
    const { slug, cookie } = await create({ title: "Secret", content: "top secret" });
    const lock = await SELF.fetch(`https://x/${slug}/settings/password`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: "pw" }),
      redirect: "manual",
    });
    expect(lock.status).toBe(303);
    const bot = await SELF.fetch(`https://x/${slug}?tg-instantview=1`, { headers: { "User-Agent": UA } });
    expect(bot.status).toBe(401);
    expect(await bot.text()).not.toContain("top secret");
  });
});

describe("toInstantViewHtml", () => {
  it("flattens nested lists with level markers", () => {
    const md = "- a\n  - b\n    - c\n  - d\n- e\n\n1. one\n   1. sub one\n   2. sub two\n2. two";
    const out = toInstantViewHtml(renderMarkdown(md)).replace(/\s+/g, "");
    expect(out).toContain("<li>a</li><li>—b</li><li>——c</li><li>—d</li><li>e</li>");
    expect(out).toContain("<li>one</li><li>—1.subone</li><li>—2.subtwo</li><li>two</li>");
    expect(out.match(/<ul>/g)?.length).toBe(1);
    expect(out.match(/<ol>/g)?.length).toBe(1);
  });

  it("reshapes reader markup for the teletype template", () => {
    const md = [
      "# T",
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "- [x] done",
      "- [ ] todo",
      "",
      "```js",
      "let a = 1",
      "```",
      "",
      "![pic](https://i/x.png)",
      "",
      "```carousel",
      "https://i/1.png",
      "https://i/2.png",
      "```",
      "",
      "note[^1]",
      "",
      "[^1]: fn",
    ].join("\n");
    const out = toInstantViewHtml(renderMarkdown(md));
    expect(out).not.toContain("header-anchor");
    expect(out).not.toContain("data-source-line");
    expect(out).not.toContain("table-wrap");
    expect(out).toContain("<table>");
    expect(out).toContain("☑ done");
    expect(out).toContain("☐ todo");
    expect(out).toContain('<pre data-language="js"><code>let a = 1\n</code></pre>');
    expect(out).not.toContain("hljs");
    expect(out).toContain('<figure><img src="https://i/x.png" alt="pic"></figure>');
    expect(out).toContain('<figure><img src="https://i/1.png" alt=""></figure><figure><img src="https://i/2.png" alt=""></figure>');
    expect(out).not.toContain("carousel");
    expect(out).not.toContain("footnote-backref");
    expect(out).not.toContain("loading=");
  });
});
