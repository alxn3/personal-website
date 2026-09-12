<!-- GENERATED — do not edit by hand. See story/__tests__/story-cost.test.ts. -->

# STORY-COST

Renderer workload at every scene, band and window edge: the geometry on screen
and which op chains do nonzero work, rendered from `story/cost.ts`'s
`storyCostAt(p, table)` over the shipped GLB's own chunks. An UPPER BOUND
(frustum culling is off on this path); no pixel, overdraw or pipeline counts;
`glassTx` and `post` are flags. Regenerate (the test pins the file
byte-for-byte):

    LENS_STORY_COST=1 npx vitest run src/lib/lens/story/__tests__/story-cost.test.ts

**Model:** `lens_web_segmented.glb` — 194 mesh nodes, 74,283 triangles, 86,966 vertices seated, plus 163 ink edge lines carrying 65,100 vertices of their own (every mesh but the decals and the elements, cut at 24° — `materials/unified.ts`). `lens_web_accessories.glb` — 5 nodes, 27,657 triangles, NONE of which the story ever draws (it is loaded for `/lens`'s accessory toggles; the hero shows no cap, hood or filter at any `p`), and they are censused here only to keep their triangles out of the model's own count.

A frame's vertex load is `kVerts + kLineV`: the visible meshes plus their ink
edge lines, which run the same deform (`kLineV` is 0 wherever the ink is off).
Each recipe's chain sits inside `If(channel ≥ 1e-6, …)`, so only the recipes
listed in a row's `channels` do per-vertex work.

## Per scene

`max` is over every sample inside the scene's range; `hold` is the reading at
the hold centre (the `?story` scrubber's jump target). `kVerts` and `kLineV`
are separate maxima, so their sum is a bound.

```text
         scene   holdP  meshes  kTris  kVerts  kLineV  draws  transp  holdKTris  holdDraws  glassTx  post                              channels
--------------  ------  ------  -----  ------  ------  -----  ------  ---------  ---------  -------  ----  ------------------------------------
          hero  0.0284     194   74.3    87.0    65.1    361     361       74.3        361        —     —                                 story
          zoom  0.1249     194   74.3    87.0    65.1    369     369       74.3        369        —     —                   assemble story zoom
          peel  0.2205     194   74.3    87.0    65.1    369     369       69.9        338        —     —    aperture assemble focus story zoom
         cards  0.2981      89   44.5    49.9    34.8    177     177       31.7        151        —     —  aperture assemble focus huddle story
     internals  0.3760      76   31.7    37.1    21.9    151     151       31.7        143        —     —           aperture focus huddle story
    flythrough  0.4953     141   46.2    57.2    21.9    153     152       46.2        145      yes   yes                  aperture focus story
constellations  0.5931      13   12.9     7.4     0.0     25      24        0.0         12      yes   yes                           focus story
        trails  0.6877       0    0.0     0.0     0.0     13      12        0.0         13        —   yes                   explode focus story
        rewrap  0.8564     194   74.3    87.0    65.1    362     361       74.3        361      yes   yes          aperture explode focus story
        capsOn  0.9611     194   74.3    87.0    65.1    361     361       74.3        361        —     —           aperture explode rose story
```

## At every edge

One row per scene edge, caption-band edge, window edge and hold centre.
`draws` = `model` + `ovl` + `sky` (no accessory is ever drawn on the story
path). `transp` counts three's transparent list (the starfield rides the opaque
list); `glassTx` counts visible transmissive glass meshes — any at all costs a
framebuffer copy per frame.

```text
     p           scene  meshes  kTris  kVerts  kLineV  draws  model  ovl  sky  transp  glassTx  post  cards                              channels
------  --------------  ------  -----  ------  ------  -----  -----  ---  ---  ------  -------  ----  -----  ------------------------------------
0.0000            hero     194   74.3    87.0    65.1    361    357    4    0     361        0     —      0                                     —
0.0057            hero     194   74.3    87.0    65.1    361    357    4    0     361        0     —      0                                 story
0.0284            hero     194   74.3    87.0    65.1    361    357    4    0     361        0     —      0                                 story
0.0468            hero     194   74.3    87.0    65.1    361    357    4    0     361        0     —      0                                 story
0.0511            hero     194   74.3    87.0    65.1    361    357    4    0     361        0     —      0                                 story
0.0568            zoom     194   74.3    87.0    65.1    369    357   12    0     369        0     —      8                                 story
0.0668            zoom     194   74.3    87.0    65.1    369    357   12    0     369        0     —      8                                 story
0.0696            zoom     194   74.3    87.0    65.1    369    357   12    0     369        0     —      8                                 story
0.0994            zoom     194   74.3    87.0    65.1    369    357   12    0     369        0     —      8                            story zoom
0.1249            zoom     194   74.3    87.0    65.1    369    357   12    0     369        0     —      8                            story zoom
0.1292            zoom     194   74.3    87.0    65.1    369    357   12    0     369        0     —      8                            story zoom
0.1320            zoom     194   74.3    87.0    65.1    369    357   12    0     369        0     —      8                   assemble story zoom
0.1420            peel     194   74.3    87.0    65.1    369    357   12    0     369        0     —      8                   assemble story zoom
0.1476            peel     194   74.3    87.0    65.1    369    357   12    0     369        0     —      8                   assemble story zoom
0.1520            peel     194   74.3    87.0    65.1    369    357   12    0     369        0     —      8                   assemble story zoom
0.1751            peel     194   74.3    87.0    65.1    369    357   12    0     369        0     —      8                   assemble story zoom
0.1798            peel     194   74.3    87.0    65.1    369    357   12    0     369        0     —      8                        assemble story
0.1959            peel     194   74.3    87.0    65.1    369    357   12    0     369        0     —      8                        assemble story
0.2205            peel     175   69.9    80.2    61.7    338    326   12    0     338        0     —      8                        assemble story
0.2224            peel     164   68.3    78.0    60.1    320    308   12    0     320        0     —      8                        assemble story
0.2266            peel     139   63.6    71.4    55.4    277    265   12    0     277        0     —      8                        assemble story
0.2289            peel     126   61.7    69.0    53.2    251    239   12    0     251        0     —      8         aperture assemble focus story
0.2290            peel     124   61.5    68.7    53.0    247    235   12    0     247        0     —      8         aperture assemble focus story
0.2328            peel     104   52.5    58.4    43.1    207    195   12    0     207        0     —      8         aperture assemble focus story
0.2366           cards      89   44.5    49.9    34.8    177    165   12    0     177        0     —      8         aperture assemble focus story
0.2382           cards      87   42.2    47.7    32.4    173    161   12    0     173        0     —      8         aperture assemble focus story
0.2466           cards      77   32.8    38.2    23.2    153    141   12    0     153        0     —      8  aperture assemble focus huddle story
0.2489           cards      76   31.7    37.1    21.9    151    139   12    0     151        0     —      8  aperture assemble focus huddle story
0.2497           cards      76   31.7    37.1    21.9    151    139   12    0     151        0     —      8  aperture assemble focus huddle story
0.2612           cards      76   31.7    37.1    21.9    151    139   12    0     151        0     —      8           aperture focus huddle story
0.2981           cards      76   31.7    37.1    21.9    151    139   12    0     151        0     —      8           aperture focus huddle story
0.3022           cards      76   31.7    37.1    21.9    151    139   12    0     151        0     —      8           aperture focus huddle story
0.3031           cards      76   31.7    37.1    21.9    151    139   12    0     151        0     —      8           aperture focus huddle story
0.3086           cards      76   31.7    37.1    21.9    151    139   12    0     151        0     —      8           aperture focus huddle story
0.3177           cards      76   31.7    37.1    21.9    151    139   12    0     151        0     —      8           aperture focus huddle story
0.3186       internals      76   31.7    37.1    21.9    151    139   12    0     151        0     —      8           aperture focus huddle story
0.3286       internals      76   31.7    37.1    21.9    143    139    4    0     143        0     —      0           aperture focus huddle story
0.3451       internals      76   31.7    37.1    21.9    143    139    4    0     143        0     —      0                  aperture focus story
0.3716       internals      76   31.7    37.1    21.9    143    139    4    0     143        0     —      0                  aperture focus story
0.3760       internals      76   31.7    37.1    21.9    143    139    4    0     143        0     —      0                  aperture focus story
0.3969       internals      76   31.7    37.1    21.9    143    139    4    0     143        0     —      0                  aperture focus story
0.4025       internals      76   31.7    37.1    21.9    143    139    4    0     143        0     —      0                  aperture focus story
0.4069      flythrough      76   31.7    37.1    21.9    143    139    4    0     143        0     —      0                  aperture focus story
0.4169      flythrough      76   31.7    37.1    21.9    143    139    4    0     143        0     —      0                        aperture story
0.4335      flythrough      76   31.7    37.1     0.0     80     76    4    0      17       13     —      0                        aperture story
0.4360      flythrough      76   31.7    37.1     0.0     80     76    4    0      17       13     —      0                        aperture story
0.4385      flythrough      76   31.7    37.1     0.0     80     76    3    1      16       13    on      0                        aperture story
0.4486      flythrough     141   46.2    57.2     0.0    145    141    3    1      16       13    on      0                        aperture story
0.4795      flythrough     141   46.2    57.2     0.0    145    141    3    1      16       13    on      0                                 story
0.4953      flythrough     141   46.2    57.2     0.0    145    141    3    1      16       13    on      0                                 story
0.5421      flythrough     141   46.2    57.2     0.0    153    141   11    1     152       13    on      0                           focus story
0.5521  constellations      13   12.9     7.4     0.0     25     13   11    1      24       13    on      0                           focus story
0.5931  constellations       0    0.0     0.0     0.0     12      0   11    1      11        0    on      0                           focus story
0.6241  constellations       0    0.0     0.0     0.0     13      0   12    1      12        0    on      0                           focus story
0.6341          trails       0    0.0     0.0     0.0     13      0   12    1      12        0    on      0                           focus story
0.6394          trails       0    0.0     0.0     0.0     13      0   12    1      12        0    on      0                           focus story
0.6441          trails       0    0.0     0.0     0.0     13      0   12    1      12        0    on      0                   explode focus story
0.6609          trails       0    0.0     0.0     0.0     13      0   12    1      12        0    on      0                   explode focus story
0.6877          trails       0    0.0     0.0     0.0     13      0   12    1      12        0    on      0                   explode focus story
0.7313          trails       0    0.0     0.0     0.0     13      0   12    1      12        0    on      0                   explode focus story
0.7413          rewrap       0    0.0     0.0     0.0     13      0   12    1      12        0    on      0                   explode focus story
0.7473          rewrap       0    0.0     0.0     0.0     13      0   12    1      12        0    on      0                   explode focus story
0.7479          rewrap       0    0.0     0.0     0.0     13      0   12    1      12        0    on      0                   explode focus story
0.7513          rewrap     194   74.3    87.0     0.0    207    194   12    1     206       13    on      0                   explode focus story
0.7605          rewrap     194   74.3    87.0     0.0    207    194   12    1      25       13    on      0                   explode focus story
0.7713          rewrap     194   74.3    87.0    65.1    362    357    4    1     361       13    on      0                   explode focus story
0.7797          rewrap     194   74.3    87.0    65.1    362    357    4    1     361        0    on      0                   explode focus story
0.7845          rewrap     194   74.3    87.0    65.1    362    357    4    1     361        0    on      0                   explode focus story
0.8037          rewrap     194   74.3    87.0    65.1    361    357    3    1     360        0    on      0                   explode focus story
0.8109          rewrap     194   74.3    87.0    65.1    361    357    3    1     360        0    on      0                   explode focus story
0.8512          rewrap     194   74.3    87.0    65.1    361    357    4    0     361        0     —      0                aperture explode story
0.8564          rewrap     194   74.3    87.0    65.1    361    357    4    0     361        0     —      0                aperture explode story
0.8612          capsOn     194   74.3    87.0    65.1    361    357    4    0     361        0     —      0                aperture explode story
0.8654          capsOn     194   74.3    87.0    65.1    361    357    4    0     361        0     —      0                aperture explode story
0.8712          capsOn     194   74.3    87.0    65.1    361    357    4    0     361        0     —      0                aperture explode story
0.9195          capsOn     194   74.3    87.0    65.1    361    357    4    0     361        0     —      0                aperture explode story
0.9500          capsOn     194   74.3    87.0    65.1    361    357    4    0     361        0     —      0                        aperture story
0.9611          capsOn     194   74.3    87.0    65.1    361    357    4    0     361        0     —      0                        aperture story
0.9681          capsOn     194   74.3    87.0    65.1    361    357    4    0     361        0     —      0                   aperture rose story
0.9944          capsOn     194   74.3    87.0    65.1    361    357    4    0     361        0     —      0                   aperture rose story
1.0000          capsOn     194   74.3    87.0    65.1    361    357    4    0     361        0     —      0                   aperture rose story
```
