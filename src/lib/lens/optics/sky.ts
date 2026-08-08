import * as THREE from "three/webgpu";
import { attribute, pow } from "three/tsl";

// ============================================================================
// THE STARFIELD — an AUTHORED table of star directions and constellation lines,
// baked into an equirect render target the background warp samples. TWO bakes
// now: the plain sky, and the SAME sky with a real line streak drawn behind
// every star (see STREAK_LOOK and `streaked` below). The warp crossfades
// between them, which is why the streak is geometry here rather than a fan of
// re-reads in the shader.
//
// FLAT-LAW COMPLIANT (the house design law: only the lens model reads 3D):
// stars are flat round ink discs and constellation lines are flat strokes, both
// drawn into a 2D texture. The only "3D" anywhere near this piece is the honest
// bending of directions the lens does when it reads the texture.
//
// THE MAPPING must agree exactly with three's `equirectUV` (r185
// src/nodes/utils/EquirectUV.js), which the warp samples with:
//     u = atan2(dir.z, dir.x)/(2π) + 0.5      v = asin(dir.y)/π + 0.5
// so this file authors (az, alt) with az = atan2(z, x) and alt = asin(y), and
// `skyUv` is that formula written forward. __tests__/sky.test.ts (d) pins the
// round trip.
//
// SKY FRAME = WORLD FRAME for v1 (spec's open question 2 covers rotating it).
//
// NOT POINTS: three r185's WebGPU backend clamps `THREE.Points` primitives to
// one pixel and ignores PointsNodeMaterial's `size` entirely
// (src/materials/nodes/PointsNodeMaterial.js:20-32). Stars are therefore drawn
// as real triangle discs in one merged geometry — one draw call, honest sizes,
// and a shape the aspect correction below can stretch toward the poles.
//
// WORDS/LABELS ARE NOT BAKED (spec §8 question 2 — treatment undecided). The
// `label` field is authored so the content is ready when the treatment is.
//
// AUTHORING NOTE — STAY OFF THE SEAM: nothing here is wrapped across u = 0/1 at
// bake time. A stroke whose ends straddle the seam is skipped outright, and a
// disc authored within its own `ru` of az = ±π would be CLIPPED at the texture
// edge rather than continued on the far side. Keep stars a disc-radius clear of
// az = ±π (the placeholder table's extreme is 3.11 rad, ~0.03 clear); the
// generated background obeys the same rule through BACKGROUND_LOOK.seamMarginRad.
//
// TWO POPULATIONS, ONE CATALOG. `SKY.stars` is the AUTHORED table (the four
// constellations and their scatter) followed by a GENERATED background field —
// see BACKGROUND_LOOK. The authored rows come first and never move, so every
// constellation index addresses the same star it always did.
// ============================================================================

export interface Star {
  /** azimuth, radians, = atan2(dir.z, dir.x); 0 points along world +X */
  az: number;
  /** altitude, radians, = asin(dir.y); +π/2 is world +Y */
  alt: number;
  /** apparent size driver; bigger = brighter/larger disc (note: inverse of the
   *  astronomical convention — bigger = brighter here) */
  mag: number;
  /** reserved for a future per-star tint; NOT read by the current bake */
  ink?: number;
}

export interface Constellation {
  id: string;
  /** authored now, NOT baked — see the header. */
  label: string;
  /** indices into SKY.stars */
  stars: number[];
  /** index PAIRS drawn as strokes; both ends must be in `stars` */
  lines: [number, number][];
}

export interface SkyPalette {
  backdrop: number;
  star: number;
  line: number;
  lineOpacity: number;
  starOpacity: number;
}

/** Look knobs. Every number here is the owner's to tune in one pass. */
export const SKY_LOOK = {
  /** equirect texture width; height is exactly half (2:1) */
  texW: 2048,
  /** base angular radius of a mag-1 star disc, radians. Sized for the DIVE when
   *  it still ran front→rear: looking in the front is the telescope-backwards
   *  direction, and the traced disc MINIFIED the sky hard there (~14× on axis
   *  from the parked framing), so at 0.006 the on-axis cluster was ~1 px of ink
   *  — invisible.
   *
   *  THE DIVE NOW RUNS REAR→FRONT and that gain is gone: measured against
   *  AXIAL_ORDER_REVERSED from the pre-entry station (gltf y ≈ −5.3mm, demo
   *  p ≈ 0.30) the traced cone is only ~±0.07 rad wide with an angular gain of
   *  1.37 — the sky reads nearly 1:1 and erect, with everything outside that
   *  cone taking the miss-the-lens bypass at exactly 1:1. So these discs now
   *  land ~4× larger in the through-glass view than this number was chosen for.
   *  It still READS (the cluster and its strokes are legible mid-dive); a
   *  smaller starRhoRad is an owner look-tune, not a fix, and is left alone
   *  rather than guessed at.
   *
   *  NO LONGER THE SPRITE PATH'S NUMBER. optics/starfield.ts used to hold the
   *  same value so the two paths matched under `?tracesky`; its discs are now
   *  much smaller (the finale wants a deep field, not a handful of blobs) and
   *  this one CANNOT follow: a disc is drawn here in TEXELS of a 2048×1024
   *  equirect, and at the sprites' 0.004 rad it would be barely a texel across
   *  and the dev-only bake would lose its stars. The two sizes are now separate
   *  numbers for separate media, and `?tracesky` reads bigger by design. */
  starRhoRad: 0.011,
  /** angular radius scales as starRhoRad × mag^magRhoGain. Flatter than it
   *  looks it should be: ONE bake serves both the traced disc and the un-warped
   *  framings, so the exponent has to lift the faint stars (which the old
   *  heavily-minified disc swallowed) without letting the mag-3 discs read as
   *  polka dots at p = 1. 0.85 did exactly that; 0.6 keeps the hierarchy
   *  legible. */
  magRhoGain: 0.6,
  /** angular HALF-thickness of a constellation stroke, radians (a stroke reads
   *  twice this on the sphere; ~2.6px total on a 2048 bake at the equator) */
  lineWidthRad: 0.004,
  /** floor on cos(alt) — used BOTH for the disc u-stretch and for the stroke's
   *  local frame, so a near-pole star or stroke stays finite */
  poleGuard: 0.15,
  /** triangles per disc. TWELVE READ AS A DODECAGON, and it showed: a disc is
   *  only ~4 px across on the bake but the screen-space wormhole magnifies the
   *  frame's middle hard, so the flat facets ended up several pixels wide at
   *  the throat. 28 puts the chord error under a third of a bake texel at the
   *  largest star, which is the point where more segments buy nothing. The cost
   *  is ~300 stars × 28 tris, still one draw in a one-off bake. */
  discSegments: 28,
  /** disc alpha at the RIM, with 1 at the centre — the soft radial falloff that
   *  turns a flat ink chip into a round glow. Interpolated per vertex, the same
   *  attribute + `opacityNode` mechanism the streaks use, so a disc is a cone of
   *  alpha rather than a plateau: no hard edge left to look polygonal, and the
   *  streak HEADS inherit it (the discs draw in BOTH bakes), which is what makes
   *  a comet read as a glowing head rather than as a chip with a tail glued on.
   *  Not 0 exactly: a hair of rim keeps the faintest stars from vanishing. */
  discRimAlpha: 0.06,
  /** exponent on that ramp. UNDER 1 ON PURPOSE, and it is the difference
   *  between a glow and a smudge: a bare linear cone peaks at a single point,
   *  so the discs came out visibly dimmer and smaller than the flat chips they
   *  replaced (measured against `streak-p100.png` — the round shape was right,
   *  the weight was gone). The exponent pulls the ramp up so the core stays
   *  near full ink and only the rim feathers, which restores the old weight
   *  WITHOUT touching starRhoRad — the size the whole magnitude table and the
   *  streaks' widthScale are calibrated against. Swept against that same
   *  before-frame: 0.45 is still perceptibly grey next to the old chips, 0.3
   *  matches them. */
  discSoftPow: 0.3,
};

/**
 * THE STREAK BAKE'S look knobs — the second product of `bakeSky`.
 *
 * THIS TABLE BAKES THE WORMHOLE'S GEOMETRY INTO THE SKY. Every streak runs
 * along the great circle from its star toward THE THROAT — the fly-through's
 * exit/view axis, world +X, which is sky az = 0 / alt = 0 (see `THROAT_AZ`) —
 * because that is the one direction optics/warp.ts's pinch draws the field
 * into. A different exit axis would need a different bake, not a different
 * uniform: this is content, not a knob the shader can turn.
 *
 * WHY GEOMETRY AND NOT A SHADER FAN. The streak used to be a nine-tap ghost of
 * the same equirect read, spread along the pinch. Nine taps at any useful
 * length is UNDERSAMPLED motion blur: the trail through a star came out as a
 * row of separate discs, and the owner read it for exactly what it was — "we're
 * just duplicating the stars to simulate a streak". A drawn line has no tap
 * spacing to bead, costs one texture read instead of nine, and can carry a real
 * along-length gradient.
 *
 * LENGTH GROWS WITH ANGULAR DISTANCE FROM THE THROAT — calm at the centre of
 * the frame, streaming at the periphery, which is the reference look AND what
 * the shipped pinch actually does (the periphery is what streams inward).
 */
export const STREAK_LOOK = {
  /** angular length of the LONGEST streak, radians — the one drawn for a star
   *  directly OPPOSITE the throat. Length is `lenRad · (γ/π)^falloffPow` with
   *  γ the angle to the throat, so this number is literally the length at the
   *  anti-throat and every other streak is a fraction of it.
   *
   *  BIG, AND MEASURED THAT WAY. 0.55 rad looked generous on paper and read as
   *  a field of stubby dashes on screen: at the peak of the dive the pinch maps
   *  a very wide patch of sky onto the aperture disc, so sky-space angle is
   *  MINIFIED hard by the time it reaches a pixel. 1.5 is what puts the ribbons
   *  back out to the rim. Re-measure it if pinchStrength moves — the two
   *  multiply. */
  lenRad: 1.5,
  /** the falloff's exponent. 1 = length linear in the angle to the throat;
   *  bigger keeps the region AROUND the throat calm and pushes the streaming to
   *  the periphery. 1.3 read as an even starburst (every ribbon the same
   *  weight); 1.6 keeps the centre of the throat quiet, which is the reference
   *  look and reads as depth rather than as a sunburst. */
  falloffPow: 1.6,
  /** streak half-width as a multiple of the star's OWN disc radius, so the
   *  ribbon leaves the disc at (near enough) the disc's own width and the two
   *  read as one mark rather than as a disc with a wire taped to it. Under 1
   *  on purpose: at 1 the long ribbons read as fat wedges, and the disc wants
   *  to stay the widest part of the mark (it is the head of the comet). */
  widthScale: 0.65,
  /** the along-length opacity gradient: alpha = (1 − t)^fadePow for t running
   *  0 at the star to 1 at the far (throat-ward) end. BRIGHT AT THE STAR — the
   *  streak is the trail the star leaves, so the star end is the head. 1 is a
   *  linear ramp; above 1 the tail thins out sooner, which is what makes a long
   *  ribbon read as SPEED instead of as a drawn line. */
  fadePow: 1.6,
  /** overall streak alpha, multiplied into the gradient and the palette's
   *  starOpacity: keeps the ribbons UNDER the discs so the star still reads as
   *  the mark and the streak as its motion. */
  alpha: 0.85,
  /** great-circle segments per streak. The path is curved in equirect uv, so a
   *  streak is a POLYLINE of thin quads, not one long one. */
  segments: 10,
  /** streaks shorter than this (radians) are dropped — near the throat the
   *  length collapses to less than a disc radius and a stub reads as grit. */
  minLenRad: 0.012,
};

/** THE THROAT, in sky coordinates: the fly-through's exit/view axis is world
 *  +X, which is az = 0, alt = 0 (`dirOf(0, 0)` = (1, 0, 0)). Hard-coded for the
 *  same reason optics/warp.ts hard-codes the pinch axis: nothing else flies.
 *  EXPORTED so optics/starfield.ts — which draws the same streaks as geometry
 *  instead of baking them — aims at the same axis from one definition. */
export const THROAT_AZ = 0;
export const THROAT_ALT = 0;

/** Dual palettes — the site theme flips the whole sky, exactly like the dust
 *  and rays do (story/cinematics applyTheme). Dark stage: cream ink on a deep
 *  ground. Light stage (paper): dark ink on a warm near-white. */
export const SKY_INK: { dark: SkyPalette; light: SkyPalette } = {
  dark: {
    backdrop: 0x0b0d12,
    star: 0xf2ecd9,
    line: 0xdd8a4c,
    lineOpacity: 0.42,
    starOpacity: 0.95,
  },
  light: {
    backdrop: 0xf4efe2,
    star: 0x3a352b,
    line: 0xb5671f,
    lineOpacity: 0.5,
    // full ink on paper: at 0.9 the dark discs washed toward the warm ground
    starOpacity: 1,
  },
};

// PLACEHOLDER CONTENT (spec §4: "machinery ships before content firms up").
// 82 stars in four loose groups plus two scatter blocks; four constellations
// wired over the first nineteen and over indices 42..48. Real content lands
// later without touching a line of code.
/* prettier-ignore */
const STAR_TABLE: [az: number, alt: number, mag: number][] = [
  // — "The Barrel" (group 0, indices 0..6). Lives at az ≈ ±π — the sky BEHIND
  //   the fly-through, never in frame during the demo: the dive no longer turns
  //   around, it faces world +X (sky az ≈ 0) from p = 0 to p = 1. It was moved
  //   here to dress an exit framing that looked back down −X — a framing since
  //   deleted — and it stays put: it fills a patch left thin when "The Keyhole"
  //   took the through-glass axis at az ≈ 0, and the bench/table sky reads it
  //   from every angle. Alts, mags, shape and line wiring untouched.
  //   SEAM: the cluster spans 0.76 rad and straddled az = 0, so a clean −π
  //   shift would straddle az = ±π instead (2.52…3.03 on one side, −3.00…−3.05
  //   on the other). Discs would survive that, but the bake SILENTLY DROPS the
  //   two strokes that cross the seam, so the whole group is carried by +2.95 —
  //   0.19 rad short of a half turn — which keeps the shape rigid, holds the
  //   leading star 0.05 rad off the exit axis, and leaves every disc AND stroke
  //   on one side of the seam.
  [ 2.33,  0.34, 2.6], [ 2.57,  0.47, 1.7], [ 2.84,  0.41, 2.2],
  [ 3.09,  0.28, 3.1], [ 3.04,  0.02, 1.9], [ 2.76, -0.12, 2.4],
  [ 2.43,  0.06, 1.5],
  // — "The Ring" (group 1, indices 7..12)
  [ 1.42,  0.12, 2.9], [ 1.68,  0.31, 1.8], [ 1.97,  0.22, 2.3],
  [ 2.05, -0.06, 1.6], [ 1.79, -0.24, 2.7], [ 1.49, -0.15, 2.0],
  // — "The Mount" (group 2, indices 13..18)
  [-2.31, -0.28, 2.1], [-2.05, -0.44, 1.4], [-1.72, -0.36, 2.8],
  [-1.58, -0.09, 1.9], [-1.84,  0.11, 2.5], [-2.18, -0.02, 3.0],
  // — scatter (indices 19..41)
  [ 2.71,  0.58, 1.2], [ 3.02,  0.16, 2.2], [-3.06, -0.51, 1.6],
  [ 0.83,  0.66, 1.1], [ 0.47, -0.55, 2.4], [-0.94, -0.62, 1.3],
  [ 2.44, -0.48, 1.8], [-2.62,  0.39, 1.5], [ 1.15, -0.71, 1.0],
  [-1.27,  0.72, 1.4], [ 0.28,  0.88, 2.0], [-0.05, -0.91, 1.7],
  [ 2.89, -0.19, 1.2], [-2.87,  0.62, 1.1], [ 1.31,  0.49, 1.9],
  [-1.44, -0.66, 1.3], [ 0.66,  0.21, 1.0], [-0.71,  0.15, 1.2],
  [ 2.16,  0.71, 1.5], [-2.44, -0.72, 1.1], [ 1.88,  0.58, 1.3],
  [-0.31, -0.35, 1.6], [ 3.11, -0.63, 1.4],
  // — "The Keyhole" (group 3, indices 42..48). Sits ON THE DIVE'S ONE AXIS
  //   (world +X, az ≈ 0, alt ≈ 0): the fly-through parks off the BAYONET MOUNT
  //   at world −X and looks down +X for the approach, the whole dive AND the
  //   flight out, so az ≈ 0 is the backdrop of the opening framings, the cone
  //   the traced disc shows, and the finale — this cluster owns the last frame.
  //   The placeholder scatter left that direction thin — without something
  //   authored here the disc is blank paper. The cluster is the old az ≈ π ring
  //   shifted by −π (rounded to this table's 2 dp), alts and lines untouched;
  //   it has this patch of sky to itself now that "The Barrel" — authored
  //   around az ≈ 0 — has moved to the ±π side. Ring of five with a two-star
  //   stem. Still a disc-radius clear of the seam.
  [-0.25,  0.10, 2.6], [-0.16,  0.16, 3.0], [-0.07,  0.09, 2.4],
  [-0.09, -0.01, 2.2], [-0.23, -0.02, 2.0], [-0.16, -0.10, 1.8],
  [-0.17, -0.18, 1.4],
  // — THROAT SCATTER (indices 49..80). Faint background texture, not shape:
  //   the WORMHOLE pinch (optics/warp.ts) draws the whole forward hemisphere
  //   into the exit axis on radial ribbons, and one ribbon per star means the
  //   throat is only as dense as the sky it has to pull. The first table gave
  //   the az ≈ 0 hemisphere ~9 stars, so the peak read as nine wires rather
  //   than a torrent. These 33 sit mostly in az ∈ (−1.2, 1.2) — the exit/view
  //   axis region the dive actually frames — at mags 0.8..1.8 (two at ~2.1–2.2)
  //   so they stay UNDER "The Keyhole", which remains the anchor the eye
  //   reads; alts spread over (−0.8, 0.8) in loose knots with stragglers
  //   between, because an even lattice reads as a screen door once the pinch
  //   combs it into parallel lines.
  //   APPENDED, not merged into the scatter block above, so "The Keyhole"
  //   keeps indices 42..48 and no constellation wiring moves.
  //   SEAM: trivially safe — every az here is inside ±1.7, i.e. more than a
  //   radian from ±π (test (g) still checks it).
  // a drift trailing off the Keyhole's stem
  [-0.52,  0.31, 1.3], [-0.44,  0.38, 0.9], [-0.36,  0.27, 1.6],
  [-0.47,  0.19, 1.0],
  // a knot just below the axis
  [ 0.11, -0.29, 1.5], [ 0.19, -0.38, 1.1], [ 0.05, -0.44, 0.8],
  [ 0.27, -0.24, 1.9],
  // right of the axis, hugging the equator
  [ 0.62, -0.04, 1.2], [ 0.74,  0.08, 0.9], [ 0.88, -0.09, 1.7],
  [ 0.95,  0.13, 1.0],
  // high and left
  [-0.98,  0.61, 1.4], [-0.83,  0.74, 1.0], [-0.76,  0.55, 0.85],
  // a thread crossing low, under the whole group
  [-0.33, -0.62, 1.1], [-0.12, -0.71, 0.9], [ 0.09, -0.66, 1.5],
  [ 0.34, -0.58, 1.0],
  // upper right, at the edge of the biased band
  [ 1.04,  0.42, 2.2], [ 1.17,  0.55, 1.2], [ 1.09,  0.29, 0.9],
  // stragglers — the in-between the knots need to stop reading as clusters
  [ 0.36,  0.16, 1.0], [ 0.22,  0.44, 1.3], [-0.62, -0.13, 1.6],
  [ 0.48,  0.61, 0.85], [-0.05,  0.33, 1.1], [ 0.79, -0.47, 1.4],
  [-1.13, -0.29, 1.0], [ 1.19, -0.36, 0.9], [-0.88,  0.05, 2.1],
  // two just outside the band, so the wider bench sky doesn't thin by contrast
  [ 1.63,  0.63, 0.9], [-1.66,  0.48, 1.1],
];

/** The authored half of the catalog: THESE ROWS NEVER MOVE. Every constellation
 *  index below addresses this array, and the generated background is appended
 *  after it precisely so that stays true. */
const AUTHORED: Star[] = STAR_TABLE.map(([az, alt, mag]) => ({ az, alt, mag }));

/** How many stars are AUTHORED — the prefix of `SKY.stars` the four
 *  constellations wire over, and the boundary the background begins at. */
export const AUTHORED_COUNT = AUTHORED.length;

/** "The Keyhole"'s indices, named because TWO things need them: the
 *  constellation wiring below, and the background generator's exclusion cap. */
const KEYHOLE_STARS = [42, 43, 44, 45, 46, 47, 48];

const CONSTELLATIONS: Constellation[] = [
  {
    id: "barrel",
    label: "The Barrel",
    stars: [0, 1, 2, 3, 4, 5, 6],
    lines: [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [5, 6],
      [6, 0],
    ],
  },
  {
    id: "ring",
    label: "The Ring",
    stars: [7, 8, 9, 10, 11, 12],
    lines: [
      [7, 8],
      [8, 9],
      [9, 10],
      [10, 11],
      [11, 12],
      [12, 7],
    ],
  },
  {
    id: "mount",
    label: "The Mount",
    stars: [13, 14, 15, 16, 17, 18],
    lines: [
      [13, 14],
      [14, 15],
      [15, 16],
      [16, 17],
      [17, 18],
    ],
  },
  {
    id: "keyhole",
    label: "The Keyhole",
    stars: KEYHOLE_STARS,
    lines: [
      [42, 43],
      [43, 44],
      [44, 45],
      [45, 46],
      [46, 42],
      [45, 47],
      [46, 47],
      [47, 48],
    ],
  },
];

/** (az, alt) → equirect uv. The forward form of three's `equirectUV`. */
export function skyUv(az: number, alt: number): [number, number] {
  return [az / (Math.PI * 2) + 0.5, alt / Math.PI + 0.5];
}

/** (az, alt) → unit direction, the inverse of `equirectUV`'s convention. */
export function dirOf(az: number, alt: number): [number, number, number] {
  const c = Math.cos(alt);
  return [c * Math.cos(az), Math.sin(alt), c * Math.sin(az)];
}

// ── THE BACKGROUND FIELD ─────────────────────────────────────────────────────
//
// The authored table is SHAPE — four constellations and the scatter that keeps
// the exit axis from being blank paper. It is not a SKY: at 82 stars the finale
// read as a handful of discs rather than as depth, which is the owner's note
// ("let's add more stars", "the end state is too zoomed in on the stars"). The
// answer is a background population — many, faint, small — generated rather than
// authored, because typing three hundred rows by hand buys nothing a seeded
// generator does not.
//
// GENERATED, NOT RANDOM. The repo forbids `Math.random` anywhere a frame can see
// it, and a catalog that changes between two loads would make every golden and
// every screenshot comparison meaningless. A 32-bit LCG with a fixed seed gives
// the same three hundred stars on every machine, every reload and every test
// run; changing `seed` is how you roll a different sky, deliberately.
//
// APPENDED, NEVER MERGED. The generated stars land AFTER the authored ones, so
// the four constellations' indices — and the exact az/alt/mag of the 82 rows
// above — are untouched by anything here.
export const BACKGROUND_LOOK = {
  /** how many background stars are appended to the authored table. With the 82
   *  authored rows this is the catalog's total, and ~300 is the number at which
   *  the finale reads as a field rather than as a constellation on empty paper. */
  count: 220,
  /** the LCG's seed — THE knob for "same sky, different draw". Any 32-bit value
   *  gives a different but equally deterministic field. */
  seed: 20260805,
  /** the background's magnitude range. `mag` here is the disc-size driver, not
   *  the astronomical convention (bigger = brighter/larger — see Star.mag), and
   *  the whole range sits UNDER the authored stars' 0.8…3.1: this population is
   *  texture, and the authored shapes must stay the marks the eye reads. */
  magMin: 0.3,
  magMax: 1.15,
  /** the distribution's skew: mag = magMin + (magMax − magMin)·u^magSkew for u
   *  uniform, so above 1 the field crowds toward magMin and only a few stars
   *  reach the top of the range. At 2.6 the median lands near 0.44 — a faint
   *  wash — with roughly one star in eight bright enough to read as an accent. */
  magSkew: 2.6,
  /** KEEP OFF THE KEYHOLE'S FACE, radians: no background star lands within this
   *  angle of the finale constellation's mean direction. The Keyhole owns the
   *  last frame and its strokes have to stay legible; the cluster itself spans
   *  ~0.2 rad, so this leaves a thin margin of clear sky around it rather than a
   *  visible hole. */
  guardRad: 0.34,
  /** and off the equirect SEAM (the header's authoring rule): |az| is capped at
   *  π − this, which at any magnitude in the range above is more than a disc
   *  radius clear of az = ±π. Only the dev-only bake cares — the sprite path has
   *  no seam — but the catalog is shared, so the rule is enforced at the source. */
  seamMarginRad: 0.15,
};

/**
 * A 32-bit linear congruential generator (Numerical Recipes' constants) as a
 * `() => [0, 1)` stream. `Math.imul` keeps the multiply exact in 32 bits, which
 * is what makes the sequence identical in every JS engine.
 */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** The mean direction of a set of stars, normalized — the axis the background
 *  keeps clear of. */
export function meanDir(stars: Star[]): [number, number, number] {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const s of stars) {
    const [dx, dy, dz] = dirOf(s.az, s.alt);
    x += dx;
    y += dy;
    z += dz;
  }
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

/**
 * The background population, from the seed alone: uniform over the whole sphere
 * (`alt = asin(uniform)` — sampling `alt` uniformly would bunch the field at the
 * poles), skewed faint, off the seam, and clear of `guard`.
 *
 * REJECTION, WITH A CEILING. A rejected sample consumes its three draws and the
 * loop tries again, so the stream — and therefore the catalog — depends only on
 * the seed. The attempt ceiling is a tripwire for a guard so wide it excludes
 * the sky rather than a hole in the finale: at the shipped knobs the cap
 * excludes under 3% of the sphere and the loop rejects a handful of samples.
 */
export function buildBackground(
  guard: [number, number, number],
  look = BACKGROUND_LOOK,
): Star[] {
  const rand = lcg(look.seed);
  const azLimit = Math.PI - look.seamMarginRad;
  const cosGuard = Math.cos(look.guardRad);
  const out: Star[] = [];
  for (let i = 0; out.length < look.count && i < look.count * 100; i++) {
    const az = (rand() * 2 - 1) * azLimit;
    const alt = Math.asin(rand() * 2 - 1);
    const u = rand();
    const [x, y, z] = dirOf(az, alt);
    if (x * guard[0] + y * guard[1] + z * guard[2] > cosGuard) continue;
    out.push({
      az,
      alt,
      mag:
        look.magMin + (look.magMax - look.magMin) * Math.pow(u, look.magSkew),
    });
  }
  return out;
}

/** THE FINALE'S SUBJECT, as a direction: "The Keyhole"'s mean heading, which the
 *  background field is generated around rather than over. */
export const KEYHOLE_DIR = meanDir(KEYHOLE_STARS.map((i) => AUTHORED[i]));

/** THE CATALOG: the authored table first, then the generated background. Both
 *  the dev-only equirect bake and the shipped sprite starfield draw exactly
 *  this. */
export const SKY: { stars: Star[]; constellations: Constellation[] } = {
  stars: [...AUTHORED, ...buildBackground(KEYHOLE_DIR)],
  constellations: CONSTELLATIONS,
};

/**
 * THE STROKE MACHINERY, shared by the constellation lines and the streaks: the
 * perpendicular offset, IN UV UNITS, for a stroke running (u0,v0) → (u1,v1)
 * with a constant ANGULAR half-thickness `halfRad`.
 *
 * Work in the local frame X = az·cos(alt̄), Y = alt at the stroke's midpoint
 * altitude (cos floored by `poleGuard`), where angles are locally isotropic; a
 * perpendicular of fixed length there is a fixed angular half-thickness
 * whichever way the stroke runs. Offsetting in raw uv instead would make a
 * horizontal stroke read thinner than a vertical one by the 2:1 texture aspect.
 */
function strokeOffset(
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  halfRad: number,
): [nx: number, ny: number] {
  const altBar = ((v0 + v1) / 2 - 0.5) * Math.PI;
  const cosAlt = Math.max(Math.cos(altBar), SKY_LOOK.poleGuard);
  const dirX = (u1 - u0) * Math.PI * 2 * cosAlt;
  const dirY = (v1 - v0) * Math.PI;
  const len = Math.hypot(dirX, dirY) || 1;
  // perpendicular of length halfRad in the local frame, converted back:
  // radians → u units is /(2π·cos alt̄), radians → v units is /π.
  return [
    ((-dirY / len) * halfRad) / (Math.PI * 2 * cosAlt),
    ((dirX / len) * halfRad) / Math.PI,
  ];
}

export interface BakedSky {
  target: THREE.RenderTarget;
  dispose(): void;
}

export interface BakeSkyOptions {
  /** Draw a real LINE STREAK behind every star, running toward the throat —
   *  the second product this file exists to make (see STREAK_LOOK). Everything
   *  else about the bake is identical, which is what lets optics/warp.ts
   *  crossfade the two targets and get motion out of the difference. */
  streaked?: boolean;
}

/**
 * Bake the sky into an equirect render target, once, with the live renderer.
 *
 * TWO PRODUCTS, ONE FUNCTION. `streaked` adds a drawn line streak behind every
 * star, running toward the throat (STREAK_LOOK); everything else — the
 * backdrop, the constellation strokes, the discs, the palette, the mapping — is
 * bit-for-bit the same code. That is the whole reason it is a flag rather than
 * a sibling function: optics/warp.ts crossfades the two targets, so any
 * divergence between them would show up as a pop in the mix, and a shared body
 * is the only way to be sure there is none.
 *
 * Everything is drawn in UV space through an ortho camera over the unit square,
 * so a vertex position IS its uv. Discs are stretched in u by 1/cos(alt)
 * (floored by `poleGuard`) because that is what an equirect projection does to
 * a circle off the equator — a disc drawn round in uv would read as an ellipse
 * once the shader samples it back.
 *
 * The backdrop is a full-square quad rather than a clear colour, so the bake
 * never touches the renderer's clear state and cannot leak into the main pass.
 * The previous render target is saved and restored for the same reason.
 *
 * NO COLOUR-SPACE CONVERSION: the target keeps RenderTarget's default
 * NoColorSpace, so the values written by these materials are already in the
 * renderer's working space and the warp can use a sample straight as a colour.
 *
 * CALL THIS ONLY AFTER `await renderer.init()`. A pre-init render silently
 * produces a BLANK target — the async render path defers the work, and the
 * geometry is disposed the moment this function returns, so the deferred pass
 * has nothing left to draw. There is no throw here on purpose; enforcing the
 * ordering is the call site's job.
 */
export function bakeSky(
  renderer: THREE.WebGPURenderer,
  light: boolean,
  { streaked = false }: BakeSkyOptions = {},
): BakedSky {
  const ink = light ? SKY_INK.light : SKY_INK.dark;
  const w = SKY_LOOK.texW;
  const h = w / 2;
  const target = new THREE.RenderTarget(w, h, {
    depthBuffer: false,
    stencilBuffer: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  // u wraps (azimuth is periodic — a sample at u = 0.999 must blend into
  // u = 0) while v clamps (altitude is not). r185's RenderTarget would forward
  // wrapS/wrapT from the options bag too (core/RenderTarget.js _setTextureOptions);
  // they are set here on the texture simply to keep them next to this note.
  target.texture.wrapS = THREE.RepeatWrapping;
  target.texture.wrapT = THREE.ClampToEdgeWrapping;

  const bakeScene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(0, 1, 1, 0, -1, 1);
  const disposables: { dispose(): void }[] = [];

  // --- backdrop --------------------------------------------------------------
  const bgGeo = new THREE.PlaneGeometry(1, 1);
  bgGeo.translate(0.5, 0.5, 0);
  const bgMat = new THREE.MeshBasicNodeMaterial({ depthTest: false });
  bgMat.color.setHex(ink.backdrop);
  bgMat.toneMapped = false;
  const bg = new THREE.Mesh(bgGeo, bgMat);
  bg.renderOrder = 0;
  bakeScene.add(bg);
  disposables.push(bgGeo, bgMat);

  // --- constellation strokes -------------------------------------------------
  // Thin quads, not THREE.Line: WebGPU clamps line width to 1px, and a 1px
  // stroke in a 2048-wide bake all but vanishes once the lens magnifies it.
  // A stroke whose ends straddle the u seam is SKIPPED — it would otherwise
  // streak all the way across the texture.
  const lineVerts: number[] = [];
  for (const c of SKY.constellations)
    for (const [a, b] of c.lines) {
      const [u0, v0] = skyUv(SKY.stars[a].az, SKY.stars[a].alt);
      const [u1, v1] = skyUv(SKY.stars[b].az, SKY.stars[b].alt);
      if (Math.abs(u1 - u0) > 0.5) continue; // seam-crossing stroke
      // Offset the stroke ON THE SPHERE, then convert back to uv — the same
      // constant-angular-size treatment the discs get (strokeOffset).
      const [nx, ny] = strokeOffset(u0, v0, u1, v1, SKY_LOOK.lineWidthRad);
      lineVerts.push(
        u0 + nx,
        v0 + ny,
        0,
        u1 + nx,
        v1 + ny,
        0,
        u1 - nx,
        v1 - ny,
        0,
        u0 + nx,
        v0 + ny,
        0,
        u1 - nx,
        v1 - ny,
        0,
        u0 - nx,
        v0 - ny,
        0,
      );
    }
  if (lineVerts.length) {
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(lineVerts), 3),
    );
    const lineMat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      // The quads above come out CW-wound in this camera's frame for EVERY
      // stroke direction, so default back-face culling would erase all of them.
      side: THREE.DoubleSide,
    });
    lineMat.color.setHex(ink.line);
    lineMat.opacity = ink.lineOpacity;
    lineMat.toneMapped = false;
    const lines = new THREE.Mesh(lineGeo, lineMat);
    lines.renderOrder = 1;
    bakeScene.add(lines);
    disposables.push(lineGeo, lineMat);
  }

  // --- streaks (the `streaked` product only) ---------------------------------
  //
  // REAL LINES, not a fan of re-read discs (STREAK_LOOK's header). Each star
  // gets a POLYLINE of thin quads walking the great circle from the star toward
  // the throat, drawn with the same `strokeOffset` machinery, the same
  // DoubleSide winding escape and the same constant-angular-width treatment the
  // constellation strokes use — with one addition: a per-vertex alpha that runs
  // 1 at the star to 0 at the far end, so the ribbon fades INTO the throat and
  // the warp's crossfade reads as motion rather than as a second starfield.
  //
  // THE GRADIENT IS AN ATTRIBUTE + opacityNode, not vertexColors: r185's
  // NodeMaterial folds vertex colours in as `colorNode.mul(vertexColor())`
  // against a vec3 material colour (NodeMaterial.js:838), so the alpha channel
  // of a 4-component `color` attribute is not something to rely on. An explicit
  // float attribute read by `opacityNode` says exactly what it does. NOTE that
  // this REPLACES `material.opacity` (setupDiffuseColor uses one or the other),
  // so the palette's starOpacity is multiplied in here. The DISCS use the same
  // `aFade` attribute for their radial softness — one mechanism, one name.
  //
  // DRAWN UNDER THE DISCS (renderOrder 1.5): a streak without its star reads as
  // a scratch, so both bakes keep the discs and the streak emerges from behind
  // one.
  const starRho = (mag: number) =>
    SKY_LOOK.starRhoRad * Math.pow(mag, SKY_LOOK.magRhoGain);
  /** `opacityNode` reading the shared per-vertex `aFade`, shaped by `softPow`
   *  and scaled. Cast at the shader-graph boundary: three's `attribute()` is
   *  typed as a bare AttributeNode, which carries none of the TSL operator
   *  methods the proxy actually gives it at runtime. */
  const fadeOpacity = (scale: number, softPow = 1) =>
    (
      pow(attribute("aFade", "float"), softPow) as unknown as {
        mul(k: number): THREE.MeshBasicNodeMaterial["opacityNode"];
      }
    ).mul(scale);
  if (streaked) {
    const streakVerts: number[] = [];
    const streakFade: number[] = [];
    const [tx, ty, tz] = dirOf(THROAT_AZ, THROAT_ALT);
    const segs = STREAK_LOOK.segments;
    for (const s of SKY.stars) {
      const [sx, sy, sz] = dirOf(s.az, s.alt);
      // γ = angle from this star to the throat, and the tangent of the great
      // circle joining them (the throat's component perpendicular to the star).
      const cosG = Math.min(1, Math.max(-1, sx * tx + sy * ty + sz * tz));
      const gamma = Math.acos(cosG);
      const px = tx - sx * cosG;
      const py = ty - sy * cosG;
      const pz = tz - sz * cosG;
      const pLen = Math.hypot(px, py, pz);
      // Star ON the axis, or exactly opposite it: no great circle is picked out,
      // and the length is either ~0 or the tangent is undefined. Skip.
      if (pLen < 1e-6) continue;
      // LENGTH GROWS WITH THE ANGLE TO THE THROAT — short near the axis, long at
      // the periphery. Capped at γ so a streak can never overshoot the throat
      // and come out the far side (unreachable at any sane knob, kept as a
      // guard on live tuning).
      const len = Math.min(
        STREAK_LOOK.lenRad * Math.pow(gamma / Math.PI, STREAK_LOOK.falloffPow),
        gamma,
      );
      if (len < STREAK_LOOK.minLenRad) continue;
      const half = starRho(s.mag) * STREAK_LOOK.widthScale;
      const ux = px / pLen;
      const uy = py / pLen;
      const uz = pz / pLen;
      // Walk the arc: P(t) = S·cos t + û·sin t, sampled at segs+1 points.
      let [pu, pv] = skyUv(s.az, s.alt);
      let pf = 1;
      for (let i = 1; i <= segs; i++) {
        const t = (len * i) / segs;
        const ct = Math.cos(t);
        const st = Math.sin(t);
        const qx = sx * ct + ux * st;
        const qy = sy * ct + uy * st;
        const qz = sz * ct + uz * st;
        const [qu, qv] = skyUv(Math.atan2(qz, qx), Math.asin(qy));
        // Seam: TRUNCATE the streak rather than let a segment streak across the
        // whole texture. Streaks run toward az = 0, so |az| shrinks and this is
        // unreachable for every star in the shipped table — it is the same
        // tripwire the constellation strokes carry, for authored content.
        if (Math.abs(qu - pu) > 0.5) break;
        const qf = Math.pow(1 - i / segs, STREAK_LOOK.fadePow);
        const [nx, ny] = strokeOffset(pu, pv, qu, qv, half);
        streakVerts.push(
          pu + nx, pv + ny, 0,
          qu + nx, qv + ny, 0,
          qu - nx, qv - ny, 0,
          pu + nx, pv + ny, 0,
          qu - nx, qv - ny, 0,
          pu - nx, pv - ny, 0,
        ); // prettier-ignore
        streakFade.push(pf, qf, qf, pf, qf, pf);
        pu = qu;
        pv = qv;
        pf = qf;
      }
    }
    if (streakVerts.length) {
      const streakGeo = new THREE.BufferGeometry();
      streakGeo.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(streakVerts), 3),
      );
      streakGeo.setAttribute(
        "aFade",
        new THREE.BufferAttribute(new Float32Array(streakFade), 1),
      );
      const streakMat = new THREE.MeshBasicNodeMaterial({
        transparent: true,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide, // same winding escape as the strokes
      });
      streakMat.color.setHex(ink.star); // the star's own ink: it IS the star
      streakMat.opacityNode = fadeOpacity(ink.starOpacity * STREAK_LOOK.alpha);
      streakMat.toneMapped = false;
      const streaks = new THREE.Mesh(streakGeo, streakMat);
      streaks.renderOrder = 1.5;
      bakeScene.add(streaks);
      disposables.push(streakGeo, streakMat);
    }
  }

  // --- star discs ------------------------------------------------------------
  // In BOTH bakes: a streak without its star reads wrong, and the disc is what
  // the eye tracks between the two textures.
  //
  // A TRIANGLE FAN OF ALPHA, not a flat chip. The hub vertex carries fade 1 and
  // every rim vertex `discRimAlpha`, so the interpolator does the falloff for
  // free and each star is a round glow — which is what the owner asked for, and
  // is also what stops 28 straight chords from reading as a polygon (there is
  // no hard edge left to have a silhouette).
  const starVerts: number[] = [];
  const starFade: number[] = [];
  const seg = SKY_LOOK.discSegments;
  const rimA = SKY_LOOK.discRimAlpha;
  for (const s of SKY.stars) {
    const [u, v] = skyUv(s.az, s.alt);
    const rho = starRho(s.mag);
    const rv = rho / Math.PI; // v units
    const ru =
      rho / (Math.PI * 2 * Math.max(Math.cos(s.alt), SKY_LOOK.poleGuard)); // u units
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2;
      const a1 = ((i + 1) / seg) * Math.PI * 2;
      starVerts.push(
        u,
        v,
        0,
        u + Math.cos(a0) * ru,
        v + Math.sin(a0) * rv,
        0,
        u + Math.cos(a1) * ru,
        v + Math.sin(a1) * rv,
        0,
      );
      starFade.push(1, rimA, rimA);
    }
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(starVerts), 3),
  );
  starGeo.setAttribute(
    "aFade",
    new THREE.BufferAttribute(new Float32Array(starFade), 1),
  );
  const starMat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  starMat.color.setHex(ink.star);
  // `opacityNode` REPLACES `material.opacity` (setupDiffuseColor takes one or
  // the other), so the palette's starOpacity is folded in here.
  starMat.opacityNode = fadeOpacity(ink.starOpacity, SKY_LOOK.discSoftPow);
  starMat.toneMapped = false;
  const stars = new THREE.Mesh(starGeo, starMat);
  stars.renderOrder = 2;
  bakeScene.add(stars);
  disposables.push(starGeo, starMat);

  // --- one render ------------------------------------------------------------
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.render(bakeScene, cam);
  renderer.setRenderTarget(prev);

  // The scene is single-use: the texture is the product.
  for (const d of disposables) d.dispose();
  bakeScene.clear();

  return {
    target,
    dispose() {
      target.dispose();
    },
  };
}
