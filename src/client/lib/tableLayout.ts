// Auto-expand tall table cells beyond their CSS max-width cap.
//
// CSS pins `.table-wrap th, .table-wrap td` to `max-width: 20vw` (desktop)
// or `70vw` (mobile) so wide tables don't blow out the layout. That cap is
// often too aggressive for cells holding a paragraph of prose, which then
// wrap to a tall stripe. This helper measures wrapped line counts after
// layout and bumps the cap to 2× (tier 1) or 4× (tier 2) for cells whose
// content still wraps to 8+ lines. Per-cell `style.maxWidth` is enough:
// the browser sizes each column to the union of its cells' constraints,
// so widening one cell widens the column.
//
// Param is `Document | Element` (rather than the DOM's `ParentNode`) because
// the Cloudflare Workers types pull in HTMLRewriter's `ParentNode` interface
// which collides with the DOM one under this project's tsconfig.
export function expandTallCells(root: Document | Element): void {
  const cells = root.querySelectorAll<HTMLTableCellElement>(
    ".table-wrap th, .table-wrap td",
  );
  if (cells.length === 0) return;
  const baseVw = window.innerWidth > 720 ? 20 : 70;
  const basePx = (baseVw / 100) * window.innerWidth;
  for (const cell of cells) {
    // Reset prior expansion so resize / preview rerender recomputes from
    // tier 0 — otherwise a cell widened on a wide window stays wide.
    cell.style.maxWidth = "";
    const cs = getComputedStyle(cell);
    // `line-height: normal` parses to NaN; 24px is a safe fallback for the
    // current 0.95em-of-18px cell font (~22–28px line-height range).
    const lh = parseFloat(cs.lineHeight) || 24;
    const lines0 = Math.round(cell.scrollHeight / lh);
    if (lines0 < 8) continue;
    cell.style.maxWidth = `${Math.round(basePx * 2)}px`;
    void cell.offsetHeight;
    const lines1 = Math.round(cell.scrollHeight / lh);
    if (lines1 < 8) continue;
    cell.style.maxWidth = `${Math.round(basePx * 4)}px`;
  }
}
