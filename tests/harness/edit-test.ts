// Browser harness for the live-markdown editor. Simulates real editing via
// synthetic beforeinput + selection placement and asserts behaviour. Bundled by
// esbuild, run via headless Chrome --dump-dom; writes "RESULT {json}".

import { TextEditor } from "../../src/client/lib/textEditor.js";

const results: Record<string, unknown> = {};
function assert(name: string, cond: boolean, extra?: unknown): void {
  results[name] = cond && extra === undefined ? true : { ok: cond, extra };
}

function caretEnd(el: HTMLElement): void {
  const sel = window.getSelection()!;
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  sel.removeAllRanges();
  sel.addRange(r);
}
// Place the caret at a plaintext source offset (walks the same way the editor maps).
function caretAt(el: HTMLElement, offset: number): void {
  const lines = Array.from(el.querySelectorAll<HTMLElement>(".md-line"));
  let rem = offset;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const len = (line.textContent ?? "").length;
    if (rem <= len || i === lines.length - 1) {
      const w = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      let t: Node | null;
      let c = 0;
      const r = document.createRange();
      let placed = false;
      while ((t = w.nextNode())) {
        const tl = (t.textContent ?? "").length;
        if (rem <= c + tl) { r.setStart(t, rem - c); placed = true; break; }
        c += tl;
      }
      if (!placed) { r.selectNodeContents(line); r.collapse(false); }
      r.collapse(true);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(r);
      line.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return;
    }
    rem -= len + 1;
  }
}
function type(el: HTMLElement, s: string): void {
  for (const ch of s) {
    el.dispatchEvent(new InputEvent("beforeinput", ch === "\n"
      ? { inputType: "insertParagraph", bubbles: true, cancelable: true }
      : { inputType: "insertText", data: ch, bubbles: true, cancelable: true }));
  }
}
function back(el: HTMLElement, n = 1): void {
  for (let i = 0; i < n; i++) el.dispatchEvent(new InputEvent("beforeinput", { inputType: "deleteContentBackward", bubbles: true, cancelable: true }));
}
function domSource(el: HTMLElement): string {
  return Array.from(el.querySelectorAll(".md-line")).map((l) => l.textContent ?? "").join("\n");
}
function fresh(): { div: HTMLElement; ed: TextEditor; model: { md: string } } {
  const div = document.createElement("div");
  div.className = "draw-text";
  div.contentEditable = "true";
  document.body.appendChild(div);
  const model = { md: "" };
  const ed = new TextEditor(div, model, { onChange: () => {} });
  ed.render(false);
  div.focus();
  caretEnd(div);
  return { div, ed, model };
}

function run(): void {
  // 1) Heading applies live as the space is typed.
  {
    const { div } = fresh();
    type(div, "## ");
    assert("heading_live_on_space", !!div.querySelector(".md-h2"));
    type(div, "Title");
    assert("heading_content", (div.querySelector(".md-h2")?.textContent ?? "") === "Title");
    assert("heading_source", domSource(div) === "## Title");
  }

  // 2) Mid-line insert keeps the source correct.
  {
    const { div, model } = fresh();
    type(div, "ab");
    caretAt(div, 1);
    type(div, "X");
    assert("midline_insert", model.md === "aXb", model.md);
  }

  // 3) Enter splits a line at the caret.
  {
    const { div, model } = fresh();
    type(div, "abcd");
    caretAt(div, 2);
    type(div, "\n");
    assert("enter_split", model.md === "ab\ncd", model.md);
    assert("enter_two_lines", div.querySelectorAll(".md-line").length === 2);
  }

  // 4) Backspace at the start of line 2 merges into line 1.
  {
    const { div, model } = fresh();
    type(div, "a\nb");
    caretAt(div, 2); // start of line 2 (offset: 'a'=1, '\n'=+1 => 2)
    back(div, 1);
    assert("backspace_merge", model.md === "ab", model.md);
    assert("merge_one_line", div.querySelectorAll(".md-line").length === 1);
  }

  // 5) Bold renders, and its markers hide once the caret leaves the line.
  {
    const { div } = fresh();
    type(div, "x **b** y\nsecond");
    // caret now on line 2; line 1's bold markers should be hidden, bold styled.
    const l1 = div.querySelectorAll<HTMLElement>(".md-line")[0]!;
    const strong = l1.querySelector<HTMLElement>(".md-strong");
    const marker = l1.querySelector<HTMLElement>(".md-mark-syntax");
    assert("bold_styled", (strong?.textContent ?? "") === "b");
    assert("bold_marker_hidden_offline", !!marker && getComputedStyle(marker).display === "none");
    // click into line 1 -> markers reveal
    caretAt(div, 2);
    const m2 = div.querySelectorAll<HTMLElement>(".md-line")[0]!.querySelector<HTMLElement>(".md-mark-syntax");
    assert("bold_marker_shown_online", !!m2 && getComputedStyle(m2).display !== "none");
  }

  // 6) Replace a selection by typing over it.
  {
    const { div, model } = fresh();
    type(div, "hello");
    const line = div.querySelector<HTMLElement>(".md-line")!;
    const node = line.firstChild!; // single text node "hello"
    const r = document.createRange();
    r.setStart(node, 1);
    r.setEnd(node, 4); // select "ell"
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
    type(div, "X");
    assert("replace_selection", model.md === "hXo", model.md);
  }

  // 7) Unordered list auto-continues on Enter.
  {
    const { div, model } = fresh();
    type(div, "- a");
    type(div, "\n");
    type(div, "b");
    assert("ul_continue", model.md === "- a\n- b", model.md);
  }

  // 8) Enter on an empty bullet exits the list.
  {
    const { div, model } = fresh();
    type(div, "- a");
    type(div, "\n"); // -> "- a\n- "
    type(div, "\n"); // empty bullet -> exit
    assert("ul_exit_empty", model.md === "- a\n", model.md);
  }

  // 9) Ordered list increments.
  {
    const { div, model } = fresh();
    type(div, "1. x");
    type(div, "\n");
    type(div, "y");
    assert("ol_increment", model.md === "1. x\n2. y", model.md);
  }

  (document.getElementById("out") as HTMLElement).textContent = "RESULT " + JSON.stringify(results);
}

try { run(); } catch (e) { (document.getElementById("out") as HTMLElement).textContent = "RESULT " + JSON.stringify({ threw: String(e), stack: (e as Error).stack }); }
