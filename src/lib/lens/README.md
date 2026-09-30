# The lens viewer

An interactive 3D model of a Sigma 18-50mm F2.8 (three.js `three/webgpu` + TSL,
with a WebGL2 fallback). It runs in two places: **`/lens`**, a free-orbit viewer
with sliders, shading looks, animations and dev tools, and **`/`**, the
scroll-driven story on the homepage.

Pages and components import **only `index.ts`**. The GLB comes from the
`lens_work/` Blender pipeline, and **node names are the API**: never rename
nodes in code. Design rules: `docs/lens-principles.md`.

## Where to make a change

| To change…                             | Edit                                        |
| -------------------------------------- | ------------------------------------------- |
| what an animated value means           | `CHANNEL_REGISTRY` in `core/scene.ts`       |
| how pieces move (explode, peel, rose…) | a recipe in `ops/recipes.ts`                |
| zoom / focus / aperture mechanics      | `ops/mechanism.ts`                          |
| the story's scenes, timing, captions   | `STORY` in `story/story.ts`                 |
| when a value changes during the story  | `story/envelopes.ts`                        |
| one story scene's extra effects        | its module in `story/` (peelcards, fly, …)  |
| realistic / ink look                   | `materials/unified.ts`                      |
| the extra /lens shading looks          | `materials/shading-bench.ts`                |
| which parts a name refers to           | `core/names.ts` (spelling), `core/parts.ts` |
| part colours in the realistic look     | `core/model.ts`                             |
| the fly-through                        | `optics/` and `story/fly.ts`                |
| /lens animations and their sliders     | `animations.ts`                             |

## How it fits together

**Channels.** `CHANNEL_REGISTRY` in `core/scene.ts` lists every animated value:
`zoom`, `focus`, `aperture` and `huddle` move real transforms
(`ops/mechanism.ts`); `explode`, `assemble`, `peel` and `rose` drive shader
recipes (`ops/host.ts`); `story` is scroll progress. A new motion channel is a
registry row plus a recipe; `ops/__tests__/channel-registry.test.ts` checks the
two match.

**Recipes.** `ops/` is the only motion system. A recipe (`ops/recipes.ts`) is a
list of ops (`ops/ops.ts`), a per-piece timing window (`ops/gate.ts`) and knob
defaults with their allowed ranges. Ops are written against `Algebra<S>`
(`ops/algebra.ts`), so the same recipe runs on plain numbers in tests and is
emitted as WGSL, GLSL and JS source (`ops/emit/`). `ops/cpu.ts` runs the JS
version for rays and picking, so CPU and GPU agree.

**Frames.** At load, `ops/frames.ts` computes per-piece constants (seat angle,
radius, rank, part class, explode rung, …) into the `_opA`/`_opB`/`_opY`
vertex attributes the deform reads. `dev/model-contract.ts` logs an error at
boot if the model breaks the naming contract these rely on.

**Story.** `story/story.ts` holds `STORY`: ten scenes (hero, zoom, peel,
cards, internals, flythrough, constellations, trails, rewrap, capsOn) with
durations, camera poses, tints and titles. `story/envelopes.ts` computes every
channel value as a function of scroll progress `p`; `story/hero-driver.ts`
writes them to the scene.

**One clock.** In story mode the scene eases one value, `state.story`, toward
the scroll position. Every 3D value is computed from that eased value in
`tick()` (via `onEvaluate`), so the model always matches one point in the
story. Page chrome (captions, HUD, tint) uses the raw scroll position. Captions
are plain layout: each scene has a scroll band with a sticky caption faded by a
CSS `view()` timeline (`lib/cap-fades.ts` is the fallback).

**Lazy modules.** `fly`, `trails`, `petals`, `constellations`, `state`, `cost`
and `flow` in `story/` are loaded with `import()` only and never re-exported
from `index.ts` (`story-state.test.ts` enforces this). The same goes for
`animations.ts`, `materials/shading-bench.ts` and all of `dev/`.

## Directory map

```
index.ts               public API; the only import for pages
animations.ts          /lens animations and their sliders (lazy)
ops/                   the motion system
  algebra.ts           Algebra<S> and the plain-number backend
  ops.ts  gate.ts      the op library; per-piece timing windows
  house.ts             shared selectors and op chains
  recipes.ts           assemble / explode / peel / rose
  frames.ts            per-piece constants computed at load
  host.ts              connects ops to three: materials, channels, knobs
  cpu.ts               runs the emitted JS deform at a point
  mechanism.ts         zoom / focus / aperture / huddle transforms
  emit/                generates the WGSL / GLSL / JS deform (checked in)
story/
  story.ts             the story table, timing, caption bands
  envelopes.ts         channel values as functions of p
  hero-driver.ts       scroll driver; `?story` scrubber
  camera.ts            story camera path and framing
  peelcards internals fly trails constellations reveal petals cinematics
                       per-scene effects
  state cost flow      readers behind the generated docs (lazy)
optics/                sky, starfield and fly-through
  fly-core.ts          fly-through knobs, pose and fades
  prescription.ts      measured positions of the glass elements
  wormhole-post.ts     the fly-through's screen-space post effect
  sky.ts  starfield.ts  constellation-lines.ts  star-trails.ts
core/
  scene.ts             renderer, channels, per-frame tick, SceneHandle
  visibility.ts        sets every model piece's `.visible`; fade thresholds
  model.ts             GLB loading, materials, environment
  warm.ts              off-screen warm-up draws (shader compiles, uploads)
  body-fade.ts         save/restore for the body fade
  parts.ts  names.ts   what node names mean; their spellings
  theme.ts  transitions.ts  math.ts
materials/
  unified.ts           realistic + ink in one material, blended by uInk
  shading.ts           switches looks
  shading-bench.ts     the extra /lens looks (lazy)
  depthfade.ts         fades pieces near the camera's near/far limits
dev/                   dev tools, all lazily imported (some DEV builds only)
```

Generated, never hand-edited: `STORY-MAP.md` (camera and channels at every
scene boundary; byte-pinned by a test), `STORY-COST.md` (render workload at
the same points) and `PIECE-FLOW.md` (every piece's position through the
story). Regenerate all three with `npm run lens:regen`.

Tests (`vitest.config.ts`): `npm test` runs everything except `piece-flow` in
a few seconds; `npm run test:structural` runs `piece-flow` (every piece through
the real pipeline at every scene boundary); `npm run test:all` runs both.

## Dev tools

Stripped from production except the two `/lens` toggles, which load lazily.

- `/?story`: story scrubber (progress, scene, channel readout, scene jumps);
  `window.__lensStory.stateAt(p)`.
- `/lens` "Motion paths": draws sample pieces' paths; `window.__lensPaths`
  (`analyze` / `compare` / `interference` / `curlCorners`, JSON output).
- `/lens` "Inspect": hover or click a piece for its node name.
- `window.__lensStars` / `window.__lensWormhole` tune the sky and post effect
  live; `window.__lensPrescriptionProbe()` re-measures the glass elements.
- `?webgl` forces WebGL2, `?diag` shows backend and post state, `?mtrace`
  records one row per frame.

## Boundaries and load order

- In `ops/`, `algebra.ts`, `gate.ts`, `ops.ts`, `house.ts`, `recipes.ts` and
  `emit/` must not import three; `host.ts` is where the ops meet three.
- `optics/fly-core.ts` and `optics/prescription.ts` are the only `optics/`
  files allowed in the homepage's initial bundle.
- Model prep order: `deriveFrames` → `stampWinkLanes` → `tagMechanismSpins` →
  `cutInkEdges` (while the renderer starts), then `createUnified` →
  `createShading`. Each step reads what the previous ones wrote.

Related files outside this directory: `components/LensStory.astro` (the
homepage hero), `components/LensSceneContent.astro` (one scene's caption band),
`LensPin.astro`, `LensPreloads.astro`, `lib/cap-fades.ts`, `pages/lens.astro`
and `pages/index.astro`.
