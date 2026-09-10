// Client-side enhancement for rendered prose images. Shared by the reader
// page and the editor preview pane.
//
// - enhanceCarousels: the server renders a ```carousel fence as a bare
//   .carousel > .carousel-track with slides (swipeable via CSS scroll-snap
//   even without JS); this adds prev/next buttons and position dots.
// - initLightbox: one delegated click listener per container opens any prose
//   image full-screen (images are height-capped by CSS, so tall screenshots
//   stay compact inline and expand on click). Click or Escape closes.

// Structural root type: the workers runtime types (worker-configuration.d.ts)
// clash with DOM lib's ParentNode/Element `append`, so ask only for what we use.
type QueryRoot = { querySelectorAll: typeof document.querySelectorAll };

export function enhanceCarousels(root: QueryRoot): void {
  for (const c of Array.from(root.querySelectorAll<HTMLElement>(".carousel"))) {
    if (c.dataset.ready) continue;
    c.dataset.ready = "1";
    const track = c.querySelector<HTMLElement>(".carousel-track");
    if (!track) continue;
    const count = track.children.length;
    if (count <= 1) continue;

    // Off-screen slides are loading="lazy" from the renderer; a lazy load
    // kicking in mid-animation causes a layout pass that makes the mandatory
    // scroll-snap cancel the smooth scroll back to the current slide. Load all
    // slides up front — a carousel is an explicit author choice of a few
    // images, so the extra requests are fine.
    for (const img of Array.from(track.querySelectorAll<HTMLImageElement>("img"))) {
      img.loading = "eager";
    }

    const makeBtn = (dir: -1 | 1): HTMLButtonElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `carousel-btn ${dir < 0 ? "carousel-prev" : "carousel-next"}`;
      b.setAttribute("aria-label", dir < 0 ? "previous image" : "next image");
      b.textContent = dir < 0 ? "‹" : "›";
      b.addEventListener("click", () => {
        // Absolute target from the current index: repeated clicks mid-animation
        // land on slide boundaries instead of compounding relative offsets.
        const w = track.clientWidth || 1;
        const i = Math.round(track.scrollLeft / w) + dir;
        track.scrollTo({ left: Math.max(0, Math.min(count - 1, i)) * w, behavior: "smooth" });
      });
      return b;
    };
    c.appendChild(makeBtn(-1));
    c.appendChild(makeBtn(1));

    const dots = document.createElement("div");
    dots.className = "carousel-dots";
    for (let i = 0; i < count; i++) {
      const d = document.createElement("span");
      d.className = "carousel-dot";
      dots.appendChild(d);
    }
    c.appendChild(dots);

    const update = (): void => {
      const w = track.clientWidth || 1;
      const i = Math.min(count - 1, Math.max(0, Math.round(track.scrollLeft / w)));
      Array.from(dots.children).forEach((d, j) => d.classList.toggle("active", j === i));
      c.querySelector(".carousel-prev")?.toggleAttribute("disabled", i === 0);
      c.querySelector(".carousel-next")?.toggleAttribute("disabled", i === count - 1);
    };
    update();
    let raf = 0;
    track.addEventListener("scroll", () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        update();
      });
    });
  }
}

let overlay: HTMLDivElement | null = null;
let overlayImg: HTMLImageElement | null = null;
let savedBodyOverflow = "";

function closeLightbox(): void {
  if (!overlay || !overlay.isConnected) return;
  overlay.remove();
  document.body.style.overflow = savedBodyOverflow;
}

function openLightbox(src: string, alt: string): void {
  if (!overlay || !overlayImg) {
    overlay = document.createElement("div");
    overlay.className = "lightbox";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-label", "image viewer");
    overlayImg = document.createElement("img");
    overlay.appendChild(overlayImg);
    overlay.addEventListener("click", closeLightbox);
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeLightbox();
    });
  }
  overlayImg.src = src;
  overlayImg.alt = alt;
  savedBodyOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  document.body.appendChild(overlay);
}

// Delegated so it survives innerHTML swaps (editor preview re-renders).
export function initLightbox(container: HTMLElement): void {
  if (container.dataset.lightbox) return;
  container.dataset.lightbox = "1";
  container.addEventListener("click", (e) => {
    const t = e.target as Element | null;
    const img = t?.closest?.("img");
    if (!img || !container.contains(img)) return;
    e.preventDefault();
    openLightbox(img.src, img.alt ?? "");
  });
}
