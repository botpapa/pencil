import { describe, it, expect } from "vitest";
import { renderInline, renderMarkdownLine } from "../src/client/lib/liveMarkdown.js";

// Recover the visible+marker text the way the DOM's textContent would: strip
// tags, decode the five entities we emit. This must equal the source (the
// contract that keeps the editor's caret offsets correct).
function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

describe("liveMarkdown — textContent contract", () => {
  const cases = [
    "plain text",
    "## Heading two",
    "a **bold** word",
    "an *italic* word",
    "`inline code`",
    "mix **bold** and *italic* and `code` and ==mark== and ~~del~~",
    "> a quote",
    "- a list item",
    "1. ordered item",
    "a [link](https://x.example/p?q=1&y=2) here",
    "tricky <html> & \"quotes\" 'apos'",
    "trailing **unclosed",
  ];
  for (const c of cases) {
    it(`round-trips: ${JSON.stringify(c)}`, () => {
      expect(textOf(renderMarkdownLine(c, {}).html)).toBe(c);
    });
  }
});

describe("liveMarkdown — markup", () => {
  it("wraps heading marker + content", () => {
    const r = renderMarkdownLine("## Hi", {});
    expect(r.html).toContain('class="md-mark-syntax"');
    expect(r.html).toContain("md-h2");
    expect(r.cls).toContain("md-h2-line");
  });
  it("renders bold/italic/code/strike/mark inline", () => {
    const h = renderInline("**b** *i* `c` ~~d~~ ==m==");
    expect(h).toContain("md-strong");
    expect(h).toContain("md-em");
    expect(h).toContain("md-code");
    expect(h).toContain("md-del");
    expect(h).toContain("md-mark");
  });
  it("escapes html in content", () => {
    expect(renderInline("<script>")).toContain("&lt;script&gt;");
  });
  it("does not parse markers inside code spans", () => {
    const h = renderInline("`a **b** c`");
    // the ** inside code should remain literal text, not a strong span
    expect(h).not.toContain("md-strong");
  });
  it("treats horizontal rule as its own line type", () => {
    expect(renderMarkdownLine("---", {}).cls).toBe("md-hr");
  });
});
