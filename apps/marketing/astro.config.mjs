import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://t3.codes",
  server: {
    port: Number(process.env.PORT ?? 4173),
  },
  vite: {
    // Allow sharing the local dev/preview server through Cloudflare quick
    // tunnels and the diorama preview host; Vite otherwise rejects foreign
    // Host headers with a 403 before our app sees the request.
    server: {
      allowedHosts: [".trycloudflare.com", "diorama.athelstan.xyz"],
    },
    preview: {
      allowedHosts: [".trycloudflare.com", "diorama.athelstan.xyz"],
    },
    build: {
      // The CSS minifier folds `animation-timeline` into the `animation`
      // shorthand, which no browser parses, so every scroll-driven animation
      // was silently dropped from the production build. See
      // scripts/check-scroll-timelines.mjs, which fails the build if it
      // regresses.
      cssMinify: false,
      rollupOptions: {
        output: {
          // Keep PixiJS in one chunk: when the bundler splits it, the
          // render-pipe extension registrations can execute after Application
          // init, and the diorama renders blank (no graphics pipe) in
          // production.
          manualChunks: (id) => (id.includes("pixi") ? "dioramaScene" : undefined),
        },
      },
    },
  },
});
