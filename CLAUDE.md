# Portfolio implementation notes

React and Vite portfolio for Parintorn Sanguanpong. The selected design is Dither Orbit: a single screen with the name and contact sheet beside a raymarched, dithered WebGL shape. Clicking the shape morphs through eight themes (shape, dither algorithm, two-color palette).

## Content and structure

- `src/data/portfolio.ts` is authoritative for name, title, links, and experience. `DitherPortfolio.tsx` derives its copy from it.
- `src/components/dither/themes.ts` lists the themes. Shape indices map to the `sd()` switch in `shaders.ts`.
- `renderer.ts` is plain WebGL1, two passes: the scene is raymarched into a 1/3-res texture, then dithered at full res. During a morph both shapes are blended and the new palette wipes out from the click point.
- `DitherPortfolio.tsx` owns the render loop and input in one effect that only touches refs. React state changes only when a morph starts or ends. Each theme renders a full `ThemeLayer`; during a morph the incoming and outgoing layers get complementary CSS masks driven by the same radius as the shader wipe, so text and canvas change in step. Keep `BAND` equal to the shader's edge band.
- `effects.ts` holds the sound chirp (off by default, persisted in localStorage) and the mask dither tile. The favicon is a static transparent PNG (`public/favicon.png`).
- Motion: idle auto-cycle after 10s, drag to spin, wheel for dither grain, pinch to zoom, link hover spins the shape. Reduced motion renders a still frame and switches themes instantly. Without WebGL, layers fall back to `public/images/shape-fallback.png` tinted by the theme ink.
- The URL hash names the theme (`#orbit`); with no hash a random theme is picked per visit.
- `public/og.png` is a screenshot of the Orbit theme at 1200x630. Regenerate it if the layout changes.

## Validation and delivery

Check rapid morphs (including interrupting one), reduced motion, phone layout below 820px, wheel and drag input, and renderer failure. Use the npm lockfile for reproducible installs. Build and lint commands are in `package.json`.

The entry is `src/App.tsx`. `design-mocks/` contains separate studies and is not bundled into the application. GitHub Actions deploys on pushes to the configured deployment branch; publishing requires explicit user instruction.
