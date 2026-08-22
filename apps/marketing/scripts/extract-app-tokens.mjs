/*
 * Extracts the T3 Trade app's design tokens from apps/web so the marketing
 * replica's values flow mechanically from the real product and can never
 * drift (DESIGN-CONTRACT.md, "The replica rule").
 *
 * What it reads:
 *   - apps/web/src/index.css and apps/web/src/trading.css for token
 *     declarations (the `:root` blocks and their nested `@variant dark`
 *     overrides, plus the `@theme` font stacks).
 *   - tailwindcss/theme.css (resolved from apps/web's dependencies) so
 *     `var(--color-blue-500)` and friends resolve to the exact Tailwind
 *     palette value the app ships.
 *   - lucide-react dist/esm/icons/<kebab>.js for the literal `__iconNode`
 *     arrays, so the replica's glyph paths are byte-identical to the app's.
 *
 * What it emits (deterministically, so regeneration is byte-identical):
 *   - src/styles/app-tokens.generated.css: one `:root` block of `--app-*`
 *     custom properties in dark-mode resolution, plus the app's font stacks.
 *   - src/lib/icons.ts: the lucide paths plus a renderIcon helper.
 *
 * Modes:
 *   node scripts/extract-app-tokens.mjs          regenerate both files
 *   node scripts/extract-app-tokens.mjs --check  regenerate to memory, assert
 *                 the P1 oracle values, and diff against the on-disk files.
 *                 Fails (exit 1) on mismatch. Skips the token half gracefully
 *                 when apps/web is absent from the checkout (icons are still
 *                 checked because lucide-react is a local devDependency);
 *                 skips everything but the oracle-independent icon diff when
 *                 apps/web is gone.
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const marketingRoot = resolve(scriptDir, "..");
const repoRoot = resolve(marketingRoot, "..", "..");
const CHECK = process.argv.includes("--check");

const WEB_INDEX = join(repoRoot, "apps/web/src/index.css");
const WEB_TRADING = join(repoRoot, "apps/web/src/trading.css");
const TOKENS_OUT = join(marketingRoot, "src/styles/app-tokens.generated.css");
const ICONS_OUT = join(marketingRoot, "src/lib/icons.ts");

/* ------------------------------------------------------------------ */
/* Minimal CSS block parser: enough for declarations + one nesting     */
/* level of @variant blocks. Not a general CSS engine.                 */
/* ------------------------------------------------------------------ */

/** Parse a stylesheet into a tree of { header, decls, children }. */
function parseBlocks(source) {
  // Comments are not token boundaries here (they contain apostrophes and
  // braces that would corrupt quote/depth tracking), so strip them first.
  source = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const root = { header: "", decls: [], children: [] };
  const stack = [root];
  let buf = "";
  let quote = null;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      buf += ch;
      if (ch === quote && source[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === "{") {
      const node = { header: buf, decls: [], children: [] };
      stack.at(-1).children.push(node);
      stack.push(node);
      buf = "";
      continue;
    }
    if (ch === "}") {
      flushDecls(stack.pop(), buf);
      buf = "";
      continue;
    }
    if (ch === ";") {
      const top = stack.at(-1);
      const d = parseDecl(buf);
      if (d) top.decls.push(d);
      buf = "";
      continue;
    }
    buf += ch;
  }
  return root;
}

/** Semicolons inside a block's trailing text (after its last child) are decls. */
function flushDecls(node, text) {
  for (const part of text.split(";")) {
    const d = parseDecl(part);
    if (d) node.decls.push(d);
  }
}

function parseDecl(text) {
  // Any property, not just custom properties: class scopes also need plain
  // declarations like box-shadow for the panel material.
  const m = text.trim().match(/^([\w-]+)\s*:\s*([\s\S]+)$/);
  if (!m) return null;
  return { name: m[1], value: m[2].trim().replace(/\s+/g, " ") };
}

/**
 * Collect custom-property declarations from every `:root` block (plain and
 * `@variant dark`) plus `@theme` blocks, and all declarations (custom props
 * and plain properties like box-shadow) from CLASS_SELECTORS blocks. Returns
 * { light, dark, theme, classes } where light/dark hold the cascade-merged
 * `:root`-scoped values for each mode and classes maps selector -> {light,
 * dark} declaration maps.
 */
const CLASS_SELECTORS = [".mission-panel-glass"];

function collectTokens(source) {
  const light = {};
  const dark = {};
  const theme = {};
  const classes = Object.fromEntries(CLASS_SELECTORS.map((s) => [s, { light: {}, dark: {} }]));
  const visit = (node, ctx, classCtx, classDark) => {
    const header = node.header.trim();
    let next = ctx;
    let nextClassCtx = classCtx;
    let nextClassDark = classDark;
    const classMatch = CLASS_SELECTORS.find((s) => header.includes(s));
    if (/^@variant\s+dark\b/.test(header)) {
      if (ctx === "root" || ctx === "root-dark") next = "root-dark";
      if (classCtx !== null) nextClassDark = true;
    } else if (/^@theme\b/.test(header)) {
      next = "theme";
    } else if (/(^|,)\s*:root\s*(,|$)/.test(header.replace(/\s+/g, " ")) || header === ":root") {
      // Plain :root (possibly inside a layer). Scoped away from
      // [data-app-sidebar] / html[data-theme-id] overrides on purpose: the
      // replica mirrors the default theme, which those blocks replace only
      // when a custom theme is active.
      next = "root";
    } else if (header === "" ) {
      // stay in context (e.g. layer wrapper around :root)
    } else if (ctx === "root-dark") {
      next = ctx; // nested blocks inside a dark variant stay dark
    } else if (ctx !== "root") {
      next = "other";
    } else {
      next = ctx;
    }
    if (classMatch && !/^@/.test(header)) {
      nextClassCtx = classMatch;
      nextClassDark = false;
    }
    for (const d of node.decls) {
      if (next === "root") {
        // A plain :root declaration applies to both modes; a later dark
        // variant declaration overrides it in dark only (the dark variant's
        // selector specificity wins in the app's cascade).
        light[d.name] = d.value;
        dark[d.name] = d.value;
      } else if (next === "root-dark") {
        dark[d.name] = d.value;
      } else if (next === "theme") {
        theme[d.name] = d.value;
      }
      if (nextClassCtx !== null) {
        const slot = nextClassDark ? "dark" : "light";
        classes[nextClassCtx][slot][d.name] = d.value;
      }
    }
    for (const child of node.children) visit(child, next, nextClassCtx, nextClassDark);
  };
  for (const child of parseBlocks(source).children) visit(child, "top", null, false);
  return { light, dark, theme, classes };
}

/* ------------------------------------------------------------------ */
/* Value resolution: var chains, --alpha(), calc(), Tailwind palette.  */
/* ------------------------------------------------------------------ */

const PX_PER_REM = 16;
let palette = {}; // --color-name -> literal, from tailwindcss/theme.css
let paletteUsed = new Set(); // tailwind token names cited in output comments

function loadTailwindPalette() {
  const req = createRequire(join(repoRoot, "apps/web/package.json"));
  const pkgPath = req.resolve("tailwindcss/package.json");
  const themePath = join(dirname(pkgPath), "theme.css");
  const theme = readFileSync(themePath, "utf8");
  for (const m of theme.matchAll(/(--color-[\w-]+)\s*:\s*([^;]+);/g)) {
    palette[m[1]] = m[2].trim();
  }
}

/** Evaluate a calc() whose operands are lengths in rem/px/% after var
 *  substitution. Supports + and - only; that is all the radius ladder uses. */
function evalCalc(expr) {
  const inner = expr.slice(expr.indexOf("(") + 1, expr.lastIndexOf(")"));
  if (!/^[\s\d.+\-rempx%]*$/.test(inner)) return expr; // not a simple sum, keep as-is
  const terms = [...inner.matchAll(/([+-]?)\s*([\d.]+)(rem|px|%)?/g)];
  if (terms.length === 0) return expr;
  let px = 0;
  let pct = 0;
  for (const [, sign, num, unit] of terms) {
    const v = Number(num) * (sign === "-" ? -1 : 1);
    if (unit === "rem") px += v * PX_PER_REM;
    else if (unit === "px" || unit === undefined) px += v;
    else if (unit === "%") pct += v;
  }
  if (pct !== 0) return expr;
  const rem = px / PX_PER_REM;
  // Prefer exact rem when it is clean, otherwise px.
  return Number.isInteger(rem * 1000) ? `${parseFloat(rem.toFixed(4))}rem` : `${parseFloat(px.toFixed(4))}px`;
}

/** --alpha(<color> / <a>) is Tailwind's relative-color syntax; expand the
 *  cases the app uses (hex / space-separated rgb) into a literal. */
function expandAlpha(value, resolve) {
  const m = value.match(/^--alpha\(([\s\S]+?)\s*\/\s*([\d.]+%?)\)$/);
  if (!m) return { value, note: "" };
  let color = resolve(m[1].trim()).value;
  const alpha = m[2];
  const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1];
    const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    color = `rgb(${r} ${g} ${b})`;
  }
  if (/^(rgb|hsl)a?\(/.test(color) && !/\/\s*[\d.]/.test(color)) {
    return { value: color.replace(/\)$/, ` / ${alpha})`), note: "" };
  }
  throw new Error(`cannot expand --alpha() around ${color}`);
}

/** Resolve a declaration value to a standalone literal plus provenance notes.
 *  `extraDecls` (e.g. a class block's declarations) is consulted before the
 *  root tokens, mirroring how the class scope shadows :root. */
function resolveValue(raw, tokens, mode, extraDecls = null, notes = new Set()) {
  const decls = mode === "dark" ? tokens.dark : tokens.light;
  let value = raw;
  for (let depth = 0; depth < 24; depth++) {
    const next = value.replace(/var\((--[\w-]+)(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g, (_all, name, fallback) => {
      if (extraDecls && extraDecls[name] !== undefined) return extraDecls[name];
      if (decls[name] !== undefined) return decls[name];
      if (palette[name] !== undefined) {
        notes.add(name.replace(/^--color-/, ""));
        return palette[name];
      }
      if (tokens.theme[name] !== undefined) return tokens.theme[name];
      if (fallback !== undefined) return fallback.trim();
      throw new Error(`unresolved var(${name}) while resolving: ${raw}`);
    });
    if (next === value) break;
    value = next;
  }
  // --alpha() may appear after var substitution.
  if (/^--alpha\(/.test(value)) {
    const resolveInner = (v) => resolveValue(v, tokens, mode, extraDecls, notes);
    value = expandAlpha(value, resolveInner).value;
  }
  if (/^calc\(/.test(value)) value = evalCalc(value);
  return { value, notes };
}

/* ------------------------------------------------------------------ */
/* Token emission                                                      */
/* ------------------------------------------------------------------ */

// app token -> emitted --app-* name. The replica is dark-only (contract
// non-negotiable 2), so every value here is the dark-mode resolution.
const TOKEN_SPEC = [
  { app: "background", out: "background" },
  { app: "card", out: "card" },
  { app: "foreground", out: "foreground" },
  { app: "muted-foreground", out: "muted-foreground" },
  { app: "border", out: "border" },
  { app: "primary", out: "primary" },
  { app: "info", out: "info" },
  { app: "profit", out: "profit" },
  { app: "loss", out: "loss" },
  { app: "long", out: "long" },
  { app: "short", out: "short" },
  { app: "armed", out: "armed" },
  { app: "radius", out: "radius" },
  { app: "radius-sm", out: "radius-sm" },
  { app: "radius-md", out: "radius-md" },
  { app: "radius-lg", out: "radius-lg" },
  { app: "radius-xl", out: "radius-xl" },
  { app: "mission-chart-wash-top", out: "mission-chart-wash-top" },
  { app: "mission-chart-wash-mid", out: "mission-chart-wash-mid" },
  { app: "mission-chart-wedge-near", out: "mission-chart-wedge-near" },
  { app: "mission-chart-wedge-far", out: "mission-chart-wedge-far" },
];

function generateTokensCss(tokens) {
  const lines = [];
  lines.push("/*");
  lines.push(" * GENERATED by scripts/extract-app-tokens.mjs from apps/web/src/index.css");
  lines.push(" * and apps/web/src/trading.css. DO NOT EDIT: rerun the script instead.");
  lines.push(" * Values are the app's dark-mode resolution (the replica is dark-only).");
  lines.push(" * Var chains, --alpha(), calc(), and Tailwind palette references are");
  lines.push(" * resolved to literals a browser can use standalone.");
  lines.push(" */");
  lines.push(":root {");
  const emit = (out, value, comment) => {
    const pad = "  ".padEnd(2);
    lines.push(`${pad}--app-${out}: ${value};${comment ? ` /* ${comment} */` : ""}`);
  };
  for (const spec of TOKEN_SPEC) {
    const { value, notes } = resolveValue(`var(--${spec.app})`, tokens, "dark");
    const comment = notes.size > 0 ? `from Tailwind ${[...notes].join(", ")}` : "";
    emit(spec.out, value, comment);
  }
  // The replica's card material: the mission panel's dark glass tokens and
  // shadow, straight out of the `.mission-panel-glass` dark block in
  // trading.css (audit fidelity row 15), plus the app-wide glass tokens the
  // panel composes with (index.css :root @variant dark).
  const panel = tokens.classes[".mission-panel-glass"].dark;
  const panelOut = (out, raw, comment) => {
    const { value, notes } = resolveValue(raw, tokens, "dark", panel);
    const tail = notes.size > 0 ? `; from Tailwind ${[...notes].join(", ")}` : "";
    emit(out, value, `${comment}${tail}`);
  };
  panelOut("mission-panel-surface", "var(--mission-panel-surface)", "mission-panel-glass dark; the app's --card straight, nothing mixed in");
  panelOut("mission-panel-outline", "var(--mission-panel-outline)", "mission-panel-glass dark");
  panelOut("mission-panel-opacity", "var(--mission-panel-opacity)", "mission-panel-glass dark");
  panelOut("mission-panel-bevel", "var(--mission-panel-bevel)", "mission-panel-glass dark");
  panelOut("mission-panel-shadow", panel["box-shadow"], "mission-panel-glass dark box-shadow, bevel resolved");
  panelOut("glass-blur", "var(--glass-blur)", "index.css :root @variant dark");
  panelOut("glass-saturation", "var(--glass-saturation)", "index.css :root @variant dark");
  lines.push("");
  lines.push("  /* Font stacks mirroring the app's @theme --font-sans/--font-mono");
  lines.push("   * (apps/web/src/index.css), byte for byte. */");
  lines.push(`  --app-font-sans: ${tokens.theme["--font-sans"]};`);
  lines.push(`  --app-font-mono: ${tokens.theme["--font-mono"]};`);
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

/* Oracle from the P1 audit: every value below was verified byte-exact against
 * the app. If the extractor stops reproducing one, resolution has regressed. */
const ORACLE = [
  "--app-primary: oklch(0.571 0.21 264);",
  "--app-info: oklch(62.3% 0.214 259.815);",
  "--app-profit: oklch(0.72 0.15 152);",
  "--app-long: oklch(0.72 0.15 152);",
  "--app-loss: oklch(0.66 0.18 27);",
  "--app-short: oklch(0.66 0.18 27);",
  "--app-armed: oklch(0.78 0.125 78);",
  "--app-mission-chart-wash-top: 0.13;",
  "--app-mission-chart-wash-mid: 0.04;",
  "--app-mission-chart-wedge-near: 0.13;",
  "--app-mission-chart-wedge-far: 0.04;",
  "--app-radius: 0.625rem;",
  "--app-radius-sm: 0.375rem;",
  "--app-radius-md: 0.5rem;",
  "--app-radius-lg: 0.625rem;",
  "--app-radius-xl: 0.875rem;",
  // Panel material (audit fidelity row 15).
  "--app-mission-panel-surface: color-mix(in srgb, oklch(14.5% 0 0) 97%, #fff);",
  "--app-mission-panel-outline: rgb(255 255 255 / 12%);",
  "--app-mission-panel-opacity: 58%;",
  "--app-mission-panel-bevel: rgb(255 255 255 / 9%);",
  "--app-mission-panel-shadow: inset 0 1px 0 rgb(255 255 255 / 9%), 0 16px 36px -24px rgb(0 0 0 / 80%);",
  "--app-glass-blur: 16px;",
  "--app-glass-saturation: 1.08;",
];

function assertOracle(css) {
  const failures = ORACLE.filter((line) => !css.includes(line));
  if (failures.length > 0) {
    console.error("extract-app-tokens: oracle regression, missing expected lines:");
    for (const f of failures) console.error(`  ${f}`);
    process.exitCode = 1;
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Icon extraction from lucide-react                                   */
/* ------------------------------------------------------------------ */

// The glyphs the mission replica needs, enumerated from the app source:
// - apps/web/src/components/trading/MissionLivePanel.tsx (log rows at 11px /
//   strokeWidth 2, watch type map, timeline cards, activity line)
// - apps/web/src/components/trading/MissionHeaderPill.tsx (status glyphs)
const ICONS = [
  ["Activity", "activity"],
  ["AlarmClock", "alarm-clock"],
  ["ArrowUp", "arrow-up"],
  ["ArrowUpRight", "arrow-up-right"],
  ["BellRing", "bell-ring"],
  ["BookOpen", "book-open"],
  ["ChartCandlestick", "chart-candlestick"],
  ["Check", "check"],
  ["ChevronDown", "chevron-down"],
  ["ChevronRight", "chevron-right"],
  ["ChevronUp", "chevron-up"],
  ["CircleSlash", "circle-slash"],
  ["Clock", "clock"],
  ["Crosshair", "crosshair"],
  ["ExternalLink", "external-link"],
  ["Eye", "eye"],
  ["FileText", "file-text"],
  ["Gauge", "gauge"],
  ["Hand", "hand"],
  ["Lock", "lock"],
  ["NotebookPen", "notebook-pen"],
  ["Radar", "radar"],
  ["Receipt", "receipt"],
  ["Route", "route"],
  ["ShieldCheck", "shield-check"],
  ["TrendingDown", "trending-down"],
  ["TrendingUp", "trending-up"],
  ["Zap", "zap"],
];

/** Pull the literal __iconNode array out of a lucide-react icon module. */
function readIconNode(lucideEsmDir, kebab) {
  const file = join(lucideEsmDir, "icons", `${kebab}.js`);
  const src = readFileSync(file, "utf8");
  const m = src.match(/const __iconNode = (\[[\s\S]*\]);/);
  if (!m) throw new Error(`no __iconNode literal in ${file}`);
  // A JS literal (unquoted keys), evaluated from the pinned package's own
  // dist file, not user input.
  const node = new Function(`return ${m[1]}`)();
  // Drop the per-node `key` props: they exist for React reconciliation only.
  return node.map(([tag, attrs]) => {
    const { key: _key, ...rest } = attrs;
    return [tag, rest];
  });
}

function generateIconsTs(lucideVersion) {
  const req = createRequire(join(marketingRoot, "package.json"));
  const pkgPath = req.resolve("lucide-react/package.json");
  const version = JSON.parse(readFileSync(pkgPath, "utf8")).version;
  if (version !== lucideVersion) {
    console.error(
      `extract-app-tokens: lucide-react is ${version}, expected ${lucideVersion} (the app's lockfile resolution).`,
    );
    process.exitCode = 1;
    return null;
  }
  const esmDir = join(dirname(pkgPath), "dist/esm");
  const entries = [];
  for (const [name, kebab] of ICONS) {
    const node = readIconNode(esmDir, kebab);
    const rendered = node
      .map(([tag, attrs]) => {
        const attrStr = Object.entries(attrs)
          .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
          .join(", ");
        return `    ["${tag}", { ${attrStr} }]`;
      })
      .join(",\n");
    entries.push(`  ${name}: [\n${rendered},\n  ],`);
  }
  return `// GENERATED by scripts/extract-app-tokens.mjs from lucide-react@${version}
// (the exact version apps/web's lockfile resolves). DO NOT EDIT: rerun the
// script instead. Zero hand-written path data; every glyph is the app's own.
//
// Usage: the log-row glyphs render at size 11, strokeWidth 2, matching the
// app's MissionLivePanel; the header pill glyphs match MissionHeaderPill.

export type IconNode = ReadonlyArray<readonly [string, Readonly<Record<string, string>>]>;

export const icons = {
${entries.join("\n")}
} as const satisfies Record<string, IconNode>;

export type IconName = keyof typeof icons;

export interface RenderIconOptions {
  /** Pixel size; the SVG is square. Default 11, the app's log-row size. */
  readonly size?: number;
  /** Default 2, the strokeWidth every mission glyph uses. */
  readonly strokeWidth?: number;
  /** Extra classes for the root svg element. */
  readonly class?: string;
}

/** Render a lucide glyph as an Astro-safe inline SVG string (use set:html). */
export function renderIcon(
  name: IconName,
  { size = 11, strokeWidth = 2, class: className }: RenderIconOptions = {},
): string {
  const children = icons[name]
    .map(([tag, attrs]) => {
      const attrStr = Object.entries(attrs)
        .map(([k, v]) => \` \${k}="\${v}"\`)
        .join("");
      return \`<\${tag}\${attrStr} />\`;
    })
    .join("");
  return (
    \`<svg xmlns="http://www.w3.org/2000/svg" width="\${size}" height="\${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="\${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"\${className ? \` class="\${className}"\` : ""} aria-hidden="true">\${children}</svg>\`
  );
}
`;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

const LUCIDE_VERSION = "0.564.0"; // apps/web lockfile resolution of ^0.564.0

function diff(label, onDiskPath, expected) {
  if (!existsSync(onDiskPath)) {
    console.error(`${label}: missing (${onDiskPath}); run node scripts/extract-app-tokens.mjs`);
    process.exitCode = 1;
    return;
  }
  const onDisk = readFileSync(onDiskPath, "utf8");
  if (onDisk !== expected) {
    console.error(
      `${label}: stale (${onDiskPath}); regenerate with node scripts/extract-app-tokens.mjs`,
    );
    process.exitCode = 1;
  }
}

function main() {
  // Icons first: lucide-react is a local devDependency, so this works even
  // when apps/web is not checked out.
  const iconsTs = generateIconsTs(LUCIDE_VERSION);
  if (iconsTs === null) return;
  if (CHECK) {
    diff("icons", ICONS_OUT, iconsTs);
  } else {
    writeFileSync(ICONS_OUT, iconsTs);
    console.log(`wrote ${ICONS_OUT}`);
  }

  const webPresent = existsSync(WEB_INDEX) && existsSync(WEB_TRADING);
  if (!webPresent) {
    console.log("extract-app-tokens: apps/web not present, skipping token check");
    return;
  }
  loadTailwindPalette();
  const tokens = collectTokens(readFileSync(WEB_INDEX, "utf8"));
  const trading = collectTokens(readFileSync(WEB_TRADING, "utf8"));
  // Cascade: trading.css is imported at the top of index.css, so index.css's
  // own :root declarations come after it. No token name is declared in both,
  // so a plain merge preserves each file's values.
  const merged = {
    light: { ...trading.light, ...tokens.light },
    dark: { ...trading.dark, ...tokens.dark },
    theme: { ...trading.theme, ...tokens.theme },
    classes: {
      ".mission-panel-glass": {
        light: { ...trading.classes[".mission-panel-glass"].light, ...tokens.classes[".mission-panel-glass"].light },
        dark: { ...trading.classes[".mission-panel-glass"].light, ...tokens.classes[".mission-panel-glass"].dark, ...trading.classes[".mission-panel-glass"].dark },
      },
    },
  };
  const css = generateTokensCss(merged);
  if (!assertOracle(css)) return;
  if (CHECK) {
    diff("tokens", TOKENS_OUT, css);
  } else {
    mkdirSync(dirname(TOKENS_OUT), { recursive: true });
    writeFileSync(TOKENS_OUT, css);
    console.log(`wrote ${TOKENS_OUT}`);
  }
  if (!process.exitCode) console.log("extract-app-tokens: ok");
}

main();
