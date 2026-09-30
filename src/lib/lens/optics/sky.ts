import * as THREE from "three/webgpu";
import { lcg } from "../core/math";

// The sky catalog: authored stars and constellations plus a seeded generated
// field; optics/starfield.ts draws it. Directions use (az, alt) =
// (atan2(z, x), asin(y)) in the world frame, matching three's `equirectUV`.
// `SKY.stars` order is fixed: authored, then bright field, then backdrop field.

export interface Star {
  /** azimuth, radians, = atan2(dir.z, dir.x); 0 points along world +X */
  az: number;
  /** altitude, radians, = asin(dir.y); +π/2 is world +Y */
  alt: number;
  /** brightness, bigger = brighter; drives disc size, trail width and ink */
  mag: number;
  /** ink multiplier, 0..1 (default 1); catalog rows carry `inkOf(mag)` */
  ink?: number;
  /** temperature tint, a linear RGB multiplier on the theme's star ink */
  tint: readonly [number, number, number];
}

export interface Constellation {
  id: string;
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
  /** trail ink, when it differs from the star ink */
  trail?: number;
}

/** The fly-through's exit axis (world +X) in sky coordinates. */
export const THROAT_AZ = 0;
export const THROAT_ALT = 0;

/** Sky palettes for the dark and light site themes. */
export const SKY_INK: { dark: SkyPalette; light: SkyPalette } = {
  dark: {
    backdrop: 0x16100a,
    star: 0xf2ecd9,
    line: 0xf2ecd9,
    lineOpacity: 0.45,
    starOpacity: 0.95,
  },
  light: {
    backdrop: 0xf4efe2,
    star: 0x3a352b,
    line: 0x3a352b,
    lineOpacity: 0.5,
    starOpacity: 1,
    trail: 0x221c14,
  },
};

/** Star temperature tints, cool → warm, sRGB hex. Each stop has a 0xff channel,
 *  so a tint only darkens the theme's ink. */
const TEMP_HEX = [
  0xe6ffe0, // sage-white
  0xf6fff2, // white, faintly sage
  0xffffff, // white — the theme's ink, untinted
  0xfff6ea, // warm white
  0xfff0d8, // yellow
  0xffe4c0, // orange
];

/** How often each tint is picked; sums to 1. */
const TEMP_WEIGHTS = [0.05, 0.14, 0.3, 0.28, 0.16, 0.07];

/** The tints as linear RGB multipliers. */
export const STAR_TINTS: readonly (readonly [number, number, number])[] =
  TEMP_HEX.map((h) => {
    const c = new THREE.Color().setHex(h, THREE.SRGBColorSpace);
    return [c.r, c.g, c.b] as const;
  });

/** A star's tint, hashed from its index and a key (independent of the field's RNG). */
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

// Brightness: a rank in 0..1 maps linearly to both `mag` and ink, and ranks are
// drawn from a truncated exponential (density ∝ e^(−decay·rank)).
export const BRIGHTNESS_LAW = {
  /** magnitude at rank 0 (faintest) */
  magDark: 0.35,
  /** magnitude at rank 1 (full ink) */
  magBright: 2.4,
  /** decay constant per unit rank */
  decay: 7,
  /** ink at rank 0 */
  inkMin: 0.15,
  /** bright/backdrop split in magnitude; must match where STARFIELD_LOOK.minRhoRad
   *  starts to bite (a test checks) */
  brightMag: 0.7,
};

/** Uniform u in [0, 1) → magnitude, via the inverse CDF of the rank distribution. */
export function magAt(u: number): number {
  const k = BRIGHTNESS_LAW.decay;
  const rank = -Math.log(1 - u * (1 - Math.exp(-k))) / k;
  return (
    BRIGHTNESS_LAW.magDark +
    (BRIGHTNESS_LAW.magBright - BRIGHTNESS_LAW.magDark) * rank
  );
}

/** A star's ink from its magnitude, clamped to [inkMin, 1]. */
export function inkOf(mag: number): number {
  const { magDark, magBright, inkMin } = BRIGHTNESS_LAW;
  const rank = (mag - magDark) / (magBright - magDark);
  return Math.min(1, Math.max(inkMin, inkMin + (1 - inkMin) * rank));
}

// Authored stars: three constellation groups, then scatter.
/* prettier-ignore */
const STAR_TABLE: [az: number, alt: number, mag: number][] = [
  // — "The Barrel" (indices 0..6), behind the fly-through, kept off the az = ±π seam
  [ 2.33,  0.34, 2.6], [ 2.57,  0.47, 1.7], [ 2.84,  0.41, 2.2],
  [ 3.09,  0.28, 3.1], [ 3.04,  0.02, 1.9], [ 2.76, -0.12, 2.4],
  [ 2.43,  0.06, 1.5],
  // — "The Ring" (indices 7..12)
  [ 1.42,  0.12, 2.9], [ 1.68,  0.31, 1.8], [ 1.97,  0.22, 2.3],
  [ 2.05, -0.06, 1.6], [ 1.79, -0.24, 2.7], [ 1.49, -0.15, 2.0],
  // — "The Mount" (indices 13..18)
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
  // — faint scatter around the throat (indices 42..74), in loose knots
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

/** Authored stars; constellation indices point into this prefix of `SKY.stars`. */
const AUTHORED: Star[] = STAR_TABLE.map(([az, alt, mag], i) => ({
  az,
  alt,
  mag,
  ink: inkOf(mag),
  tint: tintAt(i),
}));

/** Number of authored stars at the start of `SKY.stars`. */
export const AUTHORED_COUNT = AUTHORED.length;

/** A constellation whose strokes join its stars in order; `closed` also joins
 *  the last star back to the first. */
function chain(
  id: string,
  label: string,
  stars: number[],
  closed: boolean,
): Constellation {
  const lines = stars.slice(1).map((s, i): [number, number] => [stars[i], s]);
  if (closed) lines.push([stars[stars.length - 1], stars[0]]);
  return { id, label, stars, lines };
}

const CONSTELLATIONS: Constellation[] = [
  chain("barrel", "The Barrel", [0, 1, 2, 3, 4, 5, 6], true),
  chain("ring", "The Ring", [7, 8, 9, 10, 11, 12], true),
  chain("mount", "The Mount", [13, 14, 15, 16, 17, 18], false),
];

/** (az, alt) → unit direction. */
export function dirOf(az: number, alt: number): [number, number, number] {
  const c = Math.cos(alt);
  return [c * Math.cos(az), Math.sin(alt), c * Math.sin(az)];
}

// The generated field, from a fixed-seed LCG so it is identical everywhere.
export const FIELD_LOOK = {
  /** stars generated; each costs a starfield quad and a trail arc */
  count: 720,
  seed: 20260812,
  /** fraction of stars clustered about the throat; the rest are uniform */
  coreFraction: 0.7,
  /** cluster width, radians (Rayleigh σ of the angle off the throat) */
  coreSigmaRad: 0.55,
  /** stars keep at least this far from the az = ±π seam, radians */
  seamMarginRad: 0.15,
};

/** Generates the field: a throat cluster mixed with a uniform sphere, each star
 *  using four random draws. Depends only on the seed. */
export function buildField(look = FIELD_LOOK): Star[] {
  const rand = lcg(look.seed);
  const azLimit = Math.PI - look.seamMarginRad;
  const out: Star[] = [];
  for (let i = 0; out.length < look.count && i < look.count * 100; i++) {
    let az: number;
    let alt: number;
    if (rand() < look.coreFraction) {
      // Rayleigh angle off the throat axis (+X), uniform roll around it
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
    // reject cluster samples that land near the seam
    if (Math.PI - Math.abs(az) < look.seamMarginRad) continue;
    const mag = magAt(u);
    out.push({
      az,
      alt,
      mag,
      ink: inkOf(mag),
      tint: tintAt(out.length, look.seed),
    });
  }
  return out;
}

/** The field split at BRIGHTNESS_LAW.brightMag, each half in generation order. */
const FIELD = buildField();
const FIELD_BRIGHT = FIELD.filter((s) => s.mag >= BRIGHTNESS_LAW.brightMag);
const FIELD_BACKDROP = FIELD.filter((s) => s.mag < BRIGHTNESS_LAW.brightMag);

/** Stars before the backdrop in `SKY.stars`; only these may carry strokes or names. */
export const BRIGHT_COUNT = AUTHORED_COUNT + FIELD_BRIGHT.length;

/** The catalog: authored stars, then the bright field, then the backdrop field. */
export const SKY: { stars: Star[]; constellations: Constellation[] } = {
  stars: [...AUTHORED, ...FIELD_BRIGHT, ...FIELD_BACKDROP],
  constellations: CONSTELLATIONS,
};
