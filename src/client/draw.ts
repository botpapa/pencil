// draw.pencil.md — infinite-canvas client.
//
// Layers inside a pan/zoom "world": an SVG layer for strokes + shapes, and an
// HTML layer for text blocks (live-markdown contentEditable) and images.
// Two modes toggled with Cmd/Ctrl+Enter: "draw" (toolbar of colours + tools)
// and "text" (click anywhere to type). Read-only mode just pans/zooms.

import { TextEditor } from "./lib/textEditor.js";

// ---------- model ----------

type Pt = [number, number];
type Tool = "draw" | "select" | "rect" | "ellipse" | "line" | "arrow";
type Mode = "draw" | "text";

interface StrokeEl { id: string; type: "stroke"; points: Pt[]; color: string; width: number; }
interface ShapeEl { id: string; type: "shape"; shape: "rect" | "ellipse" | "line" | "arrow"; x: number; y: number; w: number; h: number; color: string; width: number; }
interface TextEl { id: string; type: "text"; x: number; y: number; md: string; color: string; fontSize: number; }
interface ImageEl { id: string; type: "image"; x: number; y: number; w: number; h: number; url: string; }
type El = StrokeEl | ShapeEl | TextEl | ImageEl;

interface Scene {
  schemaVersion: number;
  elements: El[];
  viewport: { x: number; y: number; zoom: number };
}

const COLORS = ["#1A1714", "#F4B400", "#B83A28", "#2F6F4E", "#2B5C8A"];
const SVGNS = "http://www.w3.org/2000/svg";


// DOM ParentNode.append is shadowed by @cloudflare/workers-types' HTMLRewriter
// Element.append in this project's global types, so use appendChild via a tiny
// variadic helper instead.
function add(parent: Node, ...kids: (Node | null)[]): void {
  for (const k of kids) if (k) parent.appendChild(k);
}

// ---------- boot ----------

const body = document.body;
const mode0 = (body.dataset.mode ?? "new") as "new" | "edit" | "read";
const readOnly = mode0 === "read";
const slug = body.dataset.slug ?? "";
const isMac = /Mac|iPhone|iPad/i.test(navigator.platform) || /Mac OS X/i.test(navigator.userAgent);
const MOD = isMac ? "⌘" : "Ctrl+";

const root = document.getElementById("draw-root") as HTMLElement;
const titleInput = document.getElementById("draw-title") as HTMLInputElement | null;
const saveBtn = document.getElementById("draw-save") as HTMLButtonElement | null;
const statusEl = document.getElementById("draw-status") as HTMLElement | null;

function loadScene(): Scene {
  const el = document.getElementById("scene-data");
  const fallback: Scene = { schemaVersion: 1, elements: [], viewport: { x: 0, y: 0, zoom: 1 } };
  if (!el || !el.textContent) return fallback;
  try {
    const s = JSON.parse(el.textContent) as Scene;
    if (!Array.isArray(s.elements)) return fallback;
    if (!s.viewport) s.viewport = { x: 0, y: 0, zoom: 1 };
    return s;
  } catch {
    return fallback;
  }
}

const scene = loadScene();
let mode: Mode = "draw";
let tool: Tool = "draw";
let color = COLORS[0]!;
let strokeWidth = 3;
let textSize = 18; // font size (px) for the next text block; tracks the size bar
let selectedId: string | null = null;
// True when an element is selected for transform (move/resize handles shown).
// Distinct from a text block being focused for editing.
let transformSelected = false;

let nid = 0;
function uid(): string {
  nid += 1;
  return `e${Date.now().toString(36)}${nid}`;
}

// ---------- world / coordinate transforms ----------

const world = document.createElement("div");
world.className = "draw-world";
const svg = document.createElementNS(SVGNS, "svg");
svg.setAttribute("class", "draw-svg");
svg.setAttribute("width", "1");
svg.setAttribute("height", "1");
const htmlLayer = document.createElement("div");
htmlLayer.className = "draw-html";
add(world, svg, htmlLayer);
add(root, world);

const vp = scene.viewport;

// If we arrived from the reader's "edit" link, restore that exact view
// (#v=x,y,zoom) so editing continues where the reader was looking.
(function applyHashViewport(): void {
  const m = /#v=(-?[\d.]+),(-?[\d.]+),([\d.]+)/.exec(location.hash);
  if (m) { vp.x = +m[1]!; vp.y = +m[2]!; vp.zoom = +m[3]!; }
})();

function applyViewport(): void {
  world.style.transform = `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`;
  if (zoomLevel) zoomLevel.textContent = `${Math.round(vp.zoom * 100)}%`;
  afterViewportChange();
}

function toWorld(clientX: number, clientY: number): Pt {
  return [(clientX - vp.x) / vp.zoom, (clientY - vp.y) / vp.zoom];
}

// ---------- rendering ----------

const elNodes = new Map<string, SVGElement | HTMLElement>();

function strokePath(points: Pt[]): string {
  if (points.length < 2) {
    const p = points[0] ?? [0, 0];
    return `M ${p[0]} ${p[1]} L ${p[0] + 0.1} ${p[1] + 0.1}`;
  }
  // Quadratic smoothing through midpoints for a natural hand-drawn line.
  let d = `M ${points[0]![0]} ${points[0]![1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [x0, y0] = points[i]!;
    const [x1, y1] = points[i + 1]!;
    d += ` Q ${x0} ${y0} ${(x0 + x1) / 2} ${(y0 + y1) / 2}`;
  }
  const last = points[points.length - 1]!;
  d += ` L ${last[0]} ${last[1]}`;
  return d;
}

function renderStroke(el: StrokeEl): SVGElement {
  const p = document.createElementNS(SVGNS, "path");
  p.setAttribute("d", strokePath(el.points));
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", el.color);
  p.setAttribute("stroke-width", String(el.width));
  p.setAttribute("stroke-linecap", "round");
  p.setAttribute("stroke-linejoin", "round");
  return p;
}

function renderShape(el: ShapeEl): SVGElement {
  const x = Math.min(el.x, el.x + el.w);
  const y = Math.min(el.y, el.y + el.h);
  const w = Math.abs(el.w);
  const h = Math.abs(el.h);
  let node: SVGElement;
  if (el.shape === "rect") {
    node = document.createElementNS(SVGNS, "rect");
    node.setAttribute("x", String(x));
    node.setAttribute("y", String(y));
    node.setAttribute("width", String(w));
    node.setAttribute("height", String(h));
    node.setAttribute("rx", "6");
  } else if (el.shape === "ellipse") {
    node = document.createElementNS(SVGNS, "ellipse");
    node.setAttribute("cx", String(x + w / 2));
    node.setAttribute("cy", String(y + h / 2));
    node.setAttribute("rx", String(w / 2));
    node.setAttribute("ry", String(h / 2));
  } else {
    // line / arrow share a line; arrow adds a head
    const g = document.createElementNS(SVGNS, "g");
    const line = document.createElementNS(SVGNS, "line");
    line.setAttribute("x1", String(el.x));
    line.setAttribute("y1", String(el.y));
    line.setAttribute("x2", String(el.x + el.w));
    line.setAttribute("y2", String(el.y + el.h));
    line.setAttribute("stroke", el.color);
    line.setAttribute("stroke-width", String(el.width));
    line.setAttribute("stroke-linecap", "round");
    add(g, line);
    if (el.shape === "arrow") {
      const ang = Math.atan2(el.h, el.w);
      const len = 14;
      const tip: Pt = [el.x + el.w, el.y + el.h];
      for (const off of [Math.PI - 0.5, Math.PI + 0.5]) {
        const hx = tip[0] + len * Math.cos(ang + off);
        const hy = tip[1] + len * Math.sin(ang + off);
        const hl = document.createElementNS(SVGNS, "line");
        hl.setAttribute("x1", String(tip[0]));
        hl.setAttribute("y1", String(tip[1]));
        hl.setAttribute("x2", String(hx));
        hl.setAttribute("y2", String(hy));
        hl.setAttribute("stroke", el.color);
        hl.setAttribute("stroke-width", String(el.width));
        hl.setAttribute("stroke-linecap", "round");
        add(g, hl);
      }
    }
    return g;
  }
  node.setAttribute("fill", "none");
  node.setAttribute("stroke", el.color);
  node.setAttribute("stroke-width", String(el.width));
  return node;
}

function renderImage(el: ImageEl): HTMLElement {
  const img = document.createElement("img");
  img.className = "draw-img";
  img.src = el.url;
  img.style.left = `${el.x}px`;
  img.style.top = `${el.y}px`;
  img.style.width = `${el.w}px`;
  img.style.height = `${el.h}px`;
  img.draggable = false;
  return img;
}

// Full re-render of all elements (used on load / undo / structural change).
function renderAll(): void {
  // clear
  for (const node of elNodes.values()) node.remove();
  elNodes.clear();
  for (const el of scene.elements) mountEl(el);
  applyViewport();
}

function mountEl(el: El): void {
  let node: SVGElement | HTMLElement;
  if (el.type === "stroke") {
    node = renderStroke(el);
    add(svg, node);
  } else if (el.type === "shape") {
    node = renderShape(el);
    add(svg, node);
  } else if (el.type === "image") {
    node = renderImage(el);
    add(htmlLayer, node);
  } else {
    node = mountText(el);
    add(htmlLayer, node);
  }
  (node as HTMLElement).dataset && ((node as HTMLElement).dataset.id = el.id);
  node.setAttribute("data-id", el.id);
  elNodes.set(el.id, node);
}

function remountEl(el: El): void {
  const old = elNodes.get(el.id);
  if (old) old.remove();
  elNodes.delete(el.id);
  mountEl(el);
}

// ---------- live-markdown text element ----------

const editors = new Map<string, TextEditor>();

function mountText(el: TextEl): HTMLElement {
  const div = document.createElement("div");
  div.className = "draw-text";
  div.style.left = `${el.x}px`;
  div.style.top = `${el.y}px`;
  div.style.color = el.color;
  div.style.fontSize = `${el.fontSize}px`;
  div.setAttribute("data-id", el.id);
  if (!readOnly) div.contentEditable = "true";
  const editor = new TextEditor(div, el, {
    onChange: () => { if (transformSelected) { transformSelected = false; updateSelectionOverlay(); } markDirty(); },
    onFocus: () => { selectEl(el.id, false); reflectTextSize(el.fontSize); },
    readOnly,
  });
  editors.set(el.id, editor);
  editor.render(false);
  return div;
}

// ---------- selection ----------

function selectEl(id: string | null, scroll: boolean): void {
  if (selectedId && elNodes.get(selectedId)) elNodes.get(selectedId)!.classList.remove("selected");
  selectedId = id;
  if (id && elNodes.get(id)) elNodes.get(id)!.classList.add("selected");
  void scroll;
  updateSelectionOverlay();
}

function deleteSelected(): void {
  if (!selectedId) return;
  const i = scene.elements.findIndex((e) => e.id === selectedId);
  if (i < 0) return;
  pushHistory();
  const [removed] = scene.elements.splice(i, 1);
  if (removed) {
    elNodes.get(removed.id)?.remove();
    elNodes.delete(removed.id);
    editors.delete(removed.id);
  }
  selectedId = null;
  updateSelectionOverlay();
  markDirty();
}

// ---------- selection overlay: move + resize handles (text & image) ----------

let selOverlay: HTMLElement | null = null;

function buildOverlay(): void {
  selOverlay = document.createElement("div");
  selOverlay.className = "sel-overlay";
  selOverlay.hidden = true;
  for (const corner of ["nw", "ne", "sw", "se"] as const) {
    const h = document.createElement("div");
    h.className = `sel-handle sel-${corner}`;
    h.addEventListener("pointerdown", (e) => startResize(e, corner));
    add(selOverlay, h);
  }
  selOverlay.addEventListener("pointerdown", onOverlayDown);
  // Double-click the box re-enters text editing.
  selOverlay.addEventListener("dblclick", () => {
    const el = scene.elements.find((x) => x.id === selectedId);
    if (el?.type === "text") { transformSelected = false; hideOverlay(); editors.get(el.id)?.el.focus(); }
  });
  add(document.body, selOverlay);
}

function hideOverlay(): void {
  if (selOverlay) selOverlay.hidden = true;
}

// World-space box of a resizable element (image dims are stored; text is
// measured from its rendered node).
function worldBox(el: El): { x: number; y: number; w: number; h: number } | null {
  if (el.type === "image") return { x: el.x, y: el.y, w: el.w, h: el.h };
  if (el.type === "text") {
    const node = elNodes.get(el.id) as HTMLElement | undefined;
    return { x: el.x, y: el.y, w: node ? node.offsetWidth : 120, h: node ? node.offsetHeight : 30 };
  }
  return null;
}

function updateSelectionOverlay(): void {
  if (!selOverlay) return;
  const el = selectedId ? scene.elements.find((x) => x.id === selectedId) : null;
  const node = el ? elNodes.get(el.id) : null;
  // Overlay shows only in transform mode (move/resize), never during editing.
  if (!el || !node || (el.type !== "text" && el.type !== "image") || !transformSelected) {
    selOverlay.hidden = true;
    return;
  }
  const r = node.getBoundingClientRect();
  selOverlay.hidden = false;
  selOverlay.style.left = `${r.left}px`;
  selOverlay.style.top = `${r.top}px`;
  selOverlay.style.width = `${r.width}px`;
  selOverlay.style.height = `${r.height}px`;
}

// Drag the box body → move the element.
function onOverlayDown(e: PointerEvent): void {
  if (e.target !== selOverlay) return; // handles handle themselves
  e.preventDefault();
  const el = scene.elements.find((x) => x.id === selectedId) as (TextEl | ImageEl) | undefined;
  if (!el) return;
  pushHistory();
  const startW = toWorld(e.clientX, e.clientY);
  const ox = el.x, oy = el.y;
  try { selOverlay!.setPointerCapture(e.pointerId); } catch { /* */ }
  const node = elNodes.get(el.id) as HTMLElement | undefined;
  const move = (ev: PointerEvent): void => {
    const w = toWorld(ev.clientX, ev.clientY);
    el.x = ox + (w[0] - startW[0]);
    el.y = oy + (w[1] - startW[1]);
    // Update the existing node in place — never remount mid-drag (remounting a
    // text block recreates its editor + re-parses markdown every frame = jank).
    if (node) { node.style.left = `${el.x}px`; node.style.top = `${el.y}px`; }
    updateSelectionOverlay();
  };
  const up = (): void => {
    selOverlay!.removeEventListener("pointermove", move);
    selOverlay!.removeEventListener("pointerup", up);
    markDirty();
  };
  selOverlay!.addEventListener("pointermove", move);
  selOverlay!.addEventListener("pointerup", up);
}

// Drag a corner → scale. Image scales w/h; text scales fontSize. The opposite
// corner stays anchored; aspect ratio is preserved.
function startResize(e: PointerEvent, corner: "nw" | "ne" | "sw" | "se"): void {
  e.preventDefault();
  e.stopPropagation();
  const el = scene.elements.find((x) => x.id === selectedId) as (TextEl | ImageEl) | undefined;
  if (!el) return;
  const box = worldBox(el);
  if (!box) return;
  pushHistory();
  const ax = corner === "se" || corner === "ne" ? box.x : box.x + box.w; // anchor X (opposite)
  const ay = corner === "se" || corner === "sw" ? box.y : box.y + box.h; // anchor Y (opposite)
  const dragX = corner === "ne" || corner === "se" ? box.x + box.w : box.x;
  const dragY = corner === "sw" || corner === "se" ? box.y + box.h : box.y;
  const origDiag = Math.hypot(dragX - ax, dragY - ay) || 1;
  const origFont = el.type === "text" ? el.fontSize : 0;
  try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch { /* */ }
  const node = elNodes.get(el.id) as HTMLElement | undefined;
  const move = (ev: PointerEvent): void => {
    const p = toWorld(ev.clientX, ev.clientY);
    const s = Math.min(50, Math.max(0.05, Math.hypot(p[0] - ax, p[1] - ay) / origDiag));
    const nw = box.w * s, nh = box.h * s;
    const nx = corner === "se" || corner === "ne" ? ax : ax - nw;
    const ny = corner === "se" || corner === "sw" ? ay : ay - nh;
    // In-place style updates only — no remount (text/markdown scales via the
    // em-based spans when we change the block's font-size).
    if (el.type === "image") {
      el.w = nw; el.h = nh; el.x = nx; el.y = ny;
      if (node) { node.style.width = `${nw}px`; node.style.height = `${nh}px`; node.style.left = `${nx}px`; node.style.top = `${ny}px`; }
    } else {
      el.fontSize = Math.max(MIN_FONT, origFont * s); el.x = nx; el.y = ny;
      if (node) { node.style.fontSize = `${el.fontSize}px`; node.style.left = `${nx}px`; node.style.top = `${ny}px`; }
      reflectTextSize(el.fontSize);
    }
    updateSelectionOverlay();
  };
  const up = (): void => {
    (e.target as HTMLElement).removeEventListener("pointermove", move);
    (e.target as HTMLElement).removeEventListener("pointerup", up);
    markDirty();
  };
  (e.target as HTMLElement).addEventListener("pointermove", move);
  (e.target as HTMLElement).addEventListener("pointerup", up);
}

// ---------- history (undo/redo) ----------

const undoStack: string[] = [];
const redoStack: string[] = [];
function snapshot(): string {
  return JSON.stringify(scene.elements);
}
function pushHistory(): void {
  undoStack.push(snapshot());
  if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
}
function restore(json: string): void {
  scene.elements = JSON.parse(json) as El[];
  editors.clear();
  renderAll();
  selectedId = null;
  markDirty();
}
function undo(): void {
  const prev = undoStack.pop();
  if (prev == null) return;
  redoStack.push(snapshot());
  restore(prev);
}
function redo(): void {
  const next = redoStack.pop();
  if (next == null) return;
  undoStack.push(snapshot());
  restore(next);
}

// ---------- dirty / autosave status ----------

let dirty = false;
function markDirty(): void {
  dirty = true;
  if (statusEl) statusEl.textContent = "unsaved";
  scheduleDraft();
}
let draftTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleDraft(): void {
  if (readOnly) return;
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 800);
}
const DRAFT_KEY = mode0 === "edit" && slug ? `draw:draft:${slug}` : "draw:draft:new";
function saveDraft(): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ title: titleInput?.value ?? "", scene: serialize() }));
  } catch { /* ignore */ }
}

// ---------- pointer interaction ----------

let drawing: StrokeEl | ShapeEl | null = null;
let drawingNode: SVGElement | null = null;
let panning = false;
let panStart: Pt = [0, 0];
let panOrigin: Pt = [0, 0];
let moving: { id: string; start: Pt; orig: { x: number; y: number } } | null = null;

// Multi-touch: track active pointers; 2+ → pinch-zoom + pan gesture.
const pointers = new Map<number, Pt>();
let gesture: { startDist: number; worldCx: number; worldCy: number; startZoom: number } | null = null;

function startGesture(): void {
  // Cancel any in-progress single-pointer action so two fingers only zoom/pan.
  if (drawing) { drawingNode?.remove(); drawing = null; drawingNode = null; undoStack.pop(); }
  moving = null;
  panning = false;
  root.classList.remove("panning");
  const pts = [...pointers.values()];
  if (pts.length < 2) return;
  const [a, b] = [pts[0]!, pts[1]!];
  const cx = (a[0] + b[0]) / 2;
  const cy = (a[1] + b[1]) / 2;
  gesture = {
    startDist: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1,
    worldCx: (cx - vp.x) / vp.zoom,
    worldCy: (cy - vp.y) / vp.zoom,
    startZoom: vp.zoom,
  };
}

function moveGesture(): void {
  if (!gesture) return;
  const pts = [...pointers.values()];
  if (pts.length < 2) return;
  const [a, b] = [pts[0]!, pts[1]!];
  const cx = (a[0] + b[0]) / 2;
  const cy = (a[1] + b[1]) / 2;
  const dist = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1;
  const newZoom = Math.min(8, Math.max(0.1, gesture.startZoom * (dist / gesture.startDist)));
  vp.zoom = newZoom;
  vp.x = cx - gesture.worldCx * newZoom;
  vp.y = cy - gesture.worldCy * newZoom;
  applyViewport();
}

function hitElementId(target: EventTarget | null): string | null {
  let n = target as HTMLElement | null;
  while (n && n !== root) {
    if (n.dataset && n.dataset.id) return n.dataset.id;
    n = n.parentElement;
  }
  return null;
}

root.addEventListener("pointerdown", (e) => {
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  if (pointers.size >= 2) { startGesture(); return; }
  if (e.button === 1 || (e.button === 0 && spaceDown)) {
    panning = true;
    panStart = [e.clientX, e.clientY];
    panOrigin = [vp.x, vp.y];
    root.classList.add("panning");
    try { root.setPointerCapture(e.pointerId); } catch { /* synthetic / lost pointer */ }
    return;
  }
  if (readOnly) return;
  if (e.button !== 0) return;

  // A canvas press elsewhere clears any transform selection (the overlay has its
  // own handlers, so moving/resizing doesn't reach here).
  if (selectedId) { transformSelected = false; selectEl(null, false); }

  const hitId = hitElementId(e.target);

  if (mode === "text") {
    if (hitId) {
      const ed = editors.get(hitId);
      if (ed) { transformSelected = false; ed.el.focus(); return; }
    }
    // create a new text element at the click point
    const [wx, wy] = toWorld(e.clientX, e.clientY);
    const el: TextEl = { id: uid(), type: "text", x: wx, y: wy, md: "", color, fontSize: textSize };
    pushHistory();
    scene.elements.push(el);
    mountEl(el);
    markDirty();
    requestAnimationFrame(() => editors.get(el.id)?.el.focus());
    return;
  }

  // draw mode
  if (tool === "select") {
    if (hitId) {
      const el = scene.elements.find((x) => x.id === hitId);
      selectEl(hitId, false);
      if (el && (el.type === "text" || el.type === "image" || el.type === "shape" || el.type === "stroke")) {
        const [wx, wy] = toWorld(e.clientX, e.clientY);
        const orig = el.type === "stroke" ? { x: 0, y: 0 } : { x: (el as TextEl | ShapeEl | ImageEl).x, y: (el as TextEl | ShapeEl | ImageEl).y };
        moving = { id: hitId, start: [wx, wy], orig };
        try { root.setPointerCapture(e.pointerId); } catch { /* synthetic / lost pointer */ }
      }
    } else {
      selectEl(null, false);
    }
    return;
  }

  // freehand or shape
  const [wx, wy] = toWorld(e.clientX, e.clientY);
  pushHistory();
  if (tool === "draw") {
    drawing = { id: uid(), type: "stroke", points: [[wx, wy]], color, width: strokeWidth };
  } else {
    drawing = { id: uid(), type: "shape", shape: tool, x: wx, y: wy, w: 0, h: 0, color, width: strokeWidth };
  }
  drawingNode = (drawing.type === "stroke" ? renderStroke(drawing) : renderShape(drawing)) as SVGElement;
  drawingNode.setAttribute("data-id", drawing.id);
  add(svg, drawingNode);
  try { root.setPointerCapture(e.pointerId); } catch { /* */ }
});

root.addEventListener("pointermove", (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [e.clientX, e.clientY]);
  if (gesture) { moveGesture(); return; }
  if (panning) {
    vp.x = panOrigin[0] + (e.clientX - panStart[0]);
    vp.y = panOrigin[1] + (e.clientY - panStart[1]);
    applyViewport();
    return;
  }
  if (moving) {
    const el = scene.elements.find((x) => x.id === moving!.id) as TextEl | ShapeEl | ImageEl | StrokeEl | undefined;
    if (!el) return;
    const [wx, wy] = toWorld(e.clientX, e.clientY);
    const dx = wx - moving.start[0];
    const dy = wy - moving.start[1];
    if (el.type === "stroke") {
      el.points = el.points.map(([px, py]) => [px + dx, py + dy] as Pt);
      moving.start = [wx, wy];
    } else {
      el.x = moving.orig.x + dx;
      el.y = moving.orig.y + dy;
    }
    remountEl(el);
    if (selectedId === el.id) elNodes.get(el.id)?.classList.add("selected");
    return;
  }
  if (drawing) {
    const [wx, wy] = toWorld(e.clientX, e.clientY);
    if (drawing.type === "stroke") {
      drawing.points.push([wx, wy]);
      drawingNode!.setAttribute("d", strokePath(drawing.points));
    } else {
      drawing.w = wx - drawing.x;
      drawing.h = wy - drawing.y;
      const fresh = renderShape(drawing);
      fresh.setAttribute("data-id", drawing.id);
      drawingNode!.replaceWith(fresh);
      drawingNode = fresh;
    }
  }
});

function endPointer(e: PointerEvent): void {
  pointers.delete(e.pointerId);
  if (gesture) { if (pointers.size < 2) { gesture = null; if (!readOnly) scheduleDraft(); } return; }
  if (panning) { panning = false; root.classList.remove("panning"); try { root.releasePointerCapture(e.pointerId); } catch { /* */ } }
  if (moving) { moving = null; markDirty(); try { root.releasePointerCapture(e.pointerId); } catch { /* */ } }
  if (drawing) {
    // discard zero-size shapes / single-point strokes
    const keep = drawing.type === "stroke" ? drawing.points.length > 1 : Math.abs(drawing.w) + Math.abs(drawing.h) > 4;
    if (keep) {
      scene.elements.push(drawing);
      drawingNode!.setAttribute("data-id", drawing.id);
      elNodes.set(drawing.id, drawingNode!);
      markDirty();
    } else {
      drawingNode!.remove();
      undoStack.pop(); // we pushed on down; nothing was added
    }
    drawing = null;
    drawingNode = null;
    try { root.releasePointerCapture(e.pointerId); } catch { /* */ }
  }
}
root.addEventListener("pointerup", endPointer);
root.addEventListener("pointercancel", endPointer);

// Double-click any element (in any mode) selects it for move / resize / delete.
root.addEventListener("dblclick", (e) => {
  if (readOnly) return;
  const id = hitElementId(e.target);
  if (!id) return;
  const el = scene.elements.find((x) => x.id === id);
  if (el && (el.type === "text" || el.type === "image")) {
    e.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur?.();
    transformSelected = true;
    selectEl(id, false);
    // For text, focus it and highlight all its content so it reads as
    // "selected" (and typing replaces it). Set the range after the focus-driven
    // re-render (which would otherwise collapse it to a caret).
    if (el.type === "text") {
      const node = elNodes.get(id) as HTMLElement | undefined;
      if (node) {
        node.focus(); // focus fires its re-render synchronously…
        const r = document.createRange(); // …then we set the full selection after it
        r.selectNodeContents(node);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(r);
        updateSelectionOverlay();
      }
    }
  }
});

// ---------- zoom (wheel + buttons) + pinch ----------

root.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
    } else {
      vp.x -= e.deltaX;
      vp.y -= e.deltaY;
      applyViewport();
    }
  },
  { passive: false },
);

function zoomAt(cx: number, cy: number, factor: number): void {
  const newZoom = Math.min(8, Math.max(0.1, vp.zoom * factor));
  const [wx, wy] = toWorld(cx, cy);
  vp.zoom = newZoom;
  vp.x = cx - wx * newZoom;
  vp.y = cy - wy * newZoom;
  applyViewport();
  if (!readOnly) scheduleDraft();
}

// ---------- keyboard ----------

let spaceDown = false;
window.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !isTyping(e.target)) { spaceDown = true; }
  const meta = e.metaKey || e.ctrlKey;
  if (meta && e.key === "Enter") {
    e.preventDefault();
    setMode(mode === "draw" ? "text" : "draw");
    return;
  }
  if (readOnly) return;
  if (meta && e.key.toLowerCase() === "s") { e.preventDefault(); void save(); return; }
  if (meta && e.key.toLowerCase() === "z") {
    if (isTyping(e.target)) return; // let the text editor handle its own text
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
    return;
  }
  if ((e.key === "Delete" || e.key === "Backspace") && selectedId && !isTyping(e.target)) {
    e.preventDefault();
    deleteSelected();
  }
  if (e.key === "Escape") {
    transformSelected = false;
    selectEl(null, false);
    (document.activeElement as HTMLElement | null)?.blur?.();
  }
});
window.addEventListener("keyup", (e) => { if (e.code === "Space") spaceDown = false; });

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA");
}

// ---------- image paste ----------

window.addEventListener("paste", async (e) => {
  if (readOnly) return;
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const it of items) {
    if (it.type.startsWith("image/")) {
      e.preventDefault();
      const file = it.getAsFile();
      if (file) await placeImageFile(file);
      return;
    }
  }
});

async function placeImageFile(file: File): Promise<void> {
  try {
    const res = await fetch("/api/images", { method: "POST", headers: { "Content-Type": file.type }, body: file });
    if (!res.ok) { setStatus("image upload failed"); return; }
    const { url } = (await res.json()) as { url: string };
    const dims = await imageDims(url);
    const center = toWorld(window.innerWidth / 2, window.innerHeight / 2);
    const maxW = 360;
    const scale = dims.w > maxW ? maxW / dims.w : 1;
    const el: ImageEl = { id: uid(), type: "image", x: center[0] - (dims.w * scale) / 2, y: center[1] - (dims.h * scale) / 2, w: dims.w * scale, h: dims.h * scale, url };
    pushHistory();
    scene.elements.push(el);
    mountEl(el);
    markDirty();
  } catch {
    setStatus("image upload failed");
  }
}
function imageDims(url: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({ w: 240, h: 180 });
    img.src = url;
  });
}

// ---------- "back to content" (read mode) + viewport framing ----------

let backBtn: HTMLButtonElement | null = null;
let editLink: HTMLAnchorElement | null = null;

// Frame all elements centered with padding at a comfortable zoom.
function fitToContent(): void {
  const b = elementsBounds();
  if (!b) return;
  const pad = 80;
  const cw = b.maxX - b.minX + pad * 2;
  const ch = b.maxY - b.minY + pad * 2;
  const sw = window.innerWidth;
  const sh = window.innerHeight;
  const zoom = Math.min(2, Math.max(0.1, Math.min(sw / cw, sh / ch)));
  vp.zoom = zoom;
  vp.x = sw / 2 - ((b.minX + b.maxX) / 2) * zoom;
  vp.y = sh / 2 - ((b.minY + b.maxY) / 2) * zoom;
  applyViewport();
}

// Is a meaningful chunk of the content currently on screen?
function contentVisible(): boolean {
  const b = elementsBounds();
  if (!b) return true; // empty canvas → nothing to return to
  const x1 = b.minX * vp.zoom + vp.x;
  const y1 = b.minY * vp.zoom + vp.y;
  const x2 = b.maxX * vp.zoom + vp.x;
  const y2 = b.maxY * vp.zoom + vp.y;
  const ix = Math.min(x2, window.innerWidth) - Math.max(x1, 0);
  const iy = Math.min(y2, window.innerHeight) - Math.max(y1, 0);
  return ix > 40 && iy > 40;
}

// Runs after every viewport change: toggle the read-mode button and keep the
// editor hand-off link pointed at the current view.
function afterViewportChange(): void {
  if (backBtn) backBtn.hidden = contentVisible();
  if (editLink) editLink.hash = `v=${Math.round(vp.x)},${Math.round(vp.y)},${vp.zoom.toFixed(3)}`;
  updateSelectionOverlay();
}

// ---------- mode + toolbar UI ----------

let toolbar: HTMLElement | null = null;
let toolsGroup: HTMLElement | null = null;
let modeChip: HTMLButtonElement | null = null;
let modeBtnBar: HTMLButtonElement | null = null;
let sizeInput: HTMLInputElement | null = null;
let zoomLevel: HTMLElement | null = null;

function toggleMode(): void {
  setMode(mode === "draw" ? "text" : "draw");
}

function setMode(m: Mode): void {
  mode = m;
  root.classList.toggle("mode-draw", m === "draw");
  root.classList.toggle("mode-text", m === "text");
  // Colours stay in both modes; drawing tools show in draw, the text-size bar
  // shows in text.
  toolbar?.querySelectorAll<HTMLElement>(".tools-only").forEach((e) => { e.hidden = m !== "draw"; });
  toolbar?.querySelectorAll<HTMLElement>(".text-only").forEach((e) => { e.hidden = m !== "text"; });
  const label = m === "draw" ? "draw" : "text";
  if (modeChip) modeChip.innerHTML = `<strong>${label}</strong> <span class="mode-swap">⇄</span> <kbd class="kbd-hint">${MOD}↵</kbd>`;
  if (modeBtnBar) modeBtnBar.innerHTML = m === "draw" ? ICON.textmode : ICON.pen;
}

const MIN_FONT = 8;
const MAX_FONT = 96;
// Apply a size to the bar (and to the selected text block, if any).
function applyTextSize(n: number): void {
  textSize = Math.min(MAX_FONT, Math.max(MIN_FONT, Math.round(n) || MIN_FONT));
  if (sizeInput) sizeInput.value = String(textSize);
  if (selectedId) {
    const el = scene.elements.find((x) => x.id === selectedId);
    if (el && el.type === "text") { pushHistory(); el.fontSize = textSize; remountEl(el); selectEl(selectedId, false); editors.get(el.id)?.el.focus(); markDirty(); }
  }
}
// Reflect a text block's size in the bar (on selection/focus) without mutating.
function reflectTextSize(n: number): void {
  textSize = n;
  if (sizeInput) sizeInput.value = String(Math.round(n));
}

function buildUI(): void {
  if (readOnly) {
    buildZoomChip();
    root.classList.remove("mode-draw");
    root.classList.add("mode-select");
    // "Bring me back to the content" — shown only when the content is off-screen.
    editLink = document.querySelector<HTMLAnchorElement>(".draw-actions a");
    backBtn = document.createElement("button");
    backBtn.className = "back-to-content";
    backBtn.type = "button";
    backBtn.textContent = "↻ back to the content";
    backBtn.hidden = true;
    backBtn.addEventListener("click", () => { fitToContent(); });
    add(document.body, backBtn);
    afterViewportChange();
    return;
  }
  toolbar = document.createElement("div");
  toolbar.className = "draw-toolbar";

  // Mobile mode toggle (Cmd+Enter isn't available on touch). Hidden on desktop
  // via CSS, where the bottom-left chip handles it.
  modeBtnBar = document.createElement("button");
  modeBtnBar.className = "tool-btn toolbar-mode-btn";
  modeBtnBar.title = "switch draw / text";
  modeBtnBar.addEventListener("click", toggleMode);
  add(toolbar, modeBtnBar, sep());

  const colorGroup = document.createElement("div");
  colorGroup.className = "tool-group";
  for (const c of COLORS) {
    const b = document.createElement("button");
    b.className = "swatch" + (c === color ? " active" : "");
    b.style.setProperty("--c", c);
    b.title = c;
    b.addEventListener("click", () => {
      color = c;
      colorGroup.querySelectorAll(".swatch").forEach((s) => s.classList.remove("active"));
      b.classList.add("active");
      if (selectedId) {
        const el = scene.elements.find((x) => x.id === selectedId);
        if (el && el.type !== "image") { pushHistory(); (el as StrokeEl | ShapeEl | TextEl).color = c; remountEl(el); selectEl(selectedId, false); markDirty(); }
      }
    });
    add(colorGroup, b);
  }
  add(toolbar, colorGroup);

  const toolsSep = sep();
  toolsSep.classList.add("tools-only");
  add(toolbar, toolsSep);

  const tools: [Tool, string][] = [
    ["draw", ICON.pen],
    ["rect", ICON.rect],
    ["ellipse", ICON.ellipse],
    ["line", ICON.line],
    ["arrow", ICON.arrow],
    ["select", ICON.select],
  ];
  toolsGroup = document.createElement("div");
  toolsGroup.className = "tool-group tools-only";
  for (const [t, icon] of tools) {
    const b = document.createElement("button");
    b.className = "tool-btn" + (t === tool ? " active" : "");
    b.innerHTML = icon;
    b.title = t;
    b.addEventListener("click", () => {
      tool = t;
      toolsGroup!.querySelectorAll(".tool-btn").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
    });
    add(toolsGroup, b);
  }
  add(toolbar, toolsGroup);

  // Text-size bar — shown in text mode in place of the shape tools. Sets the
  // size for the next text block and edits the selected block's size.
  const sizeSep = sep();
  sizeSep.classList.add("text-only");
  const sizeGroup = document.createElement("div");
  sizeGroup.className = "tool-group text-only size-group";
  const sizeMinus = document.createElement("button");
  sizeMinus.className = "tool-btn"; sizeMinus.textContent = "A−"; sizeMinus.title = "smaller text";
  sizeInput = document.createElement("input");
  sizeInput.className = "size-input"; sizeInput.type = "number"; sizeInput.min = String(MIN_FONT); sizeInput.max = String(MAX_FONT);
  sizeInput.value = String(textSize); sizeInput.title = "text size";
  const sizePlus = document.createElement("button");
  sizePlus.className = "tool-btn"; sizePlus.textContent = "A+"; sizePlus.title = "larger text";
  sizeMinus.addEventListener("click", () => applyTextSize(textSize - 2));
  sizePlus.addEventListener("click", () => applyTextSize(textSize + 2));
  sizeInput.addEventListener("change", () => applyTextSize(Number(sizeInput!.value)));
  add(sizeGroup, sizeMinus, sizeInput, sizePlus);
  add(toolbar, sizeSep, sizeGroup);

  add(document.body, toolbar);

  // Show the ⌘S hint on the save button (Cmd/Ctrl+S already triggers save).
  if (saveBtn) {
    const label = (saveBtn.textContent ?? "save").trim();
    saveBtn.innerHTML = `${label} <kbd class="kbd-hint">${MOD}S</kbd>`;
  }

  // Bottom-left mode toggle button (desktop).
  modeChip = document.createElement("button");
  modeChip.className = "mode-chip";
  modeChip.title = "switch draw / text (⌘↵)";
  modeChip.addEventListener("click", toggleMode);
  add(document.body, modeChip);

  buildZoomChip();
  setMode("draw");
}

function buildZoomChip(): void {
  const chip = document.createElement("div");
  chip.className = "zoom-chip";
  const minus = document.createElement("button"); minus.textContent = "−"; minus.title = "zoom out";
  const lvl = document.createElement("span"); lvl.className = "zoom-level";
  const plus = document.createElement("button"); plus.textContent = "+"; plus.title = "zoom in";
  minus.addEventListener("click", () => zoomAt(window.innerWidth / 2, window.innerHeight / 2, 0.8));
  plus.addEventListener("click", () => zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1.25));
  add(chip, minus, lvl, plus);
  add(document.body, chip);
  zoomLevel = lvl;
  applyViewport();
}

function sep(): HTMLElement { const s = document.createElement("div"); s.className = "tool-sep"; return s; }

const ICON = {
  pen: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/></svg>`,
  rect: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="6" width="16" height="12" rx="2"/></svg>`,
  ellipse: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><ellipse cx="12" cy="12" rx="9" ry="6"/></svg>`,
  line: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="4" y1="20" x2="20" y2="4"/></svg>`,
  arrow: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="20" x2="20" y2="4"/><polyline points="10 4 20 4 20 14"/></svg>`,
  select: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l7.5 18 2.5-7.5L20.5 11z"/></svg>`,
  textmode: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V5h16v2"/><path d="M9 5v14"/><path d="M7 19h4"/></svg>`,
};

// ---------- save ----------

function serialize(): string {
  return JSON.stringify({ schemaVersion: 1, elements: scene.elements, viewport: vp });
}
function setStatus(s: string): void { if (statusEl) statusEl.textContent = s; }

async function save(): Promise<void> {
  if (readOnly || !saveBtn) return;
  saveBtn.disabled = true;
  setStatus("saving…");
  try {
    const thumb = await renderThumbnail();
    const payload = { title: (titleInput?.value ?? "").trim(), scene: serialize(), thumb };
    let res: Response;
    if (mode0 === "edit" && slug) {
      res = await fetch(`/${slug}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    } else {
      res = await fetch(`/`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    }
    if (!res.ok) { setStatus(`save failed (${res.status})`); saveBtn.disabled = false; return; }
    const j = (await res.json()) as { slug: string };
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* */ }
    dirty = false;
    window.location.href = `/${j.slug}`;
  } catch {
    setStatus("save failed");
    saveBtn.disabled = false;
  }
}
saveBtn?.addEventListener("click", () => void save());

// Rasterize the scene to a PNG data URL for the share/OG card.
async function renderThumbnail(): Promise<string | undefined> {
  const b = elementsBounds();
  if (!b) return undefined;
  const pad = 40;
  const W = 1200, H = 630;
  const cw = b.maxX - b.minX + pad * 2;
  const ch = b.maxY - b.minY + pad * 2;
  const scale = Math.min(W / cw, H / ch, 2);
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;
  const bg = getComputedStyle(document.body).backgroundColor || "#FAF7F2";
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  const ox = (W - cw * scale) / 2 - b.minX * scale + pad * scale;
  const oy = (H - ch * scale) / 2 - b.minY * scale + pad * scale;
  ctx.setTransform(scale, 0, 0, scale, ox, oy);
  for (const el of scene.elements) {
    if (el.type === "stroke") {
      ctx.strokeStyle = el.color; ctx.lineWidth = el.width; ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.beginPath();
      el.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])));
      ctx.stroke();
    } else if (el.type === "shape") {
      ctx.strokeStyle = el.color; ctx.lineWidth = el.width;
      if (el.shape === "rect") ctx.strokeRect(el.x, el.y, el.w, el.h);
      else if (el.shape === "ellipse") { ctx.beginPath(); ctx.ellipse(el.x + el.w / 2, el.y + el.h / 2, Math.abs(el.w / 2), Math.abs(el.h / 2), 0, 0, Math.PI * 2); ctx.stroke(); }
      else { ctx.beginPath(); ctx.moveTo(el.x, el.y); ctx.lineTo(el.x + el.w, el.y + el.h); ctx.stroke(); }
    } else if (el.type === "text") {
      ctx.fillStyle = el.color; ctx.font = `${el.fontSize}px Georgia, serif`; ctx.textBaseline = "top";
      el.md.split("\n").forEach((ln, i) => ctx.fillText(ln.replace(/^#{1,6}\s+/, ""), el.x, el.y + i * el.fontSize * 1.5));
    }
    // images skipped (cross-origin canvas taint risk for the thumbnail)
  }
  try { return canvas.toDataURL("image/png"); } catch { return undefined; }
}

function elementsBounds(): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
  const ext = (x: number, y: number) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); any = true; };
  for (const el of scene.elements) {
    if (el.type === "stroke") el.points.forEach((p) => ext(p[0], p[1]));
    else if (el.type === "shape" || el.type === "image") { ext(el.x, el.y); ext(el.x + el.w, el.y + el.h); }
    else if (el.type === "text") { const node = elNodes.get(el.id) as HTMLElement | undefined; const w = node ? node.offsetWidth : 200; const h = node ? node.offsetHeight : 40; ext(el.x, el.y); ext(el.x + w, el.y + h); }
  }
  return any ? { minX, minY, maxX, maxY } : null;
}

// ---------- init ----------

renderAll();
buildUI();
if (!readOnly) { buildOverlay(); setMode("draw"); }

// Restore a local draft if present and newer (new mode only, to avoid clobber).
(function restoreDraft() {
  if (readOnly) return;
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return;
    const d = JSON.parse(raw) as { title: string; scene: string };
    if (mode0 === "new" && d.scene) {
      const s = JSON.parse(d.scene) as Scene;
      if (s.elements && s.elements.length) {
        scene.elements = s.elements;
        if (s.viewport) Object.assign(vp, s.viewport);
        if (titleInput && d.title) titleInput.value = d.title;
        renderAll();
      }
    }
  } catch { /* ignore */ }
})();

titleInput?.addEventListener("input", markDirty);
window.addEventListener("resize", afterViewportChange);
