import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SettingsFallbackRoute } from "./settings.$.tsx";

describe("settings fallback route (10F)", () => {
  it("names the miss and links back to General settings", () => {
    const markup = renderToStaticMarkup(<SettingsFallbackRoute />);
    expect(markup).toContain("Settings page not found");
    expect(markup).toContain("does not exist");
    expect(markup).toContain("Go to General settings");
    expect(markup).toContain('href="/settings/general"');
  });
});
