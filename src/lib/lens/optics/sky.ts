import * as THREE from "three/webgpu";
import { attribute, pow } from "three/tsl";

// ============================================================================
// THE STARFIELD — an AUTHORED table of star directions and constellation lines,
// baked into an equirect render target the background warp samples. TWO bakes
// now: the plain sky, and the SAME sky with a real line streak drawn behind
// every star (see STREAK_LOOK and `streaked` below). The retired warp crossfaded
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
// generated field obeys the same rule through FIELD_LOOK.seamMarginRad.
//
// ONE BRIGHTNESS LAW, TWO POPULATIONS. `SKY.stars` is the AUTHORED table (the
// three constellations and their scatter) followed by ONE generated field
// (FIELD_LOOK), and every star in both — authored or drawn — takes its size and
// its ink from the same magnitude (BRIGHTNESS_LAW, `inkOf`). The field is split
// where that law crosses the starfield's disc floor: the stars above it are
// emitted first, so `SKY.stars` reads authored ++ bright field ++ backdrop
// field. The order is the contract: the authored rows never move, so every
// constellation index addresses the same star it always did, and the first
// `BRIGHT_COUNT` rows are the stars anything else may draw ink to (names,
// strokes).
// ============================================================================

export interface Star {
  /** azimuth, radians, = atan2(dir.z, dir.x); 0 points along world +X */
  az: number;
  /** altitude, radians, = asin(dir.y); +π/2 is world +Y */
  alt: number;
  /** THE ONE BRIGHTNESS QUANTITY: bigger = brighter (note: inverse of the
   *  astronomical convention). It drives the disc's angular radius
   *  (optics/starfield.ts `starRho`), the trail arc's half-width
   *  (optics/star-trails.ts) and — through `inkOf` — the ink both are drawn at,
   *  so a star is one number and everything that draws it agrees. */
  mag: number;
  /** PER-STAR INK MULTIPLIER, 0..1 — 1 when absent; every row of the shipped
   *  catalog carries one, `inkOf(mag)`. This is what spreads the field's
   *  brightness once the discs are down at a pixel or two, where size alone can
   *  buy nothing. Read by optics/starfield.ts (`aInk`) and by the arcs
   *  (optics/star-trails.ts); the dev-only bake below ignores it. */
  ink?: number;
  /** THE TEMPERATURE TINT — a LINEAR RGB multiplier on the theme's star ink, not
   *  a colour of its own (see STAR_TINTS). Every star carries one; both things
   *  that draw a star read it, the discs (optics/starfield.ts `aTint`) and the
   *  long-exposure arcs (optics/star-trails.ts), so a trail is its star's
   *  colour by construction. The dev-only bake below ignores it. */
  tint: readonly [number, number, number];
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
   *  same value so the two paths matched under the retired trace; its discs are now
   *  much smaller (the finale wants a deep field, not a handful of blobs) and
   *  this one CANNOT follow: a disc is drawn here in TEXELS of a 2048×1024
   *  equirect, and at the sprites' 0.004 rad it would be barely a texel across
   *  and the dev-only bake would lose its stars. The two sizes are now separate
   *  numbers for separate media, and the bake read bigger by design. */
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
 * because that is the one direction the wormhole's pinch draws the field
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
 *  same reason optics/wormhole-post.ts hard-codes the pinch axis: nothing else flies.
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
    // THE STROKES ARE THE STARS' OWN INK (owner: "the lines should be white").
    // Not 0xffffff: pure white beside the cream discs reads as a second, colder
    // light source on a sky that has exactly one, and at these widths it blooms
    // against the near-black ground. The star ink IS the white of this stage.
    line: 0xf2ecd9,
    // UP from 0.42, with the width nearly halved at the same time
    // (CONST_LINES_LOOK.halfWidthRad): a hairline has to be BRIGHT to stay a
    // line — spend the alpha on the two pixels it has rather than on width.
    lineOpacity: 0.45,
    starOpacity: 0.95,
  },
  light: {
    backdrop: 0xf4efe2,
    star: 0x3a352b,
    // PAPER CANNOT TAKE THE DARK STAGE'S ANSWER: white on a warm near-white is
    // no mark at all. The light side takes the same decision the dark one does —
    // the strokes are drawn in the stars' own ink — which here is the dark
    // neutral, and the contrast comes back from the other side.
    line: 0x3a352b,
    // held at 0.5 while the dark side went up: dark ink on paper starts with the
    // contrast the dark stage had to buy with alpha, and a hairline any heavier
    // here reads as pencil rather than as light.
    lineOpacity: 0.5,
    // full ink on paper: at 0.9 the dark discs washed toward the warm ground
    starOpacity: 1,
  },
};

// ── STAR TEMPERATURES ────────────────────────────────────────────────────────
//
// Owner: "Stars also have different temperatures and colors — we should reflect
// those details too." They are drawn as a TINT ON THE THEME'S OWN STAR INK, not
// as absolute colours, which is the only form that can serve both stages: the
// dark one inks stars in cream and the light one in a near-black, and a table of
// absolute RGB would be right on one and wrong on the other.
//
// EVERY STOP PEAKS AT 0xff, so a tint can only ever take light OUT of a channel.
// The theme's ink IS what a white star looks like, and a temperature is what a
// star lacks — which also settles the light stage: on paper the tint only ever
// darkens the ink, so contrast can only go up.

/** The ramp, cool → warm, as authored sRGB hex. */
const TEMP_HEX = [
  0xdceaff, // blue-white
  0xf0f6ff, // white, faintly cool
  0xffffff, // white — the theme's ink, untinted
  0xfff6ea, // warm white
  0xfff0d8, // yellow
  0xffe4c0, // orange
];

/** …and how often each is drawn. MOSTLY WHITES: a real sky reads white with the
 *  occasional blue or orange accent, so the colour is seasoning and not a
 *  rainbow. Sums to 1; `tintAt` clamps to the last stop against float slop. */
const TEMP_WEIGHTS = [0.05, 0.14, 0.3, 0.28, 0.16, 0.07];

/** The ramp as LINEAR RGB multipliers — the space the shaders' colours are
 *  multiplied in, so a stop reads on screen as the hex it is authored as
 *  (three's own sRGB decode, the same one `Color.setHex` gives the palette). */
export const STAR_TINTS: readonly (readonly [number, number, number])[] =
  TEMP_HEX.map((h) => {
    const c = new THREE.Color().setHex(h, THREE.SRGBColorSpace);
    return [c.r, c.g, c.b] as const;
  });

/**
 * A star's tint, from its index within its population and that population's
 * stream key.
 *
 * A HASH, NOT A DRAW. A generated population's identity is its per-sample draw
 * COUNT (`buildField`), so pulling a colour out of the same LCG would shift
 * every star after the first — a recolour that silently moves the whole sky.
 * This reads the index instead, so temperature is orthogonal to position: the
 * catalog's az/alt/mag are bit-for-bit what they were before colour existed.
 */
export function tintAt(i: number, key = 0): readonly [number, number, number] {
  let h = Math.imul(i ^ key ^ 0x9e3779b9, 2654435761) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
  const u = ((h ^ (h >>> 13)) >>> 0) / 4294967296;
  let acc = 0;
  for (let k = 0; k < TEMP_WEIGHTS.length; k++) {
    acc += TEMP_WEIGHTS[k];
    if (u < acc) return STAR_TINTS[k];
  }
  return STAR_TINTS[STAR_TINTS.length - 1];
}

// ── THE BRIGHTNESS LAW ───────────────────────────────────────────────────────
//
// Owner: "even smaller stars and more varying opacities/brightnesses. lets make
// the distribution of bright stars exponentially decrease."
//
// ONE RANK, TWO OUTPUTS. A star's `mag` is a linear map of a BRIGHTNESS RANK in
// 0..1 (`magAt`), and its ink is the same rank mapped back onto `inkMin`..1
// (`inkOf`) — so size and ink are two readings of one number and can never
// disagree. Authored rows go through `inkOf` too: they were typed as a
// hierarchy of magnitudes and this is what turns that hierarchy into ink instead
// of leaving 75 rows sitting at full strength in front of a field that varies.
//
// EXPONENTIAL IN THE RANK. `magAt` is the inverse CDF of a truncated
// exponential: the density of stars falls as e^(−decay·rank), so each step up in
// brightness costs an e-fold in count — a handful of anchors over an
// exponentially growing mass of faint texture. That is the whole fix for the
// trails scene, where all 795 stars draw a 180° arc at their own star's ink: a
// field of one brightness reads as a rope-field however small the discs are, and
// a field whose brightnesses fall off exponentially reads as depth.
export const BRIGHTNESS_LAW = {
  /** rank 0 — the faint end of the drawn field. UNDER the disc floor's knee
   *  (see `brightMag`): these stars are drawn at the floor's size and pay the
   *  difference back in ink, so the bottom of the field falls further than
   *  `inkMin` alone (0.10 as drawn, against 0.15 authored here). */
  magDark: 0.35,
  /** rank 1 — full ink. Set at the top of the authored table's own useful range
   *  rather than at its maximum (3.1), so the nine authored rows above it are
   *  the sky's unambiguous anchors and the drawn field can still reach 1 in
   *  principle. At the shipped decay and count it does not: the brightest star
   *  the field rolls is rank ~0.93. */
  magBright: 2.4,
  /** the exponential's decay CONSTANT, per unit rank: the count of stars above a
   *  rank falls as e^(−decay·rank), so the field spans decay/ln(10) ≈ 3 decades
   *  of count end to end. 7 leaves the shipped catalog with 16 stars of 795 AS
   *  DRAWN at ink ≥ 0.9, 53 at ≥ 0.6 and 477 at ≥ 0.2, median 0.235 — measured
   *  over the shipped seed, and pinned by __tests__/sky.test.ts (h3). Lower
   *  flattens the field back toward the uniform sheet this replaced; higher
   *  empties it. */
  decay: 7,
  /** the ink of a rank-0 star before the disc floor's payback. Not 0: a star
   *  drawn at nothing is a star not worth the quad and the arc it costs. */
  inkMin: 0.15,
  /** THE BRIGHT/BACKDROP CUT, in magnitude — where `SKY.stars` splits the drawn
   *  field, and therefore where `BRIGHT_COUNT` lands.
   *
   *  IT IS THE DISC FLOOR'S KNEE. optics/starfield.ts draws nothing smaller than
   *  `minRhoRad`, which at the shipped sizes bites at mag 0.694; a star at or
   *  above this is drawn as a real disc at its own honest size, and one below it
   *  is a speck at the floor. That is exactly the line a stroke or a name may be
   *  hung on (story/constellations.ts reads the prefix), so the boundary is the
   *  drawing law's rather than a second taste. Written as a number because
   *  optics/starfield.ts imports THIS file — __tests__/starfield.test.ts (f4)
   *  is the tripwire that keeps the two in step. */
  brightMag: 0.7,
};

/**
 * THE MAGNITUDE DRAW: a uniform u in [0, 1) → a magnitude, through the inverse
 * CDF of a truncated exponential on the rank.
 *
 *     rank = −ln(1 − u·(1 − e^(−decay))) / decay      ∈ [0, 1]
 *     mag  = magDark + (magBright − magDark) · rank
 *
 * so the DENSITY in rank is ∝ e^(−decay·rank): rank 0 is the commonest draw and
 * every e-fold up the brightness costs a factor e in count.
 */
export function magAt(u: number): number {
  const k = BRIGHTNESS_LAW.decay;
  const rank = -Math.log(1 - u * (1 - Math.exp(-k))) / k;
  return (
    BRIGHTNESS_LAW.magDark +
    (BRIGHTNESS_LAW.magBright - BRIGHTNESS_LAW.magDark) * rank
  );
}

/**
 * A STAR'S INK FROM ITS MAGNITUDE — the exact inverse of `magAt`'s linear half,
 * clamped, so `inkOf(magAt(u))` is `inkMin + (1 − inkMin)·rank` and the ink
 * inherits the magnitude's exponential distribution unchanged.
 *
 * Authored rows brighter than `magBright` clamp to 1; nothing can go under
 * `inkMin`. This is the CATALOG's ink — optics/starfield.ts multiplies the disc
 * floor's payback into it on top (`buildStarQuads`), and optics/star-trails.ts
 * does the same for the arcs, which is why the drawn field reaches below 0.15.
 */
export function inkOf(mag: number): number {
  const { magDark, magBright, inkMin } = BRIGHTNESS_LAW;
  const rank = (mag - magDark) / (magBright - magDark);
  return Math.min(1, Math.max(inkMin, inkMin + (1 - inkMin) * rank));
}

// PLACEHOLDER CONTENT (spec §4: "machinery ships before content firms up").
// 75 stars in three loose groups plus two scatter blocks; three constellations
// wired over the first nineteen. Real content lands later without touching a
// line of code.
/* prettier-ignore */
const STAR_TABLE: [az: number, alt: number, mag: number][] = [
  // — "The Barrel" (group 0, indices 0..6). Lives at az ≈ ±π — the sky BEHIND
  //   the fly-through, never in frame during the demo: the dive no longer turns
  //   around, it faces world +X (sky az ≈ 0) from p = 0 to p = 1. It was moved
  //   here to dress an exit framing that looked back down −X — a framing since
  //   deleted — and it stays put: the bench/table sky reads it from every angle,
  //   and az ≈ 0 is dressed by the throat scatter and the generated field
  //   instead. Alts, mags, shape and line wiring untouched.
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
  // — THROAT SCATTER (indices 42..74). Faint background texture, not shape:
  //   the WORMHOLE pinch draws the whole forward hemisphere
  //   into the exit axis on radial ribbons, and one ribbon per star means the
  //   throat is only as dense as the sky it has to pull. The first table gave
  //   the az ≈ 0 hemisphere ~9 stars, so the peak read as nine wires rather
  //   than a torrent. These 33 sit mostly in az ∈ (−1.2, 1.2) — the exit/view
  //   axis region the dive actually frames — at mags 0.8..1.8 (two at ~2.1–2.2)
  //   so they stay a wash rather than shapes the eye tries to join; alts spread
  //   over (−0.8, 0.8) in loose knots with stragglers between, because an even
  //   lattice reads as a screen door once the pinch combs it into parallel
  //   lines.
  //   SEAM: trivially safe — every az here is inside ±1.7, i.e. more than a
  //   radian from ±π (test (g) still checks it).
  // a drift up and left of the axis
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
 *  index below addresses this array, and the generated field is appended after
 *  it precisely so that stays true. `ink` is derived, not authored — the table's
 *  own magnitude hierarchy read through the one brightness law. */
const AUTHORED: Star[] = STAR_TABLE.map(([az, alt, mag], i) => ({
  az,
  alt,
  mag,
  ink: inkOf(mag),
  tint: tintAt(i),
}));

/** How many stars are AUTHORED — the prefix of `SKY.stars` the three
 *  constellations wire over, and the boundary the background begins at. */
export const AUTHORED_COUNT = AUTHORED.length;

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

// ── THE GENERATED FIELD ──────────────────────────────────────────────────────
//
// The authored table is SHAPE — three constellations and the scatter that keeps
// the exit axis from being blank paper. It is not a SKY: at 75 stars the finale
// read as a handful of discs rather than as depth, which is the owner's note
// ("let's add more stars", "the end state is too zoomed in on the stars"). The
// answer is a generated population, because typing seven hundred rows by hand
// buys nothing a seeded generator does not.
//
// ONE POPULATION, NOT THREE. This used to be two tables — a "background" tier at
// one ink and a "dim" tier at 0.45 of it — which drew the sky as two flat bands
// of brightness with nothing in between, and that is precisely what the trails
// scene exposed. BRIGHTNESS_LAW replaced both: one continuous exponential, one
// set of placement knobs, and the only thing left to split is WHERE the array is
// cut for the stroke/name pool (`brightMag`).
//
// GENERATED, NOT RANDOM. The repo forbids `Math.random` anywhere a frame can see
// it, and a catalog that changes between two loads would make every golden and
// every screenshot comparison meaningless. A 32-bit LCG with a fixed seed gives
// the same seven hundred stars on every machine, every reload and every test
// run; changing `seed` is how you roll a different sky, deliberately.
//
// APPENDED, NEVER MERGED. The generated stars land AFTER the authored ones, so
// the three constellations' indices — and the exact az/alt/mag of the 75 rows
// above — are untouched by anything here.
export const FIELD_LOOK = {
  /** how many stars are generated. Bounded on BOTH sides: every star costs a
   *  quad in the starfield draw and a segmented arc in the trail draw
   *  (`count × (TRAIL_LOOK.segments + 1) × 2` vertices, ~129k at 795 stars), and
   *  under a few hundred the finale is discs on paper rather than a field. */
  count: 720,
  /** the LCG's seed — THE knob for "same sky, different draw". Any 32-bit value
   *  gives a different but equally deterministic field. */
  seed: 20260812,
  /** THE CONCENTRATION, and the peripheral remainder. The field used to be
   *  uniform over the whole sphere, which is astronomically honest and reads as
   *  thin: the frame the story actually holds is a ~0.7 rad cone about the view
   *  axis, and a uniform sphere puts only its share of the stars in there.
   *  `coreFraction` of the draws are therefore CONCENTRATED about the throat and
   *  the rest keep the old uniform draw — the periphery still has to be dressed,
   *  because the dive arrives through it and the trails scene spins it past. */
  coreFraction: 0.7,
  /** the concentration's WIDTH, radians: γ (the angle off the throat) is drawn
   *  Rayleigh-distributed with this σ, which is a round 2D Gaussian in the
   *  tangent plane at the axis. Chosen over "uniform inside a cap" for the two
   *  things a cap cannot do — the density is FLAT at the very centre, so the
   *  middle of the frame fills like the rest of it rather than spiking or
   *  clearing, and it has NO EDGE anywhere, so the field thins toward the
   *  frame's corners instead of ending on a visible circle. At 0.55 about 57% of
   *  the core lands inside the frame and a residual ~1.3% still reaches the far
   *  hemisphere; over the whole field 42% of the stars sit inside it. */
  coreSigmaRad: 0.55,
  /** off the equirect SEAM (the header's authoring rule): |az| is capped at
   *  π − this, which at any magnitude BRIGHTNESS_LAW can draw is more than a
   *  disc radius clear of az = ±π. Only the dev-only bake cares — the sprite has
   *  no seam — but the catalog is shared, so the rule is enforced at the source.
   *
   *  The dev-only bake does not read `ink` either, so the bake draws the
   *  whole field at full strength — one more way that path reads heavier than
   *  the shipped one by design (see SKY_LOOK.starRhoRad). */
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

/**
 * The generated field, from the seed alone: TWO PLACEMENT DRAWS mixed by
 * `coreFraction` — one concentrated about the throat, one uniform over the whole
 * sphere (`alt = asin(uniform)` — sampling `alt` uniformly would bunch the field
 * at the poles) — both off the seam, and one magnitude draw through
 * BRIGHTNESS_LAW.
 *
 * FOUR DRAWS EITHER WAY. The branch selector, two shape draws and the magnitude
 * are the same four calls on both sides, so which branch a sample took does not
 * shift the stream for the ones after it.
 *
 * REJECTION, WITH A CEILING. A rejected sample consumes its draws and the loop
 * tries again, so the stream — and therefore the catalog — depends only on the
 * seed. The seam is the only rejection there is, and it is narrow enough that at
 * the shipped seed the field loses not a single sample to it (720 attempts for
 * FIELD_LOOK's 720) — so the ceiling is a tripwire for a future rejection wide
 * enough to exclude the sky, not a live limit.
 */
export function buildField(look = FIELD_LOOK): Star[] {
  const rand = lcg(look.seed);
  const azLimit = Math.PI - look.seamMarginRad;
  const out: Star[] = [];
  for (let i = 0; out.length < look.count && i < look.count * 100; i++) {
    let az: number;
    let alt: number;
    if (rand() < look.coreFraction) {
      // CONCENTRATED, in polar form about the throat: γ off the axis, Rayleigh
      // at σ = coreSigmaRad (the radius of a round 2D Gaussian), and a uniform
      // roll around it. The axis is world +X — az = alt = 0, hard-coded here for
      // the same reason THROAT_AZ/THROAT_ALT are — so the roll turns in the
      // (Y, Z) plane and the direction goes back to sky coordinates directly.
      const gam = Math.min(
        Math.PI,
        look.coreSigmaRad * Math.sqrt(-2 * Math.log(1 - rand())),
      );
      const roll = rand() * Math.PI * 2;
      const s = Math.sin(gam);
      alt = Math.asin(s * Math.sin(roll));
      az = Math.atan2(s * Math.cos(roll), Math.cos(gam));
    } else {
      az = (rand() * 2 - 1) * azLimit;
      alt = Math.asin(rand() * 2 - 1);
    }
    const u = rand();
    // THE SEAM, for both branches. The uniform draw cannot break the rule (its
    // az is clamped); the core draw can, because a sample more than a right
    // angle off the axis lands at az ≈ ±π when its roll puts it near the Y axis.
    if (Math.PI - Math.abs(az) < look.seamMarginRad) continue;
    const mag = magAt(u);
    out.push({
      az,
      alt,
      mag,
      ink: inkOf(mag),
      // keyed by the field's own seed, so a re-seed re-rolls the colours with
      // the positions rather than replaying the same run over a new sky
      tint: tintAt(out.length, look.seed),
    });
  }
  return out;
}

/** The generated field, split at BRIGHTNESS_LAW.brightMag: the stars drawn as
 *  real discs first, the backdrop specks after. A STABLE PARTITION, not a sort —
 *  each half keeps the generator's own order, so the two halves are still the
 *  seeded stream read in sequence and a re-seed cannot silently reorder one of
 *  them against the other. */
const FIELD = buildField();
const FIELD_BRIGHT = FIELD.filter((s) => s.mag >= BRIGHTNESS_LAW.brightMag);
const FIELD_BACKDROP = FIELD.filter((s) => s.mag < BRIGHTNESS_LAW.brightMag);

/** HOW MANY STARS MAY CARRY A STROKE OR A NAME: the authored table plus the
 *  field's bright half, i.e. the prefix of `SKY.stars` before the backdrop. The
 *  boundary anything that draws TO a star reads — the line pool and the names
 *  (story/constellations.ts) — because a stroke or a label on a backdrop speck
 *  would read as a mistake. 295 at the shipped knobs: 75 authored + 220 of the
 *  720 drawn. */
export const BRIGHT_COUNT = AUTHORED_COUNT + FIELD_BRIGHT.length;

/** THE CATALOG: the authored table first, then the field's bright half, then its
 *  backdrop half. Both the dev-only equirect bake and the shipped sprite
 *  starfield draw exactly this. */
export const SKY: { stars: Star[]; constellations: Constellation[] } = {
  stars: [...AUTHORED, ...FIELD_BRIGHT, ...FIELD_BACKDROP],
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
   *  else about the bake is identical, which is what let the retired warp
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
 * a sibling function: the retired warp crossfaded the two targets, so any
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
