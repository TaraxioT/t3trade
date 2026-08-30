#!/usr/bin/env node
// Explicit-variant icon switcher.
//
//   pnpm swap:icons        print the active variant and available variants
//   pnpm swap:icons:og     restore the original upstream T3 Code assets
//   pnpm swap:icons:1      apply the first generated T3 Trade variant
//   pnpm swap:icons:2      apply the second generated T3 Trade variant
//
// Variants are self-contained mirrors of repo paths under assets/<dir>.
// Switching restores every file the previous variant touched from
// assets/original-backup before applying the target variant, so no stale
// files survive a variant change and every previous variant stays intact.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const __filename = NodeURL.fileURLToPath(import.meta.url);
const __dirname = NodePath.dirname(__filename);
const rootDir = NodePath.resolve(__dirname, "..");

const BACKUP_DIR = NodePath.join(rootDir, "assets", "original-backup");
const STATE_FILE = NodePath.join(rootDir, "assets", ".asset-theme-state.json");

const VARIANTS = [
  {
    id: "og",
    label: "Original (upstream T3 Code)",
    dir: NodePath.join(rootDir, "assets", "original-backup"),
    state: "original",
  },
  {
    id: "1",
    label: "T3 Trade variant 1",
    dir: NodePath.join(rootDir, "assets", "themed-t3trade"),
    state: "t3trade",
  },
  {
    id: "2",
    label: "T3 Trade variant 2 (Prod White T3 Family)",
    dir: NodePath.join(rootDir, "assets", "themed-t3trade-v2"),
    state: "t3trade-2",
  },
  {
    id: "3",
    label: "T3 Trade variant 3 (Dev Blueprint Family)",
    dir: NodePath.join(rootDir, "assets", "themed-t3trade-v3"),
    state: "t3trade-3",
  },
];

function getAllFiles(dir, base = dir) {
  let results = [];
  if (!NodeFS.existsSync(dir)) return results;
  const list = NodeFS.readdirSync(dir);
  for (const file of list) {
    if (file === ".DS_Store") continue;
    const filePath = NodePath.join(dir, file);
    const stat = NodeFS.statSync(filePath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getAllFiles(filePath, base));
    } else {
      results.push(NodePath.relative(base, filePath));
    }
  }
  return results;
}

function ensureDir(filePath) {
  const dir = NodePath.dirname(filePath);
  if (!NodeFS.existsSync(dir)) {
    NodeFS.mkdirSync(dir, { recursive: true });
  }
}

function copyFileSafe(src, dest) {
  ensureDir(dest);
  NodeFS.copyFileSync(src, dest);
}

function readState() {
  if (NodeFS.existsSync(STATE_FILE)) {
    try {
      return JSON.parse(NodeFS.readFileSync(STATE_FILE, "utf-8"));
    } catch {
      // fall through to defaults on a corrupt state file
    }
  }
  return {};
}

function activeVariant() {
  const state = readState();
  const byId = VARIANTS.find((variant) => variant.id === state.variantId);
  if (byId) return byId;
  // States written before variant ids existed
  if (state.activeTheme === "t3trade") {
    return VARIANTS.find((variant) => variant.id === "1");
  }
  return VARIANTS.find((variant) => variant.id === "og");
}

function saveState(variant, count) {
  ensureDir(STATE_FILE);
  NodeFS.writeFileSync(
    STATE_FILE,
    JSON.stringify(
      {
        activeTheme: variant.state,
        variantId: variant.id,
        swappedAt: new Date().toISOString(),
        filesCount: count,
      },
      null,
      2,
    ),
    "utf-8",
  );
}

function printStatus() {
  const active = activeVariant();
  console.log(`\nActive icon variant: ${active.id} (${active.label})\n`);
  console.log("Available variants:");
  for (const variant of VARIANTS) {
    const exists = NodeFS.existsSync(variant.dir);
    const marker = variant.id === active.id ? "*" : " ";
    console.log(
      ` ${marker} swap:icons:${variant.id.padEnd(3)} ${variant.label}${exists ? "" : " (not installed)"}`,
    );
  }
  console.log("");
}

function swapTo(target) {
  if (!NodeFS.existsSync(target.dir)) {
    console.error(`Error: variant directory not found at ${target.dir}`);
    process.exit(1);
  }

  const current = activeVariant();
  const treeFiles = new Set([...getAllFiles(current.dir), ...getAllFiles(target.dir)]);

  // Restore everything the outgoing variant touched back to upstream first,
  // so assets only present in the outgoing variant cannot leak through.
  let restoredCount = 0;
  for (const relPath of treeFiles) {
    const backupPath = NodePath.join(BACKUP_DIR, relPath);
    if (NodeFS.existsSync(backupPath)) {
      copyFileSafe(backupPath, NodePath.join(rootDir, relPath));
      restoredCount++;
    }
  }

  let appliedCount = 0;
  if (target.id !== "og") {
    for (const relPath of getAllFiles(target.dir)) {
      copyFileSafe(NodePath.join(target.dir, relPath), NodePath.join(rootDir, relPath));
      appliedCount++;
    }
  }

  saveState(target, appliedCount);
  console.log(`\n✨ Icon variant ${target.id} (${target.label}) is now active.`);
  console.log(
    `   Restored ${restoredCount} upstream files, applied ${appliedCount} variant files.`,
  );
  console.log(
    `   Compare variants: ${VARIANTS.map((v) => `pnpm swap:icons:${v.id}`).join(" | ")}\n`,
  );
}

const requested = process.argv[2];
if (!requested) {
  printStatus();
  process.exit(0);
}

const target = VARIANTS.find((variant) => variant.id === requested);
if (!target) {
  console.error(
    `Error: unknown icon variant "${requested}". Known variants: ${VARIANTS.map((v) => v.id).join(", ")}`,
  );
  process.exit(1);
}

swapTo(target);
