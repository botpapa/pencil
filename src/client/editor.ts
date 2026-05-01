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
    expandTallCells(previewOut!);
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

// ---------- mobile tab scroll sync ----------
//
// When swapping the visible pane on mobile we want the new pane to land on
// roughly the same content the user was reading. We anchor by markdown
// source line: the renderer tags every top-level block in the preview with
// data-source-line, and we convert textarea scroll <-> source line via the
// computed line-height. "Off by one paragraph" near the pane top is fine.

function getTextareaTopLine(): number {
  if (!mdInput) return 0;
  const lh = parseFloat(getComputedStyle(mdInput).lineHeight) || 24;
  // Desktop: textarea has its own scrollbar, so scrollTop is meaningful.
  // Mobile: the textarea grows to fit its content (field-sizing or our JS
  // autosize fallback) and the document scrolls; derive the top line from
  // the textarea's position in the viewport instead.
  const desktopScroll = mdInput.scrollTop;
  if (desktopScroll > 0) return Math.floor(desktopScroll / lh);
  const rect = mdInput.getBoundingClientRect();
  if (rect.top >= 0) return 0;
  return Math.floor(-rect.top / lh);
}

function scrollTextareaToLine(line: number): void {
  if (!mdInput || line <= 0) return;
  const lh = parseFloat(getComputedStyle(mdInput).lineHeight) || 24;
  const target = line * lh;
  if (!isMobile()) {
    mdInput.scrollTop = target;
  } else {
    const rect = mdInput.getBoundingClientRect();
    const taTopOnPage = window.scrollY + rect.top;
    window.scrollTo({ top: taTopOnPage + target, behavior: "auto" });
  }
}

function getPreviewTopLine(): number {
  if (!previewOut) return 0;
  const els = previewOut.querySelectorAll<HTMLElement>("[data-source-line]");
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.bottom > 0) {
      const v = Number(el.dataset.sourceLine);
      return Number.isFinite(v) ? v : 0;
    }
  }
  return 0;
}

function scrollPreviewToLine(line: number): void {
  if (!previewOut || !panePreview) return;
  const els = Array.from(
    previewOut.querySelectorAll<HTMLElement>("[data-source-line]"),
  );
  if (els.length === 0) return;
  // Walk in DOM order; keep the last block whose source-line is <= the
  // anchor. Markdown-it emits tokens in source order so this is stable.
  let target = els[0]!;
  for (const el of els) {
    const v = Number(el.dataset.sourceLine);
    if (Number.isFinite(v) && v <= line) target = el;
    else break;
  }
  if (!isMobile()) {
    const containerTop = panePreview.getBoundingClientRect().top;
    const targetTop = target.getBoundingClientRect().top;
    panePreview.scrollTop += targetTop - containerTop;
  } else {
    target.scrollIntoView({ block: "start", behavior: "auto" });
  }
}

// Mobile tabs.
async function selectTab(which: "edit" | "preview"): Promise<void> {
  if (!tabEdit || !tabPreview || !paneEdit || !panePreview) return;
  const fromEdit = !paneEdit.hidden;
  const fromPreview = !panePreview.hidden;
  const anchor = fromEdit
    ? getTextareaTopLine()
    : fromPreview
      ? getPreviewTopLine()
      : 0;

  const isEdit = which === "edit";
  tabEdit.setAttribute("aria-selected", isEdit ? "true" : "false");
  tabPreview.setAttribute("aria-selected", isEdit ? "false" : "true");
  paneEdit.hidden = !isEdit;
  panePreview.hidden = isEdit;

  if (!isEdit) {
    // Re-render so the preview reflects the latest textarea content before
    // we try to find a source-line anchor inside it.
    await runPreview();
    // Double rAF: one tick for the swapped pane to lay out, another for
    // the freshly-injected preview HTML to settle its block heights.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => scrollPreviewToLine(anchor));
    });
  } else {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => scrollTextareaToLine(anchor));
    });
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
  }, 150);
});
applyPreviewState();
syncPaneVisibility();

schedulePreview();
autosizeMdInput();
