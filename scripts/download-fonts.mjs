#!/usr/bin/env node
// Optional: download self-hosted fonts to public/fonts/.
// The app falls back to system fonts if these files don't exist.
//
// Sources are Google Fonts (gstatic) latin-subset variable-weight WOFF2s of Newsreader,
// JetBrains Mono, and Inter — all licensed under the SIL Open Font License.

import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const dest = join(root, "public", "fonts");

const FONTS = [
  {
    name: "newsreader-variable.woff2",
    url: "https://fonts.gstatic.com/s/newsreader/v26/cY9AfjOCX1hbuyalUrK4397yjA.woff2",
  },
  {
    name: "newsreader-italic-variable.woff2",
    url: "https://fonts.gstatic.com/s/newsreader/v26/cY9CfjOCX1hbuyalUrK439vCjohC.woff2",
  },
  {
    name: "jetbrains-mono-variable.woff2",
    url: "https://fonts.gstatic.com/s/jetbrainsmono/v24/tDbv2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKwBNntkaToggR7BYRbKPxDcwg.woff2",
  },
  {
    name: "inter-variable.woff2",
    url: "https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7.woff2",
  },
];

async function main() {
  if (!existsSync(dest)) await mkdir(dest, { recursive: true });
  for (const f of FONTS) {
    const out = join(dest, f.name);
    process.stdout.write(`fetching ${f.name}... `);
    try {
      const res = await fetch(f.url);
      if (!res.ok) {
        console.log(`FAILED (${res.status})`);
        continue;
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      await writeFile(out, buf);
      console.log(`${(buf.length / 1024).toFixed(1)} KB`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`FAILED (${msg})`);
    }
  }
  console.log("\nDone. The app will use system fonts as fallback for any missing files.");
}

main();
