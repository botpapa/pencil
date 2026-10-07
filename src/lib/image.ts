// Image ingestion for the connector: accept bytes from a URL or base64, sniff
// the real format (never trust a declared content type), read the pixel
// dimensions from the header so agents can size canvas elements, and store
// the result under the same R2 key scheme the editors use.

import { newSlug } from "./slug.js";
import { MAX_IMAGE_BYTES } from "../types.js";

export type SniffedImage = { mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; width: number; height: number };

export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  const b = bytes;
  if (b.length < 12) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  // PNG: 89 50 4E 47 0D 0A 1A 0A, IHDR width/height at 16..24
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b.length >= 24) {
    return { mime: "image/png", width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  // GIF: "GIF8", LE width/height at 6..10
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    return { mime: "image/gif", width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
  }
  // WebP: "RIFF" .... "WEBP"
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 && b.length >= 30) {
    const chunk = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
    if (chunk === "VP8 ") return { mime: "image/webp", width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = dv.getUint32(21, true);
      return { mime: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") {
      const w = 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16));
      const h = 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16));
      return { mime: "image/webp", width: w, height: h };
    }
    return null;
  }
  // JPEG: FF D8, walk markers to the first SOFn
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = dv.getUint16(i + 2);
      if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mime: "image/jpeg", height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
      }
      i += 2 + len;
    }
    return { mime: "image/jpeg", width: 0, height: 0 };
  }
  return null;
}

export type ImageIngest = { ok: true; bytes: Uint8Array; info: SniffedImage } | { ok: false; error: string };

function decodeBase64(s: string): Uint8Array | null {
  const clean = s.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  // 4/3 expansion: reject early so a 100 MB string never hits atob.
  if (clean.length > (MAX_IMAGE_BYTES * 4) / 3 + 4) return null;
  try {
    const bin = atob(clean.replaceAll("-", "+").replaceAll("_", "/"));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export async function ingestImage(src: { image_url?: unknown; image_base64?: unknown }): Promise<ImageIngest> {
  let bytes: Uint8Array | null = null;
  if (typeof src.image_base64 === "string" && src.image_base64.length > 0) {
    bytes = decodeBase64(src.image_base64);
    if (!bytes) return { ok: false, error: "image_base64 is not valid base64 or exceeds 5 MB" };
  } else if (typeof src.image_url === "string" && src.image_url.length > 0) {
    let u: URL;
    try {
      u = new URL(src.image_url);
    } catch {
      return { ok: false, error: "image_url is not a valid URL" };
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, error: "image_url must be http(s)" };
    let res: Response;
    try {
      res = await fetch(u.toString(), {
        redirect: "follow",
        headers: { Accept: "image/*", "User-Agent": "pencil.md-connector/1.0 (+https://pencil.md/connect)" },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      return { ok: false, error: `could not fetch image_url: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!res.ok) return { ok: false, error: `image_url returned HTTP ${res.status}` };
    const declared = Number.parseInt(res.headers.get("Content-Length") ?? "0", 10);
    if (declared > MAX_IMAGE_BYTES) return { ok: false, error: "image exceeds 5 MB" };
    const reader = res.body?.getReader();
    if (!reader) return { ok: false, error: "empty response from image_url" };
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel().catch(() => {});
        return { ok: false, error: "image exceeds 5 MB" };
      }
      chunks.push(value);
    }
    bytes = new Uint8Array(total);
    let off = 0;
    for (const ch of chunks) {
      bytes.set(ch, off);
      off += ch.byteLength;
    }
  } else {
    return { ok: false, error: "provide image_url or image_base64" };
  }
  if (bytes.byteLength === 0) return { ok: false, error: "image is empty" };
  if (bytes.byteLength > MAX_IMAGE_BYTES) return { ok: false, error: "image exceeds 5 MB" };
  const info = sniffImage(bytes);
  if (!info) return { ok: false, error: "unsupported image format (use PNG, JPEG, GIF or WebP)" };
  return { ok: true, bytes, info };
}

// Same key scheme as the editors' POST /api/images so images are
// interchangeable between pages, drawings and the connector.
export async function storeImage(bucket: R2Bucket, ownerId: string, bytes: Uint8Array, info: SniffedImage): Promise<{ key: string; name: string }> {
  const ext = info.mime.split("/")[1]!.replace("jpeg", "jpg");
  const name = `${ownerId.slice(0, 6)}-${newSlug()}.${ext}`;
  const key = `img/${name}`;
  await bucket.put(key, bytes, { httpMetadata: { contentType: info.mime } });
  return { key, name };
}
