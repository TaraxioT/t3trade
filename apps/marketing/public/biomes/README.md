# T3 Trade Biome Universe

An interactive 3D product universe: seven floating biome dioramas built from the
T3 Trade icon system (V1 Faceted, V2 Dimensional, V3 Blueprint across Prod, Dev
and Nightly). Self-contained static page. No build step, no new dependencies.

## Run

```sh
# from the monorepo root
pnpm dev:marketing
# open http://localhost:4173/biomes/index.html
```

(Astro serves `public/` verbatim, so the page also ships as-is in `pnpm build:marketing`.)

Three.js r0.185.1 is vendored minified under `vendor/` (module + core, no CDN,
works offline). Nothing else is loaded externally.

## Controls

- Drag to orbit, scroll or pinch to zoom
- Click or tap an island to focus it; click empty space, press Escape, or use
  Overview to return
- Keys 1-7 focus islands directly
- Idle for a few seconds and the camera slowly orbits on its own
- `prefers-reduced-motion: reduce` stops all ambient motion and idle orbit

## Structure

```
index.html          page shell, UI overlay, styles, import map
vendor/             three.module.min.js + three.core.min.js (pinned r0.185.1)
src/main.js         renderer, lighting, island assembly, hover/focus state, loop
src/camera.js       orbit controller: drag, pinch, idle auto-orbit, focus tweens
src/config.js       audited palette, island layout + metadata (single source)
src/geometry.js     slab/strata/peak primitives, plotted lines, grids, pines
src/props.js        reusable props: barn, windmill, tractor, palms, camel, ...
src/particles.js    shader particle framework: rain, snow, smoke, falls, motes
src/ui.js           DOM overlay: loading, chips, panel, hover tag, hints
src/biomes/         one builder per island + shared helpers
```

Every color in `config.js` traces to the pixel-sampled icon audit in
`icon-vote` (see the biome-universe report for the mapping). The scene is fully
deterministic: seeded RNGs make every reload identical.

`window.__biome` exposes the live scene graph for automated layout checks.
