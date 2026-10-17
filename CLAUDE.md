# Portfolio implementation notes

React and Vite portfolio for Parintorn Sanguanpong. The selected design is Dither Orbit: a single screen with the name and contact sheet beside a raymarched, dithered WebGL shape. Clicking the shape morphs through eight themes (shape, dither algorithm, two-color palette).

## Content and structure

- `src/data/portfolio.ts` is authoritative for name, title, links, and experience. `DitherPortfolio.tsx` derives its copy from it.
- `src/components/dither/themes.ts` lists the themes. Shape indices map to the `sd()` switch in `shaders.ts`.
- `renderer.ts` is plain WebGL1, two passes: the scene is raymarched into a 1/3-res texture, then dithered at full res. During a morph both shapes are blended and the new palette wipes out from the click point.
- `DitherPortfolio.tsx` owns the render loop and input in one effect that only touches refs. React state changes only when a morph starts or ends. Each theme renders a full `ThemeLayer`; during a morph the incoming and outgoing layers get complementary CSS masks driven by the same radius as the shader wipe, so text and canvas change in step. Keep `BAND` equal to the shader's edge band. On touch or narrow screens the layers use a hard-edged `clip-path` circle (`m.r + BAND`) and the complement of a smaller one (`m.r - BAND`) instead, so the compositor clips them without repainting the text every frame; the two overlap across the band, where both themes' text shows. Anything themed that must follow the wipe lives in `ThemeLayer`: the Lattice CRT scanlines (`.dp-crt`) and the phone sheet dim (`.dp-dim`, theme paper at an opacity driven by `--sheet`) included.
- Phones (below 820px, or touch screens at most 500px tall, i.e. landscape) get their own layout from `ThemeLayer`: full-bleed shape (lifted by the renderer's `offset`), name over it (`fitName` caps it below `.dp-ptop` on short screens), contact rows in a bottom sheet driven by `--sheet` on `.dp`. Swiping sideways drags the next or previous theme in under the finger; the wipe is the same circle with radius `LINE_R`, so its edge is a vertical line. Release past halfway or flick to commit, otherwise it springs back. Tap, dots, keys, and the idle cycle play the same sweep.
- iOS Safari 26+ ignores `theme-color` and tints its bars from the page background, so `chrome()` also sets `--page` on `<html>`. Safari hit-tests each edge, so on touch and narrow screens the effect appends two hit-testable 12px `.dp-tint` strips to `<body>` and recolors them by how much of each edge the wipe covers. They sit at `z-index: -1`, under `.dp`, so they neither cover the canvas nor take edge taps. The setup effect is a layout effect so the first paint already has `--page` and a rendered canvas.
- `effects.ts` holds the sound chirp (off by default, persisted in localStorage) and the mask dither tile. The favicon is a static transparent PNG (`public/favicon.png`).
- Motion: idle auto-cycle after 10s, drag to spin (desktop), wheel for dither grain, pinch to zoom, link hover spins the shape. Reduced motion renders a still frame and switches themes instantly. When `createRenderer` returns `null` (no WebGL, a shader compile or link failure, or no `highp` in fragment shaders), layers fall back to `public/images/shape-fallback.png` tinted by the theme ink. A lost WebGL context stops drawing and the renderer is rebuilt on `webglcontextrestored`.
- The URL hash names the theme (`#orbit`); with no hash a random theme is picked per visit.
- `public/og.png` is a screenshot of the Orbit theme at 1200x630. Regenerate it if the layout changes.

## Validation and delivery

Check rapid morphs (including interrupting one), reduced motion, phone layout below 820px (swipe commit and spring-back, bottom sheet), wheel and drag input, and renderer failure. Use the npm lockfile for reproducible installs. Build and lint commands are in `package.json`.

The entry is `src/App.tsx`. `design-mocks/` contains separate studies and is not bundled into the application. GitHub Actions deploys to GitHub Pages on pushes to the configured deployment branch. `npm run deploy:vm` (`scripts/deploy-vm.sh`) syncs `dist/` to the nginx host for parintorn.com, whose CSP only allows same-origin fonts and styles. Publishing either way requires explicit user instruction.
