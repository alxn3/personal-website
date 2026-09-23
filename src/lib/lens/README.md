# The lens viewer

An interactive 3D model of a Sigma 18-50mm F2.8 (three.js `three/webgpu` + TSL,
WebGL2 fallback), driven two ways: **`/lens`**, the free-orbit viewer with
sliders, shading modes, the Animations bench and dev instruments, and **`/`**,
the scroll-driven story hero.

Pages and components import **only `index.ts`**. The GLB comes from the
`lens_work/` Blender pipeline — **object names are the API**; never rename nodes
in code. Standing design laws: `docs/lens-principles.md`.

## Architecture

**Channels.** `CHANNEL_REGISTRY` in `core/scene.ts` is the single list of
animatable scalars: four MECHANISM channels (`zoom`, `focus`, `aperture`,
`huddle`) driven by real transforms in `ops/mechanism.ts`, four RECIPE channels
(`explode`, `assemble`, `peel`, `rose`) driven into the shader by `ops/host.ts`,
and `story` for scroll progress. Adding a motion channel is a registry row plus
a recipe; the reset and idle-zero lists derive from the row's flags, and
`ops/__tests__/channel-registry.test.ts` pins registry against recipe table.

**Recipes.** `ops/` is the only motion system. A recipe (`ops/recipes.ts`) is
an ordered list of ops (`ops/ops.ts` — Orient / Transform / Modifier /
Selector, scoped with `group()` and `during()`), a `gateSpec` (`ops/gate.ts`,
the two-phase per-piece window) and knob defaults. Ops are written against
`Algebra<S>` (`ops/algebra.ts`), so one recipe runs on plain numbers (`NUM`,
behind every test in `ops/__tests__/`) and as generated source (`ops/emit/`
emits the deform as one function over uniforms laid out from the recipe table,
in WGSL, GLSL and JS; the JS module is what `ops/cpu.ts` runs at a point, for
rays and picking proxies, so CPU and shader are one text). Knob defaults and
the ranges the host clamps writes to are one row per knob in the recipe.

**Frames.** `ops/frames.ts` derives every per-piece constant the deform reads
(`_opA`/`_opB`/`_opY`: seat angle, radius, span, rank, layer phase, part class,
explode rung, axisymmetric flag, axial extent, radial depth, adopted flag) at
load. Only three lanes read the model contract — part class from
`core/parts.ts`'s regexes, the explode rung from the ladder anchored on
`Chassis_Fixed`, adoption from the `SHELL_ADOPT` table — so a re-cut model
needs no table edit while it keeps that contract. `dev/model-contract.ts`
reports (console.error) at boot when it breaks.

**Story.** `story/story.ts` holds `STORY`, ten scenes (hero, zoom, peel, cards,
internals, flythrough, constellations, trails, rewrap, capsOn) with durations,
camera poses, tints and titles; `TRACK_HEIGHT_CSS` and `CAPTION_BANDS` derive
from it. `story/envelopes.ts` is every channel envelope as a pure function of
`p`; `story/hero-driver.ts` calls them and writes the results, authoring none.
Windows register themselves where they are authored (`story.ts` `span` /
`pulseFn`), so `state.ts` reports every one by construction.

**One clock.** Story mode eases ONE value, `state.story`, toward the scroll
(`core/scene.ts` `easeStep`, frame-rate independent). Every 3D value is
evaluated at that eased `pE` in `tick()`'s evaluate step (`onEvaluate`):
channels written value-and-target, the orientation, fades, ink, the fly, and
the five time-based riders' gates. An envelope's plateau is where its value is
exact, so rests are exact. DOM chrome (`--beat-*`, HUD, tint) draws at the raw
scroll `p` in `frame()` — the captions' own clock. Per-scene behaviour lives in
its own rider module. `fly`, `trails`, `petals`, `constellations`, `state`,
`cost` and `flow` are LAZY: reached by `import()` only and never re-exported
from the barrel (`story-state.test.ts` pins the chunk law for all seven, over
every static import form under `src/`). Caption visibility
is layout: each scene renders a scroll-space band with a `position: sticky`
caption faded by a CSS `view()` timeline; `lib/cap-fades.ts` is the
IntersectionObserver fallback.

## Directory map

```
index.ts               public API barrel — the only import surface for pages
animations.ts          canned /lens progress-slider animations (LAZY), over
animation-kit.ts       the LensAnimation contract + slider↔uniform params
ops/                   THE motion system
  algebra.ts           Algebra<S> vocabulary + the NUM backend
  ops.ts               op library + runPipeline;  gate.ts  the piece window
  house.ts             shared selectors, the sticker-peel chain, memoCtx
  recipes.ts           the four recipes: assemble / explode / peel / rose
  frames.ts            load-time derivation of every `_op*` per-piece constant
  host.ts              where ops meet three: attach, channels, knobs, normals
  cpu.ts               the emitted JS deform at an arbitrary point
  mechanism.ts         real mechanical drives (zoom/focus/aperture/huddle)
  emit/                the source backend (checked-in .wgsl/.glsl/.js output)
story/
  story.ts             THE story table + derived pacing, track, caption bands
  envelopes.ts         the driver's envelopes as pure functions of p
  hero-driver.ts       scroll driver: writes envelopes, chrome, pins, ?story
  camera.ts            the story camera: spline sampling + framing
  peelcards / internals / fly / trails / constellations / reveal / petals /
  cinematics           per-scene behaviour
  state / cost / flow  the readers behind the generated docs (LAZY)
optics/                the sky and the dive's own math/engines
  fly-core.ts          FLY knobs + flyPose + travel remap + passage fades
  prescription.ts      the measured element spans the dive flies through
  wormhole-post.ts     screen-space pinch / ring fold / chromatic aberration
  sky.ts  starfield.ts  constellation-lines.ts  star-trails.ts
core/
  scene.ts             orchestrator: renderer, CHANNEL_REGISTRY, tick, lifecycle
  visibility.ts        the one writer of every model `.visible` flag
  model.ts             GLB loading, materials, environment
  warm.ts              the dry-frame queue: one warm step per tick, never a
                       second pass draw;  body-fade.ts  the fade's capture law
  parts.ts             node-name classification;  names.ts  the vocabulary
  theme.ts  transitions.ts  math.ts
materials/
  unified.ts           the story's PBR↔ink pair on one material (uInk)
  shading.ts           the look swapper + roster + the bench's socket, over
  shading-bench.ts     LAZY, /lens only — the technical looks
  depthfade.ts         camera-relative dissolve for exploded pieces
dev/                   all dynamically imported — the motion-path overlay + GPU
                       probe + JSON analysis and the piece inspector with its
                       CPU proxies ship as lazy /lens chunks; the boot contract
                       tripwire, the prescription probe, ?diag and ?mtrace are
                       DEV only
```

Generated, never hand-edited: `STORY-MAP.md` (pose, channels and open windows
at every scene edge — byte-pinned, the at-rest identity proof), `STORY-COST.md`
(renderer workload at the same edges) and `PIECE-FLOW.md` (every piece's pose
in bore-cylindrical coordinates) — on-demand instruments whose tests check
shape and coverage, not bytes. Regenerate all three with `npm run lens:regen`.

Two test tiers (`vitest.config.ts`): `npm test` runs everything but
`piece-flow` in seconds — the seam and exclusion laws, the driver's evaluate
step and the riders' liveness against a recording scene
(`story/__tests__/fake-scene.ts`), and the GLB readers (`story-ending`,
`story-cost`, `story-portrait`); `npm run test:structural` runs `piece-flow`,
every piece through the real pipeline at every story edge — what a structural
wave runs before review. `npm run test:all` runs both.

## Dev surfaces

`import.meta.env.DEV`-stripped from production, except the two `/lens` toggles
below, which ship as lazy chunks fetched only when ticked. `/?story` opens the
story scrubber (live `p` / scene / channel readout, a slider that overrides
scroll, per-scene jumps) and exposes `window.__lensStory.stateAt(p)`. On
`/lens`, "Motion paths" draws representative wedges' world-space tracks
coloured by edge stretch and exposes `window.__lensPaths` (`analyze` /
`compare` / `interference` / `curlCorners`, all JSON); "Inspect" gives
hover/click node names off CPU-re-evaluated picking proxies — both ship on
`/lens`. `window.__lensStars` / `window.__lensWormhole` retune sky and post
live; `window.__lensPrescriptionProbe()` re-measures the optical table.
`?webgl` forces the WebGL fallback, `?diag` overlays backend and post state,
`?mtrace` records one row per frame.

## Boundaries and load order

`ops/` is backend-agnostic below `host.ts`: `algebra.ts`, `gate.ts`, `ops.ts`,
`house.ts`, `recipes.ts` and `emit/` must not import three. `frames.ts` may (it
runs on the CPU at load); `host.ts` is the only place the pipeline meets three.
`core/scene.ts` imports the story camera and cinematics and wires them even for
`/lens`. Anything `/lens`-only and heavy (`animations.ts`,
`materials/shading-bench.ts`, all of `dev/`) goes behind a dynamic import
rather than into the barrel. `optics/fly-core.ts` and `optics/prescription.ts`
are the only `optics/` files allowed in the homepage's initial chunk.

Model preparation runs `deriveFrames` → `tagMechanismSpins` → `cutInkEdges`
before the renderer is ready, then `createUnified` → `createShading` once it
is. The order is load-bearing: the deform graph reads the `_op*` attributes
`deriveFrames` stamps, a spin tag arriving after the materials does nothing,
and the bench swapper is handed the merged look it forwards "realistic"/"ink"
to.

Related, outside this directory: `components/LensStory.astro` (the hero —
pinned stage, caption content, fades, pins, boot), `components/LensSceneContent.astro`
(one scene's band and its sticky slot), `LensPin.astro`, `LensPreloads.astro`,
`lib/cap-fades.ts`, `pages/lens.astro` and `pages/index.astro`.
