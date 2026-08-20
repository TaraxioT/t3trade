import { describe, expect, it } from "vite-plus/test";

import { nextMigrationSeq, planMigrations } from "./migrate.ts";

const file = (id: string) => ({ id, sql: `-- ${id}`, hash: id });

describe("nextMigrationSeq", () => {
  it("starts at one when nothing is applied", () => {
    expect(nextMigrationSeq([])).toBe(1);
  });

  it("continues from the highest numeric id", () => {
    expect(nextMigrationSeq(["00001", "00002", "00003"])).toBe(4);
  });

  it("ignores ids that are not numeric", () => {
    expect(nextMigrationSeq(["00002", "baseline"])).toBe(3);
  });
});

describe("planMigrations", () => {
  it("keeps the order it was given and numbers sequentially", () => {
    const pending = planMigrations([file("a"), file("b"), file("c")], new Set(), 1);

    expect(pending.map((migration) => [migration.id, migration.name])).toEqual([
      ["00001", "a"],
      ["00002", "b"],
      ["00003", "c"],
    ]);
  });

  it("skips migrations that are already applied", () => {
    const pending = planMigrations([file("a"), file("b"), file("c")], new Set(["a", "b"]), 3);

    expect(pending.map((migration) => [migration.id, migration.name])).toEqual([["00003", "c"]]);
  });

  it("does not consume an id for a skipped migration", () => {
    const pending = planMigrations([file("a"), file("b"), file("c")], new Set(["b"]), 2);

    expect(pending.map((migration) => [migration.id, migration.name])).toEqual([
      ["00002", "a"],
      ["00003", "c"],
    ]);
  });

  it("is a no-op once every migration is applied", () => {
    expect(planMigrations([file("a"), file("b")], new Set(["a", "b"]), 3)).toEqual([]);
  });

  it("zero-pads ids to five digits", () => {
    const [pending] = planMigrations([file("a")], new Set(), 42);

    expect(pending?.id).toBe("00042");
  });
});
