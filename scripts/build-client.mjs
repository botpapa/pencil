#!/usr/bin/env node
// Bundles src/client/{editor,reader}.ts to public/client/{editor,reader}.js
// and copies styles.css. Prints gzipped sizes against the spec budget.

import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { readFile, writeFile, mkdir, copyFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const outDir = join(root, "public", "client");
const stylesOut = join(root, "public", "styles.css");

const BUDGETS = {
  "editor.js": 50 * 1024,
  "reader.js": 5 * 1024,
  "draw.js": 80 * 1024,
};

async function ensureDir(d) {
  if (!existsSync(d)) await mkdir(d, { recursive: true });
}

async function bundle(entry, outFile) {
  await build({
    entryPoints: [entry],
    bundle: true,
    minify: true,
    format: "esm",
    target: ["es2022"],
    outfile: outFile,
    sourcemap: false,
    legalComments: "none",
    treeShaking: true,
    drop: ["debugger"],
  });
}

function fmt(n) {
  return `${(n / 1024).toFixed(2)} KB`;
}

async function reportSize(file) {
  const buf = await readFile(file);
  const gz = gzipSync(buf);
  const name = file.split("/").pop();
  const budget = BUDGETS[name];
  const ok = budget == null || gz.length <= budget;
  const tag = budget == null ? "" : ` / budget ${fmt(budget)}`;
  const status = ok ? "ok" : "OVER BUDGET";
  console.log(`  ${name}: ${fmt(buf.length)} raw, ${fmt(gz.length)} gz${tag}  [${status}]`);
  return ok;
}

async function main() {
  await ensureDir(outDir);

  console.log("Bundling client...");
  await Promise.all([
    bundle(join(root, "src/client/editor.ts"), join(outDir, "editor.js")),
    bundle(join(root, "src/client/reader.ts"), join(outDir, "reader.js")),
    bundle(join(root, "src/client/draw.ts"), join(outDir, "draw.js")),
  ]);

  // Copy stylesheets straight through (no preprocessing).
  await copyFile(join(root, "src/client/styles.css"), stylesOut);
  await copyFile(join(root, "src/client/draw.css"), join(root, "public", "draw.css"));

  console.log("\nBundle sizes:");
  const ok1 = await reportSize(join(outDir, "editor.js"));
  const ok2 = await reportSize(join(outDir, "reader.js"));
  const ok3 = await reportSize(join(outDir, "draw.js"));
  const stylesStat = await stat(stylesOut);
  console.log(`  styles.css: ${fmt(stylesStat.size)} raw`);

  if (!ok1 || !ok2 || !ok3) {
    console.error("\nERROR: bundle exceeded size budget.");
    process.exit(1);
  }
  console.log("\nClient build OK.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
