import * as THREE from "three/webgpu";

// The sky catalog: an authored table of star directions and constellation
// lines plus a seeded generated field; optics/starfield.ts draws it.
// (az, alt) = (atan2(z, x), asin(y)) so `skyUv` matches three's `equirectUV`;
// sky frame = world frame. Nothing wraps across u = 0/1: a stroke straddling
// the seam is skipped, a disc within its own `ru` of az = ±π is clipped — keep
// stars a disc-radius clear of az = ±π (FIELD_LOOK.seamMarginRad).
// `SKY.stars` order is a contract: authored ++ bright field ++ backdrop; the
// authored rows never move, and only the first BRIGHT_COUNT rows may carry ink.

export interface Star {
  /** azimuth, radians, = atan2(dir.z, dir.x); 0 points along world +X */
  az: number;
  /** altitude, radians, = asin(dir.y); +π/2 is world +Y */
  alt: number;
  /** the one brightness quantity: bigger = brighter (inverse of the
   *  astronomical convention). It drives the disc's angular radius, the trail
   *  arc's half-width and — through `inkOf` — the ink both are drawn at. */
  mag: number;
  /** per-star ink multiplier, 0..1 (1 when absent); every shipped row carries
   *  `inkOf(mag)`. It spreads the field's brightness once the discs are down at
   *  a pixel or two, where size alone buys nothing. */
  ink?: number;
  /** the temperature tint — a linear RGB multiplier on the theme's star ink,
   *  not a colour of its own. Both the discs and the arcs read it. */
  tint: readonly [number, number, number];
}

export interface Constellation {
  id: string;
  /** authored, never baked — the treatment is story/constellations.ts's */
  label: string;
  /** indices into SKY.stars */
  stars: number[];
  /** index pairs drawn as strokes; both ends must be in `stars` */
  lines: [number, number][];
}

export interface SkyPalette {
  backdrop: number;
  star: number;
  line: number;
  lineOpacity: number;
  starOpacity: number;
  /** the trails' ink where it must run deeper than the stars' (light theme) */
  trail?: number;
}

/** The throat, in sky coordinates: the fly-through's exit/view axis is world
 *  +X, i.e. az = 0, alt = 0. Exported so optics/starfield.ts aims at the same
 *  axis from one definition. */
export const THROAT_AZ = 0;
export const THROAT_ALT = 0;

/** Dual palettes — the site theme flips the whole sky. Dark stage: cream ink on
 *  a deep ground. Light stage (paper): dark ink on a warm near-white. */
export const SKY_INK: { dark: SkyPalette; light: SkyPalette } = {
  dark: {
    // the hue of html.dark's --bg, taken down to a night sky
    backdrop: 0x16100a,
    star: 0xf2ecd9,
    // strokes are the stars' own ink, not white — white would read as a second,
    // colder light source
    line: 0xf2ecd9,
    lineOpacity: 0.45,
    starOpacity: 0.95,
  },
  light: {
    backdrop: 0xf4efe2,
    star: 0x3a352b,
    // strokes in the stars' own ink again, here the dark neutral
    line: 0x3a352b,
    lineOpacity: 0.5,
    starOpacity: 1,
    trail: 0x221c14,
  },
};

// Star temperatures: a tint on the theme's own star ink, not absolute colours,
// so one ramp serves both stages. Every stop peaks at 0xff, so a tint can only
// take light out of a channel.

/** The ramp, cool → warm, as authored sRGB hex. The cool end is the site's
 *  olive-sage, not blue. */
const TEMP_HEX = [
  0xe6ffe0, // sage-white
  0xf6fff2, // white, faintly sage
  0xffffff, // white — the theme's ink, untinted
  0xfff6ea, // warm white
  0xfff0d8, // yellow
  0xffe4c0, // orange
];

/** …and how often each is drawn. Sums to 1; `tintAt` clamps to the last stop
 *  against float slop. */
const TEMP_WEIGHTS = [0.05, 0.14, 0.3, 0.28, 0.16, 0.07];

/** The ramp as linear RGB multipliers — the space the shaders' colours are
 *  multiplied in, so a stop reads on screen as the hex it is authored as. */
export const STAR_TINTS: readonly (readonly [number, number, number])[] =
  TEMP_HEX.map((h) => {
    const c = new THREE.Color().setHex(h, THREE.SRGBColorSpace);
    return [c.r, c.g, c.b] as const;
  });

/** A star's tint, from its index within its population and that population's
 *  stream key. A hash, not a draw: pulling a colour out of the same LCG would
 *  shift every star after the first. */
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

// The brightness law — one rank, two outputs: a star's `mag` is a linear map of
// a brightness rank in 0..1 (`magAt`), and its ink is the same rank mapped onto
// `inkMin`..1 (`inkOf`), so size and ink cannot disagree. `magAt` is the inverse
// CDF of a truncated exponential, so the density falls as e^(−decay·rank).
export const BRIGHTNESS_LAW = {
  /** rank 0 — the faint end of the drawn field. Under the disc floor's knee, so
   *  these are drawn at the floor's size and pay the difference back in ink. */
  magDark: 0.35,
  /** rank 1 — full ink. Set at the top of the authored table's useful range,
   *  so the rows above it are the sky's clear anchors. */
  magBright: 2.4,
  /** the exponential's decay constant, per unit rank, so the field spans
   *  decay/ln(10) decades of count end to end. */
  decay: 7,
  /** the ink of a rank-0 star before the disc floor's payback. */
  inkMin: 0.15,
  /** The bright/backdrop cut, in magnitude — where `SKY.stars` splits the drawn
   *  field, and so where `BRIGHT_COUNT` lands. It is the disc floor's knee: at
   *  or above it a star is drawn at its honest size, below it a speck at
   *  STARFIELD_LOOK.minRhoRad. A literal because starfield.ts imports this
   *  file; a test keeps the two in step. */
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

/** A star's ink from its magnitude — the inverse of `magAt`'s linear half,
 *  clamped, so the ink inherits the exponential distribution. This is the
 *  catalog's ink; starfield.ts and star-trails.ts multiply the disc floor's
 *  payback in on top, which is why the drawn field goes below `inkMin`. */
export function inkOf(mag: number): number {
  const { magDark, magBright, inkMin } = BRIGHTNESS_LAW;
  const rank = (mag - magDark) / (magBright - magDark);
  return Math.min(1, Math.max(inkMin, inkMin + (1 - inkMin) * rank));
}

// Placeholder content: 75 stars in three loose groups plus two scatter blocks,
// with three constellations wired over the first nineteen.
/* prettier-ignore */
const STAR_TABLE: [az: number, alt: number, mag: number][] = [
  // — "The Barrel" (group 0, indices 0..6), at az ≈ ±π: the sky behind the
  //   fly-through. Carried by +2.95 rather than a clean half turn, so every
  //   disc and stroke stays on one side of the az = ±π seam.
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
  // — throat scatter (indices 42..74): faint background texture, not shape.
  //   Mostly az ∈ (−1.2, 1.2) at low mags, in loose knots with stragglers
  //   between — an even lattice reads as a screen door once the pinch combs it.
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
  // stragglers between the knots
  [ 0.36,  0.16, 1.0], [ 0.22,  0.44, 1.3], [-0.62, -0.13, 1.6],
  [ 0.48,  0.61, 0.85], [-0.05,  0.33, 1.1], [ 0.79, -0.47, 1.4],
  [-1.13, -0.29, 1.0], [ 1.19, -0.36, 0.9], [-0.88,  0.05, 2.1],
  // two just outside the band
  [ 1.63,  0.63, 0.9], [-1.66,  0.48, 1.1],
];

/** The authored half of the catalog: these rows never move, because every
 *  constellation index below addresses this array and the field is appended
 *  after it. */
const AUTHORED: Star[] = STAR_TABLE.map(([az, alt, mag], i) => ({
  az,
  alt,
  mag,
  ink: inkOf(mag),
  tint: tintAt(i),
}));

/** How many stars are authored — the prefix of `SKY.stars` the constellations
 *  wire over, and the boundary the background begins at. */
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

// The generated field — the depth behind the authored table's shape, one
// continuous population under BRIGHTNESS_LAW, split only where the array is cut
// for the stroke/name pool (`brightMag`). Generated from a fixed-seed 32-bit
// LCG, never `Math.random`, so the catalog is identical on every machine and
// reload. Appended, never merged, so the constellations' indices still hold.
export const FIELD_LOOK = {
  /** how many stars are generated. Every star costs a quad in the starfield
   *  draw and a segmented arc in the trail draw
   *  (`count × (TRAIL_LOOK.segments + 1) × 2` vertices). */
  count: 720,
  /** the LCG's seed — the knob for "same sky, different draw". */
  seed: 20260812,
  /** fraction of draws concentrated about the throat; the rest uniform over the
   *  sphere. */
  coreFraction: 0.7,
  /** the concentration's width, radians: γ off the throat is drawn Rayleigh
   *  with this σ, i.e. a round 2D Gaussian in the tangent plane. Unlike a cap
   *  it has no edge, so the field thins toward the corners instead of ending on
   *  a visible circle. */
  coreSigmaRad: 0.55,
  /** off the equirect seam: |az| is capped at π − this, more than a disc radius
   *  clear of az = ±π at any magnitude BRIGHTNESS_LAW can draw. */
  seamMarginRad: 0.15,
};

/** A 32-bit linear congruential generator (Numerical Recipes' constants) as a
 *  `() => [0, 1)` stream. `Math.imul` keeps the multiply exact in 32 bits, so
 *  the sequence is identical in every JS engine. */
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
 *  Four draws either way, so which branch a sample took does not shift the
 *  stream for the ones after it. A rejected sample consumes its draws and the
 *  loop retries, so the catalog depends only on the seed. */
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
      // (az = alt = 0), so the roll turns in the (Y, Z) plane.
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
      // the positions
      tint: tintAt(out.length, look.seed),
    });
  }
  return out;
}

/** The generated field, split at BRIGHTNESS_LAW.brightMag: the stars drawn as
 *  real discs first, the backdrop specks after. A stable partition, not a sort
 *  — each half keeps the generator's own order. */
const FIELD = buildField();
const FIELD_BRIGHT = FIELD.filter((s) => s.mag >= BRIGHTNESS_LAW.brightMag);
const FIELD_BACKDROP = FIELD.filter((s) => s.mag < BRIGHTNESS_LAW.brightMag);

/** How many stars may carry a stroke or a name: the authored table plus the
 *  field's bright half, i.e. the prefix of `SKY.stars` before the backdrop.
 *  Anything that draws to a star — the line pool, the names — reads this. */
export const BRIGHT_COUNT = AUTHORED_COUNT + FIELD_BRIGHT.length;

/** The catalog: the authored table, then the field's bright half, then its
 *  backdrop half. */
export const SKY: { stars: Star[]; constellations: Constellation[] } = {
  stars: [...AUTHORED, ...FIELD_BRIGHT, ...FIELD_BACKDROP],
  constellations: CONSTELLATIONS,
};
