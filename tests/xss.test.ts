import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../src/lib/markdown.js";

// Every payload below must produce ZERO script execution vectors after going
// through the markdown -> sanitize pipeline.

// Checks for actively-dangerous constructs only — escaped text containing
// the literal word "javascript:" or "<script>" is safe and expected to appear
// in code blocks / pre tags.
function noScripts(html: string) {
  // Real <script> open/close tags (not escaped, not inside hljs spans).
  expect(html).not.toMatch(/<script[\s>]/i);
  expect(html).not.toMatch(/<\/script\s*>/i);
  // Active script schemes in real href/src attributes.
  expect(html).not.toMatch(/href\s*=\s*["'][^"']*javascript:/i);
  expect(html).not.toMatch(/href\s*=\s*["'][^"']*vbscript:/i);
  expect(html).not.toMatch(/href\s*=\s*["'][^"']*livescript:/i);
  expect(html).not.toMatch(/href\s*=\s*["'][^"']*data:/i);
  expect(html).not.toMatch(/src\s*=\s*["'][^"']*javascript:/i);
  expect(html).not.toMatch(/src\s*=\s*["'][^"']*data:/i);
  expect(html).not.toMatch(/src\s*=\s*["'][^"']*vbscript:/i);
  // Event handler attributes on real (unescaped) tags.
  expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
  // Active dangerous element tags.
  expect(html).not.toMatch(/<iframe[\s>]/i);
  expect(html).not.toMatch(/<embed[\s>]/i);
  expect(html).not.toMatch(/<object[\s>]/i);
  expect(html).not.toMatch(/<svg[\s>]/i);
  expect(html).not.toMatch(/<applet[\s>]/i);
  expect(html).not.toMatch(/<form[\s>]/i);
  expect(html).not.toMatch(/<meta[\s>]/i);
  expect(html).not.toMatch(/<link[\s>]/i);
  expect(html).not.toMatch(/<style[\s>]/i);
}

describe("xss: raw HTML stripping", () => {
  it("strips <script> tags", () => {
    const out = renderMarkdown('<script>alert(1)</script>');
    noScripts(out);
  });

  it("strips <img onerror>", () => {
    const out = renderMarkdown('<img src=x onerror="alert(1)">');
    noScripts(out);
  });

  it("strips <svg onload>", () => {
    const out = renderMarkdown('<svg onload="alert(1)"></svg>');
    noScripts(out);
  });

  it("strips iframe/embed/object", () => {
    const out = renderMarkdown(
      '<iframe src="https://evil.example"></iframe>\n<embed src="x">\n<object data="x"></object>',
    );
    noScripts(out);
  });

  it("ignores HTML comments containing payloads", () => {
    const out = renderMarkdown('<!--<script>alert(1)</script>-->');
    noScripts(out);
  });
});

describe("xss: link href validation", () => {
  it("strips javascript: links", () => {
    const out = renderMarkdown("[click me](javascript:alert(1))");
    noScripts(out);
    expect(out).toContain("click me");
    expect(out).not.toContain("<a");
  });

  it("strips JaVaScRiPt: mixed case", () => {
    const out = renderMarkdown("[click](JaVaScRiPt:alert(1))");
    noScripts(out);
    expect(out).not.toContain("<a");
  });

  it("strips data: links", () => {
    const out = renderMarkdown("[click](data:text/html,<script>alert(1)</script>)");
    noScripts(out);
    expect(out).not.toContain("<a");
  });

  it("strips vbscript: links", () => {
    const out = renderMarkdown("[click](vbscript:msgbox(1))");
    noScripts(out);
    expect(out).not.toContain("<a");
  });

  it("strips file:// links", () => {
    const out = renderMarkdown("[click](file:///etc/passwd)");
    noScripts(out);
    expect(out).not.toContain("<a");
  });

  it("preserves https: links and adds rel/target", () => {
    const out = renderMarkdown("[click](https://example.com)");
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('rel="noopener noreferrer nofollow ugc"');
    expect(out).toContain('target="_blank"');
  });

  it("preserves mailto: links", () => {
    const out = renderMarkdown("[mail](mailto:hi@example.com)");
    expect(out).toContain('href="mailto:hi@example.com"');
    expect(out).not.toContain("target=");
  });

  it("preserves in-page anchors", () => {
    const out = renderMarkdown("[top](#top)");
    expect(out).toContain('href="#top"');
    expect(out).not.toContain("target=");
  });
});

describe("xss: image src validation", () => {
  it("strips data: image", () => {
    const out = renderMarkdown('![x](data:text/html,<script>alert(1)</script>)');
    noScripts(out);
    expect(out).not.toContain("<img");
  });

  it("strips javascript: image", () => {
    const out = renderMarkdown('![x](javascript:alert(1))');
    noScripts(out);
    expect(out).not.toContain("<img");
  });

  it("preserves https image with safe attrs", () => {
    const out = renderMarkdown('![alt](https://example.com/x.png "title")');
    expect(out).toContain('src="https://example.com/x.png"');
    expect(out).toContain('alt="alt"');
    expect(out).toContain('loading="lazy"');
    expect(out).toContain('referrerpolicy="no-referrer"');
    expect(out).toContain('decoding="async"');
  });

  it("strips http image protocol-relative URLs", () => {
    const out = renderMarkdown('![x](//evil.example/x.png)');
    expect(out).not.toContain('<img');
  });
});

describe("xss: encoded entity tricks", () => {
  it("does not unescape &#x6A;avascript: equivalents", () => {
    const out = renderMarkdown("[click](&#x6A;avascript:alert(1))");
    noScripts(out);
    expect(out).not.toContain("<a");
  });

  it("strips URL-encoded javascript schemes", () => {
    const out = renderMarkdown("[click](java%73cript:alert(1))");
    noScripts(out);
  });
});

describe("xss: code block tricks", () => {
  it("escapes script tags in code fences", () => {
    const out = renderMarkdown("```html\n<script>alert(1)</script>\n```");
    noScripts(out);
    // The < and > of the script tag must be escaped (hljs may wrap the
    // tag name in inner spans for highlighting, but the angle brackets
    // are always escaped entities).
    expect(out).toContain("&lt;");
    expect(out).toContain("&gt;");
    expect(out).toMatch(/<pre><code class="hljs/);
  });

  it("escapes html in inline code", () => {
    const out = renderMarkdown("inline `<script>alert(1)</script>` code");
    noScripts(out);
    expect(out).toContain("&lt;script&gt;");
  });
});

describe("xss: heading anchors", () => {
  it("does not allow injection into heading id", () => {
    const out = renderMarkdown('# hello"><script>alert(1)</script>');
    noScripts(out);
    expect(out).toMatch(/<h1[^>]*id="[a-z0-9-]*"/);
  });
});

describe("xss: task lists / footnotes", () => {
  it("only allows disabled checkboxes", () => {
    const out = renderMarkdown("- [ ] todo\n- [x] done");
    expect(out).toContain('<input');
    expect(out).toContain('disabled');
    expect(out).not.toMatch(/onclick/i);
  });

  it("renders footnotes safely", () => {
    const out = renderMarkdown("Here[^1].\n\n[^1]: see this");
    noScripts(out);
    expect(out).toContain("footnotes");
  });
});

describe("xss: real-world combos", () => {
  it("strips payload nested in markdown link text", () => {
    const out = renderMarkdown("[<script>alert(1)</script>](https://safe.example)");
    noScripts(out);
    expect(out).toContain('href="https://safe.example"');
  });

  it("strips payload in image alt", () => {
    const out = renderMarkdown('![<script>alert(1)</script>](https://safe.example/x.png)');
    noScripts(out);
    expect(out).toContain('alt="');
  });

  it("strips srcset / cross-attribute payloads", () => {
    const out = renderMarkdown('<img src="https://x" srcset="x onerror=alert(1)">');
    noScripts(out);
  });
});
