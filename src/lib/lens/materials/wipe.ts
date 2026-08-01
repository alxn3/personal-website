import * as THREE from "three/webgpu";
import {
  uniform,
  float,
  mix,
  clamp,
  smoothstep,
  positionLocal,
} from "three/tsl";

// THE WIPE PRIMITIVE — a feathered split line swept through the model, for
// hero animations that reveal/retire a state change region-by-region: below
// the line a gated channel reads 0 (seated), above it the channel's live value,
// smoothstepped across the feather band. The line lives in MODEL space (the
// deform's own frame: optical axis = Y, mm — same space bloom.ts works in), as
// a scalar field compared against a swept level; uWipeAxis picks the field —
// 0: d = y + skew·x (along the optical axis), 1: d = −z + skew·(y − H/2)
// (bottom→top in the default /lens camera).
//
// Consumers: materials/bloom.ts multiplies its effective explode/unwrap and
// the formation output by wipe factors (one per selector uniform below);
// story/cinematics.ts colors the backdrop split plane with the same line rule.
//
// IDENTITY RULE (load-bearing): at uWipeOn = 0 wipeMask() returns EXACTLY 1
// (mix(1, raw, 0)) and every downstream factor is exactly 1 — the seated
// render, the /lens sliders and the instrument's idle check are untouched no
// matter what the other wipe uniforms hold.

// TSL nodes carry math methods the .d.ts doesn't declare; `any` is the escape hatch.
type Node = any;

/** Master switch, 0/1. MUST be 0 unless a wipe animation is live (see the
 *  identity rule above). */
export const uWipeOn = uniform(0);
/** Sweep progress 0..1: 0 = the line sits fully below the model (mask 1
 *  everywhere), 1 = fully exited above (mask 0 everywhere). */
export const uWipe = uniform(0);
/** Sweep direction, 0/1: 0 = along model +y (the optical axis — reads as a
 *  SIDEWAYS front in the default /lens camera), 1 = along model −z (reads
 *  BOTTOM→TOP in the default camera). The field and its sweep extents switch
 *  together; skew tilts the line within each axis's screen plane. */
export const uWipeAxis = uniform(0);
/** Line slope: axis 0 field is d = y + skew·x, axis 1 is d = −z + skew·(y−H/2)
 *  (model mm). 0 = a line perpendicular to the sweep direction. */
export const uWipeSkew = uniform(0);
/** Feather band HALF-width, model mm — the smoothstep spans level ± feather. */
export const uWipeFeather = uniform(8);
/** Mask sense, 0/1: 0 = live above the line / seated below, 1 = INVERTED —
 *  live below, seated above. Applied to the RAW mask, so the backdrop follows
 *  the same rule: uWipeBgBelow always backs the SEATED side. Identity: sits
 *  inside the uWipeOn-gated branch of wipeMask(), so uWipeOn 0 ⇒ factor 1. */
export const uWipeInvert = uniform(0);
/** Band mode, 0/1: the mask becomes wipeBandMask() — a bump around the line,
 *  so state deviates only within ±feather and reads seated on BOTH sides.
 *  Identity: same uWipeOn gate as uWipeInvert. */
export const uWipeBand = uniform(0);
/** Pressure wave: adds bump·band to the mask right at the front — a small
 *  extra kick exactly where the line passes. 0 = off. Identity: same uWipeOn
 *  gate as uWipeInvert. */
export const uWipeBump = uniform(0);
/** Channel selectors, 0/1 each: which bloom channels the wipe gates.
 *  factor_c = mix(1, mask, uWipeOn·selector_c). All default ON. */
export const uWipeExplode = uniform(1);
export const uWipeUnwrap = uniform(1);
export const uWipeFormation = uniform(1);

/** Backdrop flag, 0/1: the cinematics split plane shows only while BOTH
 *  uWipeOn and this are 1 (visibility applied JS-side each frame). */
export const uWipeBackdrop = uniform(0);
/** Backdrop colors: below / above the line. Palette-matched pairs live in
 *  WIPE_BACKDROPS (materials/shading.ts). */
export const uWipeBgBelow = uniform(new THREE.Color(0x160d07));
export const uWipeBgTo = uniform(new THREE.Color(0xff5c1f));

// Model extents the sweep range derives from. Y mirrors bloom's MODEL_H_MM
// (mount 0 → filter 76.5) — not imported: bloom imports THIS module, and a
// back-import would be circular. X bounds the seated radial extent (the mask
// reads REST positions; the widest shell sits well inside ±40mm).
const WIPE_Y_MIN_MM = 0;
const WIPE_Y_MAX_MM = 76.5;
const WIPE_X_MM = 40;

/**
 * The raw feathered line mask at a MODEL-space point (x, y, z): 0 well below
 * the line, 1 well above, smoothstep across ±uWipeFeather. The sweep level
 * maps uWipe 0..1 over the sweep axis's model range ± feather ± skew extent,
 * so the line enters from below at 0 and fully exits above at 1. No uWipeOn
 * gate — the backdrop plane (already visibility-gated) uses this directly.
 */
export function rawWipeMask(x: Node, y: Node, z: Node): Node {
  const axis = clamp(uWipeAxis, 0.0, 1.0) as Node;
  const skew = uWipeSkew as Node;
  const midY = (WIPE_Y_MIN_MM + WIPE_Y_MAX_MM) / 2;
  // axis 0: sweep along y, skew tilts over x — axis 1: sweep along −z, skew
  // tilts over y (centered so the line pivots about the model's middle)
  const d = mix(
    y.add(skew.mul(x)),
    z.negate().add(skew.mul(y.sub(midY))),
    axis,
  ) as Node;
  const skewExt = skew.abs().mul(mix(float(WIPE_X_MM), float(midY), axis));
  const lo = (mix(float(WIPE_Y_MIN_MM), float(-WIPE_X_MM), axis) as Node)
    .sub(uWipeFeather)
    .sub(skewExt);
  const hi = (mix(float(WIPE_Y_MAX_MM), float(WIPE_X_MM), axis) as Node)
    .add(uWipeFeather)
    .add(skewExt);
  const level = mix(lo, hi, clamp(uWipe, 0.0, 1.0)) as Node;
  const m = smoothstep(
    level.sub(uWipeFeather),
    level.add(uWipeFeather),
    d,
  ) as Node;
  return mix(m, float(1).sub(m), clamp(uWipeInvert, 0.0, 1.0));
}

/** The band bump around the line: 4·m·(1−m) of the feathered line mask — 1 at
 *  the line, 0 beyond the feather (symmetric under uWipeInvert). */
export function wipeBandMask(x: Node, y: Node, z: Node): Node {
  const m = rawWipeMask(x, y, z);
  return m.mul(float(1).sub(m)).mul(4);
}

/**
 * The wipe mask for the current vertex's REST position (positionLocal — the
 * bloom deform runs in this same local/model space), identity-gated: EXACTLY 1
 * when uWipeOn = 0 regardless of every other uniform. Fresh node tree per call
 * (a node can't be shared across materials).
 */
export function wipeMask(): Node {
  const p = positionLocal as Node;
  const m = rawWipeMask(p.x, p.y, p.z);
  const band = m.mul(float(1).sub(m)).mul(4);
  const shaped = (mix(m, band, clamp(uWipeBand, 0.0, 1.0)) as Node).add(
    band.mul(uWipeBump),
  );
  return mix(float(1), shaped, clamp(uWipeOn, 0.0, 1.0));
}

/**
 * Backdrop convenience setter for animation authors: flips uWipeBackdrop and
 * optionally sets the split colors (hex, e.g. a WIPE_BACKDROPS entry). The
 * plane itself lives in story/cinematics.ts and follows these uniforms.
 */
export function setWipeBackdrop(
  on: boolean,
  colors?: { below: number; to: number },
): void {
  uWipeBackdrop.value = on ? 1 : 0;
  if (colors) {
    uWipeBgBelow.value.setHex(colors.below);
    uWipeBgTo.value.setHex(colors.to);
  }
}
