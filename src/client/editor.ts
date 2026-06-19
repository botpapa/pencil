// Editor page client. Target ≤ 15 KB gz, must stay under 50 KB cap.
// - Split-pane / mobile tabs.
// - Tab-to-indent in textarea.
// - Debounced server preview (POST /api/preview).
// - Save: POST / (new page) or PUT /:slug (update).
// - localStorage drafts: every keystroke is debounced into pencil:draft:<key>;
//   restored on load; cleared on successful save. No beforeunload prompt.

import { expandTallCells } from "./lib/tableLayout.js";

type Mode = "new" | "edit";

const root = document.body;
const mode = (root.dataset.mode ?? "new") as Mode;
const slug = root.dataset.slug ?? "";

const titleInput = document.getElementById("title-input") as HTMLInputElement | null;
const mdInput = document.getElementById("md-input") as HTMLTextAreaElement | null;
const previewOut = document.getElementById("preview-output") as HTMLElement | null;
const saveBtn = document.getElementById("save-btn") as HTMLButtonElement | null;
const saveError = document.getElementById("save-error") as HTMLElement | null;
const tabEdit = document.getElementById("tab-edit") as HTMLButtonElement | null;
const tabPreview = document.getElementById("tab-preview") as HTMLButtonElement | null;
const paneEdit = document.getElementById("pane-edit") as HTMLElement | null;
const panePreview = document.getElementById("pane-preview") as HTMLElement | null;
const previewToggle = document.getElementById("preview-toggle") as HTMLButtonElement | null;
const splitEl = document.querySelector(".split") as HTMLElement | null;

if (!titleInput || !mdInput || !saveBtn || !previewOut) {
  throw new Error("editor: required nodes missing");
}

// Save button label captured at boot so we can restore it after a transient
// "saving…" swap during a failed save attempt.
const SAVE_BTN_LABEL = saveBtn.textContent ?? "save";

// Mirror the server-side cap (128 KB UTF-8 bytes). We use Blob to get the
// actual byte length so the client check matches what the server will accept
// — string.length counts UTF-16 code units, which underestimates bytes for
// any non-ASCII content (an emoji is 1 char but up to 4 bytes).
const MAX_CONTENT_BYTES = 128 * 1024;
const PREVIEW_DEBOUNCE_MS = 220;

function byteLength(s: string): number {
  return new Blob([s]).size;
}

function showSaveError(msg: string): void {
  if (saveError) saveError.textContent = msg;
}
function clearSaveError(): void {
  if (saveError) saveError.textContent = "";
}
const DRAFT_DEBOUNCE_MS = 250;
const PREVIEW_OPEN_KEY = "pencil:preview-open";
const DRAFT_KEY = mode === "edit" && slug ? `pencil:draft:${slug}` : "pencil:draft:new";
const MOBILE_BREAKPOINT = 720;

let lastPreviewRequestId = 0;
// The textarea value the preview pane currently reflects. Lets the mobile tab
// switch skip a redundant re-render (and its flash) when nothing has changed.
let lastRenderedValue: string | null = null;
let inFlightPreview: AbortController | null = null;
let lastSavedTitle = titleInput.value;
let lastSavedContent = mdInput.value;

function isMobile(): boolean {
  return window.innerWidth <= MOBILE_BREAKPOINT;
}

let previewOpen = (() => {
  try {
    return localStorage.getItem(PREVIEW_OPEN_KEY) === "true";
  } catch {
    return false;
  }
})();

// Save is enabled iff the current title/content differ from the last-saved
// baseline. For new mode the baseline starts empty, so the first keystroke
// enables save; clearing both fields disables it again.
function syncSaveEnabled(): void {
  const changed =
    titleInput!.value !== lastSavedTitle || mdInput!.value !== lastSavedContent;
  saveBtn!.disabled = !changed;
}

// Mobile autosize fallback. CSS owns this on browsers that ship
// `field-sizing: content` (Safari ≥ 17.4, Chrome ≥ 123, Firefox ≥ 124).
// Older browsers fall back to a JS-driven height matched to scrollHeight.
// Desktop uses a fixed-height pane with internal scroll, so we no-op there.
const SUPPORTS_FIELD_SIZING =
  typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content");

function autosizeMdInput(): void {
  if (SUPPORTS_FIELD_SIZING) return;
  if (!isMobile()) return;
  const ta = mdInput!;
  ta.style.height = "auto";
  ta.style.height = ta.scrollHeight + "px";
}

// ---------- localStorage draft ----------

type Draft = { title: string; content: string; ts: number };

function readDraft(): Draft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw) as Partial<Draft>;
    if (typeof j?.title !== "string" || typeof j?.content !== "string") return null;
    return { title: j.title, content: j.content, ts: typeof j.ts === "number" ? j.ts : 0 };
  } catch {
    return null;
  }
}

function writeDraft(): void {
  try {
    const draft: Draft = {
      title: titleInput!.value,
      content: mdInput!.value,
      ts: Date.now(),
    };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    /* private browsing / quota — silently ignore */
  }
}

function clearDraft(): void {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* ignore */
  }
}

type TimerId = ReturnType<typeof setTimeout>;
let draftTimer: TimerId | undefined;
function scheduleDraftWrite(): void {
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(writeDraft, DRAFT_DEBOUNCE_MS);
}

// Restore draft on load (telegra.ph-style: local browser is the source of
// truth for unsaved edits). For mode=edit this overrides the server-rendered
// initial content; for mode=new it restores the previous unsaved page.
(function restoreDraft(): void {
  const draft = readDraft();
  if (!draft) return;
  // For an edit page, only restore if the draft has actually been touched.
  if (mode === "edit" && draft.title === titleInput!.value && draft.content === mdInput!.value) {
    return;
  }
  titleInput!.value = draft.title;
  mdInput!.value = draft.content;
  // Restored content may differ from the saved baseline (edit mode) or be
  // non-empty (new mode); resync the save button and the autosized textarea.
  syncSaveEnabled();
  autosizeMdInput();
})();

// ---------- preview ----------

let previewTimer: TimerId | undefined;
function schedulePreview(): void {
  // Skip server roundtrip when preview is hidden on desktop. Mobile uses tabs
  // (selectTab triggers an explicit render when switching to preview).
  if (!isMobile() && !previewOpen) return;
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => void runPreview(), PREVIEW_DEBOUNCE_MS);
}

async function runPreview(): Promise<void> {
  const id = ++lastPreviewRequestId;
  const body = mdInput!.value;
  if (!body.trim()) {
    previewOut!.innerHTML = `<p class="placeholder"><em>preview appears here.</em></p>`;
    lastRenderedValue = body;
    return;
  }
  // Cancel any in-flight preview fetch so we stop wasting bandwidth on stale
  // typing — the response would have been discarded by the request-id check
  // anyway, but cancelling frees the connection sooner.
  if (inFlightPreview) inFlightPreview.abort();
  const controller = new AbortController();
  inFlightPreview = controller;
  try {
    const res = await fetch("/api/preview", {
      method: "POST",
      headers: { "Content-Type": "text/markdown" },
      body,
      signal: controller.signal,
    });
    if (id !== lastPreviewRequestId) return; // stale
    if (!res.ok) {
      previewOut!.innerHTML = `<p class="placeholder">preview failed (${res.status}).</p>`;
      return;
    }
    const html = await res.text();
    previewOut!.innerHTML = html;
    lastRenderedValue = body;
    expandTallCells(previewOut!);
    rebuildSyncPoints();
  } catch (err) {
    if (id !== lastPreviewRequestId) return;
    // Aborts are expected (we cancelled ourselves); don't show an error UI.
    if (err instanceof DOMException && err.name === "AbortError") return;
    previewOut!.innerHTML = `<p class="placeholder">preview failed (network).</p>`;
  } finally {
    if (inFlightPreview === controller) inFlightPreview = null;
  }
}

// ---------- save ----------

async function save(): Promise<void> {
  if (saveBtn!.disabled) return;
  const title = titleInput!.value.trim();
  const content = mdInput!.value;
  const bytes = byteLength(content);
  if (bytes > MAX_CONTENT_BYTES) {
    // Surface an inline error and bail. The button stays enabled (re-enabled
    // below in the finally block) so the user can trim and retry.
    const kb = (bytes / 1024).toFixed(1);
    showSaveError(`too large (${kb} KB > 128 KB)`);
    return;
  }
  clearSaveError();
  saveBtn!.disabled = true;
  saveBtn!.textContent = "saving…";
  let success = false;
  try {
    let res: Response;
    if (mode === "new") {
      res = await fetch("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, content }),
      });
      if (res.ok) {
        const j = (await res.json()) as { slug: string; url: string };
        clearDraft();
        success = true;
        window.location.href = j.url;
        return;
      }
    } else {
      res = await fetch(`/${slug}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, content }),
      });
      if (res.ok) {
        // Edit mode: hop straight to the published page after saving.
        // Clear the draft *before* navigating so a back-button revisit to
        // the editor reflects the saved state, not the just-saved draft.
        clearDraft();
        let dest = `/${slug}`;
        try {
          const j = (await res.json()) as { url?: string };
          if (typeof j?.url === "string" && j.url) dest = j.url;
        } catch {
          /* fall back to /:slug */
        }
        success = true;
        window.location.href = dest;
        return;
      }
    }
  } catch {
    /* network error — fall through to the re-enable path */
  } finally {
    if (!success) {
      saveBtn!.textContent = SAVE_BTN_LABEL;
      saveBtn!.disabled = false;
    }
  }
}

// ---------- input wiring ----------

function onChange(): void {
  if (saveError && saveError.textContent) clearSaveError();
  syncSaveEnabled();
  scheduleDraftWrite();
  schedulePreview();
  autosizeMdInput();
}

mdInput.addEventListener("input", onChange);
titleInput.addEventListener("input", onChange);

// Mirror the server-side title cap (src/types.ts MAX_TITLE_LENGTH). The input's
// `maxlength` only constrains typed input — programmatic value assignment below
// can exceed it, and the server would then reject the save — so we clamp here.
const MAX_TITLE_LENGTH = 200;

// Pasting multi-line text into the (single-line) title keeps only the first
// line as the title; everything after the first line break is pushed into the
// body. Without this the browser silently flattens the pasted newlines and the
// whole blob lands on one title line.
titleInput.addEventListener("paste", (e) => {
  const pasted = e.clipboardData?.getData("text/plain");
  if (pasted == null) return; // no plain-text payload — let the default run
  const normalized = pasted.replace(/\r\n?/g, "\n");
  const nl = normalized.indexOf("\n");
  if (nl === -1) return; // single line — nothing special to do

  e.preventDefault();
  const firstLine = normalized.slice(0, nl);
  const remainder = normalized.slice(nl + 1); // everything past the first break

  // Splice the first line into the title at the caret, preserving any title
  // text that sat before/after the selection.
  const t = titleInput!;
  const selStart = t.selectionStart ?? t.value.length;
  const selEnd = t.selectionEnd ?? t.value.length;
  const before = t.value.slice(0, selStart);
  const after = t.value.slice(selEnd);
  let line = before + firstLine + after;

  // Clamp to the cap; spill any overflow into the body rather than dropping it.
  let overflow = "";
  if (line.length > MAX_TITLE_LENGTH) {
    overflow = line.slice(MAX_TITLE_LENGTH);
    line = line.slice(0, MAX_TITLE_LENGTH);
  }
  t.value = line;
  const caret = Math.min(before.length + firstLine.length, MAX_TITLE_LENGTH);
  t.setSelectionRange(caret, caret);

  // Text destined for the body: title overflow (if any) then the remainder.
  const moved = overflow ? overflow + "\n" + remainder : remainder;
  if (moved) {
    // Prepend to the body, then focus it with the caret right after the moved
    // text so the user continues where the paste ended.
    const b = mdInput!;
    const existing = b.value;
    const joiner = existing && !moved.endsWith("\n") ? "\n" : "";
    b.value = moved + joiner + existing;
    b.focus();
    b.setSelectionRange(moved.length, moved.length);
  }

  onChange();
});

mdInput.addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  e.preventDefault();
  const ta = mdInput!;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const indent = "  ";
  if (e.shiftKey) {
    // outdent: remove up to 2 leading spaces from each selected line
    const before = ta.value.slice(0, start);
    const sel = ta.value.slice(start, end);
    const after = ta.value.slice(end);
    const lineStart = before.lastIndexOf("\n") + 1;
    const head = ta.value.slice(lineStart, start);
    const block = head + sel;
    const dedented = block.replace(/^ {1,2}/gm, "");
    const removed = block.length - dedented.length;
    ta.value = ta.value.slice(0, lineStart) + dedented + after;
    const newStart = Math.max(lineStart, start - Math.min(removed, head.length));
    const newEnd = end - removed;
    ta.setSelectionRange(newStart, newEnd);
  } else if (start === end) {
    ta.value = ta.value.slice(0, start) + indent + ta.value.slice(end);
    ta.setSelectionRange(start + indent.length, start + indent.length);
  } else {
    // multi-line indent
    const before = ta.value.slice(0, start);
    const sel = ta.value.slice(start, end);
    const after = ta.value.slice(end);
    const lineStart = before.lastIndexOf("\n") + 1;
    const head = ta.value.slice(lineStart, start);
    const block = head + sel;
    const indented = block.replace(/^/gm, indent);
    const added = indented.length - block.length;
    ta.value = ta.value.slice(0, lineStart) + indented + after;
    ta.setSelectionRange(start + indent.length, end + added);
  }
  onChange();
});

saveBtn.addEventListener("click", () => void save());

// Cmd/Ctrl-S
window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    void save();
  }
});

// ---------- scroll sync core ----------
//
// The textarea and preview stay aligned by markdown *source line*. The
// renderer tags each preview block with data-source-line; we pair every such
// block with the pixel offset of that source line inside the textarea, giving
// a list of sync points {editorY, previewY}. Mapping a scroll position through
// these points (piecewise-linear) keeps a tall rendered block aligned with its
// short source even though the two sides advance at different rates — the
// "preview scrolls slower" behaviour.
//
// The textarea soft-wraps, so a source line's offset is NOT line*lineHeight.
// We measure it with an offscreen mirror that reproduces the textarea's
// wrapping. Measured once per render / resize, never during a scroll.

type SyncPoint = { editorY: number; previewY: number };
let syncPoints: SyncPoint[] = [];
// Textarea top padding (px): textarea scrollTop 0 shows the text below this
// padding, so content-offset 0 corresponds to scrollTop === editorPadTopPx.
let editorPadTopPx = 0;

let mirrorEl: HTMLDivElement | null = null;
function getMirror(): HTMLDivElement {
  if (mirrorEl) return mirrorEl;
  const m = document.createElement("div");
  m.setAttribute("aria-hidden", "true");
  m.style.position = "absolute";
  m.style.top = "0";
  m.style.left = "-9999px";
  m.style.visibility = "hidden";
  m.style.pointerEvents = "none";
  m.style.whiteSpace = "pre-wrap";
  m.style.boxSizing = "border-box";
  document.body.appendChild(m);
  mirrorEl = m;
  return m;
}

function escapeForMirror(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Measure the content-space pixel offset (line 0 → 0) of each requested source
// line inside the textarea, reproducing its wrapping in the mirror.
function measureEditorOffsets(lines: number[]): Map<number, number> {
  const ta = mdInput!;
  const cs = getComputedStyle(ta);
  editorPadTopPx = parseFloat(cs.paddingTop) || 0;
  const m = getMirror();
  // Match every property that affects line wrapping / height.
  m.style.width = ta.clientWidth + "px";
  m.style.paddingTop = cs.paddingTop;
  m.style.paddingRight = cs.paddingRight;
  m.style.paddingBottom = cs.paddingBottom;
  m.style.paddingLeft = cs.paddingLeft;
  m.style.fontFamily = cs.fontFamily;
  m.style.fontSize = cs.fontSize;
  m.style.fontWeight = cs.fontWeight;
  m.style.fontStyle = cs.fontStyle;
  m.style.lineHeight = cs.lineHeight;
  m.style.letterSpacing = cs.letterSpacing;
  m.style.tabSize = cs.tabSize;
  m.style.overflowWrap = cs.overflowWrap || "break-word";
  m.style.wordBreak = cs.wordBreak;

  const srcLines = ta.value.split("\n");
  const need = new Set(lines);
  let htmlStr = "";
  for (let i = 0; i < srcLines.length; i++) {
    if (need.has(i)) htmlStr += `<span data-ml="${i}"></span>`;
    htmlStr += escapeForMirror(srcLines[i] ?? "");
    if (i < srcLines.length - 1) htmlStr += "\n";
  }
  // Zero-width trailing char so a marker on the last line still measures.
  m.innerHTML = htmlStr + "​";

  const out = new Map<number, number>();
  const mTop = m.getBoundingClientRect().top;
  for (const span of Array.from(m.querySelectorAll<HTMLElement>("[data-ml]"))) {
    const i = Number(span.dataset.ml);
    out.set(i, Math.max(0, span.getBoundingClientRect().top - mTop - editorPadTopPx));
  }
  return out;
}

// Rebuild the sync-point table from the current preview render. Cheap layout
// work done up front so scroll handlers only do arithmetic. Desktop only:
// on mobile the panes are swapped (one is display:none at any moment), so the
// editor and preview can't be measured together — selectTab maps per swap in
// source-line space instead.
function rebuildSyncPoints(): void {
  syncPoints = [];
  if (isMobile()) return;
  if (!previewOut || !panePreview || !mdInput) return;
  const containerTop = panePreview.getBoundingClientRect().top;
  const base = panePreview.scrollTop;
  const anchors: { line: number; previewY: number }[] = [];
  for (const el of Array.from(previewOut.querySelectorAll<HTMLElement>("[data-source-line]"))) {
    const line = Number(el.dataset.sourceLine);
    if (!Number.isFinite(line)) continue;
    anchors.push({ line, previewY: base + (el.getBoundingClientRect().top - containerTop) });
  }
  if (anchors.length === 0) return;
  const offsets = measureEditorOffsets(anchors.map((a) => a.line));
  const pts: SyncPoint[] = [];
  for (const a of anchors) {
    const editorY = offsets.get(a.line);
    if (editorY !== undefined) pts.push({ editorY, previewY: a.previewY });
  }
  // Keep points strictly increasing on both axes so interpolation is stable.
  pts.sort((p, q) => p.editorY - q.editorY);
  const mono: SyncPoint[] = [];
  for (const p of pts) {
    const last = mono[mono.length - 1];
    if (!last || (p.editorY > last.editorY && p.previewY > last.previewY)) mono.push(p);
  }
  syncPoints = mono;
}

// Piecewise-linear map of `v` from one axis to the other, extrapolating with
// the last segment's slope past the final point so pane ends meet.
function mapThrough(from: "editorY" | "previewY", to: "editorY" | "previewY", v: number): number {
  const p = syncPoints;
  if (p.length === 0) return 0;
  if (p.length === 1) return p[0]![to];
  if (v <= p[0]![from]) return p[0]![to];
  for (let i = 1; i < p.length; i++) {
    if (v <= p[i]![from]) {
      const lo = p[i - 1]!, hi = p[i]!;
      const span = hi[from] - lo[from];
      const frac = span > 0 ? (v - lo[from]) / span : 0;
      return lo[to] + frac * (hi[to] - lo[to]);
    }
  }
  const a = p[p.length - 2]!, b = p[p.length - 1]!;
  const span = b[from] - a[from];
  const slope = span > 0 ? (b[to] - a[to]) / span : 0;
  return b[to] + (v - b[from]) * slope;
}

// Current editor content-offset visible at the top of the viewport, for both
// layouts: desktop the textarea scrolls (scrollTop), mobile the window scrolls
// (derive from the textarea's position relative to the viewport).
function readEditorOffset(): number {
  if (!isMobile()) return Math.max(0, mdInput!.scrollTop - editorPadTopPx);
  return Math.max(0, -mdInput!.getBoundingClientRect().top - editorPadTopPx);
}
function writeEditorOffset(editorY: number): void {
  if (!isMobile()) {
    mdInput!.scrollTop = editorY + editorPadTopPx;
  } else {
    const top = window.scrollY + mdInput!.getBoundingClientRect().top + editorPadTopPx + editorY;
    window.scrollTo({ top, behavior: "auto" });
  }
}
// Same for the preview pane. previewY is measured from the pane's border-box
// top, so it maps directly to scrollTop (desktop) or a window offset (mobile).
function readPreviewY(): number {
  if (!isMobile()) return panePreview!.scrollTop;
  return Math.max(0, -panePreview!.getBoundingClientRect().top);
}
function writePreviewY(previewY: number): void {
  if (!isMobile()) {
    panePreview!.scrollTop = previewY;
  } else {
    const top = window.scrollY + panePreview!.getBoundingClientRect().top + previewY;
    window.scrollTo({ top, behavior: "auto" });
  }
}

// ---------- mobile tab sync (source-line space) ----------
//
// Mobile shows one pane at a time, so we can't hold a combined sync table.
// Instead the markdown *source line* is the shared currency: read the line at
// the top of the visible pane, swap, then scroll the now-visible pane to that
// same line. Each pane's geometry is only ever read while it's visible (the
// editor mirror in particular needs a laid-out textarea).

type LinePoint = { line: number; y: number };

// Piecewise-linear interpolation over points, mapping `from` -> `to`. Sorts by
// `from` and extrapolates past the ends with the last segment's slope.
function interpLineY(pts: LinePoint[], from: "line" | "y", to: "line" | "y", v: number): number {
  if (pts.length === 0) return 0;
  const a = [...pts].sort((p, q) => p[from] - q[from]);
  if (a.length === 1) return a[0]![to];
  if (v <= a[0]![from]) return a[0]![to];
  for (let i = 1; i < a.length; i++) {
    if (v <= a[i]![from]) {
      const lo = a[i - 1]!, hi = a[i]!;
      const span = hi[from] - lo[from];
      const f = span > 0 ? (v - lo[from]) / span : 0;
      return lo[to] + f * (hi[to] - lo[to]);
    }
  }
  const lo = a[a.length - 2]!, hi = a[a.length - 1]!;
  const span = hi[from] - lo[from];
  const slope = span > 0 ? (hi[to] - lo[to]) / span : 0;
  return hi[to] + (v - hi[from]) * slope;
}

// Source lines that have a preview block. Readable from the DOM even while the
// preview pane is hidden (we only need the attribute, not geometry).
function previewSourceLines(): number[] {
  if (!previewOut) return [];
  const out: number[] = [];
  for (const el of Array.from(previewOut.querySelectorAll<HTMLElement>("[data-source-line]"))) {
    const line = Number(el.dataset.sourceLine);
    if (Number.isFinite(line)) out.push(line);
  }
  return out;
}

// Preview block source-line -> y offset from the pane's top. Requires the
// preview pane to be laid out (visible).
function previewLineYs(): LinePoint[] {
  if (!previewOut || !panePreview) return [];
  const top = panePreview.getBoundingClientRect().top;
  const out: LinePoint[] = [];
  for (const el of Array.from(previewOut.querySelectorAll<HTMLElement>("[data-source-line]"))) {
    const line = Number(el.dataset.sourceLine);
    if (Number.isFinite(line)) out.push({ line, y: el.getBoundingClientRect().top - top });
  }
  return out;
}

// Editor source-line -> content y offset, via the mirror. Requires the
// textarea to be laid out (visible).
function editorLineYs(lines: number[]): LinePoint[] {
  const offs = measureEditorOffsets(lines);
  const out: LinePoint[] = [];
  for (const line of lines) {
    const y = offs.get(line);
    if (y !== undefined) out.push({ line, y });
  }
  return out;
}

// Mobile tabs.
async function selectTab(which: "edit" | "preview"): Promise<void> {
  if (!tabEdit || !tabPreview || !paneEdit || !panePreview || !mdInput) return;
  const lines = previewSourceLines();

  // 1. Read the source line at the top of the pane we're leaving — while it's
  //    still visible (the hidden pane has no usable geometry).
  let targetLine = 0;
  if (!paneEdit.hidden) {
    targetLine = interpLineY(editorLineYs(lines), "y", "line", readEditorOffset());
  } else if (!panePreview.hidden) {
    targetLine = interpLineY(previewLineYs(), "y", "line", readPreviewY());
  }

  // 2. Swap panes.
  const isEdit = which === "edit";
  tabEdit.setAttribute("aria-selected", isEdit ? "true" : "false");
  tabPreview.setAttribute("aria-selected", isEdit ? "false" : "true");
  paneEdit.hidden = !isEdit;
  panePreview.hidden = isEdit;

  // 3. Position the now-visible pane to the same source line *synchronously*,
  //    in this same task before the browser paints, so the content appears
  //    already in place instead of flashing at the wrong spot then jumping.
  //    (Reading getBoundingClientRect here forces the layout we need.)
  if (isEdit) {
    writeEditorOffset(interpLineY(editorLineYs(lines), "line", "y", targetLine));
    return;
  }
  writePreviewY(interpLineY(previewLineYs(), "line", "y", targetLine));

  // 4. Only when the preview is stale (edits since the last render) do we pay
  //    for a re-render + re-anchor; otherwise the synchronous step above is the
  //    whole switch — no network, no flash.
  if (mdInput.value !== lastRenderedValue) {
    await runPreview();
    writePreviewY(interpLineY(previewLineYs(), "line", "y", targetLine));
  }
}
tabEdit?.addEventListener("click", () => void selectTab("edit"));
tabPreview?.addEventListener("click", () => void selectTab("preview"));

// Desktop preview-toggle.
function applyPreviewState(): void {
  if (splitEl) splitEl.dataset.previewOpen = previewOpen ? "true" : "false";
  if (previewToggle) {
    previewToggle.textContent = previewOpen ? "preview: on" : "preview: off";
    previewToggle.setAttribute("aria-pressed", previewOpen ? "true" : "false");
  }
}

function setPreviewOpen(next: boolean): void {
  previewOpen = next;
  try {
    localStorage.setItem(PREVIEW_OPEN_KEY, next ? "true" : "false");
  } catch {
    /* ignore quota / unavailable storage */
  }
  applyPreviewState();
  syncPaneVisibility();
  if (next) void runPreview();
}

previewToggle?.addEventListener("click", () => setPreviewOpen(!previewOpen));

// On desktop, the preview pane visibility is driven by the data-preview-open
// flag on .split (CSS collapses the column to 0). The `hidden` attribute is
// only used to swap panes on mobile.
function syncPaneVisibility(): void {
  if (!paneEdit || !panePreview) return;
  if (!isMobile()) {
    paneEdit.hidden = false;
    panePreview.hidden = false;
  } else {
    const editSelected = tabEdit?.getAttribute("aria-selected") !== "false";
    paneEdit.hidden = !editSelected;
    panePreview.hidden = editSelected;
  }
}
let tableResizeTimer: TimerId | undefined;
window.addEventListener("resize", () => {
  syncPaneVisibility();
  autosizeMdInput();
  if (tableResizeTimer) clearTimeout(tableResizeTimer);
  tableResizeTimer = setTimeout(() => {
    if (previewOut) expandTallCells(previewOut);
    rebuildSyncPoints(); // widths/wrapping changed → offsets are stale
  }, 150);
});
applyPreviewState();
syncPaneVisibility();

// ---------- desktop live scroll sync ----------
//
// With both panes visible side by side, scrolling whichever pane the pointer is
// over (the "leader") drives the other (the "follower") through the shared
// sync points above. The follower's scroll handler is short-circuited by the
// activePane check, so setting its scrollTop never feeds back into a loop.

let activePane: "edit" | "preview" = "edit";
paneEdit?.addEventListener("pointerenter", () => {
  activePane = "edit";
});
panePreview?.addEventListener("pointerenter", () => {
  activePane = "preview";
});

// rAF-coalesce scroll events: at most one sync per frame, and only arithmetic
// inside (sync points are precomputed, never measured during a scroll).
let syncRaf = 0;
function scheduleSync(run: () => void): void {
  if (syncRaf) return;
  syncRaf = requestAnimationFrame(() => {
    syncRaf = 0;
    run();
  });
}

function canSync(): boolean {
  return !isMobile() && previewOpen && syncPoints.length > 0;
}

mdInput.addEventListener("scroll", () => {
  if (!canSync() || activePane !== "edit") return;
  scheduleSync(() => {
    panePreview!.scrollTop = mapThrough("editorY", "previewY", readEditorOffset());
  });
});

panePreview?.addEventListener("scroll", () => {
  if (!canSync() || activePane !== "preview") return;
  scheduleSync(() => {
    mdInput!.scrollTop = mapThrough("previewY", "editorY", panePreview!.scrollTop) + editorPadTopPx;
  });
});

schedulePreview();
autosizeMdInput();
