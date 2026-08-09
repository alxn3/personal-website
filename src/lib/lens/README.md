# The lens viewer

An interactive 3D model of a Sigma 18-50mm F2.8 (three.js `three/webgpu` + TSL,
WebGL2 fallback), driven two ways:

- **`/lens`** — free-orbit viewer with four sliders (zoom/focus/aperture/explode),
  shading modes, accessories, animations and demo compositions.
- **`/`** — the scroll-jacked story hero (pinned stage, scripted camera, captions).

Pages and components import **only from `index.ts`** (the public API). Everything
else in here is internal. The GLB comes from the `lens_work/` Blender pipeline —
**object names are the API**; never rename nodes in code.

Two laws govern the whole module. Break either and the seated render stops being
bit-exact, which is how every regression here has announced itself:

> **The one-registry channel law.** `CHANNEL_REGISTRY` in `core/scene.ts` is the
> single list of channels. A MOTION channel is its op recipe's channel uniform,
> one-for-one — there is no second, JS-side ladder moving the same pieces. The
> page's rest-on-None list and the instrument's idle-zero list DERIVE from the
> registry's flags; no hand-kept parallel lists exist anywhere.

> **The derived-frames law.** No per-piece constant is hand-tabulated per piece.
> All twelve the deform reads (the packed `_op*` attributes: seat angle, radius,
> span, rank — `_opA`; layer phase, part class, explode rung, axisymmetric
> flag — `_opB`; axial extent yMin/yMax, layer count, adopted flag — `_opY`) are
> DERIVED by `ops/frames.ts` at load, under a MODEL CONTRACT of naming,
> hierarchy and geometry heuristics. Nine lanes are pure geometry; three read the contract — part class from the name regexes in
> `core/parts.ts`, explode rung from the ladder anchored on the NAMED
> `Chassis_Fixed` node, adopted partly from the authored `SHELL_ADOPT` table. So
> a re-cut model needs no table edit as long as it keeps the contract — and
> `dev/model-contract.ts` fails loudly at boot if a mesh comes out without a
> frame.

## I want to change… → touch…

| Change                                                                     | File(s)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Scene order, durations, camera poses/waypoints, stage tints, HUD titles    | `story/story.ts` — THE story table (`STORY`, ten scenes today: hero, zoom, peel, cards, internals, flythrough, constellations, trails, rewrap, capsOn); beat structure derives from it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| What a scene _animates_ (channel envelope timing)                          | `story/hero-driver.ts` — the `pulse(...)` one-liners in `frame()`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| A scene's caption/overlay content                                          | `components/LensStory.astro` — `<LensSceneContent scene="…">` blocks (any markup), keyed by scene id                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| WHEN a caption appears / how long it holds                                 | nothing to author — `story/story.ts` DERIVES it (`CAPTION_BANDS`: each scene's range padded by `CAPTION_PAD`, the last band running to the end of the track). A band IS the caption's slice of the scroll track and the caption is `position: sticky` inside it, so visibility is LAYOUT: no JS, no driver, right while the model is still downloading. A band is measured in SCROLL space (`a · (100% − 100dvh)` down the track, `(b − a) · (100% − 100dvh) + 100dvh` tall) because `p = scrollY / (track − viewport)` and the trailing viewport is the sticky caption's pin room — plain track percentages put a band `p · 100dvh` late. `components/LensSceneContent.astro` renders a scene's band and owns the pinned slot it sticks to; `components/LensStory.astro` owns the fades (a `view()` timeline per band, one `--cap-fade`-long window at each band edge, so a caption is lit over exactly its scene and cross-dissolves with its neighbour over the shared pad) and hand-authors the hero intro's band off the same `bandOf`; `lib/cap-fades.ts` is the IntersectionObserver fallback for browsers without `animation-timeline: view()` |
| A scene-specific visual effect (CSS driven by the scene's own progress)    | CSS in the content block (`components/LensStory.astro` — the `<LensSceneContent scene="…">` caption blocks), reading the driver-set `--beat-local`/`--beat-progress` vars (and `--beat-visibility`, the story table's own fade band for the block — `LensPin`'s opacity rides it; the captions do NOT); the sweep window is `<LensSceneContent progressFrom/progressTo>`. These are enhancement only: the block is placed and faded without them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Add/edit a tracked part annotation                                         | `components/LensStory.astro` — `<LensPin scene track="NodeName">` (solid nodes only; shader-deformed wedges anchor at their un-exploded spot). CURRENTLY UNUSED: no pins have been mounted since the story-rework skeleton; `LensPin.astro` is kept for reuse                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Camera transit math (splines, ortho flatten, view-offset park)             | `story/camera.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Rays, dust, sketch-in entrance, caps-on finale                             | `story/cinematics.ts` — presentation only; the caps are ACCESSORIES it owns outright, and it writes no other model `.visible` flag. `core/scene.ts`'s `applyVisibility` is the ONE writer of those (demo isolate + glass gates + the body-fade and shell tails + accessory choice, composed: visible iff every active gate allows it)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| The peel and the card field (unroll, outward drift, the eight cards)       | `story/peelcards.ts` — ONE module because it is one gesture, on TWO clocks: scroll owns the `peel` channel and the per-piece `setPartOffset` drift (the shell strips, the two inner tubes and the baffles that follow them out), time owns the cards' orbit and opacity. All three casts fan on `ops/house` `peelOrder`, the same meridian key the recipe staggers its unroll on. The unroll's SHAPE is not here but in the `peel` recipe (`ops/recipes.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| The internals scene's ambient (the focus rack, the iris breathing)         | `story/internals.ts` — TIME, not scroll, off an accumulated dt; the ONLY writer of focus/aperture inside its range (hero-driver gates its own writes out of the span) and it hands the iris to the dive already closing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| The dive, on the scroll (glass, room light, wormhole, sky arrival, pose)   | `story/fly.ts` — the demo's laws transcribed over the SAME knobs (`optics/fly-core.ts`); it owns the span from `flythrough` through `trails` and hands the camera back at `rewrap`. LAZY: reachable only through hero-driver's `import()`, never re-exported from `index.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Sky ink — the strokes, the star names, the quote                           | `story/constellations.ts` (WHAT is drawn and when, plus the type: `SKY_TYPE_LOOK`, the per-theme ink alphas, `QUOTE_ATTR_INK`) + `optics/constellation-lines.ts` (the self-drawing stroke engine — one ring-buffer draw call, forever). Colours are `optics/sky.ts`'s `SKY_INK`, per theme                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| The turn home — the long exposure (sky spin, star arcs)                    | `story/trails.ts` — ONE θ handed to `uSkySpin` and `setSweep` every frame, so an arc's head is by construction at its disc — over `optics/star-trails.ts` (the arcs). Lazy, on `story/fly.ts`'s terms                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| The crown — the arc that becomes the lens                                  | `optics/crown-arc.ts` (an AUTHORED screen-space circle segment, its own mesh and its own draw — not a trail) driven by `story/trails.ts`: it resolves out of the field late in `trails`, parks on the front element's landing circle, then tracks the element's DRAWN disc (`SceneHandle.projectDrawn`) and fades out on it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Taking the shell off / putting it back                                     | `core/parts.ts` `isShellPart` (the cast: barrel sections, name band, grips, printed markings), `isPeelTube` (the two closed tubes under the skin — `Chassis_Fixed`, `Cam_Barrel` — without which the card scene still looks at a solid cylinder) and `isPeelExtra` (the internal baffles, which leave LAST so the bore opens behind everything) + `core/scene.ts` `setShellFade` (four bands, outside-in: markings, wedges, tubes, baffles) (a per-mesh visibility THRESHOLD, so the shell leaves piece by piece and no shading swap can stomp it); the hero drives it as ONE scroll envelope in `story/hero-driver.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Where sky ink hangs / how far the sky fades into the stage                 | `core/scene.ts` — `starfieldAttach` (the camera-centred starfield group; everything drawn on the sky rides it and inherits the re-centring) + `setSkyDim` (the sky's fade toward a stage tint, which is how the sky hands off to the rewrap)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Add a slider / channel                                                     | `core/scene.ts` (`CHANNEL_REGISTRY` — ONE row: `default` + optional `animReset`/`idleZero` flags) → a MOTION channel needs its recipe in `ops/recipes.ts` (the host drives it straight through `recipeChannel`); a MECHANISM channel is consumed in `ops/mechanism.ts` (bespoke mechanical code, not a table) → `lens.astro` (slider row). The derived lists (`CHANNEL_DEFAULTS` / `ANIM_RESET_CHANNELS` / `IDLE_ZERO_CHANNELS`) mean no other file needs an edit: `driveChannels()` in `core/scene.ts` bridges registry → uniform by LOOPING `ops/host`'s `RECIPE_NAMES` (`recipeChannel(name).value = clamp01(state[name])`), so a motion channel is driven the moment its recipe exists. Only the mechanism trio stays hand-written there, because its three reads share one ease. `ops/__tests__/channel-registry.test.ts` pins the registry, the recipe table and `RECIPE_NAMES` against each other in both directions, so a missing row shows up as a failing test, not a dead slider                                                                                                                                                            |
| Zoom/focus/aperture mechanics                                              | `ops/mechanism.ts` — the measured `MECHANISM` table + real-transform driver; constants follow `lens_work/lens_mechanism.md`. `MECHANISM_PARTS` (every node it drives by name) feeds the model-contract tripwire. A node spun about an OFF-AXIS pivot (only the focus lead screw) must also be tagged by `tagMechanismSpins` — called from `core/scene.ts`'s `prepareModelMaterials` BEFORE the materials are built — so `ops/host.ts` un-spins its op delta and it spins in place when exploded instead of orbiting its seat                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| The explode ladder (which piece travels how far)                           | nothing to author — `ops/frames.ts` DERIVES it (`ladderRungs`: rear/front split at the `Chassis_Fixed` anchor, ordered outward, stepped to two reach anchors). Art-direct a disagreement through `deriveFrames`'s `overrides.tierOrder` / `overrides.anchorY`; the throw itself is the explode recipe's knobs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Explode/peel/reassembly look (throw, separation, stagger, swirl, curl)     | `ops/recipes.ts` — each recipe's `knobDefaults` (physical units); live values go through `ops/host.ts` `recipeKnob`, which clamps the gate-feeding ones (`KNOB_LIMITS`). The reassembly's SHAPE is not a knob but the wrap's op chain itself (`rot` → `anchor` → three `arc`s, off `wrapTerms`) — change the chain and you change the peel                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| A recipe's per-piece timing (who flies when, the stick/tape-down split)    | the recipe's `gateSpec(knobs)` in `ops/recipes.ts`; the two-phase window law itself is `ops/gate.ts`. To give ONE PART of a recipe its own window, wrap it in `during({ from, to, ease }, [...])` (`ops/ops.ts`) — it narrows the CHANNEL the subtree's gate reads, so the scope is seated below `from`, complete above `to`, and the per-piece stagger replays inside. It cannot reverse or ping-pong (monotone, m(0) = 0): non-monotone time art belongs to the driver's channel envelope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Add/compose a motion (helix / assemble / rollout / bend / explode)         | `ops/ops.ts` (the four op classes — Orient / Transform / Modifier / Selector — plus the two scoping forms, `group([...])` for weight and `during(progress, [...])` for weight AND a sub-window of the channel) + `ops/recipes.ts` (a recipe IS its ordered op list plus a `gateSpec`); `ops/host.ts` folds the active recipes into the deform graph. ONE law per channel: the same pipeline moves wedges, glass, rings and hardware                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Aim a motion / re-anchor a bend                                            | `rot(rad)` in `ops/ops.ts` — the DIRECTION class. It turns the working aim (`v.aim` / `f.orient`, seeded to the piece's own meridian `ctx.t0`) and moves nothing; every op that needs "which way" reads it from there. `spread` after `rot(halfSpan)` throws down the seam; `rot(...)` before `anchor()` is where a bend chain starts and which way it walks. The aim THREADS FORWARD out of a group like all state — the inverse is one explicit `rot(−a)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Prototype a new motion                                                     | edit the `scratch` recipe in `ops/recipes.ts` (HMR reloads on save); its bench animation exposes the knobs (`animations.ts`, "Scratch")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Add a scalar primitive an op needs (a new `sin`, `pow`, `step`…)           | `ops/algebra.ts` (the `Algebra<S>` interface + the `NUM` backend) AND `ops/algebra-tsl.ts` (the shader backend) — both, or the op only runs on one side                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| How a `_op*` frame value is measured (span, rank, adoption, part class)    | `ops/frames.ts` — plus the adoption pass (`adoptJobs`): authored `SHELL_ADOPT` for hardware bolted to a shell, DERIVED hosts for printed markings (nearest ancestor owning `_SegN` wedges) — data, not re-parenting                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Where the deform meets three (materials, edge lines, normals, knob clamps) | `ops/host.ts` — the ONE attach surface: `attachOps` / `attachOpsLine` / `attachOpsHull`, `opsEdgeGeometry`, `recipeChannel` / `recipeKnob`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| A canned animation on the /lens progress slider                            | `animations.ts` (`ANIMATIONS` — one entry) or `explore/*-anims.ts` for the exploration families; the contract + slider↔uniform param table is `animation-kit.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| A demo composition (camera choreo + animation + page wipe + palette)       | `explore/demos.ts`, on the ergonomics layer in `explore/scene-kit.ts` (auto-restore, channel brackets); page-owned layers are `explore/page-wipe.ts` + `explore/page-text.ts`, screen-space extras `explore/prism-light.ts` / `explore/ray-ribbons.ts` over `explore/overlay.ts`, timelines/easings `explore/motion.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| A look-swap transition (the gesture a shading change plays)                | `core/transitions.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| See the PATH a wedge takes / whether an op stretches the mesh              | `/lens` → "Motion paths" toggle → `dev/paths.ts` (overlay + drift checks) + `dev/path-probe.ts` (GPU readback of the real graph) + `dev/analysis.ts` (`window.__lensPaths` programmatic API — see "Authoring workflow"). Read-only: it drives the existing channels/uniforms and adds no math of its own                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Look up the NODE NAME of a piece on screen                                 | `/lens` → "Inspect" toggle → `dev/inspect.ts` (hover tooltip = hit mesh + its top-level part, plus a terracotta wash over the piece; click copies). Raycasts PICKING PROXIES whose vertices `dev/ops-cpu.ts` re-evaluates on the CPU at the live channel/knob values, so an exploded piece is picked where it is DRAWN — and the wash re-draws that same proxy, so no model material is ever touched. Rebuilt lazily, ~200ms after the op state settles                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Preview an animation under the hero's rewrap→caps-on camera                | `/lens` → "Hero camera" toggle → `core/scene.ts` (`setStoryCamera`: the non-story tick runs the same sampleStory/applyStoryFraming path; the caps-on finale cinematic runs too) + the progress→storyP span mapping in `pages/lens.astro`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Add a shading mode / change ink or blueprint colors                        | `materials/shading.ts` — technical looks are entries in `TECHNICAL_PALETTES`; uniform looks go in `makeUniform`; add the button in `lens.astro`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Realistic-mode materials (rubber, chrome, brass, glass coating)            | `core/model.ts` — `lensMaterialFor`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Which meshes count as glass / decal / accessory / wedge                    | `core/parts.ts` — the ONE home for name classification (the sets differ on purpose; read the doc comments)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Depth-fade dissolve planes                                                 | `materials/depthfade.ts` (graph) + `core/scene.ts` (per-frame placement)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Fly-through pacing, camera, passage fades, darkness, sky arrival           | `optics/fly-core.ts` — the `FLY` knob table + `flyPose` + `travelRemap`, the ONE set of knobs both the `/lens` demo (`explore/demos.ts`) and the story span (`story/fly.ts`) read; see "The fly-through scene" below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Star catalog (authored constellations, background density, palettes)       | `optics/sky.ts` — 82 authored rows (never perturb; constellations index into them) + `BACKGROUND_LOOK` seeded field (deterministic LCG; count/seed/mag knobs)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Star look (disc size, streaks, Einstein-ring arcs)                         | `optics/starfield.ts` — `STARFIELD_LOOK` + uniforms; live via `window.__lensStars`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Wormhole distortion, ring fold/smear, chromatic aberration, edge safety    | `optics/wormhole-post.ts` — `RING_LOOK` / `CA_LOOK` / `EDGE_FADE`; live via `window.__lensWormhole`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Glass during the dive (transmissive clones, detint, per-element fades)     | `core/scene.ts` — `enableGlassTransmissive` (+ `GLASS_DETINT`), `setGlassElementFade`, `setRoomLight`; the demo drives them from `FLY` spans                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Model/preload URLs                                                         | `core/model.ts` + `../../components/LensPreloads.astro`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Theme behavior                                                             | `core/theme.ts` (watcher); palettes live per-consumer: `materials/shading.ts` (ink/blueprint), `story/cinematics.ts` (dust/rays), the pages' CSS vars                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

`STORY` is the single source of truth for story STRUCTURE only — beat order,
durations/ranges, track height, caption bands, camera poses, stage tints,
rail/titles. It deliberately does NOT own channel envelope tuning, cinematic
implementation, authored Astro content, or content-specific visual effects (the
`--beat-*` CSS vars above) — those belong with their consumers; don't
consolidate them into the table.

## Authoring workflow

Tick **"Motion paths"** in the Animations
panel: it draws, for three representative wedges (inner / mid / outer shell
rank), the world-space track each point of a 5×3 sheet takes through the
selected animation — polylines coloured by EDGE STRETCH (green 1.0 = bending
without stretching, red = the mesh is being pulled apart), time-tick crosses
(bunched = slow), and the live deformed sheet grid in orange. Use it to judge
whether an op moves a piece smoothly and whether it deforms the mesh; the
panel's `peak stretch` is the number that caught a 3.7× op bug. Positions are
read back from the GPU running the real `opsLocalPosition()` graph, not a CPU
mirror — see the header of `dev/paths.ts` for the two drift checks (`idle Δ`
and `live Δ`) that fail loudly when the drawn path stops describing the render.

While the toggle is on, the same instrument is QUERYABLE: `window.__lensPaths`
(the `PathViz` handle) exposes async methods that walk an animation over EVERY
moving piece — every FRAMED mesh via the GPU probe (outer + inner wall grids +
the four seam/far × front/rear corners), any unframed solid via CPU-transformed
rest samples (rigid ⇒ exact; under the op host that population is normally
empty) — and return plain JSON, positions in the model frame (optical axis = Y,
mm):

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
  animations (defaults: `assemble` vs `rollout`).

Every result carries `coverage` ({sampledMeshes, totalMovingMeshes, excluded})
and `idleCheck` (the per-mesh idle-identity check) — read them before the
numbers. Walks are never cached (param sliders retune uniforms live).

The op algebra runs on plain numbers too (`NUM` in `ops/algebra.ts`), so every
op, gate and recipe has an executable spec under `ops/__tests__/` — check a
motion question there before reaching for the browser.

Open **`/?story`** for the dev scrubber: live `p` / scene / channel readout, a
slider that overrides scroll (park the story at any depth), per-scene jump
buttons, "follow scroll" to release. Iterate: jump to the scene → nudge the
`STORY` table in `story/story.ts` or the `pulse` windows in
`story/hero-driver.ts` → reload → jump back. Verifying end-to-end in-sandbox
(headless browser recipe): see `verify-SKILL.md` in the WORKSPACE directory one
level above this git root (`../verify-SKILL.md` from the repo root — it sits
next to `lens_work/`, not in the site repo).

## The fly-through scene (Demos → "Fly-through")

The dive: camera enters the lens at the bayonet mount, flies rear→front down
the optical axis (world +X, one heading, zero rotation), passes every element,
and exits into open starfield with "The Keyhole" constellation on axis. It is
the prototype for the story's lens→sky transition; the story's next scene has
NO lens, so the demo ends on pure sky. Doctrine (owner): **performance over
precision** — the site must run on all devices; effects are geometry and
screen-space passes, never per-pixel physics.

### The frame pipeline

Each tick, in order:

1. **Pose** — `flyPose` (`optics/fly-core.ts`): a `posePath` over `targetX`
   (travel-by-moving-target; camera X ≈ targetX − distIn). `travelRemap(p,
FLY.pInside, FLY.insideRate)` compresses the in-glass stretch about its own
   midpoint (insideRate 1 = the old linear dive, bit-recoverable). Elevation and
   fov are FLAT through the flight; fov is held from `pClear` to 1 — a late fov
   ramp reads as zooming into the stars (owner-rejected, twice: it was the
   "still zooming after we're through" bug).
2. **Scene channels** (all kit-recorded, auto-restored on exit):
   `setRoomLight` ramps IBL + studio lights to `FLY.darkFloor` over `pDark`
   (dark tube; stars carry the light — the sky/backdrop is deliberately NOT
   dimmed); `setGlassElementFade` runs the passage fades (below);
   `uStarMix` fades the stars in over `pSkyIn` (nothing before the dive).
3. **Starfield** — `optics/starfield.ts`: ~300 stars from `optics/sky.ts`'s
   catalog as ONE merged quad-soup draw (+1 for constellation strokes), sphere
   re-centred on the camera every frame (camera translation cannot magnify
   stars — only fov can). Discs are analytic circles in the fragment shader:
   round at any size, radius = `starRhoRad · magnitude-scale · uStarSize`.
   Streaks = per-quad elongation toward the throat (`uStarStreak`); ring-band
   stars (angular band about the exit axis, baked per-star into an `aRing`
   attribute) swing tangential instead (`uStarRing`) — the Einstein ring's
   speckle half.
4. **Glass** — 13 transmissive clones (`enableGlassTransmissive`), fully
   colorless via `GLASS_DETINT` (the tint was iridescence + green specular in
   the shipped material; Fresnel reflections survive, they're ior-driven).
   Refraction of the stars comes from three's transmission (framebuffer-copy
   sampling), NOT from any traced physics.
5. **Wormhole post** — `optics/wormhole-post.ts`, mounted only during this
   demo, warm-rendered at construction (the pipeline compiles before p moves —
   otherwise the filter pops on a beat late). Screen-space radial pinch about
   the throat (= the vanishing point of +X, computed per frame), plus the ring
   fold + tangential smear, plus chromatic aberration (R/G/B sampled at
   k·(1∓caShift)). 10 texture reads total.

### Laws (each one was paid for)

- **Transmission sees only the opaque pass.** three r185 copies the framebuffer
  when the first transmissive object draws; anything in the transparent list
  renders after and is INVISIBLE through glass. The starfield therefore rides
  the opaque list with `transparent: false` + `CustomBlending` (blending is
  applied regardless of the transparent flag; `isOpaque()` only forces
  alpha = 1 under NormalBlending) + `depthWrite false` +
  `blendSrcAlpha One` (a soft rim through the default alpha blend punches a
  hole in the canvas). A suite test transcribes three's own predicate — if an
  edit would drop the stars out of the transmission copy, the test fails.
- **The camera must never be inside visible glass.** Screen-space transmission
  from inside an element explodes the refraction offset ("everything goes
  small") and its separable dual-blur smears an axis-aligned cross. Hence the
  per-element passage fades: each element fades out finishing `passageLead`
  world units BEFORE the near plane reaches its rearmost point (extents
  measured from mesh bounding boxes at enter(), `worldAxialSpans`;
  `passageLead` must exceed the 0.1 near plane — tripwired in tests).
- **`uWormhole = 0` is a bit-exact passthrough.** Every distortion term is
  offset-form (`uv + d·k` with k exactly 0 at rest) and every ring/CA term
  rides k or `mix(base, extra, mask·uWormhole)` — never "×1.0" round trips.
  Goldens must never be taken through the post pass (HalfFloat RT).
- **Edge safety = circular shape × rectangular window.** The pinch profile is
  the aspect-corrected circle (corner-pinned); a separate border window (ρ =
  fraction of the way to the frame border along the pixel's own ray, `EDGE_FADE`)
  fades ALL displacement to zero on the border. History: circle-only smeared
  clamped bands on the short-dimension edges at wide aspects; rectangle-only
  made the funnel bulge into a four-leaf clover. Ring taps additionally clamp
  via `keepInFrame` (they leave the pixel's ray, so the window alone can't
  vouch for them).
- **WebKit-on-Metal caps shader private memory at 8KB** (macOS + iOS Safari).
  Big TSL graphs must LOOP or stay small; the old unrolled trace died at
  9,548 bytes. The current shaders are tiny; keep tap counts bounded.
- **`THREE.Points` are 1px on WebGPU** (PointsNodeMaterial.size is ignored) —
  "point sprites" here means quads, always.
- **Theme flips re-seat materials from the load-time original map.** Anything
  stateful on the transmissive clones (detint, fade levels, glint scaling) must
  be applied wherever clones are (re)created, or a mid-dive theme flip restores
  the stock look. `GLASS_DETINT` is the pattern to copy.
- **Deterministic sky.** The background field is a seeded LCG
  (`BACKGROUND_LOOK.seed`); no `Math.random` in render paths. The 82 authored
  stars are byte-stable and FIRST in the array — constellations index into that
  prefix (`AUTHORED_COUNT` tripwired).

### Dev surface

- `?tracesky` — the legacy per-pixel refraction trace (`optics/warp.ts` +
  `optics/sky.ts` equirect bake, loop-built for the 8KB law). Kept as an A/B
  reference; the bake only runs on this branch. `?webgl` forces the WebGL
  fallback; `?diag` overlays backend/warp/post state.
- `window.__lensStars` — `.set({size, streak})`, `.look` (STARFIELD_LOOK
  mutable; re-select the demo to re-bake per-star attributes), `.reset()`.
- `window.__lensWormhole` — `.set({ringRadius, ringWidth, foldGain, smearArc,
smearMix, caShift})` live, `.reset()`.
- `/lens` persists the selected demo in localStorage `lens-demo` — clear it
  before automated checks or the bench auto-resumes mid-demo.

### Test map

`optics/__tests__/`: trace goldens + laws (legacy path — untouched by sprite
work, never regenerate silently), `sky.test` (catalog determinism, authored
byte-stability, seam/guard rules), `starfield.test` (opaque-pass material
contract, streak tangents, ring band mask, packing).
`explore/__tests__/flythrough.test.ts`: travelRemap identity/monotonicity,
passage-fade windows ("gone before the near plane", rear→front order), fov
held over `[pClear, 1]`, ramp overlap invariants. Suite baseline at this
writing: 33 files / 390 tests.

### Story integration

Built: the dive runs on the scroll as `story/fly.ts` (the demo's laws
transcribed over the shared `optics/fly-core.ts` knobs), the sky carries its own
ink and typography (`story/constellations.ts`), and the exposure turns and
writes before the shell comes home (`story/trails.ts`). The demo stays the bench
copy — when a number disagrees, the demo is right. Still open: the owner's
storyboard for overall flow.

## Module boundaries

`core/scene.ts` deliberately imports the story camera + cinematics (`story/`)
and wires them even for the free-orbit `/lens` viewer, which bundles them
unused — ONE assembly path is simpler than injecting story pieces per caller.
Pages never see this: they import the barrel.

`explore/` is `/lens`-only, but only PART of it is lazy. The barrel's
`loadDemos()` is a dynamic import, which is what keeps `explore/demos.ts` — and
through it anime.js (`explore/motion.ts`), `explore/scene-kit.ts` and the
overlay/ribbon extras — out of the shared chunk the homepage hero loads. Two
files are exported STATICALLY on purpose, because the page itself needs them
before any demo is picked: `explore/page-wipe.ts` and `explore/page-text.ts`
(the page-owned layers). Both are small and three-free; anything that pulls
anime.js or three overlays belongs behind `loadDemos()`.

The animation FAMILIES (`choreo-anims.ts`, `formation-anims.ts`,
`bend-anims.ts`) sit next to `animations.ts`, not under `explore/`: `ANIMATIONS`
re-exports them statically, so they ship in the shared chunk the hero loads and
are not `/lens`-only in any bundling sense.

`ops/` is backend-agnostic below `host.ts`: `algebra.ts`, `gate.ts`, `ops.ts`,
`house.ts` and `recipes.ts` must not import three. `frames.ts` may (it runs on the CPU at
load); `host.ts` is where the pipeline meets three, and it is the only place
that does.

## Load-order contract (don't reorder)

`core/scene.ts` prepares the model as: `deriveFrames` → `setActiveRecipes` →
`applyOps` → `createShading`, after recentring. Each step feeds the next: the
deform graph reads the `_op*` attributes `deriveFrames` stamps, a recipe not
selected before `applyOps` is not folded into the baked graph at all, and
shading captures the freshly-applied op materials as "realistic".

## File index

```
index.ts               public API barrel — the only import surface for pages
animations.ts          canned /lens progress-slider animations (ANIMATIONS)
animation-kit.ts       LensAnimation contract + drive() + slider↔uniform params
choreo-anims.ts        choreography family      bend-anims.ts   fold-chain bench
formation-anims.ts     reassembly-gesture family
ops/                   THE motion system — one pipeline, every moving piece
  algebra.ts           Algebra<S> vocabulary + NUM backend (the executable spec)
  algebra-tsl.ts       the same vocabulary over three/tsl shader nodes
  gate.ts              the two-phase per-piece choreography window
  ops.ts               Orient / Transform / Modifier / Selector library + runPipeline
  house.ts             the shared house selectors (selSheet / selNotAccessory /
                       selNotOptical) + the roll-step / fold bend CHAINS + memoCtx
  recipes.ts           the five authored recipes + the `scratch` bench:
                       gateSpec + ordered op list + knobs
  frames.ts            load-time derivation of every `_op*` per-piece constant
  host.ts              where ops meet three: material/line/hull attach, channels, knobs
  cpu.ts               the same deform on the NUM backend, at an ARBITRARY point
                       (the ONE deliberate CPU mirror — rays + picking proxies)
  mechanism.ts         real mechanical drives only (zoom/focus/aperture)
  __tests__/           per-layer specs on the NUM backend, plus
                       channel-registry.test.ts (registry rows ≡ the recipe set)
story/
  story.ts             THE story table (STORY) + types + derived pacing
                       (TOTAL_HOLD, TRACK_HEIGHT_CSS, RANGES, rangeOf, pulse,
                       CAPTION_BANDS)
  camera.ts            sampleStory spline camera + applyStoryFraming
  hero-driver.ts       scroll driver: envelopes, chrome, pins, --beat-* vars,
                       ?story scrubber
  cinematics.ts        presentation extras layered on the scene (nothing mechanical)
  peelcards.ts         the peel + the card field — one gesture, two clocks
  internals.ts         the internals scene's time-based focus/iris ambient
  fly.ts               the dive on the scroll (LAZY — hero-driver import() only)
  constellations.ts    the sky chapter's ink: strokes, star names, the quote
  trails.ts            the sky turns: spin + star arcs + the crown (LAZY)
optics/                the sky and the dive's own math/engines
  fly-core.ts          the FLY knobs + posePath/flyPose + travel remap + fades
                       (pure — the one optics file the hero may import statically)
  prescription.ts      the measured element spans the dive flies through
  sky.ts               star catalog + constellations + SKY_INK (per theme)
  starfield.ts         the star quad-soup draw + spin/streak uniforms
  constellation-lines.ts  self-drawing strokes  star-trails.ts  long-exposure arcs
  crown-arc.ts         the authored screen-space arc that becomes the lens's edge
  wormhole-post.ts     screen-space pinch / ring fold / chromatic aberration
  warp.ts              the legacy per-pixel refraction trace (?tracesky)
  trace.ts             its bake                __tests__/  optics laws + goldens
core/
  scene.ts             orchestrator: renderer, CHANNEL_REGISTRY, tick, lifecycle
  model.ts             GLB loading, materials, environment, disposal
  parts.ts             node-name classification predicates
  theme.ts             site-theme watcher
  transitions.ts       look-swap gestures (molt, …)
  math.ts              clamp01 / smoothstep / lerp / band / deg
materials/
  shading.ts           render-style swapper + TECHNICAL_PALETTES + ink edge lines
  depthfade.ts         camera-relative dissolve for exploded pieces
explore/               /lens ONLY — lazy-loaded, keeps anime.js out of the hero
  demos.ts             full demo compositions (camera + animation + wipe + palette)
  scene-kit.ts         auto-restore / verb ergonomics under the demos
  page-wipe.ts         page-owned hard wipe     page-text.ts    type-sandwich layers
  prism-light.ts       screen-space prism bands ray-ribbons.ts  steerable ray bands
  overlay.ts           shared NDC overlay pass  motion.ts       the anime.js surface
  __tests__/           scene-kit-knobs.test.ts — the kit's auto-restore contract
                       (knob + channel undos, the measured-prior class)
dev/                   DEV ONLY — dynamically imported by scene.enablePathViz()
                       / scene.enableInspect() / the `?diag` param, so none of
                       it reaches a normal visitor's bundle
  paths.ts             motion-path overlay + its two drift checks (lazy-loaded)
  inspect.ts           hover/click piece-name inspector (proxy raycast + tooltip)
  ops-cpu.ts           ops/cpu.ts swept over a whole geometry — displaced
                       positions (+ the decal binding) for the proxies
  path-probe.ts        GPU readback of the real deform graph (no CPU mirror)
  analysis.ts          programmatic scene analysis (window.__lensPaths API):
                       analyze/compare/interference/curlCorners as JSON
  model-contract.ts    boot tripwire: every structural assumption about the GLBs
  diag.ts              `?diag` status card: backend / warp status / trace
                       channels / three revision, readable off a PHONE
```

Related, outside this dir: `components/LensStory.astro` (the hero — pinned
stage, authored caption content, the caption-fade animations + the hero intro's
own band, pins, boot script; the story TABLE lives in `story/story.ts`),
`components/LensSceneContent.astro` (one scene's caption band + the sticky slot
inside it), `components/LensPin.astro` (tracked annotations),
`lib/cap-fades.ts` (the caption-fade fallback — standalone, imports nothing from
here on purpose, so a broken 3D chunk cannot take the captions with it),
`components/LensPreloads.astro` (model+decoder preloads), `pages/lens.astro`,
`pages/index.astro` (renders `<LensStory />` + the below-hero sections).
