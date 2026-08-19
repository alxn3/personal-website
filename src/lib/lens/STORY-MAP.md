<!-- GENERATED — do not edit by hand. See story/__tests__/story-map.test.ts. -->

# STORY-MAP

The hero story's pose and flow at every interesting scroll position `p`,
rendered from `story/state.ts`'s `storyStateAt(p)` — which is itself nothing
but a composition of the functions the drivers call, so every number here is the
story's own. Regenerate with

    LENS_STORY_MAP=1 npx vitest run src/lib/lens/story/__tests__/story-map.test.ts

and `story/__tests__/story-map.test.ts` asserts the checked-in file matches, so
this cannot silently rot: a duration or window change fails the suite with the
new table in the diff.

**What it is not.** These are the AUTHORED values at `p` — what the drivers
would write on a frame handed exactly this position, with every lazy module
loaded. The live frame lags them (core/scene eases `story` toward
`storyTarget`), the internals rack/breath and the card orbit run on a phase
clock rather than on `p`, and a `—` means the value is genuinely not a
function of `p` alone. `story/state.ts`'s header has the full residual.

Track: 10 scenes, 14.70 screenfuls of hold.

## Scenes

```text
scn              id           title      p0      p1  hold  transit                  flags
---  --------------  --------------  ------  ------  ----  -------  ---------------------
 00            hero            HERO  0.0000  0.0612  0.90   0.0000
 01            zoom            ZOOM  0.0612  0.1531  1.35   0.6000                   rail
 02            peel            PEEL  0.1531  0.2347  1.20   0.7200                   rail
 03           cards           CARDS  0.2347  0.3231  1.30   0.5000                   rail
 04       internals       INTERNALS  0.3231  0.4184  1.40   0.5000                   rail
 05      flythrough     FLY-THROUGH  0.4184  0.5646  2.15   0.1628                   rail
 06  constellations  CONSTELLATIONS  0.5646  0.6531  1.30   0.0000                   rail
 07          trails          TRAILS  0.6531  0.7687  1.70   0.0000                   rail
 08          rewrap          REWRAP  0.7687  0.8844  1.70   0.9500  linkNext camHold 0.16
 09          capsOn           BLOOM  0.8844  1.0000  1.70   0.7000
```

## Caption bands

Each scene's range padded by `CAPTION_PAD`; the final band runs to the track
end. `--beat-visibility` is `band(p, a, b)`.

```text
          band       a       b  flags
--------------  ------  ------  -----
          hero  0.0000  0.0812
          zoom  0.0412  0.1731
          peel  0.1331  0.2547
         cards  0.2147  0.3431
     internals  0.3031  0.4384
    flythrough  0.3984  0.5846
constellations  0.5446  0.6731
        trails  0.6331  0.7887
        rewrap  0.7487  0.9044
        capsOn  0.8644  1.0000  final
```

## Windows

Every ramp whose EDGES its owning module exports, in absolute story `p`. A
window authored as literals inside its own expression is deliberately absent —
listing it here would be a second copy of numbers this map does not own.

```text
          window      p0      p1   width
----------------  ------  ------  ------
       scrollCue  0.0061  0.0551  0.0490
        ink.half  0.0612  0.1071  0.0459
       zoom.rise  0.0750  0.1182  0.0432
        ink.full  0.1531  0.1816  0.0286
       zoom.fall  0.1531  0.1857  0.0327
       peel.spin  0.1792  0.2833  0.1041
   iris.handover  0.2280  0.4184  0.1904
    peel.release  0.2382  0.2665  0.0283
cards.apart.rise  0.2382  0.2701  0.0318
            wink  0.2718  0.2895  0.0177
cards.apart.fall  0.2913  0.3001  0.0088
         preShut  0.3803  0.4136  0.0333
      fly.inkOut  0.4184  0.4372  0.0188
   interior.back  0.4374  0.4476  0.0102
        fly.dive  0.4422  0.5646  0.1224
       fly.glass  0.4422  0.7751  0.3329
        fly.span  0.4422  0.8358  0.3936
    explode.rise  0.6588  0.7109  0.0520
        ink.drop  0.6646  0.7224  0.0578
   assemble.rise  0.6704  0.7456  0.0752
            roll  0.6704  0.8728  0.2024
            turn  0.6820  0.8057  0.1237
      shell.back  0.7687  0.7745  0.0058
   assemble.fall  0.7745  0.8728  0.0983
     ink.restore  0.7803  0.8612  0.0810
     fly.inkBack  0.7872  0.8103  0.0231
     fly.fovBack  0.8057  0.8288  0.0231
    explode.fall  0.8901  0.9480  0.0578
       rose.rise  0.9561  0.9942  0.0382
          chrome  0.9734  1.0000  0.0266
```

## State at every edge

One row per scene edge, caption-band edge and window edge. `roll` is radians
about the optical axis (reveal + peel, one write); `sweep` is the sky's turn in
radians; `iris` is who owns focus/aperture there.

```text
     p           scene  local    camX    camY    camZ    fov   dolly     roll   zoom  focus   aper   expl    asm   peel  inkFill  inkMix   body  shell   intr  sweep       iris
------  --------------  -----  ------  ------  ------  -----  ------  -------  -----  -----  -----  -----  -----  -----  -------  ------  -----  -----  -----  -----  ---------
0.0000            hero  0.000  146.33    0.00    0.00   3.00    0.00    0.000  0.000  0.000  0.000  0.000  0.000  0.000    0.000   1.000  1.000  1.000  1.000  0.000     driver
0.0061            hero  0.100  146.33    0.00    0.00   3.00    0.00    0.000  0.000  0.000  0.000  0.000  0.000  0.000    0.000   1.000  1.000  1.000  1.000  0.000     driver
0.0412            hero  0.673  146.33    0.00    0.00   3.00    0.00    0.000  0.000  0.000  0.000  0.000  0.000  0.000    0.000   1.000  1.000  1.000  1.000  0.000     driver
0.0551            hero  0.900  146.33    0.00    0.00   3.00    0.00    0.000  0.000  0.000  0.000  0.000  0.000  0.000    0.000   1.000  1.000  1.000  1.000  0.000     driver
0.0612            zoom  0.000   14.30    0.00    0.00  30.00    0.00    0.000  0.000  0.000  0.000  0.000  0.000  0.000    0.000   1.000  1.000  1.000  1.000  0.000     driver
0.0750            zoom  0.150   14.06    0.00    2.60  30.31    0.00    0.000  0.000  0.000  0.000  0.000  0.000  0.000    0.108   1.000  1.000  1.000  1.000  0.000     driver
0.0812            zoom  0.218   13.15    0.00    5.62  30.60    0.00    0.000  0.056  0.000  0.000  0.000  0.000  0.000    0.202   1.000  1.000  1.000  1.000  0.000     driver
0.1071            zoom  0.500    1.14    0.00   14.25  31.85    0.00    0.000  0.838  0.000  0.000  0.000  0.000  0.000    0.500   1.000  1.000  1.000  1.000  0.000     driver
0.1182            zoom  0.620    0.00    0.00   15.38  29.85    0.00    0.000  1.000  0.000  0.000  0.000  0.000  0.000    0.500   1.000  1.000  1.000  1.000  0.000     driver
0.1331            zoom  0.782    0.00    0.00  156.59   3.00    0.00    0.000  1.000  0.000  0.000  0.000  0.000  0.000    0.500   1.000  1.000  1.000  1.000  0.000     driver
0.1531            peel  0.000    0.00    0.00   14.30  32.00    0.00    0.000  1.000  0.000  0.000  0.000  0.000  0.000    0.500   1.000  1.000  1.000  1.000  0.000     driver
0.1731            peel  0.245    7.77    7.91   11.50  33.00    0.00    0.000  0.334  0.000  0.000  0.000  0.000  0.535    0.892   1.000  1.000  1.000  1.000  0.000     driver
0.1792            peel  0.320    9.31   11.36    6.23  32.79    0.00    0.000  0.104  0.000  0.000  0.000  0.000  0.781    0.990   1.000  1.000  1.000  1.000  0.000     driver
0.1816            peel  0.350    9.36   12.48    2.93  32.64    0.00   -0.021  0.043  0.000  0.000  0.000  0.000  0.863    1.000   1.000  1.000  1.000  1.000  0.000     driver
0.1857            peel  0.400    8.43   12.91   -2.98  32.36    0.00   -0.142  0.000  0.000  0.000  0.000  0.000  0.963    1.000   1.000  1.000  1.000  1.000  0.000     driver
0.2147            peel  0.755    4.62    1.76  -15.84  32.00    0.00   -3.386  0.000  0.000  0.000  0.000  0.000  1.000    1.000   1.000  1.000  1.000  1.000  0.000     driver
0.2280            peel  0.918    4.62    1.76  -15.84  32.00    0.00   -5.687  0.000      —      —  0.000  0.000  1.000    1.000   1.000  1.000  1.000  1.000  0.000  internals
0.2347           cards  0.000    4.62    1.76  -15.84  32.00    0.00   -6.904  0.000      —      —  0.000  0.000  1.000    1.000   1.000  1.000  1.000  1.000  0.000  internals
0.2382           cards  0.040    4.56    1.75  -16.02  32.04    0.00   -7.538  0.000      —      —  0.000  0.000  1.000    1.000   1.000  1.000  1.000  1.000  0.000  internals
0.2547           cards  0.226    3.18    1.53  -20.21  32.96    0.00  -10.238  0.000      —      —  0.000  0.526  0.378    1.000   1.000  1.000  1.000  1.000  0.000  internals
0.2665           cards  0.360    3.39    1.91  -17.86  32.47    0.00  -11.691  0.000      —      —  0.000  0.966  0.000    1.000   1.000  1.000  1.000  1.000  0.000  internals
0.2701           cards  0.400    3.57    2.05  -16.77  32.24    0.00  -12.007  0.000      —      —  0.000  1.000  0.000    1.000   1.000  1.000  1.000  1.000  0.000  internals
0.2718           cards  0.420    3.64    2.10  -16.35  32.15    0.00  -12.141  0.000      —      —  0.000  1.000  0.000    1.000   1.000  1.000  1.000  1.000  0.000  internals
0.2833           cards  0.550    3.74    2.20  -15.62  32.00    0.00    0.000  0.000      —      —  0.000  1.000  0.000    1.000   1.000  1.000  0.282  0.282  0.000  internals
0.2895           cards  0.620    3.74    2.20  -15.62  32.00    0.00    0.000  0.000      —      —  0.000  1.000  0.000    1.000   1.000  1.000  0.000  0.000  0.000  internals
0.2913           cards  0.640    3.74    2.20  -15.62  32.00    0.00    0.000  0.000      —      —  0.000  1.000  0.000    1.000   1.000  1.000  0.000  0.000  0.000  internals
0.3001           cards  0.740    3.74    2.20  -15.62  32.00    0.00    0.000  0.000      —      —  0.000  0.000  0.000    1.000   1.000  1.000  0.000  0.000  0.000  internals
0.3031           cards  0.774    3.74    2.20  -15.62  32.00    0.00    0.000  0.000      —      —  0.000  0.000  0.000    1.000   1.000  1.000  0.000  0.000  0.000  internals
0.3231       internals  0.000    3.74    2.20  -15.62  32.00    0.00    0.000  0.000      —      —  0.000  0.000  0.000    1.000   1.000  1.000  0.000  0.000  0.000  internals
0.3431       internals  0.210    8.79    3.46  -10.86  29.71    0.00    0.000  0.000      —      —  0.000  0.000  0.000    1.000   1.000  1.000  0.000  0.000  0.000  internals
0.3803       internals  0.600    8.58    2.20    7.26  26.00    0.00    0.000  0.000      —      —  0.000  0.000  0.000    1.000   1.000  1.000  0.000  0.000  0.000  internals
0.3984       internals  0.790    8.58    2.20    7.26  26.00    0.00    0.000  0.000      —      —  0.000  0.000  0.000    1.000   1.000  1.000  0.000  0.000  0.000  internals
0.4136       internals  0.950    8.58    2.20    7.26  26.00    0.00    0.000  0.000      —      —  0.000  0.000  0.000    1.000   1.000  1.000  0.000  0.000  0.000  internals
0.4184      flythrough  0.000    8.58    2.20    7.26  26.00    0.00    0.000  0.000      —      —  0.000  0.000  0.000    1.000   1.000  1.000  0.000  0.000  0.000  internals
0.4372      flythrough  0.129   -9.21    0.33    1.09  40.18    0.00    0.000  0.000  0.000  1.000  0.000  0.000  0.000    1.000   0.000  1.000  0.000  0.000  0.000     driver
0.4374      flythrough  0.130   -9.20    0.30    0.98  40.31    0.00    0.000  0.000  0.000  1.000  0.000  0.000  0.000    1.000   0.000  1.000  0.000  0.000  0.000     driver
0.4384      flythrough  0.137   -9.15    0.18    0.58  40.90    0.00    0.000  0.000  0.000  1.000  0.000  0.000  0.000    1.000   0.000  1.000  0.000  0.026  0.000     driver
0.4422      flythrough  0.163   -9.00    0.00    0.00  42.00    0.00    0.000  0.000  0.000  1.000  0.000  0.000  0.000    1.000   0.000  1.000  0.000  0.453  0.000        fly
0.4476      flythrough  0.200   -9.00    0.00    0.00  42.00   -0.39    0.000  0.000  0.000  1.000  0.000  0.000  0.000    1.000   0.000  1.000  0.000  1.000  0.000        fly
0.5446      flythrough  0.863   -9.00    0.00    0.00  42.00  -17.55    0.000  0.000  0.376  0.000  0.000  0.000  0.000    1.000   0.000  1.000  0.000  1.000  0.000        fly
0.5646  constellations  0.000   -9.00    0.00    0.00  42.00  -25.00    0.000  0.000  1.000  0.000  0.000  0.000  0.000    1.000   0.000  0.000  0.000  1.000  0.000        fly
0.5846  constellations  0.226   -9.00    0.00    0.00  42.00  -25.00    0.000  0.000  1.000  0.000  0.000  0.000  0.000    1.000   0.000  0.000  0.000  1.000  0.000        fly
0.6331  constellations  0.774   -9.00    0.00    0.00  42.00  -25.00    0.000  0.000  1.000  0.000  0.000  0.000  0.000    1.000   0.000  0.000  0.000  1.000  0.000        fly
0.6531          trails  0.000   -9.00    0.00    0.00  42.00  -25.00    0.000  0.000  1.000  0.000  0.000  0.000  0.000    1.000   0.000  0.000  0.000  1.000  0.000        fly
0.6588          trails  0.050   -9.00    0.00    0.00  42.00  -25.00    0.000  0.000  1.000  0.000  0.000  0.000  0.000    1.000   0.000  0.000  0.000  1.000  0.000        fly
0.6646          trails  0.100   -9.00    0.00    0.00  42.00  -25.00    0.000  0.000  1.000  0.000  0.034  0.000  0.000    1.000   0.000  0.000  0.000  1.000  0.000        fly
0.6704          trails  0.150   -9.00    0.00    0.00  42.00  -25.00    0.000  0.000  1.000  0.000  0.126  0.000  0.000    0.976   0.000  0.000  0.000  1.000  0.000        fly
0.6731          trails  0.173   -9.00    0.00    0.00  42.00  -25.00   -0.017  0.000  1.000  0.000  0.183  0.004  0.000    0.952   0.000  0.000  0.000  1.000  0.000        fly
0.6820          trails  0.250   -9.00    0.00    0.00  42.00  -25.00   -0.300  0.000  1.000  0.000  0.417  0.064  0.000    0.819   0.000  0.000  0.000  1.000  0.000        fly
0.7109          trails  0.500   -9.00    0.00    0.00  42.00  -25.00   -2.570  0.000  1.000  0.000  1.000  0.558  0.000    0.247   0.000  0.000  0.000  1.000  0.222        fly
0.7224          trails  0.600   -9.00    0.00    0.00  42.00  -25.00   -3.449  0.000  1.000  0.000  1.000  0.774  0.000    0.160   0.000  0.000  0.000  1.000  0.508        fly
0.7456          trails  0.800   -9.00    0.00    0.00  42.00  -25.00   -3.917  0.000  1.000  0.000  1.000  1.000  0.000    0.160   0.000  0.000  0.000  1.000  1.233        fly
0.7487          trails  0.827   -9.00    0.00    0.00  42.00  -25.00   -3.826  0.000  1.000  0.000  1.000  1.000  0.000    0.160   0.000  0.000  0.000  1.000  1.332        fly
0.7687          rewrap  0.000   -9.00    0.00    0.00  42.00   -3.89   -3.213  0.000  1.000  0.000  1.000  1.000  0.000    0.160   0.000  0.000  0.000  1.000  1.967        fly
0.7745          rewrap  0.050   -9.00    0.00    0.00  42.00    3.50   -3.034  0.000  1.000  0.000  1.000  1.000  0.000    0.160   0.000  0.000  1.000  1.000  2.151        fly
0.7751          rewrap  0.055   -9.00    0.00    0.00  42.00    3.50   -3.016  0.000  1.000  0.000  1.000  1.000  0.000    0.160   0.000  0.000  1.000  1.000  2.169        fly
0.7803          rewrap  0.100   -9.00    0.00    0.00  42.00    3.50   -2.828  0.000  1.000  0.000  1.000  0.990  0.000    0.160   0.000  0.352  1.000  1.000  2.334        fly
0.7872          rewrap  0.160   -9.00    0.00    0.00  42.00    3.50   -2.521  0.000  1.000  0.000  1.000  0.954  0.000    0.177   0.000  1.000  1.000  1.000  2.554        fly
0.7887          rewrap  0.173   -9.02    0.01   -0.02  41.97    3.50   -2.448  0.000  1.000  0.000  1.000  0.943  0.000    0.185   0.012  1.000  1.000  1.000  2.602        fly
0.7976          rewrap  0.250   -9.75    0.56   -1.23  40.26    3.50   -1.996  0.000  1.000  0.000  1.000  0.860  0.000    0.259   0.425  1.000  1.000  1.000  2.885        fly
0.8057          rewrap  0.320  -10.75    1.81   -4.30  36.33    0.44   -1.577  0.000  1.000  0.000  1.000  0.761  0.000    0.357   0.896  1.000  1.000  1.000  3.142        fly
0.8103          rewrap  0.360  -11.20    2.69   -6.35  33.36    0.00   -1.346  0.000  1.000  0.000  1.000  0.698  0.000    0.422   1.000  1.000  1.000  1.000  3.142        fly
0.8288          rewrap  0.520  -14.88    5.55   -0.00  29.57    0.00   -0.571  0.000  1.000  0.000  1.000  0.421  0.000    0.704   1.000  1.000  1.000  1.000  3.142        fly
0.8358          rewrap  0.580  -13.60    5.41    5.54  30.00    0.00   -0.364  0.000  1.000  0.000  1.000  0.318  0.000    0.803   1.000  1.000  1.000  1.000  3.142        fly
0.8612          rewrap  0.800    2.26   -6.80   12.66  30.00    0.00   -0.014  0.000  0.000  1.000  1.000  0.038  0.000    1.000   1.000  1.000  1.000  1.000  3.142     driver
0.8644          rewrap  0.827    2.63  -11.04    9.71  30.00    0.00   -0.005  0.000  0.000  1.000  1.000  0.021  0.000    1.000   1.000  1.000  1.000  1.000  3.142     driver
0.8728          rewrap  0.900    1.52  -15.68   -2.97  30.00    0.00    0.000  0.000  0.000  1.000  1.000  0.000  0.000    1.000   1.000  1.000  1.000  1.000  3.142     driver
0.8844          capsOn  0.000    1.78  -12.83  -10.27  30.00    0.00    0.000  0.000  0.000  1.000  1.000  0.000  0.000    1.000   1.000  1.000  1.000  1.000  3.142     driver
0.8901          capsOn  0.050    3.54   -7.76  -13.84  30.00    0.00    0.000  0.000  0.000  1.000  1.000  0.000  0.000    1.000   1.000  1.000  1.000  1.000  3.142     driver
0.9044          capsOn  0.173    5.15   11.44   -8.17  30.00    0.00    0.000  0.000  0.000  1.000  0.848  0.000  0.000    1.000   1.000  1.000  1.000  1.000  3.142     driver
0.9480          capsOn  0.550    0.67    1.84   19.68  30.00    0.00    0.000  0.000  0.000  1.000  0.000  0.000  0.000    1.000   1.000  1.000  1.000  1.000  3.142     driver
0.9561          capsOn  0.620    0.19    0.52   21.38  30.00    0.00    0.000  0.000  0.000  1.000  0.000  0.000  0.000    1.000   1.000  1.000  1.000  1.000  3.142     driver
0.9734          capsOn  0.770    0.00    0.00   22.00  30.00    0.00    0.000  0.000  0.000  1.000  0.000  0.000  0.000    1.000   1.000  1.000  1.000  1.000  3.142     driver
0.9942          capsOn  0.950    0.00    0.00   22.00  30.00    0.00    0.000  0.000  0.000  1.000  0.000  0.000  0.000    1.000   1.000  1.000  1.000  1.000  3.142     driver
1.0000          capsOn  1.000    0.00    0.00   22.00  30.00    0.00    0.000  0.000  0.000  1.000  0.000  0.000  0.000    1.000   1.000  1.000  1.000  1.000  3.142     driver
```

## Which windows are open

```text
     p                                                                        windows containing p (fraction through)
------  -------------------------------------------------------------------------------------------------------------
0.0000                                                                                                              —
0.0061                                                                                                 scrollCue 0.00
0.0412                                                                                                 scrollCue 0.72
0.0551                                                                                                 scrollCue 1.00
0.0612                                                                                                  ink.half 0.00
0.0750                                                                                  zoom.rise 0.00, ink.half 0.30
0.0812                                                                                  zoom.rise 0.14, ink.half 0.44
0.1071                                                                                  zoom.rise 0.74, ink.half 1.00
0.1182                                                                                                 zoom.rise 1.00
0.1331                                                                                                              —
0.1531                                                                                  zoom.fall 0.00, ink.full 0.00
0.1731                                                                                  zoom.fall 0.61, ink.full 0.70
0.1792                                                                  zoom.fall 0.80, ink.full 0.91, peel.spin 0.00
0.1816                                                                  zoom.fall 0.88, ink.full 1.00, peel.spin 0.02
0.1857                                                                                 zoom.fall 1.00, peel.spin 0.06
0.2147                                                                                                 peel.spin 0.34
0.2280                                                                             iris.handover 0.00, peel.spin 0.47
0.2347                                                                             iris.handover 0.04, peel.spin 0.53
0.2382                                   iris.handover 0.05, peel.spin 0.57, peel.release 0.00, cards.apart.rise 0.00
0.2547                                   iris.handover 0.14, peel.spin 0.73, peel.release 0.58, cards.apart.rise 0.52
0.2665                                   iris.handover 0.20, peel.spin 0.84, peel.release 1.00, cards.apart.rise 0.89
0.2701                                                      iris.handover 0.22, peel.spin 0.87, cards.apart.rise 1.00
0.2718                                                                  iris.handover 0.23, wink 0.00, peel.spin 0.89
0.2833                                                                  iris.handover 0.29, wink 0.65, peel.spin 1.00
0.2895                                                                                  iris.handover 0.32, wink 1.00
0.2913                                                                      iris.handover 0.33, cards.apart.fall 0.00
0.3001                                                                      iris.handover 0.38, cards.apart.fall 1.00
0.3031                                                                                             iris.handover 0.39
0.3231                                                                                             iris.handover 0.50
0.3431                                                                                             iris.handover 0.60
0.3803                                                                               iris.handover 0.80, preShut 0.00
0.3984                                                                               iris.handover 0.89, preShut 0.54
0.4136                                                                               iris.handover 0.97, preShut 1.00
0.4184                                                                            iris.handover 1.00, fly.inkOut 0.00
0.4372                                                                                                fly.inkOut 1.00
0.4374                                                                                             interior.back 0.00
0.4384                                                                                             interior.back 0.10
0.4422                                               interior.back 0.47, fly.span 0.00, fly.dive 0.00, fly.glass 0.00
0.4476                                               interior.back 1.00, fly.span 0.01, fly.dive 0.04, fly.glass 0.02
0.5446                                                                   fly.span 0.26, fly.dive 0.84, fly.glass 0.31
0.5646                                                                   fly.span 0.31, fly.dive 1.00, fly.glass 0.37
0.5846                                                                                  fly.span 0.36, fly.glass 0.43
0.6331                                                                                  fly.span 0.48, fly.glass 0.57
0.6531                                                                                  fly.span 0.54, fly.glass 0.63
0.6588                                                               explode.rise 0.00, fly.span 0.55, fly.glass 0.65
0.6646                                                explode.rise 0.11, ink.drop 0.00, fly.span 0.57, fly.glass 0.67
0.6704                 explode.rise 0.22, assemble.rise 0.00, ink.drop 0.10, roll 0.00, fly.span 0.58, fly.glass 0.69
0.6731                 explode.rise 0.27, assemble.rise 0.04, ink.drop 0.15, roll 0.01, fly.span 0.59, fly.glass 0.69
0.6820      explode.rise 0.44, assemble.rise 0.15, ink.drop 0.30, turn 0.00, roll 0.06, fly.span 0.61, fly.glass 0.72
0.7109      explode.rise 1.00, assemble.rise 0.54, ink.drop 0.80, turn 0.23, roll 0.20, fly.span 0.68, fly.glass 0.81
0.7224                         assemble.rise 0.69, ink.drop 1.00, turn 0.33, roll 0.26, fly.span 0.71, fly.glass 0.84
0.7456                                        assemble.rise 1.00, turn 0.51, roll 0.37, fly.span 0.77, fly.glass 0.91
0.7487                                                            turn 0.54, roll 0.39, fly.span 0.78, fly.glass 0.92
0.7687                                           shell.back 0.00, turn 0.70, roll 0.49, fly.span 0.83, fly.glass 0.98
0.7745                       assemble.fall 0.00, shell.back 1.00, turn 0.75, roll 0.51, fly.span 0.84, fly.glass 1.00
0.7751                                        assemble.fall 0.01, turn 0.75, roll 0.52, fly.span 0.85, fly.glass 1.00
0.7803                                      assemble.fall 0.06, ink.restore 0.00, turn 0.79, roll 0.54, fly.span 0.86
0.7872                    assemble.fall 0.13, ink.restore 0.09, turn 0.85, roll 0.58, fly.span 0.88, fly.inkBack 0.00
0.7887                    assemble.fall 0.14, ink.restore 0.10, turn 0.86, roll 0.58, fly.span 0.88, fly.inkBack 0.06
0.7976                    assemble.fall 0.24, ink.restore 0.21, turn 0.93, roll 0.63, fly.span 0.90, fly.inkBack 0.45
0.8057  assemble.fall 0.32, ink.restore 0.31, turn 1.00, roll 0.67, fly.span 0.92, fly.inkBack 0.80, fly.fovBack 0.00
0.8103             assemble.fall 0.36, ink.restore 0.37, roll 0.69, fly.span 0.94, fly.inkBack 1.00, fly.fovBack 0.20
0.8288                               assemble.fall 0.55, ink.restore 0.60, roll 0.78, fly.span 0.98, fly.fovBack 1.00
0.8358                                                 assemble.fall 0.62, ink.restore 0.69, roll 0.82, fly.span 1.00
0.8612                                                                assemble.fall 0.88, ink.restore 1.00, roll 0.94
0.8644                                                                                  assemble.fall 0.91, roll 0.96
0.8728                                                                                  assemble.fall 1.00, roll 1.00
0.8844                                                                                                              —
0.8901                                                                                              explode.fall 0.00
0.9044                                                                                              explode.fall 0.25
0.9480                                                                                              explode.fall 1.00
0.9561                                                                                                 rose.rise 0.00
0.9734                                                                                    rose.rise 0.45, chrome 0.00
0.9942                                                                                    rose.rise 1.00, chrome 0.78
1.0000                                                                                                    chrome 1.00
```
