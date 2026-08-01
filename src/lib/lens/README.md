# The lens viewer

An interactive 3D model of a Sigma 18-50mm F2.8 (three.js `three/webgpu` + TSL,
WebGL2 fallback), driven two ways:

- **`/lens`** — free-orbit viewer with sliders (zoom/focus/aperture/explode/peel),
  shading modes, accessories.
- **`/`** — the scroll-jacked story hero (pinned stage, scripted camera, captions).

Pages and components import **only from `index.ts`** (the public API). Everything
else in here is internal. The GLB comes from the `lens_work/` Blender pipeline —
**object names are the API**; never rename nodes in code.

> Vocabulary: **"bloom"** in this codebase means the radial explode / sticker-peel
> shell deformation (from the Blender plan's term), _not_ the glow post-effect.

## I want to change… → touch…

| Change                                                                       | File(s)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scene order, durations, camera poses/waypoints, stage tints, HUD titles      | `story/story.ts` — THE story table (`STORY`); beat structure derives from it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| What a scene _animates_ (mechanism envelope timing)                          | `story/hero-driver.ts` — the `pulse(...)` one-liners in `frame()`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| A scene's caption/overlay content                                            | `components/LensStory.astro` — `<LensSceneContent scene="…">` blocks (any markup), keyed by scene id                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| A scene-specific visual effect (e.g. the focus blur-rack)                    | CSS in the content block (`components/LensStory.astro`), reading the driver-set `--beat-local`/`--beat-progress`/`--beat-visibility` vars; the sweep window is `<LensSceneContent progressFrom/progressTo>`                                                                                                                                                                                                                                                                                                                                                                |
| Add/edit a tracked part annotation                                           | `components/LensStory.astro` — `<LensPin scene track="NodeName">` (solid nodes only; shader-deformed wedges anchor at their un-exploded spot)                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Camera transit math (splines, ortho flatten, view-offset park)               | `story/camera.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Rays, dust, glass isolate, sketch-in entrance, caps-on finale                | `story/cinematics.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Add a slider / mechanism channel                                             | `core/scene.ts` (`CHANNEL_DEFAULTS`) → `core/rig.ts` (consume in `RigDrive`) → `lens.astro` (slider row)                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Zoom/focus/aperture mechanics, the explode ladder (tier tables)              | `core/rig.ts` — constants follow `lens_work/lens_mechanism.md`; the explode ladder's tier ORDER + GROUPING is owner-approved art direction, distances derive from two REACH anchors                                                                                                                                                                                                                                                                                                                                                                                        |
| Explode/peel look (dilation, separation, stagger, swirl, curl radius)        | `materials/bloom.ts` — the `u*` knobs up top; `BLOOM_DILATION` is shared with the rig                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Add/compose a formation preset (helix / assemble) — ops, order, stagger/snap | `materials/formation.ts` — the op FACTORY library + PRESET table (each preset's uniforms live here, imported directly); bloom.ts folds every preset into the deform. The **assemble** channel drives TWO consumers off one timing law: the shader wedges (this preset) AND the rig's tier ladder (`core/rig` object-level axial flight) via the exported `assembleFlightState` — the JS mirror of the gate's flight phase, so glass/rings/mount/screw fly home in lock-step with the wedges (single law, two consumers, like the rewrap's shared `REWRAP_STAGGER/WINDOW`). |
| See the PATH a wedge takes / whether an op stretches the mesh                | `/lens` → "Motion paths" toggle → `dev/paths.ts` (overlay + drift checks) + `dev/path-probe.ts` (GPU readback of the real graph) + `dev/analysis.ts` (`window.__lensPaths` programmatic API — see "Authoring workflow"). Read-only: it drives the existing rig/uniforms and adds no math of its own                                                                                                                                                                                                                                                                        |
| Preview an animation under the hero's rewrap→caps-on camera                  | `/lens` → "Hero camera" toggle → `core/scene.ts` (`setStoryCamera`: the non-story tick runs the same sampleStory/applyStoryFraming path; the caps-on finale cinematic runs too) + the progress→storyP span mapping in `pages/lens.astro`                                                                                                                                                                                                                                                                                                                                   |
| Add a shading mode / change ink or blueprint colors                          | `materials/shading.ts` — technical looks are entries in `TECHNICAL_PALETTES`; uniform looks go in `makeUniform`; add the button in `lens.astro`                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Realistic-mode materials (rubber, chrome, brass, glass coating)              | `core/model.ts` — `lensMaterialFor`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Which meshes count as glass / decal / accessory / wedge                      | `core/parts.ts` — the ONE home for name classification (the sets differ on purpose; read the doc comments)                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Depth-fade dissolve planes                                                   | `materials/depthfade.ts` (graph) + `core/scene.ts` (per-frame placement)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Model/preload URLs                                                           | `core/model.ts` + `../../components/LensPreloads.astro`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Theme behavior                                                               | `core/theme.ts` (watcher); palettes live per-consumer: `materials/shading.ts` (ink/blueprint), `story/cinematics.ts` (dust/rays), the pages' CSS vars                                                                                                                                                                                                                                                                                                                                                                                                                      |

`STORY` is the single source of truth for story STRUCTURE only — beat order,
durations/ranges, track height, camera poses, stage tints, rail/titles. It
deliberately does NOT own mechanism envelope tuning, cinematic implementation,
authored Astro content, or content-specific visual effects (the `--beat-*` CSS
vars above) — those belong with their consumers; don't consolidate them into
the table.

## Authoring workflow

Tick **"Motion paths"** in the Animations
panel: it draws, for three representative wedges (inner / mid / outer shell
rank), the world-space track each point of a 5×3 sheet takes through the
selected animation — polylines coloured by EDGE STRETCH (green 1.0 = bending
without stretching, red = the mesh is being pulled apart), time-tick crosses
(bunched = slow), and the live deformed sheet grid in orange. Use it to judge
whether a formation op moves a piece smoothly and whether it deforms the mesh;
the panel's `peak stretch` is the number that caught a 3.7× op bug. Positions
are read back from the GPU running the real `bloomLocalPosition()` graph, not a
CPU mirror — see the header of `dev/paths.ts` for the two drift checks (`idle Δ`
and `live Δ`) that fail loudly when the drawn path stops describing the render.

While the toggle is on, the same instrument is QUERYABLE: `window.__lensPaths`
(the `PathViz` handle) exposes async methods that walk an animation over EVERY
moving piece — all ~bloom-carrying meshes via the GPU probe (outer + inner
wall grids + the four seam/far × front/rear corners), all non-bloom solids via
CPU-transformed rest samples (rigid ⇒ exact) — and return plain JSON, positions
in the model frame (optical axis = Y, mm):

- `analyze(animId, {timeline?})` — per piece: centroid + cylindrical timeline,
  min/max radius, peak edge stretch, total path length, seat p, and the
  REVERSAL structure of min-radius (each outward excursion's p + amplitude);
  plus per-shell-rank aggregates.
- `compare(idA, idB)` — same sample set through both walks: per-piece max/mean
  divergence at equal p (sorted) + per-rank radial envelope timelines.
- `interference(animId)` — adjacent-seat-rank pairs whose radial bands overlap
  while both pieces are >1mm off their seats AND their axial bands overlap,
  named, with p ranges; sorted by `maxExcessMm`, the overlap BEYOND the pair's
  seated nesting (nested-at-rest shells overlap by construction). Azimuthally
  disjoint pieces can still over-report — it is a band check, not a mesh
  intersection test.
- `curlCorners(idA?, idB?)` — per wedge/shell: which corner departs the seated
  surface LAST (= seats first = leads the stick), compared across two
  animations (defaults: `reassemble` vs `reassemble-ops`).

Every result carries `coverage` ({sampledMeshes, totalMovingMeshes, excluded})
and `idleCheck` (the per-mesh idle-identity check) — read them before the
numbers. Walks are never cached (param sliders retune uniforms live).

Open **`/?story`** for the dev scrubber: live `p` / scene / channel readout, a
slider that overrides scroll (park the story at any depth), per-scene jump
buttons, "follow scroll" to release. Iterate: jump to the scene → nudge the
`STORY` table in `story/story.ts` or the `pulse` windows in
`story/hero-driver.ts` → reload → jump back. Verifying end-to-end in-sandbox
(headless browser recipe): see `verify-SKILL.md` at the repo root.

## The wipe primitive

A feathered split line swept through the model (`materials/wipe.ts`): `uWipe`
(sweep 0 = line below the model → 1 = exited above), `uWipeSkew` (slope — the
field is y + skew·x, model mm), `uWipeFeather` (band half-width, mm), all
gated by `uWipeOn` (0/1). Selectors `uWipeExplode`/`uWipeUnwrap`/
`uWipeFormation` (0/1) pick which channels the mask multiplies — hooked in
bloom's `fields()` (formation is masked at the `buildFormations` output).
IDENTITY: at `uWipeOn` = 0 every factor is exactly 1 — idle checks and the
seated render are untouched. The matching backdrop split plane lives in
`story/cinematics.ts`, shown only while `uWipeOn`·`uWipeBackdrop`
(`setWipeBackdrop(on, colors?)`); palette-matched color pairs for the "ember"
and "paper" shading modes are `WIPE_BACKDROPS` (`materials/shading.ts`).

## Module boundaries

`core/scene.ts` deliberately imports the story camera + cinematics (`story/`)
and wires them even for the free-orbit `/lens` viewer, which bundles them
unused — ONE assembly path is simpler than injecting story pieces per caller.
Pages never see this: they import the barrel.

## Load-order contract (don't reorder)

`core/scene.ts` prepares the model as: `seatShellFeatures` → `assignShellRates`
→ `applyBloom` → `createShading`, after recentring. Each step feeds the next
(features need seating before they get bloom materials; shading captures the
bloom materials as "realistic").

## File index

```
index.ts               public API barrel — the only import surface for pages
story/
  story.ts             THE story table (STORY) + types + derived pacing
                       (TOTAL_HOLD, TRACK_HEIGHT_CSS, RANGES, rangeOf, pulse)
  camera.ts            sampleStory spline camera + applyStoryFraming
  hero-driver.ts       scroll driver: envelopes, captions, HUD/rail, ?story scrubber
  cinematics.ts        presentation extras layered on the scene (nothing mechanical)
materials/
  shading.ts           render-style swapper + TECHNICAL_PALETTES + ink edge lines
  bloom.ts             TSL explode / sticker-peel deformation (the big one)
  formation.ts         composable formation-op factory pipeline + PRESET table (helix + assemble)
  depthfade.ts         camera-relative dissolve for exploded pieces
core/
  scene.ts             orchestrator: renderer, state channels, tick, lifecycle
  model.ts             GLB loading, materials, environment, disposal
  rig.ts               mechanism drives (zoom/focus/aperture/explode ladder)
  parts.ts             node-name classification predicates
  theme.ts             site-theme watcher
  math.ts              clamp01 / smoothstep / lerp / band / deg
dev/                   DEV ONLY — dynamically imported by scene.enablePathViz(),
                       so none of it reaches a normal visitor's bundle
  paths.ts             motion-path overlay + its two drift checks (lazy-loaded)
  path-probe.ts        GPU readback of the real deform graph (no CPU mirror)
  analysis.ts          programmatic scene analysis (window.__lensPaths API):
                       analyze/compare/interference/curlCorners as JSON

```

Related, outside this dir: `components/LensStory.astro` (the hero — captions +
pins + boot script; the story TABLE lives in `story/story.ts`),
`components/LensSceneContent.astro` (scene overlay
slots), `components/LensPin.astro` (tracked annotations),
`components/LensPreloads.astro` (model+decoder preloads), `pages/lens.astro`,
`pages/index.astro` (renders `<LensStory />` + the below-hero sections).
