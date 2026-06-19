// Browser harness: drives the real TextEditor with synthetic beforeinput events
// (the editor preventDefaults and owns the source, so synthetic events exercise
// the true editing path) and asserts the Obsidian-style behaviour. Bundled by
// esbuild and run via headless Chrome --dump-dom; writes "RESULT {json}".

import { TextEditor } from "../../src/client/lib/textEditor.js";

const results: Record<string, unknown> = {};
function assert(name: string, cond: boolean, extra?: unknown): void {
  results[name] = extra === undefined ? cond : { ok: cond, ...((typeof extra === "object" && extra) || { v: extra }) };
}

function placeCaretEnd(el: HTMLElement): void {
  const sel = window.getSelection()!;
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  sel.removeAllRanges();
  sel.addRange(r);
}

function type(el: HTMLElement, s: string): void {
  for (const ch of s) {
    const init = ch === "\n"
      ? { inputType: "insertParagraph", bubbles: true, cancelable: true }
      : { inputType: "insertText", data: ch, bubbles: true, cancelable: true };
    el.dispatchEvent(new InputEvent("beforeinput", init));
  }
}
function backspace(el: HTMLElement, n: number): void {
  for (let i = 0; i < n; i++) el.dispatchEvent(new InputEvent("beforeinput", { inputType: "deleteContentBackward", bubbles: true, cancelable: true }));
}

// textContent of the block joined by line boundaries == source contract.
function domSource(el: HTMLElement): string {
  return Array.from(el.querySelectorAll(".md-line")).map((l) => l.textContent ?? "").join("\n");
}

function run(): void {
  const div = document.createElement("div");
  div.className = "draw-text";
  div.contentEditable = "true";
  document.body.appendChild(div);
  const model = { md: "" };
  const ed = new TextEditor(div, model, { onChange: () => {} });
  ed.render(false);
  div.focus();
  placeCaretEnd(div);

  // 1) Type a heading, a newline, and a paragraph with inline marks.
  type(div, "## Hello");
  type(div, "\n");
  type(div, "a **bold** and `code` here");

  assert("source_after_type", model.md === "## Hello\na **bold** and `code` here", { got: model.md });
  assert("dom_source_matches", domSource(div) === model.md, { dom: domSource(div) });
  assert("has_h2", !!div.querySelector(".md-h2"));
  assert("h2_text", (div.querySelector(".md-h2")?.textContent ?? "") === "Hello");
  assert("has_strong", (div.querySelector(".md-strong")?.textContent ?? "") === "bold");
  assert("has_code", (div.querySelector(".md-code")?.textContent ?? "") === "code");

  // 2) Caret is on line 2 → line 1 (heading) markers hidden, line 2 markers shown.
  const lines = div.querySelectorAll<HTMLElement>(".md-line");
  const headingMarker = lines[0]?.querySelector<HTMLElement>(".md-mark-syntax");
  const para = lines[1];
  assert("two_lines", lines.length === 2, { n: lines.length });
  assert("heading_marker_hidden", !!headingMarker && getComputedStyle(headingMarker).display === "none");
  assert("caret_line_is_2", !!para && para.classList.contains("caret-line"));

  // 3) Click into the heading line → its markers reveal.
  const h1line = lines[0]!;
  const sel = window.getSelection()!;
  const r = document.createRange();
  r.selectNodeContents(h1line);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
  h1line.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  const m2 = div.querySelectorAll<HTMLElement>(".md-line")[0]?.querySelector<HTMLElement>(".md-mark-syntax");
  assert("heading_marker_revealed_on_caret", !!m2 && getComputedStyle(m2).display !== "none");

  // 4) Backspace removes characters from the source.
  placeCaretEnd(div);
  backspace(div, 5); // delete " here"
  assert("after_backspace", model.md === "## Hello\na **bold** and `code`", { got: model.md });

  (document.getElementById("out") as HTMLElement).textContent = "RESULT " + JSON.stringify(results);
}

try {
  run();
} catch (e) {
  (document.getElementById("out") as HTMLElement).textContent = "RESULT " + JSON.stringify({ threw: String(e) });
}
