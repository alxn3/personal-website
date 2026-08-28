<!-- GENERATED — do not edit by hand. See story/__tests__/piece-flow.test.ts. -->

# PIECE-FLOW

Where every PIECE of the lens is through the hero story, in the bore's own
cylindrical coordinates — the space the op algebra works in, where a
trajectory that looks like a curve on screen is a line or a ramp. Rendered from
`story/flow.ts`'s `pieceStateAt(p, key, table)`, which runs the REAL op
pipeline on the NUM backend (`ops/cpu.ts` `pieceField` — the same fold
preamble the shader is built from, and the same path the recipe goldens are
pinned on) at the channels `storyStateAt(p)` reports, and composes
story/peelcards.ts's rigid per-piece offset on top exactly as core/scene does.
Regenerate with

    LENS_PIECE_FLOW=1 npx vitest run src/lib/lens/story/__tests__/piece-flow.test.ts

and `story/__tests__/piece-flow.test.ts` asserts the checked-in file matches,
so a wave that retunes a recipe fails the suite with the new table in the diff.

**Roster.** `lens_web_segmented.glb` — 194 mesh nodes, 207 pieces: ONE PIECE PER DISTINCT LANE TUPLE, which is how the deform itself reads the model. Six meshes carry more than one tuple (an adopted feature is framed island by island so each screw snaps to its own host wedge) — and islands that snapped to the SAME wedge inherit identical lanes and are therefore one piece, so a mesh's pieces are its distinct FRAMES, not its islands. By cast: wedges 25, decals 19, extras 10, interior 65, elements 13, other 75. A piece IS its derived frame (`ops/frames.ts`'s `_op*` lanes); the casts are core/visibility.ts's own wink bands.

**Deform set.** The hero pins `assemble / explode / peel / rose` and drives them off the story's channels; every knob rests at its recipe's `knobDefaults` but the three the story writes (`assemble.keepScope`, `explode.bloom`, `explode.curl` — story/envelopes.ts). Nothing moves outside p ∈ [0.1530, 1.0000] — the op channels' own live span, scanned at 1/2000 and snapped outward by a step. Every piece is exactly on its seat outside it.

**The dimensions.** `dTheta`/`dR`/`dX` are the piece frame's displacement from its seat — round the bore (rad), out from the axis (mm), along the axis (mm). `roll` is the piece turning IN PLACE about the bore (a rigid revolution reads 0: the local frame is carried with it). `bend` and `curl` are the two halves of "how did its shape change", and neither implies the other: `bend` is AXIAL — the relative rotation of the piece's two ends, how much one has turned against the other, unsigned, 0 for any rigid motion (and a true 0.000 through the peel and internals, which move a piece's two ends alike) — while `curl` is CIRCUMFERENTIAL and SIGNED: how much more its arcs curve than they do at their seat, positive curled tighter, negative flattened, which is what a wedge peeling off the barrel does. `stretch` and `stretch X` are its size round the bore and along it: 1 is rigid, and they are separate readings off separate probe pairs (`stretch X` is a ratio of the piece's OWN axial extent, so it runs to 100× on a 0.093mm shim the ops spread by a millimetre — as the render does). `travel` is the straight-line distance from the seat. There is no rigid half any more: story/peelcards.ts's per-piece offsets went with the cards scene's old drift departure, so every motion in the story is a deform channel and this table is all of it.

**What it is not.** The AUTHORED pose at `p`: every residual `story/state.ts`
declares (ease lag, phase clocks, mount latches) applies. It carries no
mechanism drive (the iris blades' aperture rotation, the focus screw's spin are
object-level and on their own clocks), no model placement (dolly, rolls,
camera) and no visibility — a winked-out piece still has a pose and it is
reported here. Two measurement restrictions are worth naming. `stretch` is NOT
REPORTED for the 15 axisymmetric pieces (`Cam_Followers`, `Iris_ActuatorGear`,
`Element_01…13`): a body of revolution's frame span is the convention 2π rather
than a measured extent, so its circumferential probes are a ring sample, whose
size answers to the ring's rigid motion and not to any stretch — those cells
read a flat 1.0000 and mean "not measured". And the eight iris nodes are seated
off the optical axis, so their `radius` is a distance from their own origin —
the frame ops/frames.ts measures and ops/host.ts deforms them in, so the
instrument mirrors the render. `story/flow.ts`'s header has the full list.

## Per scene × cast — the range

`min…max` over every piece of the cast at every sample inside the scene's own
range (the shared edge grid, half-open on the right, plus the scene's hold
centre). This is the diff surface: regenerate after a wave and read this table.

```text
         scene      cast   n         dTheta          dR mm          dX mm          roll         bend           curl        stretch       stretch X  travel
--------------  --------  --  -------------  -------------  -------------  ------------  -----------  -------------  -------------  --------------  ------
          hero    wedges  25    0.000…0.000      0.00…0.00      0.00…0.00   0.000…0.000  0.000…0.000    0.000…0.000  1.0000…1.0000   1.0000…1.0000    0.00
          hero    decals  19    0.000…0.000      0.00…0.00      0.00…0.00   0.000…0.000  0.000…0.000    0.000…0.000  1.0000…1.0000   1.0000…1.0000    0.00
          hero    extras  10    0.000…0.000      0.00…0.00      0.00…0.00   0.000…0.000  0.000…0.000    0.000…0.000  1.0000…1.0000   1.0000…1.0000    0.00
          hero  interior  65    0.000…0.000      0.00…0.00      0.00…0.00   0.000…0.000  0.000…0.000    0.000…0.000  1.0000…1.0000   1.0000…1.0000    0.00
          hero  elements  13    0.000…0.000      0.00…0.00      0.00…0.00   0.000…0.000  0.000…0.000    0.000…0.000  1.0000…1.0000   1.0000…1.0000    0.00
          hero     other  75    0.000…0.000      0.00…0.00      0.00…0.00   0.000…0.000  0.000…0.000    0.000…0.000  1.0000…1.0000   1.0000…1.0000    0.00
          zoom    wedges  25    0.000…0.000      0.00…0.00      0.00…0.00   0.000…0.000  0.000…0.000    0.000…0.000  1.0000…1.0000   1.0000…1.0000    0.00
          zoom    decals  19    0.000…0.000      0.00…0.00      0.00…0.00   0.000…0.000  0.000…0.000    0.000…0.000  1.0000…1.0000   1.0000…1.0000    0.00
          zoom    extras  10    0.000…0.000      0.00…0.00      0.00…0.00   0.000…0.000  0.000…0.000    0.000…0.000  1.0000…1.0000   1.0000…1.0000    0.00
          zoom  interior  65    0.000…0.000      0.00…0.00      0.00…0.00   0.000…0.000  0.000…0.000    0.000…0.000  1.0000…1.0000   1.0000…1.0000    0.00
          zoom  elements  13    0.000…0.000      0.00…0.00      0.00…0.00   0.000…0.000  0.000…0.000    0.000…0.000  1.0000…1.0000   1.0000…1.0000    0.00
          zoom     other  75    0.000…0.000      0.00…0.00      0.00…0.00   0.000…0.000  0.000…0.000    0.000…0.000  1.0000…1.0000   1.0000…1.0000    0.00
          peel    wedges  25   -1.341…0.030     0.00…67.55    -3.73…38.00  -1.193…0.000  0.000…1.761   -0.743…0.504  0.8259…1.0595   1.0000…2.3385   95.83
          peel    decals  19   -1.341…0.030     0.00…67.55     0.00…38.00  -1.188…0.000  0.000…1.761   -0.743…0.496  0.8259…1.0595   1.0000…2.0114   95.60
          peel    extras  10   -0.861…0.009     0.00…39.95     0.00…38.00  -0.320…0.000  0.000…0.178   -0.666…0.000  1.0000…1.0475   1.0000…1.0103   61.35
          peel  interior  65   -1.330…0.026     0.00…63.61   -18.67…38.00  -0.965…0.000  0.000…1.679   -0.655…0.471  0.8537…1.0459   1.0000…5.9490   88.81
          peel  elements  13    0.000…0.000      0.00…0.00      0.00…0.00   0.000…0.000  0.000…0.000    0.000…0.000  1.0000…1.0000   1.0000…1.0000    0.00
          peel     other  75    0.000…0.000      0.00…0.00      0.00…0.00   0.000…0.000  0.000…0.000    0.000…0.000  1.0000…1.0000   1.0000…1.0000    0.00
         cards    wedges  25   -1.341…0.000     0.00…67.55    -3.73…38.00  -0.355…0.000  0.000…0.000   -0.743…0.000  1.0000…1.0595   1.0000…1.0000   95.83
         cards    decals  19   -1.341…0.000     0.00…67.55     0.00…38.00  -0.355…0.000  0.000…0.000   -0.743…0.000  1.0000…1.0595   1.0000…1.0000   95.60
         cards    extras  10   -0.861…0.000     0.00…39.95     0.00…38.00  -0.320…0.000  0.000…0.000   -0.666…0.000  1.0000…1.0475   1.0000…1.0000   61.35
         cards  interior  65   -1.330…0.000     0.00…63.61   -18.67…38.00  -0.756…0.000  0.000…0.760   -0.655…0.000  1.0000…1.0459   1.0000…1.2361   88.81
         cards  elements  13    0.000…0.000      0.00…0.00      0.00…0.00   0.000…0.000  0.000…0.000    0.000…0.000  1.0000…1.0000   1.0000…1.0000    0.00
         cards     other  75    0.000…0.000      0.00…0.00      0.00…0.00   0.000…0.000  0.000…0.000    0.000…0.000  1.0000…1.0000   1.0000…1.0000    0.00
     internals    wedges  25    0.000…0.000      0.00…0.00      0.00…0.00   0.000…0.000  0.000…0.000    0.000…0.000  1.0000…1.0000   1.0000…1.0000    0.00
     internals    decals  19    0.000…0.000      0.00…0.00      0.00…0.00   0.000…0.000  0.000…0.000    0.000…0.000  1.0000…1.0000   1.0000…1.0000    0.00
     internals    extras  10    0.000…0.000      0.00…0.00      0.00…0.00   0.000…0.000  0.000…0.000    0.000…0.000  1.0000…1.0000   1.0000…1.0000    0.00
     internals  interior  65    0.000…0.000      0.00…0.00      0.00…0.00   0.000…0.000  0.000…0.000    0.000…0.000  1.0000…1.0000   1.0000…1.0000    0.00
     internals  elements  13    0.000…0.000      0.00…0.00      0.00…0.00   0.000…0.000  0.000…0.000    0.000…0.000  1.0000…1.0000   1.0000…1.0000    0.00
     internals     other  75    0.000…0.000      0.00…0.00      0.00…0.00   0.000…0.000  0.000…0.000    0.000…0.000  1.0000…1.0000   1.0000…1.0000    0.00
    flythrough    wedges  25    0.000…0.000      0.00…0.00      0.00…0.00   0.000…0.000  0.000…0.000    0.000…0.000  1.0000…1.0000   1.0000…1.0000    0.00
    flythrough    decals  19    0.000…0.000      0.00…0.00      0.00…0.00   0.000…0.000  0.000…0.000    0.000…0.000  1.0000…1.0000   1.0000…1.0000    0.00
    flythrough    extras  10    0.000…0.000      0.00…0.00      0.00…0.00   0.000…0.000  0.000…0.000    0.000…0.000  1.0000…1.0000   1.0000…1.0000    0.00
    flythrough  interior  65    0.000…0.000      0.00…0.00      0.00…0.00   0.000…0.000  0.000…0.000    0.000…0.000  1.0000…1.0000   1.0000…1.0000    0.00
    flythrough  elements  13    0.000…0.000      0.00…0.00      0.00…0.00   0.000…0.000  0.000…0.000    0.000…0.000  1.0000…1.0000   1.0000…1.0000    0.00
    flythrough     other  75    0.000…0.000      0.00…0.00      0.00…0.00   0.000…0.000  0.000…0.000    0.000…0.000  1.0000…1.0000   1.0000…1.0000    0.00
constellations    wedges  25    0.000…0.000      0.00…0.00      0.00…0.00   0.000…0.000  0.000…0.000    0.000…0.000  1.0000…1.0000   1.0000…1.0000    0.00
constellations    decals  19    0.000…0.000      0.00…0.00      0.00…0.00   0.000…0.000  0.000…0.000    0.000…0.000  1.0000…1.0000   1.0000…1.0000    0.00
constellations    extras  10    0.000…0.000      0.00…0.00      0.00…0.00   0.000…0.000  0.000…0.000    0.000…0.000  1.0000…1.0000   1.0000…1.0000    0.00
constellations  interior  65    0.000…0.000      0.00…0.00      0.00…0.00   0.000…0.000  0.000…0.000    0.000…0.000  1.0000…1.0000   1.0000…1.0000    0.00
constellations  elements  13    0.000…0.000      0.00…0.00      0.00…0.00   0.000…0.000  0.000…0.000    0.000…0.000  1.0000…1.0000   1.0000…1.0000    0.00
constellations     other  75    0.000…0.000      0.00…0.00      0.00…0.00   0.000…0.000  0.000…0.000    0.000…0.000  1.0000…1.0000   1.0000…1.0000    0.00
        trails    wedges  25   -1.496…3.099    0.00…138.60    0.00…187.48   0.000…0.000  0.000…0.000   -0.608…0.000  1.0000…1.0575   1.0000…1.0000  250.62
        trails    decals  19   -1.350…0.000    0.00…138.60    0.00…187.48   0.000…0.000  0.000…0.000   -0.608…0.000  1.0000…1.0575   1.0000…1.0000  233.32
        trails    extras  10   -0.800…2.250     0.00…81.90    0.00…169.02   0.000…0.000  0.000…0.000   -0.545…0.000  1.0000…1.0459   1.0000…1.0000  190.74
        trails  interior  65   -2.303…2.074    0.00…130.50    0.00…187.42   0.000…0.000  0.000…0.000   -0.536…0.000  1.0000…1.0444   1.0000…1.0000  220.12
        trails  elements  13    0.000…0.000      0.00…0.00    0.00…155.17   0.000…0.000  0.000…0.000    0.000…0.000  1.0000…1.0000   1.0000…1.0000  155.17
        trails     other  75   -3.078…2.640    0.00…130.50    0.00…151.57   0.000…0.000  0.000…0.000    0.000…0.000  1.0000…1.0000   1.0000…1.0000  217.32
        rewrap    wedges  25   -1.350…3.027  123.30…138.60  151.21…187.48   0.000…0.000  0.000…0.000  -0.608…-0.423  1.0273…1.0575   1.0000…1.0000  250.62
        rewrap    decals  19  -1.350…-0.800  125.48…138.60  152.43…187.48   0.000…0.000  0.000…0.000  -0.608…-0.427  1.0279…1.0575   1.0000…1.0000  233.32
        rewrap    extras  10   -0.800…2.250    58.84…81.90  152.92…169.02   0.000…0.000  0.000…0.000  -0.545…-0.484  1.0361…1.0459   1.0000…1.0000  190.74
        rewrap  interior  65   -2.303…2.074    0.00…130.50   99.36…187.42   0.000…0.000  0.000…0.000   -0.536…0.000  1.0000…1.0444   1.0000…1.0000  220.12
        rewrap  elements  13    0.000…0.000      0.00…0.00   91.04…155.17   0.000…0.000  0.000…0.000    0.000…0.000  1.0000…1.0000   1.0000…1.0000  155.17
        rewrap     other  75   -3.078…2.640    0.00…130.50   94.55…151.57   0.000…0.000  0.000…0.000    0.000…0.000  1.0000…1.0000   1.0000…1.0000  217.32
        capsOn    wedges  25   -1.384…3.028   -8.03…138.60  -28.46…187.48   0.000…0.225  0.000…0.841   -0.608…0.212  0.6514…1.8896   1.0000…1.1767  250.62
        capsOn    decals  19   -1.350…0.000   -7.98…138.60  -28.46…187.48   0.000…0.218  0.000…0.836   -0.608…0.212  0.6543…1.8896   1.0000…1.1767  233.32
        capsOn    extras  10   -2.172…2.452     0.00…81.90    0.00…169.02   0.000…0.181  0.000…0.308   -0.545…0.184  1.0000…1.8753   1.0000…1.0373  190.74
        capsOn  interior  65   -2.440…2.326   -6.27…130.50   -7.87…187.42   0.000…0.739  0.000…0.981   -0.536…0.396  0.4334…1.3489   1.0000…2.9177  220.12
        capsOn  elements  13    0.000…0.000      0.00…0.00    0.00…155.17   0.000…0.000  0.000…0.000    0.000…0.000  1.0000…1.0000   1.0000…1.0000  155.17
        capsOn     other  75   -3.078…2.640   -8.77…130.50   -7.87…151.57   0.000…1.333  0.000…1.199   -0.004…0.424  0.4467…1.3489  1.0000…36.0364  217.32
```

## Per scene × cast — the mean

The same cells averaged over pieces and samples. A signed mean near zero with a
wide range above is a cast moving SYMMETRICALLY — the fan of a shell opening
outward round the whole bore — rather than one standing still.

```text
         scene      cast  dTheta   dR mm   dX mm    roll   bend    curl  stretch  stretch X
--------------  --------  ------  ------  ------  ------  -----  ------  -------  ---------
          hero    wedges   0.000    0.00    0.00   0.000  0.000   0.000   1.0000     1.0000
          hero    decals   0.000    0.00    0.00   0.000  0.000   0.000   1.0000     1.0000
          hero    extras   0.000    0.00    0.00   0.000  0.000   0.000   1.0000     1.0000
          hero  interior   0.000    0.00    0.00   0.000  0.000   0.000   1.0000     1.0000
          hero  elements   0.000    0.00    0.00   0.000  0.000   0.000   1.0000     1.0000
          hero     other   0.000    0.00    0.00   0.000  0.000   0.000   1.0000     1.0000
          zoom    wedges   0.000    0.00    0.00   0.000  0.000   0.000   1.0000     1.0000
          zoom    decals   0.000    0.00    0.00   0.000  0.000   0.000   1.0000     1.0000
          zoom    extras   0.000    0.00    0.00   0.000  0.000   0.000   1.0000     1.0000
          zoom  interior   0.000    0.00    0.00   0.000  0.000   0.000   1.0000     1.0000
          zoom  elements   0.000    0.00    0.00   0.000  0.000   0.000   1.0000     1.0000
          zoom     other   0.000    0.00    0.00   0.000  0.000   0.000   1.0000     1.0000
          peel    wedges  -0.665   34.71    6.33  -0.196  0.061  -0.328   1.0181     1.0296
          peel    decals  -0.670   35.30    9.76  -0.208  0.074  -0.339   1.0182     1.0259
          peel    extras  -0.371   17.07   17.41  -0.151  0.003  -0.314   1.0212     1.0002
          peel  interior  -0.400   17.62   -0.34  -0.115  0.016  -0.214   1.0106     1.0184
          peel  elements   0.000    0.00    0.00   0.000  0.000   0.000   1.0000     1.0000
          peel     other   0.000    0.00    0.00   0.000  0.000   0.000   1.0000     1.0000
         cards    wedges  -0.570   28.93    5.30  -0.135  0.000  -0.279   1.0188     1.0000
         cards    decals  -0.567   28.94    7.70  -0.137  0.000  -0.285   1.0196     1.0000
         cards    extras  -0.332   15.22   15.48  -0.135  0.000  -0.279   1.0188     1.0000
         cards  interior  -0.356   15.50   -0.31  -0.096  0.003  -0.192   1.0104     1.0010
         cards  elements   0.000    0.00    0.00   0.000  0.000   0.000   1.0000     1.0000
         cards     other   0.000    0.00    0.00   0.000  0.000   0.000   1.0000     1.0000
     internals    wedges   0.000    0.00    0.00   0.000  0.000   0.000   1.0000     1.0000
     internals    decals   0.000    0.00    0.00   0.000  0.000   0.000   1.0000     1.0000
     internals    extras   0.000    0.00    0.00   0.000  0.000   0.000   1.0000     1.0000
     internals  interior   0.000    0.00    0.00   0.000  0.000   0.000   1.0000     1.0000
     internals  elements   0.000    0.00    0.00   0.000  0.000   0.000   1.0000     1.0000
     internals     other   0.000    0.00    0.00   0.000  0.000   0.000   1.0000     1.0000
    flythrough    wedges   0.000    0.00    0.00   0.000  0.000   0.000   1.0000     1.0000
    flythrough    decals   0.000    0.00    0.00   0.000  0.000   0.000   1.0000     1.0000
    flythrough    extras   0.000    0.00    0.00   0.000  0.000   0.000   1.0000     1.0000
    flythrough  interior   0.000    0.00    0.00   0.000  0.000   0.000   1.0000     1.0000
    flythrough  elements   0.000    0.00    0.00   0.000  0.000   0.000   1.0000     1.0000
    flythrough     other   0.000    0.00    0.00   0.000  0.000   0.000   1.0000     1.0000
constellations    wedges   0.000    0.00    0.00   0.000  0.000   0.000   1.0000     1.0000
constellations    decals   0.000    0.00    0.00   0.000  0.000   0.000   1.0000     1.0000
constellations    extras   0.000    0.00    0.00   0.000  0.000   0.000   1.0000     1.0000
constellations  interior   0.000    0.00    0.00   0.000  0.000   0.000   1.0000     1.0000
constellations  elements   0.000    0.00    0.00   0.000  0.000   0.000   1.0000     1.0000
constellations     other   0.000    0.00    0.00   0.000  0.000   0.000   1.0000     1.0000
        trails    wedges  -0.121   81.65   98.15   0.000  0.000  -0.317   1.0254     1.0000
        trails    decals  -0.676   82.50  103.40   0.000  0.000  -0.323   1.0263     1.0000
        trails    extras   0.242   23.46   53.66   0.000  0.000  -0.171   1.0136     1.0000
        trails  interior   0.118   29.98   50.55   0.000  0.000  -0.141   1.0092     1.0000
        trails  elements   0.000    0.00   39.90   0.000  0.000   0.000   1.0000     1.0000
        trails     other  -0.356   29.74   40.31   0.000  0.000   0.000   1.0000     1.0000
        rewrap    wedges  -0.291  133.72  164.86   0.000  0.000  -0.514   1.0410     1.0000
        rewrap    decals  -1.099  133.69  170.26   0.000  0.000  -0.524   1.0427     1.0000
        rewrap    extras   0.725   70.37  160.98   0.000  0.000  -0.514   1.0408     1.0000
        rewrap  interior   0.471   72.38  130.33   0.000  0.000  -0.356   1.0227     1.0000
        rewrap  elements   0.000    0.00  119.71   0.000  0.000   0.000   1.0000     1.0000
        rewrap     other  -1.042   85.09  116.71   0.000  0.000   0.000   1.0000     1.0000
        capsOn    wedges  -0.112   43.41   44.99   0.020  0.100  -0.132   1.0825     1.0207
        capsOn    decals  -0.390   45.25   46.31   0.017  0.082  -0.137   1.1346     1.0177
        capsOn    extras   0.030   18.29   38.43   0.037  0.060  -0.077   1.1678     1.0060
        capsOn  interior   0.049   16.74   30.44   0.055  0.129  -0.036   1.0033     1.0605
        capsOn  elements   0.000    0.00   18.01   0.000  0.000   0.000   1.0000     1.0000
        capsOn     other  -0.271   17.59   28.95   0.105  0.149   0.059   0.9179     2.4342
```

## The pieces that move — top 5 per scene

Each named at the sample where it is furthest from its seat inside the scene,
with its whole state there. Full per-piece trajectories are the API's job
(`pieceFlow(key, table)`), not this file's.

```text
 scene            piece    cast       p  travel  dTheta   dR mm   dX mm    roll   bend    curl  stretch  stretch X
------  ---------------  ------  ------  ------  ------  ------  ------  ------  -----  ------  -------  ---------
  peel  Ring_Focus_Seg0  wedges  0.2070   95.83  -1.337   67.31   -3.73  -0.291  0.000  -0.603   1.0387     1.0000
  peel   DecalT_Zoom_50  decals  0.2070   95.60  -1.307   65.43   25.33  -0.289  0.000  -0.599   1.0382     1.0000
  peel   Ring_Zoom_Seg4  wedges  0.2070   95.60  -1.307   65.43   25.33  -0.289  0.000  -0.599   1.0382     1.0000
  peel  Ring_Focus_Seg2  wedges  0.1821   95.53  -1.325   67.39   -3.73  -0.302  0.000  -0.626   1.0418     1.0000
  peel  Ring_Focus_Seg1  wedges  0.2070   95.51  -1.324   67.40   -3.73  -0.303  0.000  -0.628   1.0420     1.0000
 cards  Ring_Focus_Seg0  wedges  0.2396   95.83  -1.337   67.31   -3.73  -0.291  0.000  -0.603   1.0387     1.0000
 cards   DecalT_Zoom_50  decals  0.2396   95.60  -1.307   65.43   25.33  -0.289  0.000  -0.599   1.0382     1.0000
 cards   Ring_Zoom_Seg4  wedges  0.2396   95.60  -1.307   65.43   25.33  -0.289  0.000  -0.599   1.0382     1.0000
 cards  Ring_Focus_Seg2  wedges  0.2396   95.53  -1.325   67.39   -3.73  -0.302  0.000  -0.626   1.0418     1.0000
 cards  Ring_Focus_Seg1  wedges  0.2396   95.51  -1.324   67.40   -3.73  -0.303  0.000  -0.628   1.0420     1.0000
trails  Ring_Focus_Seg0  wedges  0.6622  250.62   3.027  138.48  151.21   0.000  0.000  -0.493   1.0374     1.0000
trails  Ring_Focus_Seg1  wedges  0.6693  250.62   3.027  138.48  151.21   0.000  0.000  -0.513   1.0406     1.0000
trails  Ring_Focus_Seg2  wedges  0.6622  250.62   3.027  138.48  151.21   0.000  0.000  -0.512   1.0404     1.0000
trails  Ring_Focus_Seg3  wedges  0.6622  250.62   3.027  138.48  151.21   0.000  0.000  -0.517   1.0413     1.0000
trails  Ring_Focus_Seg4  wedges  0.6622  250.62   3.027  138.48  151.21   0.000  0.000  -0.534   1.0441     1.0000
rewrap  Ring_Focus_Seg0  wedges  0.7508  250.62   3.027  138.48  151.21   0.000  0.000  -0.493   1.0374     1.0000
rewrap  Ring_Focus_Seg1  wedges  0.7508  250.62   3.027  138.48  151.21   0.000  0.000  -0.513   1.0406     1.0000
rewrap  Ring_Focus_Seg2  wedges  0.7508  250.62   3.027  138.48  151.21   0.000  0.000  -0.512   1.0404     1.0000
rewrap  Ring_Focus_Seg3  wedges  0.7508  250.62   3.027  138.48  151.21   0.000  0.000  -0.517   1.0413     1.0000
rewrap  Ring_Focus_Seg4  wedges  0.7508  250.62   3.027  138.48  151.21   0.000  0.000  -0.534   1.0441     1.0000
capsOn  Ring_Focus_Seg0  wedges  0.8594  250.62   3.027  138.48  151.21   0.000  0.000  -0.493   1.0374     1.0000
capsOn  Ring_Focus_Seg1  wedges  0.8594  250.62   3.027  138.48  151.21   0.000  0.000  -0.513   1.0406     1.0000
capsOn  Ring_Focus_Seg2  wedges  0.8594  250.62   3.027  138.48  151.21   0.000  0.000  -0.512   1.0404     1.0000
capsOn  Ring_Focus_Seg3  wedges  0.8594  250.62   3.027  138.48  151.21   0.000  0.000  -0.517   1.0413     1.0000
capsOn  Ring_Focus_Seg4  wedges  0.8594  250.62   3.027  138.48  151.21   0.000  0.000  -0.534   1.0441     1.0000
```
