# The Evolution of the Lens Animation System

A running history of how the website's 3D lens animation system came to be —
what each era added, what problem forced the next one, and the decisions
(with their reasoning) that shaped it. Kept so the story can be written about
later with the context intact.

The subject: a Sigma 18-50mm lens, modeled in Blender, segmented into shell
wedges, rendered with three.js WebGPU/TSL, driven by scroll on the homepage
hero and by a workbench at `/lens`.

---

## Era 1 — The story and the channels (foundation)

The original system: a **story table** (scroll → scenes), a handful of named
scalar **channels** (`zoom`, `focus`, `aperture`, `explode`, `unwrap`,
`curl`, `shear`), and the **bloom** material — a TSL vertex-shader deform
that reads per-wedge baked attributes (sector center, shell radius, stagger
rank) and computes explode/peel/curl entirely on the GPU. The CPU animates
roughly a dozen numbers; the shader does the choreography.

Two design decisions from this era shaped everything after:

- **Value/target easing.** UI writes a channel's _target_; a tick loop eases
  the live value toward it (~12% of the remaining gap per frame). One
  mechanism gave every knob a damped feel and powered demand rendering (the
  page repaints only while something eases or is dirty).
- **The reassembly ("rewrap") machinery** — per-shell staggered windows that
  fly the peeled sheets home. Hand-built, calibrated, and the thing a later
  era would spend weeks reproducing.

## Era 2 — The formation ops (motion as mathematics)

Trigger: wanting _new_ motion vocabulary ("it all still revolves around
exploding") — starting with the owner's "rolling thing": the shell unrolling
along its tangent plane like a carpet (`rollout`).

The insight that became the architecture: a formation is **built from
composable operators over material coordinates** — a pipeline of small
functions transforming a wedge state, gated by per-wedge flight/stick
weights. Generators (wrap, rollOut) establish a bent state from material
coordinates; ops (approach, spread, orbit, coil, twist, stick) transform it.
Order matters — "these are like matrix transformations" (owner) — it's a
layered application, not a bag of effects.

Era 2's discipline mattered as much as its math:

- **Golden hashes.** A dev instrument samples every wedge's path through an
  animation and the analysis JSON is SHA-256'd. The ops `assemble` preset was
  calibrated until it reproduced the classic rewrap **to 0.00mm**, and from
  then on any refactor had to keep the hash byte-identical. This gate caught
  drift repeatedly and made aggressive renames safe.
- **Redundancy audits.** wind + swirl merged into one `orbit` op; the `shear`
  op renamed `twist` (it's torsion; `shear` stayed the name of the peel-front
  channel only) — hash-proven identical.
- **Taxonomy.** Ops classify as _positional_ (rigid, piece-level selection
  only), _deforming_ (per-vertex), and — the owner's key insight —
  _selection_ (participation weight fields: stick's front, wrap's carry,
  the masks). Selection is what makes "only part of the geometry does this"
  a first-class concept instead of a hack inside each op.
- **The κ-unification experiment (`bendProfile`).** Fold, roll-out and wrap
  are all curvature profiles: a fold is a κ spike (its radius = softness), a
  roll-out is a traveling κ step (reproduced to 0.00mm), a wrap is κ plus a
  material-redistribution `carry` term. Proof exists in-repo; adoption is
  deliberately deferred — one architecture decision, made once, at cleanup
  time rather than mid-exploration.

"We're essentially just warping space" (owner) became the mental model: the
geometry at rest is the identity; everything else is operators.

## Era 3 — Composition (scenes, not effects)

Trigger: "I was looking for end to end examples, like with the camera choreo
as well." Individual effects don't sell a website — compositions do.

This era built the page-level vocabulary:

- **Demos**: full scenes — camera + model + page — under one scrub `p`.
- **The hard wipe law**: background reveals are _page DOM_ with a hard
  clipped line, never a feathered shader backdrop. The canvas renders with
  alpha so the page itself is the stage.
- **The type sandwich**: display type _behind_ the lens, captions in front —
  the model occludes the text, so 2D and 3D read as one composition.
- **The 2D/3D design law** (owner): _only the lens model reads as 3D_.
  Everything else — rays, wipes, text — must pass the vector-graphic test.
  This produced the ortho tricks: fov 3° with matched pullback renders the
  lens itself as a flat diagram, and perspective returns as the camera dives
  in ("the diagram becomes 3D as the viewer enters the glass" — the Prism
  scene, the owner's own storyboard beat).
- **Look transitions as choreography**: shading swaps carry a gesture
  (blink/twist/molt/punch) with a retarget-in-flight contract.
- **New primitives on the wedge infrastructure**: cardify (sheets square
  into photo cards), genie (the macOS minimize, a swallow front to a dock
  point), per-part offsets, screen-space ribbon fields. _(cardify and genie
  were REMOVED AT THE OPS SQUASH, 2026-08-02: both were classic-deform
  primitives, and neither had been ported to a recipe. Per-part offsets and
  the ribbon fields survive — they never touched the deform.)_
- **anime.js, subordinated.** Evaluated seriously, adopted _as a math
  helper_ (springs, staggers, `seek()`-driven timelines) — never as the
  owner of state. The scrub doctrine: deterministic in both directions.

## Era 4 — The fork (score files vs. code)

Trigger: scene code had accumulated bookkeeping — hand-written `exit()`
restore blocks, module-level `let`s for boundary state, six-deep camera lerp
stacks. Question: is the _format_ wrong?

A "score" architecture was proposed (scenes as declarative JSON-ish tracks —
lanes, spans, keyframes — played by an engine), then put through an
adversarial panel. The minimalist argued the typed `apply(p)` function _is_
already the right format and a score is a second system to maintain. The
motion veteran extracted the genuinely valuable mechanics: discrete spans
with gestures, camera keys with a framing constant, engine-owned
restore, and a determinism rule (eased targets make frames depend on scrub
history).

**Resolution (owner, 2026-08-02):** "Honestly I would want to keep it in
code. We can simplify the API or how we interact with the engine to make it
less cumbersome to deal with." Scenes stay TypeScript; the engine absorbs
the bookkeeping. No scene files, no player.

## Era 5 — The scene-kit and the verbs (the engine absorbs the chores)

The resolution built, in three moves:

1. **The kit** (`scene-kit.ts`, ~450 lines total): a recording api — every
   write a scene makes registers its own undo; deselect rewinds in reverse.
   `exit()` became optional. `spans()` owns segment/boundary law (single
   crossings gesture, multi-boundary jumps land silently, mid-gesture
   retarget, reduced-motion). `posePath()` turns camera work into
   carry-forward keyframes with a `frame` field (`dist = frame/tan(fov/2)` —
   framing holds while fov drifts, which is how ortho→perspective reads as
   one move). `drive()` writes a channel's value _and_ target, making a
   scrubbed frame a pure function of p. Proof: three scenes ported
   (43→33, 92→58, 163→133 lines), pixel-identical, hashes intact.
2. **The verbs**: the owner disliked threading `api` through every function
   — so the api became an implicit context (the React-hooks trick). Scene
   code just says what happens: `setShading("flat"); drive("bend", v)`. The
   page brackets each scene callback in `withKit()`; the kit re-enters the
   bracket around callbacks it fires later (a transition's beat); `bind()`
   captures it for genuinely async motion. Unbracketed async calls throw —
   loud failure over silent recorder-escape.
3. **The bench port**: the first Animations-tab scene (`reassemble-ops`)
   moved to verbs. The path instrument scrubs animations against a _scratch_
   state copy, which forced the right generalization: `withChannelState()`
   points the verbs at whichever state the caller owns. The golden hash came
   back byte-identical — the port was provably motion-neutral.

## Era 6 — The feel corrections (determinism meets fingers)

Shipping `drive()`'s exact scrub immediately exposed something the old
easing had been quietly hiding: **input quantization**. The progress sliders
had 101 positions (default `step="1"`), and a ~240px slider only reports
pixel steps. The old target-easing had been acting as an input low-pass
filter — smoothing the staircase _and_ the feel, at the cost of scrub-history
dependence and never-quite-zero residue.

The fixes landed at the right layers, in sequence, driven by the owner
feeling each iteration live:

1. `step="any"` — per-pixel input resolution.
2. A jump-vs-drag glide — rejected by feel ("moving the slider slowly still
   produces jumps").
3. **Ease the input, not the state**: a follower chases the slider's p at
   the classic cushion rate, feeds every intermediate p through the scene's
   own `apply`, then _lands exactly_ on the input p. Transients replay the
   actual choreography — a click is a true fast-forward (camera and all,
   which the old channel-space easing only approximated) — and rest is
   still a pure function of the slider. Verified: one pixel step → 11
   distinct eased frames → settles exact to 1e-9.

The era's principle, and maybe the system's thesis:

> **Determinism belongs to the state; easing belongs to the input.**

The old system entangled them in one mechanism and got both slightly wrong.
The new system separates them and gets both exactly right.

## Era 7 — The unification (one pipeline, everything derived)

Trigger: publishing. The pre-publish cleanup question — "which of these
systems do we keep?" — got the maximal answer: none of them, individually.
"Get rid of the generators, we can describe them purely via ops. The
reassemble animation was the only thing I wanted to preserve from before,
everything else can go as it will change." Then the two deeper cuts: the
gearbox warping along with its shell — an accident of a compatibility
mechanism — was declared the _desired_ look ("it makes everything look a
lot more cohesive. I want to extend that to the other parts"), and the
baked model attributes were identified as "another moving part that can be
removed." Together those two sentences dissolved all three subsystems: if
everything is op-addressable and everything is measured from geometry,
there is nothing left for bloom.ts, formation.ts, or the rig's ladder to
do.

The design that came out of that conversation:

- **Three operator classes, named on Blender's own convention** —
  **Transform** (a per-piece map with a well-defined action on the piece
  frame; rigid today, affine admissible), **Modifier** (per-vertex, acting
  through material coordinates — no frame image), **Selector**
  (participation weight fields, at piece, spatial, or material
  granularity). "Affine" was considered as the class name and kept instead
  as the class _boundary_.
- **A pipeline, not a bag**: each op's output feeds the next in order.
  Selectors are pipeline members — one sets the active selection for
  everything after it, selections compound multiplicatively, and
  `group([...])` scopes them like a transform stack. Order matters in both
  directions: ops before a selector change what it sees, because spatial
  selectors read the _current_ piece frame. And one law keeps it sane —
  "deform changes the space" — so the frame selectors sample is advanced
  by transforms only; a bent sheet has no single location, and pretending
  otherwise would tear selections mid-piece.
- **Recipes over presets**: a recipe = channel + gate + pipeline. The
  generators became profiles handed to one `bend` op; the gate (staggered
  windows → flight/stick) survived intact as the choreography engine,
  now written once in a scalar algebra that runs identically as TSL nodes
  in the shader and as plain numbers in the test suite. The old
  hand-mirrored JS copy of the gate died of that — one source, two
  backends.
- **Everything measured**: piece frames (centre meridian, reference
  radius, span, extents), ranks, within-layer phases, even the explode
  ladder, all derived from geometry at load. The one irreducible authored
  dataset is the mechanism table — the zoom cam measured off a photograph
  of the real lens can't be derived from a mesh, and shouldn't be.

The execution taught as much as the design. The reference pack (analysis
JSON plus screenshot sweeps, captured before anything moved) was the
ground truth every step compared against, and the adversarial review loop
caught things no single pass would have: the plan's own modifier-weight
law turned out to _invert_ the selection contract (a masked-out piece
would have flattened instead of staying seated — the fix was the classic's
own law, folding the weight into the gate); WebGPU's eight-vertex-buffer
limit made nine separate frame attributes an invisible model until they
were packed into three; and the dev instrument was quietly measuring the
_deleted_ graph — a comparator gate that would have certified a swap it
never touched.

Participation — who wraps and who rides — took three iterations to derive
honestly, and the destination is a principle: **participation is measured,
not named.** Class lists were wrong (decals must fly with their shells;
the iris regex caught the housing shell along with the mechanism), layer
population was fragile against measured radii, and the answer that held is
geometric: a sheet is a measured _sector_ (span well under a full turn,
not a body of revolution); full rings and glass ride the ladder; adopted
hardware and decals go where their shell goes. Along the way the framing
unit itself had to be corrected twice, and landed on the **glTF node** —
the authoring unit, one Blender object. First up from connected-component,
after a PCB's solder islands each measured their own tiny frame and the
board fell out of the choreography; then up again from mesh, once a
multi-material node — which exports as several glTF primitives and imports
as one mesh each — was framed apart into two radii, two ranks and two gate
timings, and its halves visibly diverged mid-wrap.

Two footnotes for honesty's sake. The golden byte-hashes were finally
retired — measured reference radii differ from the baked cut radii by
construction, so the bar became endpoints-exact plus the instrument as a
millimetre comparator plus the owner's eye, which is what "preserve the
reassemble" always really meant. And the scariest bug of the wave — demo
knob writes apparently surviving deselection — was a phantom: the probe
had been clicking the _Animations_ tab's None button while testing the
_Demos_ tab. The kit's restore had been correct all along. Two fix waves
chased it; the hardening they added was real, but the lesson is older than
the project: instrument the world before theorizing about it.

The story kept its one promised beat through all of this: at the
reassembly's midpoint the glass column sits seated and waiting — explode
now seats the core during the light-path blackout, and assemble's
staggered gate owns the visible layer-by-layer wrap-on.

## Standing principles (as of 2026-08-02)

- A scene frame is a **pure function of progress**. Anything time-based is
  an input-layer concern.
- **Exact endpoints matter**: zero means zero, so the shader's
  identity-at-rest contract holds and idle costs nothing.
- **Selection is first-class**: what participates is as important as what
  the operator does.
- **The engine records; scenes declare.** Bookkeeping in scene code is a
  bug in the engine's API.
- **Verify by instrument, not by eye alone**: the path comparator for
  motion identity; screenshots for composition; the owner's hands for
  feel — all three catch different failures. (Feel found the quantization
  bug that both instruments were blind to; the byte-exact golden hashes
  served through Era 6 and were retired with the derived frames.)
- **Code is the format.** Every "maybe a DSL/file format?" question so far
  has resolved to "no — better API."
- **Participation is measured, not named** (Era 7): whether a piece wraps
  or rides derives from its measured geometry — span, symmetry,
  adoption — not from a hand-kept participation list. Names have not gone
  away, and the principle overstates itself if read that way: glass, iris,
  decal and accessory participation still routes through `selClass`, fed by
  the name regexes in `core/parts.ts`, and the explode ladder is anchored on
  a named node. The rule is narrower than the slogan — geometry decides the
  SHAPE of a motion; a name only says what KIND of part it is.
- **The framing unit is the authoring unit**: one set of frame values per
  glTF NODE (one Blender object) — not per island, and not per mesh either,
  since a multi-material node exports as several primitives; per-island
  measurement only where a feature genuinely snaps to a host.
- **One registry row ≡ one recipe**: the channel registry and the recipe
  set are the same list, and a test enforces it in both directions.
- **A law isn't pinned until its mutant fails**: every load-bearing law
  carries a test that was verified to break when the law is broken.

## Open questions

The first three RESOLVED at the ops-unification squash (2026-08-02) — kept
here with their answers, because the answers are the interesting part:

- **bendProfile + selection adoption** — DONE (2026-08-02): `bend` is now the
  single κ-profile modifier every sheet motion is written against (wrap,
  roll-out and fold are three profiles handed to one op), and selection is the
  recipes' own default: a recipe opens with the selector that says who
  participates (`assemble`'s sheet rule, `explode`'s accessory/optics
  exemptions) instead of ops carrying exemption flags.
- **Math-native op verification** — DONE (2026-08-02): the op source is written
  against `Algebra<S>`, with the `NUM` backend running the identical code on
  plain numbers. The whole motion layer's spec now lives in `ops/__tests__/`
  as portable node tests, and browser-driven hash machinery is no longer the
  math layer's safety net (it remains useful for end-to-end visual identity).
- **Classic-path deletion** — DONE (2026-08-02): the classic rewrap/peel
  machinery is deleted, not merely superseded. What replaced it is the OPS
  HOST (`ops/host.ts`), which owns the one deform graph; the bloom material
  that used to host the classic deform went with it, so nothing of that era is
  still standing.
- Whether the last classic channel ideas (peel-and-curl as their own knobs)
  ever come back as separate ops — today's `assemble` recipe already spends
  them as terms of the wrap profile (a selection front + a curvature op), so
  this is a vocabulary question rather than a missing capability.
