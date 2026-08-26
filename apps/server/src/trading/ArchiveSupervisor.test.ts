// @effect-diagnostics nodeBuiltinImport:off - resolving files the supervisor resolves.
import { assert, describe, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { resolveArchiverEntry } from "./ArchiveSupervisor.ts";

const withDir = <A>(use: (dir: string) => A): A => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "archive-entry-"));
  try {
    return use(dir);
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
};

const urlOf = (dir: string): string => NodeURL.pathToFileURL(NodePath.join(dir, "x.ts")).href;

describe("resolveArchiverEntry", () => {
  // The supervisor and the archiver ship together in two shapes — the source
  // tree, and the packed CLI where both were bundled into one directory. A
  // resolver that only knew the first would leave every packaged install
  // recording nothing, silently.
  it("finds the archiver beside this module in the source tree", () => {
    const entry = resolveArchiverEntry(import.meta.url);
    assert.isNotNull(entry);
    assert.ok(entry !== null && entry.endsWith(NodePath.join("archive", "main.ts")));
    assert.isTrue(NodeFS.existsSync(entry as string));
  });

  it("finds the bundled archiver beside a packed supervisor", () => {
    withDir((dir) => {
      NodeFS.writeFileSync(NodePath.join(dir, "main.js"), "");
      assert.equal(resolveArchiverEntry(urlOf(dir)), NodePath.join(dir, "main.js"));
    });
  });

  // Better to report "not running, entry not found" than to spawn a path that
  // does not exist and restart it forever.
  it("finds nothing when neither shape is present", () => {
    withDir((dir) => {
      assert.isNull(resolveArchiverEntry(urlOf(dir)));
    });
  });
});
