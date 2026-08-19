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

**Deform set.** The hero pins `assemble / explode / peel / rose` and drives them off the story's channels; every knob rests at its recipe's `knobDefaults`. Nothing moves outside p ∈ [0.1545, 1.0000] — the op channels' own live span, scanned at 1/2000 and snapped outward by a step. Every piece is exactly on its seat outside it.

**The dimensions.** `dTheta`/`dR`/`dX` are the piece frame's displacement from its seat — round the bore (rad), out from the axis (mm), along the axis (mm). `roll` is the piece turning IN PLACE about the bore (a rigid revolution reads 0: the local frame is carried with it). `bend` and `curl` are the two halves of "how did its shape change", and neither implies the other: `bend` is AXIAL — the relative rotation of the piece's two ends, how much one has turned against the other, unsigned, 0 for any rigid motion (and a true 0.000 through the peel, cards and internals, which move a piece's two ends alike) — while `curl` is CIRCUMFERENTIAL and SIGNED: how much more its arcs curve than they do at their seat, positive curled tighter, negative flattened, which is what a wedge peeling off the barrel does. `stretch` and `stretch X` are its size round the bore and along it: 1 is rigid, and they are separate readings off separate probe pairs (`stretch X` is a ratio of the piece's OWN axial extent, so it runs to 100× on a 0.093mm shim the ops spread by a millimetre — as the render does). `travel` is the straight-line distance from the seat. There is no rigid half any more: story/peelcards.ts's per-piece offsets went with the cards scene's old drift departure, so every motion in the story is a deform channel and this table is all of it.

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
         scene      cast   n         dTheta         dR mm         dX mm          roll         bend          curl        stretch        stretch X  travel
--------------  --------  --  -------------  ------------  ------------  ------------  -----------  ------------  -------------  ---------------  ------
          hero    wedges  25    0.000…0.000     0.00…0.00     0.00…0.00   0.000…0.000  0.000…0.000   0.000…0.000  1.0000…1.0000    1.0000…1.0000    0.00
          hero    decals  19    0.000…0.000     0.00…0.00     0.00…0.00   0.000…0.000  0.000…0.000   0.000…0.000  1.0000…1.0000    1.0000…1.0000    0.00
          hero    extras  10    0.000…0.000     0.00…0.00     0.00…0.00   0.000…0.000  0.000…0.000   0.000…0.000  1.0000…1.0000    1.0000…1.0000    0.00
          hero  interior  65    0.000…0.000     0.00…0.00     0.00…0.00   0.000…0.000  0.000…0.000   0.000…0.000  1.0000…1.0000    1.0000…1.0000    0.00
          hero  elements  13    0.000…0.000     0.00…0.00     0.00…0.00   0.000…0.000  0.000…0.000   0.000…0.000  1.0000…1.0000    1.0000…1.0000    0.00
          hero     other  75    0.000…0.000     0.00…0.00     0.00…0.00   0.000…0.000  0.000…0.000   0.000…0.000  1.0000…1.0000    1.0000…1.0000    0.00
          zoom    wedges  25    0.000…0.000     0.00…0.00     0.00…0.00   0.000…0.000  0.000…0.000   0.000…0.000  1.0000…1.0000    1.0000…1.0000    0.00
          zoom    decals  19    0.000…0.000     0.00…0.00     0.00…0.00   0.000…0.000  0.000…0.000   0.000…0.000  1.0000…1.0000    1.0000…1.0000    0.00
          zoom    extras  10    0.000…0.000     0.00…0.00     0.00…0.00   0.000…0.000  0.000…0.000   0.000…0.000  1.0000…1.0000    1.0000…1.0000    0.00
          zoom  interior  65    0.000…0.000     0.00…0.00     0.00…0.00   0.000…0.000  0.000…0.000   0.000…0.000  1.0000…1.0000    1.0000…1.0000    0.00
          zoom  elements  13    0.000…0.000     0.00…0.00     0.00…0.00   0.000…0.000  0.000…0.000   0.000…0.000  1.0000…1.0000    1.0000…1.0000    0.00
          zoom     other  75    0.000…0.000     0.00…0.00     0.00…0.00   0.000…0.000  0.000…0.000   0.000…0.000  1.0000…1.0000    1.0000…1.0000    0.00
          peel    wedges  25    0.000…0.393    0.00…14.89     0.00…0.00  -1.959…0.000  0.000…0.000  -0.246…1.045  0.7675…1.0017    1.0000…1.0000   20.90
          peel    decals  19    0.000…0.393    0.00…14.89     0.00…0.00  -1.959…0.000  0.000…0.000  -0.246…1.045  0.7675…1.0000    1.0000…1.0000   20.90
          peel    extras  10    0.000…0.000     0.00…0.00     0.00…0.00   0.000…0.000  0.000…0.000   0.000…0.000  1.0000…1.0000    1.0000…1.0000    0.00
          peel  interior  65    0.000…0.000     0.00…0.00     0.00…0.00   0.000…0.000  0.000…0.000   0.000…0.000  1.0000…1.0000    1.0000…1.0000    0.00
          peel  elements  13    0.000…0.000     0.00…0.00     0.00…0.00   0.000…0.000  0.000…0.000   0.000…0.000  1.0000…1.0000    1.0000…1.0000    0.00
          peel     other  75    0.000…0.000     0.00…0.00     0.00…0.00   0.000…0.000  0.000…0.000   0.000…0.000  1.0000…1.0000    1.0000…1.0000    0.00
         cards    wedges  25   -1.341…0.393    0.00…67.55   -3.73…38.00  -1.959…1.951  0.000…0.000  -0.743…1.045  0.7654…1.0595    1.0000…1.0000   95.83
         cards    decals  19   -1.341…0.393    0.00…67.55    0.00…38.00  -1.959…1.951  0.000…0.000  -0.743…1.045  0.7654…1.0595    1.0000…1.0000   95.60
         cards    extras  10   -0.861…0.052    0.00…39.95    0.00…38.00  -1.150…0.000  0.000…1.222  -0.666…0.000  0.9560…1.0475    1.0000…1.2375   61.35
         cards  interior  65   -1.330…0.022    0.00…63.61  -18.67…38.00  -0.851…0.000  0.000…1.483  -0.655…0.467  0.8632…1.0459    1.0000…1.7745   88.81
         cards  elements  13    0.000…0.000     0.00…0.00     0.00…0.00   0.000…0.000  0.000…0.000   0.000…0.000  1.0000…1.0000    1.0000…1.0000    0.00
         cards     other  75    0.000…0.000     0.00…0.00     0.00…0.00   0.000…0.000  0.000…0.000   0.000…0.000  1.0000…1.0000    1.0000…1.0000    0.00
     internals    wedges  25    0.000…0.000     0.00…0.00     0.00…0.00   0.000…0.000  0.000…0.000   0.000…0.000  1.0000…1.0000    1.0000…1.0000    0.00
     internals    decals  19    0.000…0.000     0.00…0.00     0.00…0.00   0.000…0.000  0.000…0.000   0.000…0.000  1.0000…1.0000    1.0000…1.0000    0.00
     internals    extras  10    0.000…0.000     0.00…0.00     0.00…0.00   0.000…0.000  0.000…0.000   0.000…0.000  1.0000…1.0000    1.0000…1.0000    0.00
     internals  interior  65    0.000…0.000     0.00…0.00     0.00…0.00   0.000…0.000  0.000…0.000   0.000…0.000  1.0000…1.0000    1.0000…1.0000    0.00
     internals  elements  13    0.000…0.000     0.00…0.00     0.00…0.00   0.000…0.000  0.000…0.000   0.000…0.000  1.0000…1.0000    1.0000…1.0000    0.00
     internals     other  75    0.000…0.000     0.00…0.00     0.00…0.00   0.000…0.000  0.000…0.000   0.000…0.000  1.0000…1.0000    1.0000…1.0000    0.00
    flythrough    wedges  25    0.000…0.000     0.00…0.00     0.00…0.00   0.000…0.000  0.000…0.000   0.000…0.000  1.0000…1.0000    1.0000…1.0000    0.00
    flythrough    decals  19    0.000…0.000     0.00…0.00     0.00…0.00   0.000…0.000  0.000…0.000   0.000…0.000  1.0000…1.0000    1.0000…1.0000    0.00
    flythrough    extras  10    0.000…0.000     0.00…0.00     0.00…0.00   0.000…0.000  0.000…0.000   0.000…0.000  1.0000…1.0000    1.0000…1.0000    0.00
    flythrough  interior  65    0.000…0.000     0.00…0.00     0.00…0.00   0.000…0.000  0.000…0.000   0.000…0.000  1.0000…1.0000    1.0000…1.0000    0.00
    flythrough  elements  13    0.000…0.000     0.00…0.00     0.00…0.00   0.000…0.000  0.000…0.000   0.000…0.000  1.0000…1.0000    1.0000…1.0000    0.00
    flythrough     other  75    0.000…0.000     0.00…0.00     0.00…0.00   0.000…0.000  0.000…0.000   0.000…0.000  1.0000…1.0000    1.0000…1.0000    0.00
constellations    wedges  25    0.000…0.000     0.00…0.00     0.00…0.00   0.000…0.000  0.000…0.000   0.000…0.000  1.0000…1.0000    1.0000…1.0000    0.00
constellations    decals  19    0.000…0.000     0.00…0.00     0.00…0.00   0.000…0.000  0.000…0.000   0.000…0.000  1.0000…1.0000    1.0000…1.0000    0.00
constellations    extras  10    0.000…0.000     0.00…0.00     0.00…0.00   0.000…0.000  0.000…0.000   0.000…0.000  1.0000…1.0000    1.0000…1.0000    0.00
constellations  interior  65    0.000…0.000     0.00…0.00     0.00…0.00   0.000…0.000  0.000…0.000   0.000…0.000  1.0000…1.0000    1.0000…1.0000    0.00
constellations  elements  13    0.000…0.000     0.00…0.00     0.00…0.00   0.000…0.000  0.000…0.000   0.000…0.000  1.0000…1.0000    1.0000…1.0000    0.00
constellations     other  75    0.000…0.000     0.00…0.00     0.00…0.00   0.000…0.000  0.000…0.000   0.000…0.000  1.0000…1.0000    1.0000…1.0000    0.00
        trails    wedges  25   -1.118…0.000   0.00…163.46   -7.47…76.00   0.000…0.285  0.000…0.000  -0.475…0.000  1.0000…1.5630    1.0000…1.0000  184.45
        trails    decals  19   -1.118…0.000   0.00…163.46    0.00…76.00   0.000…0.285  0.000…0.000  -0.475…0.000  1.0000…1.5630    1.0000…1.0000  184.45
        trails    extras  10   -0.881…0.000    0.00…99.01    0.00…76.00  -0.283…0.196  0.000…0.644  -0.467…1.076  0.6925…1.3578    1.0000…1.1389  130.80
        trails  interior  65   -1.112…0.000   0.00…155.13  -37.33…76.00  -0.731…0.322  0.000…3.052  -0.457…1.222  0.6015…1.5703    1.0000…2.9213  172.07
        trails  elements  13    0.000…0.000     0.00…0.00  -37.33…76.00   0.000…0.000  0.000…0.000   0.000…0.000  1.0000…1.0000    1.0000…1.0000   76.00
        trails     other  75   -1.112…0.000   0.00…155.13  -56.00…12.67  -1.859…0.956  0.000…3.037  -0.514…0.944  0.5615…1.6116   1.0000…14.1255  172.07
        rewrap    wedges  25  -1.118…-0.594  80.83…163.46   -7.47…76.00  -2.721…1.174  0.000…3.104  -0.616…0.817  0.6354…1.5630    1.0000…1.4696  184.45
        rewrap    decals  19  -1.118…-0.594  82.26…163.46    0.00…76.00  -2.721…0.293  0.000…2.911  -0.616…0.717  0.6354…1.5630    1.0000…1.4440  184.45
        rewrap    extras  10  -0.881…-0.668   38.57…99.01   31.67…76.00  -0.174…0.196  0.000…0.243  -0.467…0.000  0.7538…1.3578    1.0000…1.0251  130.80
        rewrap  interior  65   -1.112…0.000   0.00…155.13  -37.33…76.00  -0.779…1.124  0.000…3.054  -0.457…1.115  0.5778…1.5711    1.0000…4.1710  172.07
        rewrap  elements  13    0.000…0.000     0.00…0.00  -37.33…76.00   0.000…0.000  0.000…0.000   0.000…0.000  1.0000…1.0000    1.0000…1.0000   76.00
        rewrap     other  75   -1.112…0.000   0.00…155.13  -56.00…12.67  -1.640…1.094  0.000…3.088  -0.593…1.124  0.5645…1.6116  1.0000…106.1153  172.07
        capsOn    wedges  25   -0.700…0.000   -8.03…90.86  -28.46…38.00   0.000…0.233  0.000…0.841   0.000…0.237  0.6514…1.8896    1.0000…1.1767  100.48
        capsOn    decals  19   -0.700…0.000   -7.98…90.86  -28.46…38.00   0.000…0.226  0.000…0.836   0.000…0.234  0.6543…1.8896    1.0000…1.1767  100.48
        capsOn    extras  10   -0.700…0.000    0.00…53.69    0.00…38.00   0.000…0.181  0.000…0.308   0.000…0.184  1.0000…1.8753    1.0000…1.0373   70.30
        capsOn  interior  65   -0.700…0.000   -6.27…85.55  -18.67…38.00   0.000…0.739  0.000…0.981   0.000…0.396  0.4334…1.3489    1.0000…2.9177   98.20
        capsOn  elements  13    0.000…0.000     0.00…0.00  -18.67…38.00   0.000…0.000  0.000…0.000   0.000…0.000  1.0000…1.0000    1.0000…1.0000   38.00
        capsOn     other  75   -0.700…0.000   -8.77…85.55  -28.00…24.47   0.000…1.333  0.000…1.199   0.000…0.450  0.4467…1.3489   1.0000…36.0364   94.24
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
          peel    wedges   0.180    6.98    0.00  -0.931  0.000   0.474   0.8973     1.0000
          peel    decals   0.217    8.30    0.00  -1.121  0.000   0.581   0.8743     1.0000
          peel    extras   0.000    0.00    0.00   0.000  0.000   0.000   1.0000     1.0000
          peel  interior   0.000    0.00    0.00   0.000  0.000   0.000   1.0000     1.0000
          peel  elements   0.000    0.00    0.00   0.000  0.000   0.000   1.0000     1.0000
          peel     other   0.000    0.00    0.00   0.000  0.000   0.000   1.0000     1.0000
         cards    wedges  -0.709   39.14    6.95  -0.326  0.000  -0.255   0.9993     1.0000
         cards    decals  -0.695   39.12   10.11  -0.315  0.000  -0.234   0.9924     1.0000
         cards    extras  -0.372   17.68   19.17  -0.209  0.065  -0.331   1.0190     1.0100
         cards  interior  -0.439   19.36   -0.16  -0.124  0.018  -0.233   1.0110     1.0103
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
        trails    wedges  -0.488   70.15   10.21   0.101  0.000  -0.160   1.2163     1.0000
        trails    decals  -0.493   70.92   15.24   0.099  0.000  -0.163   1.2147     1.0000
        trails    extras  -0.319   31.73   27.31   0.032  0.045  -0.097   1.0621     1.0087
        trails  interior  -0.328   35.05    0.26   0.068  0.046  -0.070   1.1105     1.0336
        trails  elements   0.000    0.00    8.70   0.000  0.000   0.000   1.0000     1.0000
        trails     other  -0.350   42.04  -14.18   0.068  0.034  -0.117   1.1346     1.0544
        rewrap    wedges  -0.963  137.26   20.52   0.153  0.058  -0.277   1.3611     1.0113
        rewrap    decals  -0.960  137.29   29.88   0.132  0.058  -0.288   1.3577     1.0093
        rewrap    extras  -0.771   69.29   56.24   0.092  0.012  -0.268   1.1660     1.0011
        rewrap  interior  -0.736   73.16    0.27   0.123  0.086  -0.149   1.1977     1.0284
        rewrap  elements   0.000    0.00   19.51   0.000  0.000   0.000   1.0000     1.0000
        rewrap     other  -0.749   84.68  -28.70   0.116  0.150  -0.175   1.1971     3.0302
        capsOn    wedges  -0.311   33.83   -1.33   0.037  0.150   0.044   1.1111     1.0282
        capsOn    decals  -0.311   36.36   -0.92   0.033  0.125   0.039   1.1914     1.0240
        capsOn    extras  -0.329   20.90   18.67   0.070  0.111   0.066   1.2942     1.0106
        capsOn  interior  -0.292   17.36    4.90   0.097  0.222   0.077   0.9952     1.1098
        capsOn  elements   0.000    0.00    4.02   0.000  0.000   0.000   1.0000     1.0000
        capsOn     other  -0.293   16.21    0.83   0.183  0.260   0.109   0.8483     3.5767
```

## The pieces that move — top 5 per scene

Each named at the sample where it is furthest from its seat inside the scene,
with its whole state there. Full per-piece trajectories are the API's job
(`pieceFlow(key, table)`), not this file's.

```text
 scene            piece    cast       p  travel  dTheta   dR mm  dX mm    roll   bend    curl  stretch  stretch X
------  ---------------  ------  ------  ------  ------  ------  -----  ------  -----  ------  -------  ---------
  peel    Band_Mid_Seg2  wedges  0.1731   20.90   0.393   14.89   0.00  -1.959  0.000   1.045   0.7675     1.0000
  peel    DecalT_BadgeC  decals  0.1731   20.90   0.393   14.89   0.00  -1.959  0.000   1.045   0.7675     1.0000
  peel  Decal_BadgeDisc  decals  0.1731   20.90   0.393   14.89   0.00  -1.959  0.000   1.045   0.7675     1.0000
  peel  Ring_Focus_Seg4  wedges  0.1731   20.86   0.393   14.87   0.00  -1.818  0.000   0.683   0.8711     1.0000
  peel    Band_Mid_Seg0  wedges  0.1792   20.39   0.384   14.62   0.00  -1.941  0.000   1.033   0.7723     1.0000
 cards  Ring_Focus_Seg0  wedges  0.2547   95.83  -1.337   67.31  -3.73  -0.291  0.000  -0.603   1.0387     1.0000
 cards   DecalT_Zoom_50  decals  0.2665   95.60  -1.307   65.43  25.33  -0.289  0.000  -0.599   1.0382     1.0000
 cards   Ring_Zoom_Seg4  wedges  0.2665   95.60  -1.307   65.43  25.33  -0.289  0.000  -0.599   1.0382     1.0000
 cards  Ring_Focus_Seg2  wedges  0.2665   95.53  -1.325   67.39  -3.73  -0.302  0.000  -0.626   1.0418     1.0000
 cards  Ring_Focus_Seg1  wedges  0.2547   95.51  -1.324   67.40  -3.73  -0.303  0.000  -0.628   1.0420     1.0000
trails   DecalT_Zoom_18  decals  0.7109  184.45  -1.090  159.29  50.67   0.245  0.000  -0.401   1.5386     1.0000
trails   DecalT_Zoom_24  decals  0.7109  184.45  -1.090  159.29  50.67   0.245  0.000  -0.401   1.5386     1.0000
trails   DecalT_Zoom_28  decals  0.7109  184.45  -1.090  159.29  50.67   0.245  0.000  -0.401   1.5386     1.0000
trails   DecalT_Zoom_35  decals  0.7109  184.45  -1.090  159.29  50.67   0.245  0.000  -0.401   1.5386     1.0000
trails   Ring_Zoom_Seg3  wedges  0.7109  184.45  -1.090  159.29  50.67   0.245  0.000  -0.401   1.5386     1.0000
rewrap   DecalT_Zoom_18  decals  0.7687  184.45  -1.090  159.29  50.67   0.245  0.000  -0.401   1.5386     1.0000
rewrap   DecalT_Zoom_24  decals  0.7687  184.45  -1.090  159.29  50.67   0.245  0.000  -0.401   1.5386     1.0000
rewrap   DecalT_Zoom_28  decals  0.7687  184.45  -1.090  159.29  50.67   0.245  0.000  -0.401   1.5386     1.0000
rewrap   DecalT_Zoom_35  decals  0.7687  184.45  -1.090  159.29  50.67   0.245  0.000  -0.401   1.5386     1.0000
rewrap   Ring_Zoom_Seg3  wedges  0.7687  184.45  -1.090  159.29  50.67   0.245  0.000  -0.401   1.5386     1.0000
capsOn   DecalT_Zoom_18  decals  0.8844  100.48  -0.700   88.26  25.33   0.000  0.000   0.000   1.0000     1.0000
capsOn   DecalT_Zoom_24  decals  0.8844  100.48  -0.700   88.26  25.33   0.000  0.000   0.000   1.0000     1.0000
capsOn   DecalT_Zoom_28  decals  0.8844  100.48  -0.700   88.26  25.33   0.000  0.000   0.000   1.0000     1.0000
capsOn   DecalT_Zoom_35  decals  0.8844  100.48  -0.700   88.26  25.33   0.000  0.000   0.000   1.0000     1.0000
capsOn   Ring_Zoom_Seg3  wedges  0.8844  100.48  -0.700   88.26  25.33   0.000  0.000   0.000   1.0000     1.0000
```
