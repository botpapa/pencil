// Live-markdown line renderer for the canvas text editor.
//
// CONTRACT: the concatenated textContent of the returned HTML must EXACTLY
// equal the input line. Markers (`## `, `**`, …) are wrapped in
// <span class="md-mark-syntax"> — never removed or substituted — so they can be
// CSS-hidden on inactive lines while the source round-trips perfectly (which is
// what keeps the editor's caret offsets correct).
//
// Implementation trick: we escape the WHOLE line for HTML first, then run the
// marker regexes on the escaped string. Markdown markers (* _ ~ = ` # > [ ] ( ))
// are never touched by HTML-escaping, so the regexes still match, and every
// captured group is already-escaped text we can emit verbatim — no risk of
// double-escaping and no character loss.

export interface LineCtx {
  _?: never; // reserved for future cross-line state
}

export interface RenderedLine {
  html: string;
  cls: string;
}

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function syn(rawMarker: string): string {
  return `<span class="md-mark-syntax">${esc(rawMarker)}</span>`;
}

const PH_OPEN = "\uE000";
const PH_CLOSE = "\uE001";

// Inline marks on an already-RAW string; returns HTML whose textContent equals
// the input.
export function renderInline(text: string): string {
  let s = esc(text);

  // Protect inline code so its contents aren't re-parsed for other marks.
  const codes: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_m, inner: string) => {
    const ph = `${PH_OPEN}${codes.length}${PH_CLOSE}`;
    codes.push(`${syn("`")}<span class="md-code">${inner}</span>${syn("`")}`);
    return ph;
  });

  // Links [text](url)
  s = s.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (_m, label: string, url: string) =>
    `${syn("[")}<span class="md-link">${label}</span>${syn("](")}<span class="md-mark-syntax">${url}</span>${syn(")")}`,
  );

  // Bold, then italic, strike, highlight.
  s = s.replace(/\*\*([^*\n]+)\*\*/g, (_m, x: string) => `${syn("**")}<span class="md-strong">${x}</span>${syn("**")}`);
  s = s.replace(/__([^_\n]+)__/g, (_m, x: string) => `${syn("__")}<span class="md-strong">${x}</span>${syn("__")}`);
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, (_m, pre: string, x: string) => `${pre}${syn("*")}<span class="md-em">${x}</span>${syn("*")}`);
  s = s.replace(/(^|[^_])_([^_\n]+)_/g, (_m, pre: string, x: string) => `${pre}${syn("_")}<span class="md-em">${x}</span>${syn("_")}`);
  s = s.replace(/~~([^~\n]+)~~/g, (_m, x: string) => `${syn("~~")}<span class="md-del">${x}</span>${syn("~~")}`);
  s = s.replace(/==([^=\n]+)==/g, (_m, x: string) => `${syn("==")}<span class="md-mark">${x}</span>${syn("==")}`);

  // Restore protected code spans.
  s = s.replace(new RegExp(`${PH_OPEN}(\\d+)${PH_CLOSE}`, "g"), (_m, i: string) => codes[Number(i)] ?? "");
  return s;
}

export function renderMarkdownLine(line: string, _ctx: LineCtx): RenderedLine {
  if (line.length === 0) return { html: "<br>", cls: "md-empty" };

  // Heading: #..###### + space(s)
  let m = /^(#{1,6})( +)(.*)$/.exec(line);
  if (m) {
    const level = m[1]!.length;
    return {
      html: `${syn(m[1]! + m[2]!)}<span class="md-content md-h${level}">${renderInline(m[3]!)}</span>`,
      cls: `md-head md-h${level}-line`,
    };
  }

  // Blockquote
  m = /^(> ?)(.*)$/.exec(line);
  if (m) {
    return { html: `${syn(m[1]!)}<span class="md-content">${renderInline(m[2]!)}</span>`, cls: "md-quote" };
  }

  // Horizontal rule
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
    return { html: syn(line), cls: "md-hr" };
  }

  // Unordered list ( -, *, + )
  m = /^(\s*)([-*+] )(.*)$/.exec(line);
  if (m) {
    return {
      html: `${esc(m[1]!)}${syn(m[2]!)}<span class="md-content">${renderInline(m[3]!)}</span>`,
      cls: "md-li",
    };
  }

  // Ordered list
  m = /^(\s*)(\d+\. )(.*)$/.exec(line);
  if (m) {
    return {
      html: `${esc(m[1]!)}${syn(m[2]!)}<span class="md-content">${renderInline(m[3]!)}</span>`,
      cls: "md-li md-li-ol",
    };
  }

  return { html: renderInline(line), cls: "md-p" };
}
