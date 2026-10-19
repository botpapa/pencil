// Chat avatars: a square tile with one of a few ink patterns in a random hue.
// Shared by the worker (picks the random avatar on join) and the chat client
// (draws it). Plain SVG presentation attributes only — the CSP forbids inline
// `style` attributes — and no <pattern> ids, so hundreds of copies can sit in
// one document without id collisions.

export const AVATAR_PATTERNS = [
  "stripes",
  "dots",
  "checks",
  "waves",
  "rings",
  "grid",
  "zigzag",
  "plus",
  "half",
  "bars",
  "sun",
  "diamond",
] as const;

export type AvatarPattern = (typeof AVATAR_PATTERNS)[number];
export type Avatar = { pattern: AvatarPattern; hue: number };

export function isAvatarPattern(v: unknown): v is AvatarPattern {
  return typeof v === "string" && (AVATAR_PATTERNS as readonly string[]).includes(v);
}

export function randomAvatar(): Avatar {
  const r = new Uint32Array(2);
  crypto.getRandomValues(r);
  return { pattern: AVATAR_PATTERNS[r[0]! % AVATAR_PATTERNS.length]!, hue: r[1]! % 360 };
}

// Validate a client-proposed avatar (the join form lets people re-roll);
// anything malformed gets a fresh random one.
export function normaliseAvatar(v: unknown): Avatar {
  if (v && typeof v === "object") {
    const a = v as Record<string, unknown>;
    if (isAvatarPattern(a.pattern) && typeof a.hue === "number" && Number.isInteger(a.hue) && a.hue >= 0 && a.hue < 360) {
      return { pattern: a.pattern, hue: a.hue };
    }
  }
  return randomAvatar();
}

function shapes(p: AvatarPattern, ink: string): string {
  let s = "";
  switch (p) {
    case "stripes":
      for (let i = -40; i <= 80; i += 10) s += `<path d="M${i} 0L${i - 40} 40" stroke="${ink}" stroke-width="3.5"/>`;
      return s;
    case "dots":
      for (let y = 5; y < 40; y += 10) for (let x = (y / 10) % 2 ? 5 : 10; x < 40; x += 10) s += `<circle cx="${x}" cy="${y}" r="2.6" fill="${ink}"/>`;
      return s;
    case "checks":
      for (let y = 0; y < 40; y += 10) for (let x = (y / 10) % 2 ? 10 : 0; x < 40; x += 20) s += `<rect x="${x}" y="${y}" width="10" height="10" fill="${ink}"/>`;
      return s;
    case "waves":
      for (let y = 4; y < 44; y += 9) s += `<path d="M-5 ${y}q5 -5 10 0t10 0t10 0t10 0t10 0" fill="none" stroke="${ink}" stroke-width="2.5"/>`;
      return s;
    case "rings":
      for (let r = 4; r <= 28; r += 6) s += `<circle cx="20" cy="20" r="${r}" fill="none" stroke="${ink}" stroke-width="2.5"/>`;
      return s;
    case "grid":
      for (let i = 5; i < 40; i += 10) s += `<path d="M${i} 0V40M0 ${i}H40" stroke="${ink}" stroke-width="2"/>`;
      return s;
    case "zigzag":
      for (let y = 6; y < 44; y += 10) s += `<path d="M0 ${y}l5 -5l5 5l5 -5l5 5l5 -5l5 5l5 -5l5 5" fill="none" stroke="${ink}" stroke-width="2.5"/>`;
      return s;
    case "plus":
      for (let y = 7; y < 40; y += 13) for (let x = 7; x < 40; x += 13) s += `<path d="M${x - 3.5} ${y}h7M${x} ${y - 3.5}v7" stroke="${ink}" stroke-width="2.4"/>`;
      return s;
    case "half":
      return `<path d="M0 0H40L0 40Z" fill="${ink}"/>`;
    case "bars":
      for (let x = 2; x < 40; x += 9) s += `<rect x="${x}" y="0" width="4" height="40" fill="${ink}"/>`;
      return s;
    case "sun":
      for (let a = 0; a < 360; a += 30) {
        const r = (a * Math.PI) / 180;
        s += `<path d="M${(20 + Math.cos(r) * 12).toFixed(1)} ${(20 + Math.sin(r) * 12).toFixed(1)}L${(20 + Math.cos(r) * 19).toFixed(1)} ${(20 + Math.sin(r) * 19).toFixed(1)}" stroke="${ink}" stroke-width="2.4"/>`;
      }
      return s + `<circle cx="20" cy="20" r="8" fill="${ink}"/>`;
    case "diamond":
      for (let r = 6; r <= 30; r += 8) s += `<path d="M20 ${20 - r}L${20 + r} 20L20 ${20 + r}L${20 - r} 20Z" fill="none" stroke="${ink}" stroke-width="2.5"/>`;
      return s;
  }
}

export function avatarSvg(a: { pattern: string; hue: number }, size = 32): string {
  const pattern: AvatarPattern = isAvatarPattern(a.pattern) ? a.pattern : "dots";
  const hue = Math.abs(Math.round(a.hue)) % 360;
  const bg = `hsl(${hue} 72% 80%)`;
  const ink = `hsl(${hue} 58% 30%)`;
  return `<svg class="avatar" viewBox="0 0 40 40" width="${size}" height="${size}" aria-hidden="true"><rect width="40" height="40" fill="${bg}"/>${shapes(pattern, ink)}</svg>`;
}
