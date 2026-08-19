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

**Model:** `lens_web_segmented.glb` — 194 mesh nodes, 74,283 triangles, 86,966 vertices seated, plus 176 ink edge lines carrying 66,956 vertices of their own (every mesh but the decals, cut at 24° — `materials/unified.ts`). `lens_web_accessories.glb` — 5 nodes, 27,657 triangles, NONE of which the story ever draws (it is loaded for `/lens`'s accessory toggles; the hero shows no cap, hood or filter at any `p`), and they are censused here only to keep their triangles out of the model's own count.

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
         scene   holdP  meshes  kTris  kVerts  kLineV  draws  transp  holdKTris  holdDraws  glassTx  post                               channels
--------------  ------  ------  -----  ------  ------  -----  ------  ---------  ---------  -------  ----  -------------------------------------
          hero  0.0306     194   74.3    87.0    67.0    374     374       74.3        374        —     —                                  story
          zoom  0.1347     194   74.3    87.0    67.0    382     382       74.3        382        —     —                             story zoom
          peel  0.2233     194   74.3    87.0    67.0    382     382       74.3        382        —     —         aperture focus peel story zoom
         cards  0.3010     194   74.3    87.0    67.0    382     382       31.7        164        —     —     aperture assemble focus peel story
     internals  0.3946      76   31.7    37.1    23.7    164     164       31.7        156        —     —                   aperture focus story
    flythrough  0.5034     141   46.2    57.2    23.7    156     156       46.2        145      yes   yes                   aperture focus story
constellations  0.6088      13   12.9     7.4     0.0     25      24        0.0         12      yes   yes                            focus story
        trails  0.7109       0    0.0     0.0     0.0     14      13        0.0         14        —   yes           assemble explode focus story
        rewrap  0.8815     194   74.3    87.0    67.0    384     383       74.3        374      yes   yes  aperture assemble explode focus story
        capsOn  0.9827     194   74.3    87.0    67.0    374     374       74.3        374        —     —            aperture explode rose story
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
     p           scene  meshes  kTris  kVerts  kLineV  draws  model  ovl  sky  transp  glassTx  post  cards                            channels
------  --------------  ------  -----  ------  ------  -----  -----  ---  ---  ------  -------  ----  -----  ----------------------------------
0.0000            hero     194   74.3    87.0    67.0    374    370    4    0     374        0     —      0                                   —
0.0061            hero     194   74.3    87.0    67.0    374    370    4    0     374        0     —      0                               story
0.0306            hero     194   74.3    87.0    67.0    374    370    4    0     374        0     —      0                               story
0.0412            hero     194   74.3    87.0    67.0    374    370    4    0     374        0     —      0                               story
0.0551            hero     194   74.3    87.0    67.0    374    370    4    0     374        0     —      0                               story
0.0612            zoom     194   74.3    87.0    67.0    382    370   12    0     382        0     —      8                               story
0.0750            zoom     194   74.3    87.0    67.0    382    370   12    0     382        0     —      8                               story
0.0812            zoom     194   74.3    87.0    67.0    382    370   12    0     382        0     —      8                          story zoom
0.1071            zoom     194   74.3    87.0    67.0    382    370   12    0     382        0     —      8                          story zoom
0.1182            zoom     194   74.3    87.0    67.0    382    370   12    0     382        0     —      8                          story zoom
0.1331            zoom     194   74.3    87.0    67.0    382    370   12    0     382        0     —      8                          story zoom
0.1347            zoom     194   74.3    87.0    67.0    382    370   12    0     382        0     —      8                          story zoom
0.1531            peel     194   74.3    87.0    67.0    382    370   12    0     382        0     —      8                          story zoom
0.1731            peel     194   74.3    87.0    67.0    382    370   12    0     382        0     —      8                     peel story zoom
0.1792            peel     194   74.3    87.0    67.0    382    370   12    0     382        0     —      8                     peel story zoom
0.1816            peel     194   74.3    87.0    67.0    382    370   12    0     382        0     —      8                     peel story zoom
0.1857            peel     194   74.3    87.0    67.0    382    370   12    0     382        0     —      8                          peel story
0.2147            peel     194   74.3    87.0    67.0    382    370   12    0     382        0     —      8                          peel story
0.2233            peel     194   74.3    87.0    67.0    382    370   12    0     382        0     —      8                          peel story
0.2280            peel     194   74.3    87.0    67.0    382    370   12    0     382        0     —      8           aperture focus peel story
0.2347           cards     194   74.3    87.0    67.0    382    370   12    0     382        0     —      8           aperture focus peel story
0.2382           cards     194   74.3    87.0    67.0    382    370   12    0     382        0     —      8           aperture focus peel story
0.2547           cards     194   74.3    87.0    67.0    382    370   12    0     382        0     —      8  aperture assemble focus peel story
0.2665           cards     194   74.3    87.0    67.0    382    370   12    0     382        0     —      8       aperture assemble focus story
0.2701           cards     194   74.3    87.0    67.0    382    370   12    0     382        0     —      8       aperture assemble focus story
0.2718           cards     194   74.3    87.0    67.0    382    370   12    0     382        0     —      8       aperture assemble focus story
0.2833           cards      87   32.8    38.5    25.1    186    174   12    0     186        0     —      8       aperture assemble focus story
0.2895           cards      76   31.7    37.1    23.7    164    152   12    0     164        0     —      8       aperture assemble focus story
0.2913           cards      76   31.7    37.1    23.7    164    152   12    0     164        0     —      8       aperture assemble focus story
0.3001           cards      76   31.7    37.1    23.7    164    152   12    0     164        0     —      8                aperture focus story
0.3010           cards      76   31.7    37.1    23.7    164    152   12    0     164        0     —      8                aperture focus story
0.3031           cards      76   31.7    37.1    23.7    164    152   12    0     164        0     —      8                aperture focus story
0.3231       internals      76   31.7    37.1    23.7    164    152   12    0     164        0     —      8                aperture focus story
0.3431       internals      76   31.7    37.1    23.7    156    152    4    0     156        0     —      0                aperture focus story
0.3803       internals      76   31.7    37.1    23.7    156    152    4    0     156        0     —      0                aperture focus story
0.3946       internals      76   31.7    37.1    23.7    156    152    4    0     156        0     —      0                aperture focus story
0.3984       internals      76   31.7    37.1    23.7    156    152    4    0     156        0     —      0                aperture focus story
0.4136       internals      76   31.7    37.1    23.7    156    152    4    0     156        0     —      0                aperture focus story
0.4184      flythrough      76   31.7    37.1    23.7    156    152    4    0     156        0     —      0                aperture focus story
0.4372      flythrough      76   31.7    37.1     0.0     80     76    4    0      17       13     —      0                      aperture story
0.4374      flythrough      76   31.7    37.1     0.0     80     76    4    0      17       13     —      0                      aperture story
0.4384      flythrough      76   31.7    37.1     0.0     80     76    4    0      17       13     —      0                      aperture story
0.4422      flythrough      95   35.6    42.5     0.0     99     95    3    1      16       13    on      0                      aperture story
0.4476      flythrough     141   46.2    57.2     0.0    145    141    3    1      16       13    on      0                      aperture story
0.5034      flythrough     141   46.2    57.2     0.0    145    141    3    1      16       13    on      0                               story
0.5446      flythrough     141   46.2    57.2     0.0    153    141   11    1      24       13    on      0                         focus story
0.5646  constellations      13   12.9     7.4     0.0     25     13   11    1      24       13    on      0                         focus story
0.5846  constellations       0    0.0     0.0     0.0     12      0   11    1      11        0    on      0                         focus story
0.6088  constellations       0    0.0     0.0     0.0     12      0   11    1      11        0    on      0                         focus story
0.6331  constellations       0    0.0     0.0     0.0     14      0   13    1      13        0    on      0                         focus story
0.6531          trails       0    0.0     0.0     0.0     14      0   13    1      13        0    on      0                         focus story
0.6588          trails       0    0.0     0.0     0.0     14      0   13    1      13        0    on      0                         focus story
0.6646          trails       0    0.0     0.0     0.0     14      0   13    1      13        0    on      0                 explode focus story
0.6704          trails       0    0.0     0.0     0.0     14      0   13    1      13        0    on      0                 explode focus story
0.6731          trails       0    0.0     0.0     0.0     14      0   13    1      13        0    on      0        assemble explode focus story
0.6820          trails       0    0.0     0.0     0.0     14      0   13    1      13        0    on      0        assemble explode focus story
0.7109          trails       0    0.0     0.0     0.0     14      0   13    1      13        0    on      0        assemble explode focus story
0.7224          trails       0    0.0     0.0     0.0     14      0   13    1      13        0    on      0        assemble explode focus story
0.7456          trails       0    0.0     0.0     0.0     14      0   13    1      13        0    on      0        assemble explode focus story
0.7487          trails       0    0.0     0.0     0.0     14      0   13    1      13        0    on      0        assemble explode focus story
0.7687          rewrap       0    0.0     0.0     0.0     14      0   13    1      13        0    on      0        assemble explode focus story
0.7745          rewrap       0    0.0     0.0     0.0     14      0   13    1      13        0    on      0        assemble explode focus story
0.7751          rewrap       0    0.0     0.0     0.0     14      0   13    1      13        0    on      0        assemble explode focus story
0.7803          rewrap     194   74.3    87.0     0.0    208    194   13    1     207       13    on      0        assemble explode focus story
0.7872          rewrap     194   74.3    87.0     0.0    208    194   13    1      26       13    on      0        assemble explode focus story
0.7887          rewrap     194   74.3    87.0    67.0    384    370   13    1     383       13    on      0        assemble explode focus story
0.7976          rewrap     194   74.3    87.0    67.0    376    370    5    1     375       13    on      0        assemble explode focus story
0.8057          rewrap     194   74.3    87.0    67.0    376    370    5    1     375        0    on      0        assemble explode focus story
0.8103          rewrap     194   74.3    87.0    67.0    376    370    5    1     375        0    on      0        assemble explode focus story
0.8288          rewrap     194   74.3    87.0    67.0    375    370    4    1     374        0    on      0        assemble explode focus story
0.8358          rewrap     194   74.3    87.0    67.0    375    370    4    1     374        0    on      0        assemble explode focus story
0.8612          rewrap     194   74.3    87.0    67.0    374    370    4    0     374        0     —      0     aperture assemble explode story
0.8644          rewrap     194   74.3    87.0    67.0    374    370    4    0     374        0     —      0     aperture assemble explode story
0.8728          rewrap     194   74.3    87.0    67.0    374    370    4    0     374        0     —      0              aperture explode story
0.8815          rewrap     194   74.3    87.0    67.0    374    370    4    0     374        0     —      0              aperture explode story
0.8844          capsOn     194   74.3    87.0    67.0    374    370    4    0     374        0     —      0              aperture explode story
0.8901          capsOn     194   74.3    87.0    67.0    374    370    4    0     374        0     —      0              aperture explode story
0.9044          capsOn     194   74.3    87.0    67.0    374    370    4    0     374        0     —      0              aperture explode story
0.9480          capsOn     194   74.3    87.0    67.0    374    370    4    0     374        0     —      0                      aperture story
0.9561          capsOn     194   74.3    87.0    67.0    374    370    4    0     374        0     —      0                      aperture story
0.9734          capsOn     194   74.3    87.0    67.0    374    370    4    0     374        0     —      0                 aperture rose story
0.9827          capsOn     194   74.3    87.0    67.0    374    370    4    0     374        0     —      0                 aperture rose story
0.9942          capsOn     194   74.3    87.0    67.0    374    370    4    0     374        0     —      0                 aperture rose story
1.0000          capsOn     194   74.3    87.0    67.0    374    370    4    0     374        0     —      0                 aperture rose story
```
