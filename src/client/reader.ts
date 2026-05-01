// Reader page client. Stays under 5 KB gz.
// - Smooth-scroll to in-page anchors after load (handles refresh-with-hash).
// - Header-anchor (#) click copies a section anchor link.
// - Corner copy-link button copies the page URL.
// - Auto-expand tall table cells past the CSS 20vw/70vw cap.

import { expandTallCells } from "./lib/tableLayout.js";

(() => {
  const hash = window.location.hash;
  if (hash && hash.length > 1) {
    const target = document.getElementById(decodeURIComponent(hash.slice(1)));
    if (target) {
      requestAnimationFrame(() => target.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
  }

  // Header-anchor permalinks are emitted by markdown-it-anchor as the first
  // child of every heading (<a class="header-anchor" href="#id">#</a>). One
  // delegated listener on the prose container intercepts the navigation and
  // copies the section URL to the clipboard instead. Native focus + Enter
  // activation on the <a> gives keyboard parity for free.
  const proseRoot = document.querySelector(".prose");
  proseRoot?.addEventListener("click", (e) => {
    const t = e.target as Element | null;
    const anchor = t?.closest?.(".header-anchor") as HTMLAnchorElement | null;
    if (!anchor) return;
    e.preventDefault();
    const id = (anchor.getAttribute("href") ?? "").replace(/^#/, "");
    if (!id) return;
    const url = `${window.location.origin}${window.location.pathname}#${id}`;
    void copyToClipboard(url).then((ok) => { if (ok) toast("link copied"); });
    history.replaceState(null, "", `#${id}`);
  });

  const copyBtn = document.getElementById("copy-link-btn") as HTMLButtonElement | null;
  if (copyBtn) {
    copyBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      const url = window.location.origin + window.location.pathname;
      const ok = await copyToClipboard(url);
      if (!ok) return;
      copyBtn.dataset.copied = "true";
      setTimeout(() => { delete copyBtn.dataset.copied; }, 1500);
    });
  }

  // The reader script is appended at the bottom of <body>, so the prose
  // DOM is already parsed by the time we run.
  expandTallCells(document.body);

  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener("resize", () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => expandTallCells(document.body), 150);
  });

  async function copyToClipboard(text: string): Promise<boolean> {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch { /* fall through to legacy path */ }
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    const sel = document.getSelection();
    const savedRange = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
    if (savedRange && sel) {
      sel.removeAllRanges();
      sel.addRange(savedRange);
    }
    return ok;
  }

  function toast(msg: string): void {
    const el = document.createElement("div");
    el.className = "toast";
    // role=status + aria-live=polite so screen readers announce the
    // confirmation when the link is copied.
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1500);
  }
})();
