// Controlled contentEditable with Obsidian-style live markdown.
//
// We own the source string + caret. On `beforeinput` we preventDefault and
// mutate the source ourselves, then re-render: each source line becomes a
// .md-line whose syntax markers (`## `, `**`, …) are visible only on the line
// the caret is on (CSS hides them elsewhere). Because the rendered textContent
// always equals the source, caret offsets map back and forth cleanly.

import { renderMarkdownLine, type LineCtx } from "./liveMarkdown.js";

export interface TextModel { md: string }
export interface TextEditorOptions {
  onChange: () => void;
  onFocus?: () => void;
  readOnly?: boolean;
}

export class TextEditor {
  el: HTMLElement;
  model: TextModel;
  src: string;
  private onChange: () => void;
  private onFocus?: () => void;
  private composing = false;
  // Per-editor undo history — required because we preventDefault native input,
  // so the browser's own undo stack stays empty.
  private undoStack: { src: string; caret: number }[] = [];
  private redoStack: { src: string; caret: number }[] = [];
  private lastUndoKind = "";

  constructor(el: HTMLElement, model: TextModel, opts: TextEditorOptions) {
    this.el = el;
    this.model = model;
    this.src = model.md;
    this.onChange = opts.onChange;
    this.onFocus = opts.onFocus;
    if (!opts.readOnly && el.isContentEditable) this.wire();
  }

  private wire(): void {
    this.el.addEventListener("beforeinput", (e) => this.onBeforeInput(e as InputEvent));
    this.el.addEventListener("compositionstart", () => { this.composing = true; });
    this.el.addEventListener("compositionend", () => { this.composing = false; this.syncFromDom(); });
    this.el.addEventListener("keydown", (e) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) this.redo(); else this.undo();
      }
    });
    this.el.addEventListener("keyup", () => this.refreshCaretLine());
    this.el.addEventListener("mouseup", () => this.refreshCaretLine());
    this.el.addEventListener("focus", () => { this.onFocus?.(); this.render(true); });
    this.el.addEventListener("blur", () => this.render(false));
    this.el.addEventListener("paste", (e) => {
      const t = e.clipboardData?.getData("text/plain");
      if (t == null) return;
      e.preventDefault();
      this.snapshot("paste");
      this.replaceSelection(t);
    });
  }

  // ----- source <-> DOM caret mapping -----
  private caretOffset(): number | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const r = sel.getRangeAt(0);
    if (!this.el.contains(r.endContainer)) return null;
    return this.offsetOf(r.endContainer, r.endOffset);
  }
  private selectionRange(): [number, number] | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const r = sel.getRangeAt(0);
    if (!this.el.contains(r.startContainer) || !this.el.contains(r.endContainer)) return null;
    const a = this.offsetOf(r.startContainer, r.startOffset);
    const b = this.offsetOf(r.endContainer, r.endOffset);
    return a <= b ? [a, b] : [b, a];
  }
  private offsetOf(node: Node, off: number): number {
    let count = 0;
    const lines = Array.from(this.el.querySelectorAll<HTMLElement>(".md-line"));
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li]!;
      if (li > 0) count += 1;
      if (line === node) {
        let c = 0;
        for (let k = 0; k < off && k < line.childNodes.length; k++) c += (line.childNodes[k]!.textContent ?? "").length;
        return count + c;
      }
      if (line.contains(node)) {
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        let t: Node | null;
        let c = 0;
        while ((t = walker.nextNode())) {
          if (t === node) return count + c + off;
          c += (t.textContent ?? "").length;
        }
        return count + c;
      }
      count += (line.textContent ?? "").length;
    }
    return count;
  }
  private setCaret(offset: number): void {
    const lines = Array.from(this.el.querySelectorAll<HTMLElement>(".md-line"));
    let remaining = offset;
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li]!;
      const len = (line.textContent ?? "").length;
      if (remaining <= len || li === lines.length - 1) {
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        let t: Node | null;
        let c = 0;
        const sel = window.getSelection();
        const range = document.createRange();
        let placed = false;
        while ((t = walker.nextNode())) {
          const tl = (t.textContent ?? "").length;
          if (remaining <= c + tl) {
            range.setStart(t, Math.max(0, remaining - c));
            placed = true;
            break;
          }
          c += tl;
        }
        if (!placed) { range.selectNodeContents(line); range.collapse(false); }
        range.collapse(true);
        sel?.removeAllRanges();
        sel?.addRange(range);
        return;
      }
      remaining -= len + 1;
    }
  }

  private caretLineIndex(offset: number): number {
    const lines = this.src.split("\n");
    let c = 0;
    for (let i = 0; i < lines.length; i++) {
      const len = lines[i]!.length;
      if (offset <= c + len) return i;
      c += len + 1;
    }
    return Math.max(0, lines.length - 1);
  }

  // ----- editing (controlled) -----
  private onBeforeInput(e: InputEvent): void {
    if (this.composing) return;
    const t = e.inputType;
    if (t === "historyUndo") { e.preventDefault(); this.undo(); return; }
    if (t === "historyRedo") { e.preventDefault(); this.redo(); return; }
    if (t === "insertText" && e.data != null) { e.preventDefault(); this.snapshot("insert"); this.replaceSelection(e.data); }
    else if (t === "insertParagraph" || t === "insertLineBreak") { e.preventDefault(); this.snapshot("newline"); this.insertNewline(); }
    else if (t === "deleteContentBackward") { e.preventDefault(); this.snapshot("delete"); this.deleteBackward(); }
    else if (t === "deleteContentForward") { e.preventDefault(); this.snapshot("delete"); this.deleteForward(); }
    else if (t === "insertFromPaste") { /* paste listener handles it */ }
    else if (t.startsWith("delete")) { e.preventDefault(); this.snapshot("delete"); this.deleteBackward(); }
  }

  private caretOrEnd(): number {
    return this.caretOffset() ?? this.src.length;
  }
  // Record a pre-edit state. Consecutive inserts coalesce into one undo step.
  private snapshot(kind: string): void {
    if (kind === "insert" && this.lastUndoKind === "insert") return;
    this.undoStack.push({ src: this.src, caret: this.caretOrEnd() });
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack.length = 0;
    this.lastUndoKind = kind;
  }
  private restore(snap: { src: string; caret: number }): void {
    this.src = snap.src;
    this.model.md = this.src;
    this.renderInner(snap.caret);
    this.setCaret(snap.caret);
    this.lastUndoKind = "";
    this.onChange();
  }
  undo(): void {
    const snap = this.undoStack.pop();
    if (!snap) return;
    this.redoStack.push({ src: this.src, caret: this.caretOrEnd() });
    this.restore(snap);
  }
  redo(): void {
    const snap = this.redoStack.pop();
    if (!snap) return;
    this.undoStack.push({ src: this.src, caret: this.caretOrEnd() });
    this.restore(snap);
  }

  replaceSelection(text: string): void {
    const range = this.selectionRange() ?? [this.src.length, this.src.length];
    const [a, b] = range;
    this.src = this.src.slice(0, a) + text + this.src.slice(b);
    this.commit(a + text.length);
  }

  // Enter: continue a list (next bullet / number), or exit it when the current
  // item is empty (Obsidian behaviour). Otherwise a plain newline.
  private insertNewline(): void {
    const range = this.selectionRange();
    if (range && range[0] !== range[1]) { this.replaceSelection("\n"); return; }
    const caret = this.caretOffset() ?? this.src.length;
    const li = this.caretLineIndex(caret);
    const lines = this.src.split("\n");
    const line = lines[li] ?? "";
    const ul = /^(\s*)([-*+] )(.*)$/.exec(line);
    const ol = /^(\s*)(\d+)\. (.*)$/.exec(line);
    if (ul) {
      if (ul[3]!.trim() === "") { this.clearLine(li); return; } // empty item → exit list
      this.replaceSelection("\n" + ul[1]! + ul[2]!);
      return;
    }
    if (ol) {
      if (ol[3]!.trim() === "") { this.clearLine(li); return; }
      this.replaceSelection("\n" + ol[1]! + (parseInt(ol[2]!, 10) + 1) + ". ");
      return;
    }
    this.replaceSelection("\n");
  }

  // Blank out the current line (used to exit an empty list item).
  private clearLine(li: number): void {
    const lines = this.src.split("\n");
    let start = 0;
    for (let i = 0; i < li; i++) start += lines[i]!.length + 1;
    const end = start + lines[li]!.length;
    this.src = this.src.slice(0, start) + this.src.slice(end);
    this.commit(start);
  }
  private deleteBackward(): void {
    const range = this.selectionRange();
    if (range && range[0] !== range[1]) { this.src = this.src.slice(0, range[0]) + this.src.slice(range[1]); this.commit(range[0]); return; }
    const off = this.caretOffset() ?? this.src.length;
    if (off <= 0) return;
    this.src = this.src.slice(0, off - 1) + this.src.slice(off);
    this.commit(off - 1);
  }
  private deleteForward(): void {
    const range = this.selectionRange();
    if (range && range[0] !== range[1]) { this.src = this.src.slice(0, range[0]) + this.src.slice(range[1]); this.commit(range[0]); return; }
    const off = this.caretOffset() ?? 0;
    if (off >= this.src.length) return;
    this.src = this.src.slice(0, off) + this.src.slice(off + 1);
    this.commit(off);
  }

  private syncFromDom(): void {
    const lines = Array.from(this.el.querySelectorAll<HTMLElement>(".md-line")).map((l) => l.textContent ?? "");
    this.src = lines.join("\n");
    this.commit(this.caretOffset() ?? this.src.length);
  }

  private commit(caret: number): void {
    this.model.md = this.src;
    this.renderInner(caret);
    this.setCaret(caret);
    this.onChange();
  }

  private refreshCaretLine(): void {
    const off = this.caretOffset();
    if (off == null) return;
    const ci = this.caretLineIndex(off);
    this.el.querySelectorAll<HTMLElement>(".md-line").forEach((l, i) => l.classList.toggle("caret-line", i === ci));
  }

  private renderInner(caretOffset: number | null): void {
    const srcLines = this.src.split("\n");
    const caretLine = caretOffset == null ? -1 : this.caretLineIndex(caretOffset);
    const ctx: LineCtx = {};
    this.el.innerHTML = srcLines
      .map((line, i) => {
        const r = renderMarkdownLine(line, ctx);
        return `<div class="md-line ${r.cls}${i === caretLine ? " caret-line" : ""}">${r.html}</div>`;
      })
      .join("");
  }

  render(focused: boolean): void {
    const off = focused ? this.caretOffset() : null;
    this.renderInner(off);
    if (focused && off != null) this.setCaret(off);
  }
}
