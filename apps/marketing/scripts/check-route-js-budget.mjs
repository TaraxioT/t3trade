/**
 * Durable route-isolation budget check for the marketing site.
 *
 * 1. Resolve every JavaScript module reachable from dist/index.html (inline
 *    module scripts, external script srcs, modulepreload links, and the full
 *    recursive static import graph of every emitted chunk) and assert the
 *    total gzipped weight stays at or below LANDING_BUDGET_BYTES. Chunks that
 *    are imported but never preloaded are followed too, so a genuinely
 *    recursive escape lands in the total rather than slipping past it.
 * 2. Assert dist/diorama/index.html exists as a built route and that its
 *    module graph stays disjoint from the landing page's module set, except
 *    for an Astro-emitted shared chunk, in which case the landing total must
 *    still fit the budget and no shared chunk may carry three or howler code.
 *
 * Node standard library only.
 */

import { existsSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const LANDING_BUDGET_BYTES = 12288;
const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
const landingHtmlPath = path.join(distDir, "index.html");
const dioramaHtmlPath = path.join(distDir, "diorama", "index.html");

function fail(message) {
  console.error(`route-js-budget: ${message}`);
  process.exit(1);
}

/** Collect inline module script bodies and external JS references from HTML. */
function collectHtmlModules(htmlPath) {
  if (!existsSync(htmlPath)) return null;
  const html = readFileSync(htmlPath, "utf8");
  const inline = [];
  const roots = new Set();

  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    const attrs = match[1];
    if (!/\btype="module"/.test(attrs)) continue;
    const src = attrs.match(/\bsrc="([^"]+)"/);
    if (src) roots.add(src[1]);
    else inline.push(Buffer.from(match[2], "utf8"));
  }

  for (const match of html.matchAll(/<link\b[^>]*\brel="modulepreload"[^>]*>/g)) {
    const href = match[0].match(/\bhref="([^"]+)"/);
    if (href) roots.add(href[1]);
  }

  return { inline, roots };
}

/** Static import/export specifiers in an emitted chunk. Strings, not regex
 *  parsing of arbitrary JS: emitted chunks quote every specifier, so the two
 *  quote forms cover the grammar Vite emits. */
function chunkImports(code) {
  const specifiers = new Set();
  const patterns = [
    /\bimport\s+[^;]*?from\s*(["'])([^"']+)\1/g,
    /\bimport\s*(["'])([^"']+)\1/g,
    /\bexport\s+[^;]*?from\s*(["'])([^"']+)\1/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) specifiers.add(match[2]);
  }
  return specifiers;
}

/** Absolute-path URL for a root-relative or spec-relative reference, or null
 *  for remote URLs, data URIs, and bare specifiers (treated as opaque). */
function resolveReference(specifier, fromDir) {
  if (/^(https?:)?\/\//.test(specifier) || /^[a-z]+:/i.test(specifier)) return null;
  if (specifier.startsWith("/")) return specifier;
  if (specifier.startsWith(".")) {
    const joined = path.posix.join(fromDir, specifier);
    return path.posix.normalize(joined);
  }
  // Bare specifier: nothing Vite emits into dist should still have one.
  return null;
}

/** Read a dist asset by its root-relative path. Astro emits chunks under
 *  /_astro; /assets is checked as a fallback so an output config change does
 *  not silently break the check. */
function readAsset(rootRelative) {
  const direct = path.join(distDir, rootRelative);
  if (existsSync(direct)) return direct;
  const basename = path.posix.basename(rootRelative);
  for (const dir of ["_astro", "assets"]) {
    const candidate = path.join(distDir, dir, basename);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Walk the full static module graph from a set of root URLs. Returns the
 * reachable set keyed by root-relative path and an ordered visit list.
 */
function resolveGraph(roots, label) {
  const visited = new Map(); // rootRelative path -> absolute file path
  const queue = [];
  for (const root of roots) {
    const normalized = root.startsWith("/") ? root : `/${root}`;
    if (!visited.has(normalized)) {
      visited.set(normalized, null);
      queue.push(normalized);
    }
  }

  while (queue.length > 0) {
    const current = queue.pop();
    const file = readAsset(current);
    if (!file) fail(`${label} references missing asset ${current}`);
    visited.set(current, file);

    const dir = path.posix.dirname(current);
    for (const specifier of chunkImports(readFileSync(file, "utf8"))) {
      const next = resolveReference(specifier, dir);
      if (next === null || visited.has(next)) continue;
      // Imported-but-never-preloaded chunks are deliberately followed here:
      // they are real bytes the browser fetches, so an accidental deep edge
      // (for example a stray three import) counts toward the total.
      visited.set(next, null);
      queue.push(next);
    }
  }

  return visited;
}

function gzipBytes(buffer) {
  return gzipSync(buffer).length;
}

const landing = collectHtmlModules(landingHtmlPath);
if (!landing) fail("dist/index.html is missing; run astro build first");

const landingGraph = resolveGraph(landing.roots, "landing");

let landingTotal = 0;
for (const body of landing.inline) landingTotal += gzipBytes(body);
for (const file of landingGraph.values()) {
  landingTotal += gzipBytes(readFileSync(file));
}

if (landingTotal > LANDING_BUDGET_BYTES) {
  fail(`landing gzipped JS ${landingTotal} bytes exceeds the ${LANDING_BUDGET_BYTES} byte budget`);
}

console.log(
  `route-js-budget: landing gzipped JS ${landingTotal} bytes across ` +
    `${landing.inline.length} inline + ${landingGraph.size} fetched modules (budget ${LANDING_BUDGET_BYTES})`,
);

const diorama = collectHtmlModules(dioramaHtmlPath);
if (!diorama) fail("dist/diorama/index.html is missing; the /diorama route did not build");

const dioramaGraph = resolveGraph(diorama.roots, "diorama");

const shared = [...dioramaGraph.keys()].filter((key) => landingGraph.has(key));
if (shared.length > 0) {
  // Shared chunks are only acceptable as an Astro common chunk that stays
  // within budget and carries no scene/audio library code.
  for (const key of shared) {
    if (/three|howler/.test(key)) {
      fail(`shared chunk ${key} contains three or howler code`);
    }
    const code = readFileSync(dioramaGraph.get(key), "utf8");
    if (/from\s+["']three["']|howler/i.test(code)) {
      fail(`shared chunk ${key} bundles three or howler imports`);
    }
  }
  console.log(`route-js-budget: shared chunks tolerated (${shared.join(", ")})`);
} else {
  console.log("route-js-budget: /diorama module graph is disjoint from landing");
}
