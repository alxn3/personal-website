import * as THREE from "three/webgpu";
import { attribute, pow } from "three/tsl";

// THE SKY CATALOG — an authored table of star directions and constellation
// lines, plus a seeded generated field. optics/starfield.ts draws it as
// geometry; `bakeSky` below bakes it into an equirect texture and is ORPHANED
// (nothing calls it), as is STREAK_LOOK.
//
// FLAT-LAW COMPLIANT (only the lens model reads 3D): stars are flat round ink
// discs and constellation lines are flat strokes.
//
// THE MAPPING must agree exactly with three's `equirectUV`:
//     u = atan2(dir.z, dir.x)/(2π) + 0.5      v = asin(dir.y)/π + 0.5
// so this file authors (az, alt) with az = atan2(z, x) and alt = asin(y), and
// `skyUv` is that formula written forward. __tests__/sky.test.ts (d) pins the
// round trip. Sky frame = world frame.
//
// AUTHORING RULE — STAY OFF THE SEAM: nothing is wrapped across u = 0/1 at bake
// time. A stroke whose ends straddle the seam is skipped outright, and a disc
// within its own `ru` of az = ±π is CLIPPED at the texture edge. Keep stars a
// disc-radius clear of az = ±π; the generated field obeys the same rule through
// FIELD_LOOK.seamMarginRad.
//
// ONE BRIGHTNESS LAW, TWO POPULATIONS. Every star, authored or generated, takes
// its size and its ink from one magnitude (BRIGHTNESS_LAW, `inkOf`). THE ORDER
// OF `SKY.stars` IS A CONTRACT: authored ++ bright field ++ backdrop field. The
// authored rows never move, so every constellation index addresses the same
// star it always did, and the first `BRIGHT_COUNT` rows are the stars anything
// else may draw ink to (names, strokes).

export interface Star {
  /** azimuth, radians, = atan2(dir.z, dir.x); 0 points along world +X */
  az: number;
  /** altitude, radians, = asin(dir.y); +π/2 is world +Y */
  alt: number;
  /** THE ONE BRIGHTNESS QUANTITY: bigger = brighter (inverse of the
   *  astronomical convention). It drives the disc's angular radius, the trail
   *  arc's half-width and — through `inkOf` — the ink both are drawn at. */
  mag: number;
  /** per-star ink multiplier, 0..1 (1 when absent); every shipped row carries
   *  `inkOf(mag)`. It spreads the field's brightness once the discs are down at
   *  a pixel or two, where size alone buys nothing. */
  ink?: number;
  /** the temperature tint — a LINEAR RGB multiplier on the theme's star ink,
   *  not a colour of its own (see STAR_TINTS). Both the discs and the arcs read
   *  it, so a trail is its star's colour by construction. */
  tint: readonly [number, number, number];
}

export interface Constellation {
  id: string;
  /** authored, never baked — the treatment is story/constellations.ts's */
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

/** The bake's look knobs — used only by the orphaned `bakeSky`. */
export const SKY_LOOK = {
  /** equirect texture width; height is exactly half (2:1) */
  texW: 2048,
  /** base angular radius of a mag-1 star disc, radians. NOT the sprite path's
   *  number and it cannot follow it: a disc is drawn here in TEXELS of the
   *  equirect, and at the sprites' size it would be barely one across. */
  starRhoRad: 0.011,
  /** angular radius scales as starRhoRad × mag^magRhoGain */
  magRhoGain: 0.6,
  /** angular HALF-thickness of a constellation stroke, radians (a stroke reads
   *  twice this on the sphere) */
  lineWidthRad: 0.004,
  /** floor on cos(alt) — used BOTH for the disc u-stretch and for the stroke's
   *  local frame, so a near-pole star or stroke stays finite */
  poleGuard: 0.15,
  /** triangles per disc, sized so the chord error stays under a bake texel */
  discSegments: 28,
  /** disc alpha at the RIM, 1 at the centre, interpolated per vertex through
   *  the same `aFade` attribute the streaks use. Not 0: a hair of rim keeps the
   *  faintest stars from vanishing. */
  discRimAlpha: 0.06,
  /** exponent on that ramp. Under 1, so the core holds near full ink and only
   *  the rim feathers — a bare linear cone peaks at a point and reads dim. */
  discSoftPow: 0.3,
};

/** The streak bake's look knobs. ORPHANED with `bakeSky` — nothing reads this.
 *  Every streak runs along the great circle from its star toward THE THROAT
 *  (world +X, sky az = alt = 0), so a different exit axis would need a
 *  different bake rather than a different uniform: content, not a knob. */
export const STREAK_LOOK = {
  /** angular length of the LONGEST streak, radians — drawn for the star
   *  directly OPPOSITE the throat. Every other streak is
   *  `lenRad · (γ/π)^falloffPow` for γ the angle to the throat. */
  lenRad: 1.5,
  /** the falloff's exponent: 1 = length linear in the angle to the throat. */
  falloffPow: 1.6,
  /** streak half-width as a multiple of the star's OWN disc radius. Under 1,
   *  so the disc stays the widest part and the two read as one mark. */
  widthScale: 0.65,
  /** the along-length opacity gradient: alpha = (1 − t)^fadePow, t = 0 at the
   *  star (the head) and 1 at the throat-ward end. */
  fadePow: 1.6,
  /** overall streak alpha, on top of the gradient and the palette's
   *  starOpacity: keeps the ribbons under the discs. */
  alpha: 0.85,
  /** great-circle segments per streak: the path is curved in equirect uv, so a
   *  streak is a POLYLINE of thin quads. */
  segments: 10,
  /** streaks shorter than this (radians) are dropped — near the throat the
   *  length collapses under a disc radius and a stub reads as grit. */
  minLenRad: 0.012,
};

/** THE THROAT, in sky coordinates: the fly-through's exit/view axis is world
 *  +X, i.e. az = 0, alt = 0. Exported so optics/starfield.ts, which draws the
 *  same streaks as geometry, aims at the same axis from one definition. */
export const THROAT_AZ = 0;
export const THROAT_ALT = 0;

/** Dual palettes — the site theme flips the whole sky. Dark stage: cream ink on
 *  a deep ground. Light stage (paper): dark ink on a warm near-white. */
export const SKY_INK: { dark: SkyPalette; light: SkyPalette } = {
  dark: {
    backdrop: 0x0b0d12,
    star: 0xf2ecd9,
    // the strokes are the stars' own ink, not 0xffffff: pure white beside the
    // cream discs reads as a second, colder light source
    line: 0xf2ecd9,
    // a hairline has to be BRIGHT to stay a line: the alpha is spent on the
    // two pixels it has rather than on width
    lineOpacity: 0.45,
    starOpacity: 0.95,
  },
  light: {
    backdrop: 0xf4efe2,
    star: 0x3a352b,
    // same decision as the dark side — strokes in the stars' own ink — which
    // here is the dark neutral; white on a warm near-white is no mark at all
    line: 0x3a352b,
    // held lower than the dark side: dark ink on paper starts with the contrast
    // the dark stage had to buy with alpha
    lineOpacity: 0.5,
    starOpacity: 1,
  },
};

// ── STAR TEMPERATURES ────────────────────────────────────────────────────────
// A TINT ON THE THEME'S OWN STAR INK, not absolute colours — the only form that
// serves both stages, since the dark one inks stars in cream and the light one
// in a near-black. EVERY STOP PEAKS AT 0xff, so a tint can only take light OUT
// of a channel.

/** The ramp, cool → warm, as authored sRGB hex. */
const TEMP_HEX = [
  0xdceaff, // blue-white
  0xf0f6ff, // white, faintly cool
  0xffffff, // white — the theme's ink, untinted
  0xfff6ea, // warm white
  0xfff0d8, // yellow
  0xffe4c0, // orange
];

/** …and how often each is drawn. Sums to 1; `tintAt` clamps to the last stop
 *  against float slop. */
const TEMP_WEIGHTS = [0.05, 0.14, 0.3, 0.28, 0.16, 0.07];

/** The ramp as LINEAR RGB multipliers — the space the shaders' colours are
 *  multiplied in, so a stop reads on screen as the hex it is authored as. */
export const STAR_TINTS: readonly (readonly [number, number, number])[] =
  TEMP_HEX.map((h) => {
    const c = new THREE.Color().setHex(h, THREE.SRGBColorSpace);
    return [c.r, c.g, c.b] as const;
  });

/** A star's tint, from its index within its population and that population's
 *  stream key. A HASH, NOT A DRAW: a generated population's identity is its
 *  per-sample draw COUNT, so pulling a colour out of the same LCG would shift
 *  every star after the first. Reading the index keeps temperature orthogonal
 *  to position. */
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
// ONE RANK, TWO OUTPUTS: a star's `mag` is a linear map of a BRIGHTNESS RANK in
// 0..1 (`magAt`), and its ink is the same rank mapped onto `inkMin`..1
// (`inkOf`), so size and ink cannot disagree. `magAt` is the inverse CDF of a
// truncated exponential, so the density falls as e^(−decay·rank) — a handful of
// anchors over a growing mass of faint texture.
export const BRIGHTNESS_LAW = {
  /** rank 0 — the faint end of the drawn field. Under the disc floor's knee, so
   *  these are drawn at the floor's size and pay the difference back in ink. */
  magDark: 0.35,
  /** rank 1 — full ink. Set at the top of the authored table's useful range,
   *  not its maximum, so the rows above it are the sky's clear anchors. */
  magBright: 2.4,
  /** the exponential's decay CONSTANT, per unit rank, so the field spans
   *  decay/ln(10) decades of count end to end. Lower flattens it toward a
   *  uniform sheet; higher empties it. Pinned by sky.test.ts (h3). */
  decay: 7,
  /** the ink of a rank-0 star before the disc floor's payback. Not 0: a star
   *  drawn at nothing is not worth the quad it costs. */
  inkMin: 0.15,
  /** THE BRIGHT/BACKDROP CUT, in magnitude — where `SKY.stars` splits the drawn
   *  field, and therefore where `BRIGHT_COUNT` lands. It is the DISC FLOOR'S
   *  KNEE: at or above it a star is drawn at its honest size, below it a speck
   *  at STARFIELD_LOOK.minRhoRad — exactly the line a stroke or a name may hang
   *  on. A literal because starfield.ts imports this file; its test (f4) keeps
   *  the two in step. */
  brightMag: 0.7,
};

/** The magnitude draw: a uniform u in [0, 1) → a magnitude, through the inverse
 *  CDF of a truncated exponential on the rank.
 *      rank = −ln(1 − u·(1 − e^(−decay))) / decay      ∈ [0, 1]
 *      mag  = magDark + (magBright − magDark) · rank */
export function magAt(u: number): number {
  const k = BRIGHTNESS_LAW.decay;
  const rank = -Math.log(1 - u * (1 - Math.exp(-k))) / k;
  return (
    BRIGHTNESS_LAW.magDark +
    (BRIGHTNESS_LAW.magBright - BRIGHTNESS_LAW.magDark) * rank
  );
}

/** A star's ink from its magnitude — the exact inverse of `magAt`'s linear
 *  half, clamped, so the ink inherits the exponential distribution unchanged.
 *  This is the CATALOG's ink: the disc floor's payback is multiplied in on top
 *  by starfield.ts and star-trails.ts, which is why the drawn field goes below
 *  `inkMin`. */
export function inkOf(mag: number): number {
  const { magDark, magBright, inkMin } = BRIGHTNESS_LAW;
  const rank = (mag - magDark) / (magBright - magDark);
  return Math.min(1, Math.max(inkMin, inkMin + (1 - inkMin) * rank));
}

// Placeholder content: 75 stars in three loose groups plus two scatter blocks,
// with three constellations wired over the first nineteen.
/* prettier-ignore */
const STAR_TABLE: [az: number, alt: number, mag: number][] = [
  // — "The Barrel" (group 0, indices 0..6), at az ≈ ±π: the sky BEHIND the
  //   fly-through, which faces world +X throughout.
  //   SEAM: the cluster spans 0.76 rad, so the whole group is carried by +2.95
  //   rather than a clean half turn — that keeps the shape rigid and leaves
  //   every disc AND stroke on one side of az = ±π, which the bake needs since
  //   it silently drops seam-crossing strokes.
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
  // — THROAT SCATTER (indices 42..74): faint background texture, not shape. The
  //   wormhole pinch draws one radial ribbon per star into the exit axis, so
  //   the throat is only as dense as the sky it has to pull. These sit mostly
  //   in az ∈ (−1.2, 1.2) at low mags, in loose knots with stragglers between —
  //   an even lattice reads as a screen door once the pinch combs it.
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
 *  index below addresses this array, and the field is appended after it
 *  precisely so that stays true. */
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
// The authored table is SHAPE; this is the depth behind it — one continuous
// population under BRIGHTNESS_LAW, split only where the array is cut for the
// stroke/name pool (`brightMag`).
//
// GENERATED, NOT RANDOM: `Math.random` is forbidden anywhere a frame can see
// it, and a catalog that changed between loads would make every golden
// meaningless. A fixed-seed 32-bit LCG gives the same field on every machine,
// reload and test run. APPENDED, NEVER MERGED, so the constellations' indices
// and the authored rows are untouched by anything here.
export const FIELD_LOOK = {
  /** how many stars are generated. Bounded on BOTH sides: every star costs a
   *  quad in the starfield draw and a segmented arc in the trail draw
   *  (`count × (TRAIL_LOOK.segments + 1) × 2` vertices), and under a few
   *  hundred the finale is discs on paper rather than a field. */
  count: 720,
  /** the LCG's seed — THE knob for "same sky, different draw". Any 32-bit value
   *  gives a different but equally deterministic field. */
  seed: 20260812,
  /** fraction of draws CONCENTRATED about the throat; the rest uniform over the
   *  sphere. A uniform-only field reads thin (the frame the story holds is a
   *  narrow cone), but the periphery still has to be dressed. */
  coreFraction: 0.7,
  /** the concentration's WIDTH, radians: γ off the throat is drawn Rayleigh
   *  with this σ, i.e. a round 2D Gaussian in the tangent plane. Chosen over
   *  "uniform inside a cap" for what a cap cannot do — the density is FLAT at
   *  the very centre, and it has NO EDGE, so the field thins toward the corners
   *  instead of ending on a visible circle. */
  coreSigmaRad: 0.55,
  /** off the equirect SEAM (the header's authoring rule): |az| is capped at
   *  π − this, more than a disc radius clear of az = ±π at any magnitude
   *  BRIGHTNESS_LAW can draw. Only the bake cares, but the catalog is shared,
   *  so the rule is enforced at the source. */
  seamMarginRad: 0.15,
};

/** A 32-bit linear congruential generator (Numerical Recipes' constants) as a
 *  `() => [0, 1)` stream. `Math.imul` keeps the multiply exact in 32 bits,
 *  which is what makes the sequence identical in every JS engine. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** The generated field, from the seed alone: two placement draws mixed by
 *  `coreFraction` — one concentrated about the throat, one uniform over the
 *  sphere (`alt = asin(uniform)`; sampling alt uniformly bunches the poles) —
 *  plus one magnitude draw through BRIGHTNESS_LAW.
 *
 *  FOUR DRAWS EITHER WAY, so which branch a sample took does not shift the
 *  stream for the ones after it. A rejected sample consumes its draws and the
 *  loop retries, so the catalog depends only on the seed; the iteration ceiling
 *  is a tripwire, not a live limit. */
export function buildField(look = FIELD_LOOK): Star[] {
  const rand = lcg(look.seed);
  const azLimit = Math.PI - look.seamMarginRad;
  const out: Star[] = [];
  for (let i = 0; out.length < look.count && i < look.count * 100; i++) {
    let az: number;
    let alt: number;
    if (rand() < look.coreFraction) {
      // concentrated, in polar form about the throat: γ off the axis, Rayleigh
      // at σ = coreSigmaRad, and a uniform roll around it. The axis is world +X
      // (az = alt = 0), so the roll turns in the (Y, Z) plane and the direction
      // goes back to sky coordinates directly.
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
    // the seam, for both branches. The uniform draw cannot break the rule (its
    // az is clamped); the core draw can, when a sample more than a right angle
    // off the axis rolls near the Y axis.
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
 *  real discs first, the backdrop specks after. A STABLE PARTITION, not a sort:
 *  each half keeps the generator's own order, so a re-seed cannot silently
 *  reorder one half against the other. */
const FIELD = buildField();
const FIELD_BRIGHT = FIELD.filter((s) => s.mag >= BRIGHTNESS_LAW.brightMag);
const FIELD_BACKDROP = FIELD.filter((s) => s.mag < BRIGHTNESS_LAW.brightMag);

/** HOW MANY STARS MAY CARRY A STROKE OR A NAME: the authored table plus the
 *  field's bright half, i.e. the prefix of `SKY.stars` before the backdrop.
 *  Anything that draws TO a star — the line pool, the names — reads this, since
 *  a stroke or a label on a backdrop speck would read as a mistake. */
export const BRIGHT_COUNT = AUTHORED_COUNT + FIELD_BRIGHT.length;

/** THE CATALOG: the authored table, then the field's bright half, then its
 *  backdrop half. */
export const SKY: { stars: Star[]; constellations: Constellation[] } = {
  stars: [...AUTHORED, ...FIELD_BRIGHT, ...FIELD_BACKDROP],
  constellations: CONSTELLATIONS,
};

/** The stroke machinery, shared by the constellation lines and the streaks: the
 *  perpendicular offset IN UV UNITS for a stroke running (u0,v0) → (u1,v1) at a
 *  constant ANGULAR half-thickness. Worked in the local frame X = az·cos(alt̄),
 *  Y = alt at the stroke's midpoint altitude, where angles are locally
 *  isotropic; offsetting in raw uv would make a horizontal stroke read thinner
 *  than a vertical one by the 2:1 texture aspect. */
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
  /** draw a real LINE STREAK behind every star, toward the throat; everything
   *  else about the bake is identical */
  streaked?: boolean;
}

/** Bake the sky into an equirect render target, once, with the live renderer.
 *  ORPHANED — nothing calls this, and STREAK_LOOK goes with it.
 *
 *  Drawn in UV space through an ortho camera over the unit square, so a vertex
 *  position IS its uv; discs are stretched in u by 1/cos(alt) because that is
 *  what an equirect projection does to a circle off the equator. The backdrop
 *  is a quad and the previous render target is restored, so nothing leaks into
 *  the main pass. The target keeps RenderTarget's default NoColorSpace.
 *
 *  CALL THIS ONLY AFTER `await renderer.init()`: a pre-init render silently
 *  produces a BLANK target, because the async path defers the work and the
 *  geometry is disposed the moment this returns. There is deliberately no
 *  throw — the ordering is the call site's job. */
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
  // u wraps (azimuth is periodic — a sample at u = 0.999 must blend into u = 0)
  // while v clamps (altitude is not)
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
  // Thin quads, not THREE.Line: WebGPU clamps line width to 1px, which all but
  // vanishes in a 2048-wide bake. A stroke whose ends straddle the u seam is
  // SKIPPED — it would otherwise streak all the way across the texture.
  const lineVerts: number[] = [];
  for (const c of SKY.constellations)
    for (const [a, b] of c.lines) {
      const [u0, v0] = skyUv(SKY.stars[a].az, SKY.stars[a].alt);
      const [u1, v1] = skyUv(SKY.stars[b].az, SKY.stars[b].alt);
      if (Math.abs(u1 - u0) > 0.5) continue; // seam-crossing stroke
      // offset ON THE SPHERE, then back to uv — the same constant-angular-size
      // treatment the discs get
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
      // the quads come out CW-wound in this camera's frame for EVERY stroke
      // direction, so default back-face culling would erase all of them
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
  // A POLYLINE of thin quads per star, walking the great circle toward the
  // throat on the same `strokeOffset` machinery and DoubleSide winding escape
  // as the constellation strokes, plus a per-vertex alpha running 1 at the star
  // to 0 at the far end. Drawn UNDER the discs (renderOrder 1.5).
  //
  // THE GRADIENT IS AN ATTRIBUTE + opacityNode, not vertexColors: NodeMaterial
  // folds vertex colours in against a vec3 material colour, so a 4-component
  // `color` attribute's alpha is not reliable. `opacityNode` REPLACES
  // `material.opacity`, so the palette's starOpacity is multiplied in here.
  const starRho = (mag: number) =>
    SKY_LOOK.starRhoRad * Math.pow(mag, SKY_LOOK.magRhoGain);
  /** `opacityNode` reading the shared per-vertex `aFade`, shaped by `softPow`.
   *  Cast at the shader-graph boundary: three's `attribute()` is typed as a
   *  bare AttributeNode, without the TSL methods the proxy gives it. */
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
      // γ = angle to the throat, and the tangent of the great circle joining
      // them (the throat's component perpendicular to the star)
      const cosG = Math.min(1, Math.max(-1, sx * tx + sy * ty + sz * tz));
      const gamma = Math.acos(cosG);
      const px = tx - sx * cosG;
      const py = ty - sy * cosG;
      const pz = tz - sz * cosG;
      const pLen = Math.hypot(px, py, pz);
      // star ON the axis or exactly opposite it: no great circle is picked
      // out and the tangent is undefined
      if (pLen < 1e-6) continue;
      // length grows with the angle to the throat, capped at γ so a streak can
      // never overshoot it and come out the far side
      const len = Math.min(
        STREAK_LOOK.lenRad * Math.pow(gamma / Math.PI, STREAK_LOOK.falloffPow),
        gamma,
      );
      if (len < STREAK_LOOK.minLenRad) continue;
      const half = starRho(s.mag) * STREAK_LOOK.widthScale;
      const ux = px / pLen;
      const uy = py / pLen;
      const uz = pz / pLen;
      // walk the arc: P(t) = S·cos t + û·sin t, sampled at segs+1 points
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
        // seam: TRUNCATE rather than let a segment streak across the whole
        // texture. Streaks run toward az = 0, so |az| shrinks and this is a
        // tripwire for future authored content, not a live case.
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
  // A TRIANGLE FAN OF ALPHA, not a flat chip: the hub vertex carries fade 1 and
  // every rim vertex `discRimAlpha`, so the interpolator does the falloff for
  // free. With no hard edge left there is no silhouette for the chords to make
  // read as a polygon.
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
  // `opacityNode` REPLACES `material.opacity`, so the palette's starOpacity is
  // folded in here
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

  // the scene is single-use: the texture is the product
  for (const d of disposables) d.dispose();
  bakeScene.clear();

  return {
    target,
    dispose() {
      target.dispose();
    },
  };
}
