// Drawing scene validation shared by the draw.* routes and the MCP connector.

import { bytesOf } from "./http.js";
import { MAX_SCENE_BYTES } from "../types.js";

// Image element URLs must reference an image we issued (same-origin /img/<name>),
// never an arbitrary external URL — otherwise a crafted/shared scene could make
// every viewer's browser fetch attacker-controlled URLs (tracking / IP leak).
export const SAFE_IMG_URL = /^\/img\/[A-Za-z0-9._-]+$/;

export type SceneCheck = { ok: true; scene: string } | { ok: false; status: 400 | 413; error: string };

// Scene validation: valid JSON, expected top-level shape, size-capped, and every
// image element points at one of our own uploaded images.
export function validateScene(raw: unknown): SceneCheck {
  if (typeof raw !== "string") return { ok: false, status: 400, error: "scene must be a string" };
  if (bytesOf(raw) > MAX_SCENE_BYTES) return { ok: false, status: 413, error: "scene too large" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, status: 400, error: "scene is not valid JSON" };
  }
  const elements = (parsed as { elements?: unknown })?.elements;
  if (typeof parsed !== "object" || parsed === null || !Array.isArray(elements)) {
    return { ok: false, status: 400, error: "scene shape invalid" };
  }
  for (const el of elements) {
    if (el && typeof el === "object" && (el as { type?: unknown }).type === "image") {
      const url = (el as { url?: unknown }).url;
      if (typeof url !== "string" || !SAFE_IMG_URL.test(url)) {
        return { ok: false, status: 400, error: "invalid image reference" };
      }
    }
  }
  return { ok: true, scene: raw };
}
