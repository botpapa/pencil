import { describe, it, expect } from "vitest";
import { renderMarkdown, plaintextExcerpt } from "../src/lib/markdown.js";
import { isSafeHref, isSafeImgSrc } from "../src/lib/sanitize.js";

describe("URL validators", () => {
  it.each([
    ["https://x", true],
    ["http://x", true],
    ["mailto:a@b", true],
    ["#anchor", true],
    ["javascript:1", false],
    ["data:text/html,1", false],
    ["vbscript:1", false],
    ["//x", false],
    ["ftp://x", false],
    ["", false],
    [" javascript:1", false],
  ])("isSafeHref(%j) = %s", (input, expected) => {
    expect(isSafeHref(input)).toBe(expected);
  });

  it.each([
    ["https://x", true],
    ["http://x", true],
    ["data:image/png;base64,xx", false],
    ["javascript:1", false],
    ["#x", false],
    ["mailto:a@b", false],
  ])("isSafeImgSrc(%j) = %s", (input, expected) => {
    expect(isSafeImgSrc(input)).toBe(expected);
  });
});

describe("renderMarkdown core", () => {
  it("renders headings with id anchors", () => {
    const out = renderMarkdown("# Hello World");
    expect(out).toMatch(/<h1[^>]*id="hello-world"/);
  });

  it("emits a header-anchor permalink for each heading", () => {
    const out = renderMarkdown("# Hello\n\n## World\n");
    // The anchor must be the first child of the heading and survive sanitisation.
    // Attribute order is sanitiser-driven (href first, then class), and the
    // linkInsideHeader factory inserts a separator space between the # and
    // the heading text — both are stable details of the pipeline.
    expect(out).toMatch(/<h1[^>]*id="hello"[^>]*><a href="#hello"[^>]*class="header-anchor"[^>]*>#<\/a> Hello<\/h1>/);
    expect(out).toMatch(/<h2[^>]*id="world"[^>]*><a href="#world"[^>]*class="header-anchor"[^>]*>#<\/a> World<\/h2>/);
  });

  it("preserves the header-anchor class through sanitisation", () => {
    const out = renderMarkdown("### Topic\n");
    expect(out).toContain('class="header-anchor"');
  });

  it("renders tables", () => {
    const out = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |\n");
    expect(out).toContain("<table");
    expect(out).toContain("<th");
    expect(out).toContain("<td");
  });

  it("wraps tables in .table-wrap for mobile horizontal scroll", () => {
    const out = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |\n");
    expect(out).toMatch(/<div class="table-wrap"[^>]*><table/);
    expect(out).toContain("</table></div>");
  });

  it("renders code blocks with hljs classes", () => {
    const out = renderMarkdown("```ts\nconst x = 1;\n```");
    expect(out).toContain('class="hljs language-ts"');
  });

  it("renders unknown language as plaintext class", () => {
    const out = renderMarkdown("```madeuplang\nfoo\n```");
    expect(out).toContain("language-plaintext");
  });

  it("renders mark/strikethrough/footnote", () => {
    const out = renderMarkdown("==marked== ~~struck~~ note[^1]\n\n[^1]: ref");
    expect(out).toContain("<mark>");
    expect(out).toContain("<del>");
    expect(out).toContain("footnote");
  });

  it("renders task lists with disabled checkboxes", () => {
    const out = renderMarkdown("- [ ] todo");
    expect(out).toMatch(/<input[^>]*type="checkbox"[^>]*disabled/);
  });

  it("emits data-source-line on top-level blocks for scroll sync", () => {
    const md = "para one\n\npara two\n\n# heading";
    const out = renderMarkdown(md);
    expect(out).toMatch(/<p data-source-line="0"/);
    expect(out).toMatch(/<p data-source-line="2"/);
    // markdown-it-anchor injects id="..." before our attr, so allow any
    // intervening attributes between <h1 and data-source-line.
    expect(out).toMatch(/<h1[^>]*\sdata-source-line="4"/);
  });

  it("propagates data-source-line through the table wrapper", () => {
    const md = "intro\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
    const out = renderMarkdown(md);
    expect(out).toMatch(/<div class="table-wrap" data-source-line="2"><table/);
  });
});

describe("plaintextExcerpt", () => {
  it("strips markdown noise", () => {
    const md = "# Title\n\nThis is **bold** and `code` and [link](https://x).";
    const out = plaintextExcerpt(md, 200);
    expect(out).toBe("Title This is bold and and link.");
  });

  it("truncates with ellipsis at maxChars", () => {
    const md = "a".repeat(500);
    const out = plaintextExcerpt(md, 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out.endsWith("\u2026")).toBe(true);
  });
});
