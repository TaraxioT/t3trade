import { describe, expect, it } from "vite-plus/test";

import { relayDatabaseName } from "./dbConfig.ts";

describe("relayDatabaseName", () => {
  it("gives production the canonical database name", () => {
    expect(relayDatabaseName("prod")).toBe("t3coderelay");
  });

  it("suffixes every other stage with its slug", () => {
    expect(relayDatabaseName("dev_george")).toBe("t3coderelay_dev-george");
    expect(relayDatabaseName("preview")).toBe("t3coderelay_preview");
  });

  it("applies the shared slug rules to the suffix", () => {
    expect(relayDatabaseName("Dev_George__2")).toBe("t3coderelay_dev-george-2");
    expect(relayDatabaseName("--staging--")).toBe("t3coderelay_staging");
  });
});
