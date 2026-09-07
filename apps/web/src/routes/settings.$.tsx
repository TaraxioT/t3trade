import { createFileRoute } from "@tanstack/react-router";

/**
 * The settings-scoped catch-all (10F): an unknown nested settings path used
 * to render blank inside the settings shell. This route names the miss and
 * hands the user the way back. The parent `/settings` route keeps the pair
 * gate and the `/settings → /settings/general` redirect.
 */
export function SettingsFallbackRoute() {
  return (
    <div className="flex flex-col items-center gap-2 px-3 py-12 text-center sm:px-4">
      <h1 className="text-base font-semibold text-foreground">Settings page not found</h1>
      <p className="max-w-sm text-[13px] leading-snug text-muted-foreground">
        This settings page does not exist. It may have moved or the link that brought you here is
        out of date.
      </p>
      <a
        href="/settings/general"
        className="mt-1 text-sm font-medium text-foreground underline-offset-4 hover:underline"
      >
        Go to General settings
      </a>
    </div>
  );
}

export const Route = createFileRoute("/settings/$")({
  component: SettingsFallbackRoute,
});
