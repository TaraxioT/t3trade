import { defineConfig } from "astro/config";

export default defineConfig({
  server: {
    port: Number(process.env.PORT ?? 4173),
  },
  vite: {
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
          manualChunks: (id) =>
            id.includes("pixi") ? "dioramaScene" : undefined,
        },
      },
    },
  },
});
