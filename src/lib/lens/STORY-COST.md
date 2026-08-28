<!-- GENERATED — do not edit by hand. See story/__tests__/story-cost.test.ts. -->

# STORY-COST

The hero story's RENDERER WORKLOAD at every interesting scroll position `p` —
how much geometry is on screen and which op chains are doing nonzero work,
with no clock in it anywhere. Rendered from `story/cost.ts`'s
`storyCostAt(p, table)`, whose state comes from `storyStateAt(p)` and whose
geometry comes out of the shipped GLB itself — the mesh counts from its JSON
chunk, the ink line-work cut from its BIN chunk. Regenerate with

    LENS_STORY_COST=1 npx vitest run src/lib/lens/story/__tests__/story-cost.test.ts

and `story/__tests__/story-cost.test.ts` asserts the checked-in file matches,
so a wave that makes a scene heavier fails the suite with the new table in the
diff.

**Model:** `lens_web_segmented.glb` — 194 mesh nodes, 74,283 triangles, 86,966 vertices seated, plus 163 ink edge lines carrying 65,100 vertices of their own (every mesh but the decals and the elements, cut at 24° — `materials/unified.ts`). `lens_web_accessories.glb` — 5 nodes, 27,657 triangles, NONE of which the story ever draws (it is loaded for `/lens`'s accessory toggles; the hero shows no cap, hood or filter at any `p`), and they are censused here only to keep their triangles out of the model's own count.

**What it is not.** An UPPER BOUND, and deliberately so: frustum culling is off
on this whole path (in-shader displacement invalidates rest-pose bounds), so
"everything visible is drawn" is what the renderer actually does. It counts no
pixels — no overdraw, no blur passes, no pipeline counts; `glassTx` and
`post` are reported as the flags they are. It is the AUTHORED cost at `p`,
so every residual `story/state.ts` declares (ease lag, phase clocks, mount
latches) applies here too. `story/cost.ts`'s header has the full list.

**Vertices and the deform.** The vertex load of a frame is
`kVerts + kLineV`: the visible meshes AND the ink edge lines they carry, whose
materials run the same deform fold as the surfaces they outline. `kLineV` is
the measured EdgesGeometry vertex count of those lines, and it is 0 wherever the
ink is off, since that is where the line objects are hidden.

Both halves go through the deform host's one baked graph. The hero pins
`assemble / explode / peel / rose`, but each recipe's chain sits inside
`If(channel ≥ 1e-6, …)` — a uniform branch — so an IDLE recipe executes
nothing at all. Every recipe channel rests at 0, so the recipes doing
per-vertex work in a row are exactly the pinned ones listed in that row's
`channels`, and the cost is `(kVerts + kLineV) × those` — not
`× 4 recipes`, which is what it was everywhere until the
fold learned to branch. `channels` also names the non-deform chains a scene
drives, the same "which chains are producing deltas here" signal it always was.

## Per scene

`max` is over every sample inside the scene's range; `hold` is the reading at
the scene's hold centre — the `?story` scrubber's own jump target, and where a
reader actually rests. `kVerts` and `kLineV` are the two halves of the vertex
load and each is its own maximum, so their sum is a bound rather than a reading
at one `p`. This is the diff surface: regenerate after a wave and read this
table.

```text
         scene   holdP  meshes  kTris  kVerts  kLineV  draws  transp  holdKTris  holdDraws  glassTx  post                              channels
--------------  ------  ------  -----  ------  ------  -----  ------  ---------  ---------  -------  ----  ------------------------------------
          hero  0.0288     194   74.3    87.0    65.1    361     361       74.3        361        —     —                                 story
          zoom  0.1265     194   74.3    87.0    65.1    369     369       74.3        369        —     —                            story zoom
          peel  0.2233     194   74.3    87.0    65.1    369     369       53.3        247        —     —    aperture assemble focus story zoom
         cards  0.3019      76   31.7    37.1    21.9    151     151       31.7        151        —     —  aperture assemble focus huddle story
     internals  0.3898      76   31.7    37.1    21.9    151     151       31.7        143        —     —           aperture focus huddle story
    flythrough  0.5016     141   46.2    57.2    21.9    153     143       46.2        145      yes   yes                  aperture focus story
constellations  0.6006      13   12.9     7.4     0.0     25      24        0.0         12      yes   yes                           focus story
        trails  0.6965       0    0.0     0.0     0.0     13      12        0.0         13        —   yes                   explode focus story
        rewrap  0.8567     194   74.3    87.0    65.1    370     369       74.3        361      yes   yes          aperture explode focus story
        capsOn  0.9606     194   74.3    87.0    65.1    361     361       74.3        361        —     —           aperture explode rose story
```

## At every edge

One row per scene edge, caption-band edge, window edge and scene hold centre.
`draws` is the total; `model`/`ovl`/`sky` are its parts (meshes plus ink
edge-lines / the mounted overlays / the starfield) — and they are ALL of it,
since no accessory is ever drawn on the story path.
`kVerts` is the visible meshes' vertices and `kLineV` those of their edge
lines — the frame's vertex load is the SUM.
`transp` counts surfaces in three's transparent list — the starfield is
deliberately absent from it, since it rides the OPAQUE list to stay inside the
transmission copy. The body is in that list whenever any ink shows or a body
fade runs (materials/unified.ts `bodyTransparent`). `glassTx` is the number of
visible glass meshes still wearing a transmissive material: any at all costs a
full framebuffer copy per frame.

```text
     p           scene  meshes  kTris  kVerts  kLineV  draws  model  ovl  sky  transp  glassTx  post  cards                              channels
------  --------------  ------  -----  ------  ------  -----  -----  ---  ---  ------  -------  ----  -----  ------------------------------------
0.0000            hero     194   74.3    87.0    65.1    361    357    4    0     361        0     —      0                                     —
0.0058            hero     194   74.3    87.0    65.1    361    357    4    0     361        0     —      0                                 story
0.0288            hero     194   74.3    87.0    65.1    361    357    4    0     361        0     —      0                                 story
0.0375            hero     194   74.3    87.0    65.1    361    357    4    0     361        0     —      0                                 story
0.0518            hero     194   74.3    87.0    65.1    361    357    4    0     361        0     —      0                                 story
0.0575            zoom     194   74.3    87.0    65.1    369    357   12    0     369        0     —      8                                 story
0.0704            zoom     194   74.3    87.0    65.1    369    357   12    0     369        0     —      8                                 story
0.0775            zoom     194   74.3    87.0    65.1    369    357   12    0     369        0     —      8                            story zoom
0.1006            zoom     194   74.3    87.0    65.1    369    357   12    0     369        0     —      8                            story zoom
0.1110            zoom     194   74.3    87.0    65.1    369    357   12    0     369        0     —      8                            story zoom
0.1238            zoom     194   74.3    87.0    65.1    369    357   12    0     369        0     —      8                            story zoom
0.1265            zoom     194   74.3    87.0    65.1    369    357   12    0     369        0     —      8                            story zoom
0.1438            peel     194   74.3    87.0    65.1    369    357   12    0     369        0     —      8                            story zoom
0.1495            peel     194   74.3    87.0    65.1    369    357   12    0     369        0     —      8                            story zoom
0.1534            peel     194   74.3    87.0    65.1    369    357   12    0     369        0     —      8                            story zoom
0.1638            peel     194   74.3    87.0    65.1    369    357   12    0     369        0     —      8                   assemble story zoom
0.1773            peel     194   74.3    87.0    65.1    369    357   12    0     369        0     —      8                   assemble story zoom
0.1821            peel     194   74.3    87.0    65.1    369    357   12    0     369        0     —      8                        assemble story
0.2070            peel     194   74.3    87.0    65.1    369    357   12    0     369        0     —      8                        assemble story
0.2196            peel     156   66.4    75.3    58.7    309    297   12    0     309        0     —      8                        assemble story
0.2233            peel     124   53.3    60.9    45.2    247    235   12    0     247        0     —      8                        assemble story
0.2319            peel      81   32.3    37.9    22.5    161    149   12    0     161        0     —      8                        assemble story
0.2321            peel      81   32.3    37.9    22.5    161    149   12    0     161        0     —      8         aperture assemble focus story
0.2387            peel      76   31.7    37.1    21.9    151    139   12    0     151        0     —      8         aperture assemble focus story
0.2396           cards      76   31.7    37.1    21.9    151    139   12    0     151        0     —      8         aperture assemble focus story
0.2413           cards      76   31.7    37.1    21.9    151    139   12    0     151        0     —      8         aperture assemble focus story
0.2496           cards      76   31.7    37.1    21.9    151    139   12    0     151        0     —      8  aperture assemble focus huddle story
0.2529           cards      76   31.7    37.1    21.9    151    139   12    0     151        0     —      8  aperture assemble focus huddle story
0.2596           cards      76   31.7    37.1    21.9    151    139   12    0     151        0     —      8  aperture assemble focus huddle story
0.2612           cards      76   31.7    37.1    21.9    151    139   12    0     151        0     —      8           aperture focus huddle story
0.3019           cards      76   31.7    37.1    21.9    151    139   12    0     151        0     —      8           aperture focus huddle story
0.3027           cards      76   31.7    37.1    21.9    151    139   12    0     151        0     —      8           aperture focus huddle story
0.3061           cards      76   31.7    37.1    21.9    151    139   12    0     151        0     —      8           aperture focus huddle story
0.3227       internals      76   31.7    37.1    21.9    151    139   12    0     151        0     —      8           aperture focus huddle story
0.3427       internals      76   31.7    37.1    21.9    143    139    4    0     143        0     —      0           aperture focus huddle story
0.3495       internals      76   31.7    37.1    21.9    143    139    4    0     143        0     —      0                  aperture focus story
0.3764       internals      76   31.7    37.1    21.9    143    139    4    0     143        0     —      0                  aperture focus story
0.3898       internals      76   31.7    37.1    21.9    143    139    4    0     143        0     —      0                  aperture focus story
0.3921       internals      76   31.7    37.1    21.9    143    139    4    0     143        0     —      0                  aperture focus story
0.4077       internals      76   31.7    37.1    21.9    143    139    4    0     143        0     —      0                  aperture focus story
0.4121      flythrough      76   31.7    37.1    21.9    143    139    4    0     143        0     —      0                  aperture focus story
0.4321      flythrough      76   31.7    37.1    21.9    143    139    4    0     143       13     —      0                        aperture story
0.4391      flythrough      76   31.7    37.1     0.0     80     76    4    0      17       13     —      0                        aperture story
0.4441      flythrough      76   31.7    37.1     0.0     80     76    3    1      16       13    on      0                        aperture story
0.4544      flythrough     141   46.2    57.2     0.0    145    141    3    1      16       13    on      0                        aperture story
0.5016      flythrough     141   46.2    57.2     0.0    145    141    3    1      16       13    on      0                                 story
0.5391      flythrough     141   46.2    57.2     0.0    153    141   11    1      24       13    on      0                           focus story
0.5591  constellations      13   12.9     7.4     0.0     25     13   11    1      24       13    on      0                           focus story
0.5791  constellations       0    0.0     0.0     0.0     12      0   11    1      11        0    on      0                           focus story
0.6006  constellations       0    0.0     0.0     0.0     12      0   11    1      11        0    on      0                           focus story
0.6222  constellations       0    0.0     0.0     0.0     13      0   12    1      12        0    on      0                           focus story
0.6422          trails       0    0.0     0.0     0.0     13      0   12    1      12        0    on      0                           focus story
0.6476          trails       0    0.0     0.0     0.0     13      0   12    1      12        0    on      0                           focus story
0.6622          trails       0    0.0     0.0     0.0     13      0   12    1      12        0    on      0                   explode focus story
0.6693          trails       0    0.0     0.0     0.0     13      0   12    1      12        0    on      0                   explode focus story
0.6965          trails       0    0.0     0.0     0.0     13      0   12    1      12        0    on      0                   explode focus story
0.7308          trails       0    0.0     0.0     0.0     13      0   12    1      12        0    on      0                   explode focus story
0.7508          rewrap       0    0.0     0.0     0.0     13      0   12    1      12        0    on      0                   explode focus story
0.7562          rewrap       0    0.0     0.0     0.0     13      0   12    1      12        0    on      0                   explode focus story
0.7568          rewrap       0    0.0     0.0     0.0     13      0   12    1      12        0    on      0                   explode focus story
0.7682          rewrap     194   74.3    87.0     0.0    207    194   12    1      25       13    on      0                   explode focus story
0.7708          rewrap     194   74.3    87.0    65.1    370    357   12    1     369       13    on      0                   explode focus story
0.7780          rewrap     194   74.3    87.0    65.1    362    357    4    1     361       13    on      0                   explode focus story
0.7856          rewrap     194   74.3    87.0    65.1    362    357    4    1     361        0    on      0                   explode focus story
0.7899          rewrap     194   74.3    87.0    65.1    362    357    4    1     361        0    on      0                   explode focus story
0.8073          rewrap     194   74.3    87.0    65.1    361    357    3    1     360        0    on      0                   explode focus story
0.8138          rewrap     194   74.3    87.0    65.1    361    357    3    1     360        0    on      0                   explode focus story
0.8394          rewrap     194   74.3    87.0    65.1    361    357    4    0     361        0     —      0                aperture explode story
0.8567          rewrap     194   74.3    87.0    65.1    361    357    4    0     361        0     —      0                aperture explode story
0.8594          capsOn     194   74.3    87.0    65.1    361    357    4    0     361        0     —      0                aperture explode story
0.8794          capsOn     194   74.3    87.0    65.1    361    357    4    0     361        0     —      0                aperture explode story
0.9213          capsOn     194   74.3    87.0    65.1    361    357    4    0     361        0     —      0                aperture explode story
0.9494          capsOn     194   74.3    87.0    65.1    361    357    4    0     361        0     —      0                        aperture story
0.9578          capsOn     194   74.3    87.0    65.1    361    357    4    0     361        0     —      0                        aperture story
0.9606          capsOn     194   74.3    87.0    65.1    361    357    4    0     361        0     —      0                        aperture story
0.9677          capsOn     194   74.3    87.0    65.1    361    357    4    0     361        0     —      0                   aperture rose story
0.9944          capsOn     194   74.3    87.0    65.1    361    357    4    0     361        0     —      0                   aperture rose story
1.0000          capsOn     194   74.3    87.0    65.1    361    357    4    0     361        0     —      0                   aperture rose story
```
