import * as THREE from "three/webgpu";
import {
  abs,
  attribute,
  cameraProjectionMatrix,
  clamp,
  float,
  length,
  max,
  mix,
  modelViewMatrix,
  positionGeometry,
  pow,
  smoothstep,
  step,
  uniform,
  varying,
  vec2,
  vec4,
} from "three/tsl";
import type { TslNode } from "../ops/algebra-tsl";
import {
  SKY,
  SKY_INK,
  THROAT_ALT,
  THROAT_AZ,
  dirOf,
  type SkyPalette,
  type Star,
} from "./sky";

// ============================================================================
// THE STARFIELD AS GEOMETRY — the same authored sky optics/sky.ts bakes into an
// equirect texture, drawn instead as REAL BILLBOARDED QUADS on a sphere around
// the camera. Two draw calls: the star discs, and the constellation strokes.
//
// WHY IT EXISTS. The baked sky can only be seen through optics/warp.ts, which
// traces 21 lens surfaces PER PIXEL of a full-screen background sphere to decide
// which texel to read. That trace is the fly-through's frame-rate killer, and
// every pixel of it pays whether or not a star lands there. Drawn quads cost the
// stars themselves and nothing else, and they need no background node at all —
// so with this mounted `scene.backgroundNode` stays null and the trace does not
// run. The traced path is still reachable behind `?tracesky` (explore/demos.ts).
//
// NOT POINTS — the repo law, and it has not moved: three r185's WebGPU backend
// clamps `THREE.Points` to one pixel and ignores PointsNodeMaterial's `size`
// entirely (src/materials/nodes/PointsNodeMaterial.js:20-32). "Point sprite"
// here means a QUAD billboarded in view space.
//
// FLAT-LAW COMPLIANT (the house design law: only the lens model reads 3D). A
// star is an analytic round disc of flat ink with a feathered rim — no lighting,
// no texture, no depth cue. It is round at ANY zoom because the shape is solved
// in the fragment, not tessellated.
//
// ── THE GLASS CONTRACT — WHY THESE MATERIALS LOOK ODD ──────────────────────
// The dive spends p ≈ 0.30…0.75 looking through thirteen TRANSMISSIVE elements,
// and three r185 feeds a transmissive fragment from a COPY of the framebuffer
// (nodes/functions/PhysicalLightingModel.js:71-72 → nodes/display/
// ViewportTextureNode.js `updateBefore` → `renderer.copyFramebufferToTexture`).
// That copy is taken when the FIRST transmissive object draws — i.e. after the
// whole opaque pass and before the transparent one (renderers/common/
// Renderer.js:1022-1023). Anything in the TRANSPARENT list is therefore not in
// the copy and CANNOT BE SEEN THROUGH THE GLASS.
//
// And the split is decided by exactly one predicate (renderers/common/
// RenderList.js:312-322): `material.transparent === true`, or a transmission
// node, or a backdrop node. Nothing else — blending is not consulted.
//
// So the stars ship as `transparent = false` (⇒ the OPAQUE list, ⇒ inside the
// copy, ⇒ visible and refracted through the glass) with CustomBlending set to
// the ordinary src-alpha/one-minus-src-alpha pair. Both backends apply a blend
// state whenever `blending !== NormalBlending` regardless of `transparent`
// (webgpu/utils/WebGPUPipelineUtils.js:104, webgl-fallback/utils/
// WebGLState.js:914-916), and NodeBuilder only forces alpha to 1 for materials
// that are BOTH non-transparent and NormalBlending (nodes/core/NodeBuilder.js
// :519-525) — so the soft rim survives. That is the whole trick: opaque-list
// membership for the transmission copy, real alpha blending for the look.
//
// `depthWrite = false` completes it. The starfield is the farthest thing in the
// scene and must never occlude anything; depth TESTING stays on, so the barrel,
// the blades and the body hide the stars behind them exactly as they should.
//
// SPHERE, NOT INFINITY: the quads sit on a sphere of `radius` re-centred on the
// camera every frame (`sync`), which is how the baked sky's parallax-free
// behaviour is reproduced without a background node. Nothing else in the scene
// reaches anywhere near that radius, and it stays inside the camera's far plane.
// ============================================================================

/** Look knobs. Every number here is the owner's to tune in one pass; the four
 *  that wanted live tuning are uniforms below (and on `__lensStars`). */
export const STARFIELD_LOOK = {
  /** world units — the sphere the stars sit on, re-centred on the camera each
   *  frame. Comfortably outside the model (±2 units) and inside the camera's
   *  400 far plane (core/scene.ts). Only the RATIO of this to the angular sizes
   *  matters for the look; it is a number so the depth sort has something sane
   *  to work with. */
  radius: 200,
  /** THE SIZE KNOB. Angular radius of a mag-1 star disc, radians; every disc in
   *  the field is this times `mag^magRhoGain`, and `uStarSize` scales the lot
   *  live. Turn this one number for "the stars are too big / too small".
   *
   *  0.004, DOWN FROM 0.011, and the arithmetic is the reason. The finale holds
   *  fov 70 (explore/demos.ts FLY.fovOut), i.e. 1.22 rad across the frame's
   *  height, so on an 800 px-tall canvas one radian is ~655 px. The old number
   *  put the brightest star in the catalog (mag 3.1) at 0.0217 rad = a 28 px
   *  disc — and at the OLD fovOut of 38 that was a 52 px disc, which is the
   *  "handful of huge discs" the owner read as being zoomed in. At 0.004 the
   *  same star is 0.0099 rad ≈ a 13 px disc, a mag-1 authored star is ~5 px and
   *  the faint background (mag 0.3) is a ~2 px point: a field with a hierarchy
   *  in it rather than a row of blobs.
   *
   *  NOT the bake's number any more. SKY_LOOK.starRhoRad stays at 0.011 because
   *  a disc there is drawn in TEXELS of a 2048×1024 equirect and 0.004 rad is
   *  barely one across; `?tracesky` therefore reads bigger than the shipped
   *  path by design (see the note on SKY_LOOK.starRhoRad). */
  starRhoRad: 0.004,
  /** angular radius scales as starRhoRad × mag^magRhoGain — the exponent that
   *  sets how far apart the bright and faint ends of the catalog read.
   *
   *  0.85, UP FROM 0.6, because the catalog now has two populations in it
   *  (optics/sky.ts BACKGROUND_LOOK): ~220 generated background stars at mag
   *  0.3…1.15 under the 82 authored ones at 0.8…3.1. A flat exponent squashes
   *  them together — at 0.6 the whole catalog spans only 4× in radius and the
   *  background reads as more of the same rather than as depth behind it. At
   *  0.85 the span is 9×: the authored stars stay marks and the background sits
   *  clearly under them, which is the deep-field look. The bake keeps 0.6 for
   *  the same reason it keeps its own starRhoRad — one exponent cannot serve a
   *  texel-bound texture and a resolution-free sprite at once. */
  magRhoGain: 0.85,
  /** fraction of the disc radius that stays at FULL ink before the rim starts
   *  feathering. 0 = a pure cone of alpha (reads grey and small); 1 = a hard
   *  chip (aliases). The rim is what makes a flat disc read as a glow. */
  discCore: 0.35,
  /** angular HALF-thickness of a constellation stroke, radians. Held in ANGLE,
   *  not pixels: both ends of a stroke sit on the same sphere, so a fixed
   *  view-space offset there is a fixed screen width at any fov. */
  lineWidthRad: 0.0016,
  /** the strokes' equivalent of discCore, across the stroke's width. */
  lineCore: 0.4,
  /** THE STREAK. Angular length of the LONGEST streak (the star directly
   *  OPPOSITE the throat) at `uStarStreak` = 1: length is
   *  `streakLenRad · (γ/π)^streakFalloffPow`, γ the angle to the throat.
   *  Smaller than the bake's STREAK_LOOK.lenRad on purpose — the bake drew a
   *  curved great-circle polyline in equirect space, this stretches ONE quad
   *  along the tangent's screen projection, which is a straight line and only
   *  reads honestly over a modest arc. Straight is also the look: the throat is
   *  the frame's centre, so the streaks come out radial. */
  streakLenRad: 0.5,
  /** the falloff's exponent. 1 = length linear in the angle to the throat;
   *  bigger keeps the region AROUND the throat calm and pushes the streaming to
   *  the periphery, which reads as depth rather than as a sunburst. */
  streakFalloffPow: 1.6,
  /** the along-length opacity gradient: alpha ∝ (1 − t)^streakFadePow, t = 0 at
   *  the star's disc and 1 at the tip. BRIGHT AT THE STAR — the streak is the
   *  trail the star leaves, so the star end is the head of the comet. */
  streakFadePow: 1.6,
  /** the tail's half-width at the tip, as a fraction of the disc radius (1 at
   *  the head). Under 1 so the mark tapers and the disc stays the widest part. */
  streakTipWidth: 0.3,
  /** streaks shorter than this (radians) are dropped to zero — near the throat
   *  the length collapses to less than a disc radius and a stub reads as grit. */
  streakMinLenRad: 0.012,
  /** THE RING — half of the Einstein ring (the post pass carries the other half,
   *  optics/wormhole-post.ts). Stars in a BAND OF ANGLES about the exit axis
   *  swing their streak from throat-ward to TANGENTIAL, so instead of pointing
   *  at the throat they lie ACROSS the ray to it: little arcs on a ring, which
   *  is what the reference photograph's turbulent annulus is made of.
   *
   *  ringCentreRad — the band's centre, as the angle γ from the exit axis. The
   *  dive runs at fov 70 (FLY.fovIn), so the frame's vertical half-angle is
   *  ~0.61 rad; 0.45 puts the ring inside the frame at the beat the ramp peaks,
   *  and the pinch then pulls it further in toward the throat.
   *  ringHalfWidthRad — half the band's width. The weight is 1 at the centre and
   *  falls smoothly to 0 at ±this, so there is no edge to see.
   *  ringArcGain — how much longer a band star's mark is than its radial streak
   *  would have been. Arcs want length to read as arcs. */
  ringCentreRad: 0.45,
  ringHalfWidthRad: 0.25,
  ringArcGain: 1.6,
};

/** THE FADE-IN, 0..1, BOOTS 0 — the sprite path's `uSkyMix`: a straight opacity
 *  ramp on every disc and stroke, driven over explore/demos.ts FLY.pSkyIn. At 0
 *  nothing is drawn at all and the frame is the flat backdrop. */
export const uStarMix = uniform(0);
/** THE STREAK RAMP, 0..1, BOOTS 0 — the sprite path's `uStreak`: how far each
 *  disc has drawn itself out into a line toward the throat. Driven over
 *  explore/demos.ts FLY.pStreak. */
export const uStarStreak = uniform(0);
/** THE RING RAMP, 0..1, BOOTS 0 — how far the band stars have swung from radial
 *  streaks to TANGENTIAL arcs. Driven over the demo's wormhole window, because
 *  the ring is a feature OF the wormhole: at 0 every star streaks at the throat
 *  exactly as before, at 1 the band is arcs. Which stars are in the band is
 *  baked per star (STARFIELD_LOOK.ring*, `ringWeight`); this is only HOW FAR. */
export const uStarRing = uniform(0);
/** GLOBAL SIZE, a multiplier on every star's angular radius — the LIVE half of
 *  STARFIELD_LOOK.starRhoRad, for judging a size change from the console before
 *  committing it to the constant. Boots at 1: the shipped size is the constant's
 *  job, so nothing has to drive this. */
export const uStarSize = uniform(1);
/** GLOBAL STREAK LENGTH GAIN, a multiplier on `streakLenRad`. Separate from
 *  `uStarStreak` so the SHAPE can be tuned live while the RAMP stays the demo's. */
export const uStreakGain = uniform(1);

/** THE THROAT, as a unit direction: the fly-through's exit/view axis, world +X.
 *  Read from optics/sky.ts so the two paths can never disagree about where the
 *  streaks point. */
const THROAT = dirOf(THROAT_AZ, THROAT_ALT);

/** Guard for every `normalize` in this file, as a plain number so the CPU side
 *  and the shader side use one value. */
const EPS = 1e-5;

/** A star's angular disc radius before `uStarSize`. */
export function starRho(mag: number): number {
  return STARFIELD_LOOK.starRhoRad * Math.pow(mag, STARFIELD_LOOK.magRhoGain);
}

export interface StarStreak {
  /** unit great-circle TANGENT at the star, pointing toward the throat */
  tan: [number, number, number];
  /** angular length at uStarStreak = 1 (0 = this star never elongates) */
  len: number;
}

/**
 * The streak basis for one star direction: the unit tangent of the great circle
 * running from the star toward the throat, and how long that streak grows.
 *
 * The tangent is the throat's component PERPENDICULAR to the star, normalized —
 * the derivative of the great-circle arc at the star. It is undefined for a star
 * ON the axis or exactly opposite it (no unique great circle joins them), and
 * both cases come back as a zero tangent with zero length, i.e. a disc that
 * never elongates.
 *
 * LENGTH GROWS WITH THE ANGLE TO THE THROAT — calm at the centre of the frame,
 * streaming at the periphery — and is capped at γ so a streak can never
 * overshoot the throat and come out the far side.
 */
export function streakOf(dir: [number, number, number]): StarStreak {
  const none: StarStreak = { tan: [0, 0, 0], len: 0 };
  const [sx, sy, sz] = dir;
  const [tx, ty, tz] = THROAT;
  const cosG = Math.min(1, Math.max(-1, sx * tx + sy * ty + sz * tz));
  const gamma = Math.acos(cosG);
  const px = tx - sx * cosG;
  const py = ty - sy * cosG;
  const pz = tz - sz * cosG;
  const pLen = Math.hypot(px, py, pz);
  if (pLen < 1e-6) return none;
  const len = Math.min(
    STARFIELD_LOOK.streakLenRad *
      Math.pow(gamma / Math.PI, STARFIELD_LOOK.streakFalloffPow),
    gamma,
  );
  if (len < STARFIELD_LOOK.streakMinLenRad) return none;
  return { tan: [px / pLen, py / pLen, pz / pLen], len };
}

/** The angle from a star direction to the exit axis, radians (0 = on the
 *  throat, π = directly behind the camera at the peak of the dive). */
export function throatAngle(dir: [number, number, number]): number {
  const [sx, sy, sz] = dir;
  const [tx, ty, tz] = THROAT;
  return Math.acos(Math.min(1, Math.max(-1, sx * tx + sy * ty + sz * tz)));
}

/**
 * THE RING BAND, per star: 1 at `ringCentreRad`, falling smoothly to 0 at
 * ±`ringHalfWidthRad` and flat 0 everywhere outside — so the band has no edge
 * to see, the CALM CENTRE around the throat is untouched (the band's inner edge
 * sits well off the axis), and the wide periphery keeps its radial streaks.
 *
 * Baked per star into the quad soup rather than solved in the shader: γ is a
 * property of the catalog and the fixed exit axis, neither of which moves.
 * Re-tuning the two angles therefore means a fresh starfield, exactly as it does
 * for the streak knobs — see the `look` note on the dev handle.
 */
export function ringWeight(gamma: number): number {
  const hw = STARFIELD_LOOK.ringHalfWidthRad;
  const d = Math.abs(gamma - STARFIELD_LOOK.ringCentreRad);
  if (!(d < hw)) return 0; // also catches a non-positive half-width
  const t = d / hw;
  return 1 - t * t * (3 - 2 * t); // 1 − smoothstep(0, hw, d)
}

export interface StarQuads {
  /** the QUAD CORNER, (qx, qy, 0) with qx/qy ∈ {−1, +1} — the `position`
   *  attribute is the corner rather than a place, because the vertex graph
   *  builds the real position from `aDir` and the camera. */
  position: Float32Array;
  /** unit direction of this vertex's star */
  dir: Float32Array;
  /** angular disc radius of this vertex's star */
  rho: Float32Array;
  /** unit great-circle tangent toward the throat */
  tan: Float32Array;
  /** angular streak length at uStarStreak = 1 */
  len: Float32Array;
  /** the ring band's weight at this star, 0..1 (see ringWeight) */
  ring: Float32Array;
  index: Uint32Array;
}

/** The four corners of the unit quad, and the two triangles over them. */
const CORNERS: [number, number][] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];
const QUAD_TRIS = [0, 1, 2, 0, 2, 3];

/** Catalog → one merged quad soup: 4 vertices and 2 triangles per star, every
 *  per-star quantity repeated across its four corners. NOT instanced — ~300
 *  stars is ~1200 vertices, and a plain merged geometry is one draw call either
 *  way with none of the instancing bookkeeping. */
export function buildStarQuads(stars: Star[]): StarQuads {
  const n = stars.length;
  const position = new Float32Array(n * 4 * 3);
  const dir = new Float32Array(n * 4 * 3);
  const rho = new Float32Array(n * 4);
  const tan = new Float32Array(n * 4 * 3);
  const len = new Float32Array(n * 4);
  const ring = new Float32Array(n * 4);
  const index = new Uint32Array(n * 6);
  for (let s = 0; s < n; s++) {
    const star = stars[s];
    const d = dirOf(star.az, star.alt);
    const streak = streakOf(d);
    const r = starRho(star.mag);
    const w = ringWeight(throatAngle(d));
    for (let c = 0; c < 4; c++) {
      const v = s * 4 + c;
      position[v * 3] = CORNERS[c][0];
      position[v * 3 + 1] = CORNERS[c][1];
      position[v * 3 + 2] = 0;
      dir[v * 3] = d[0];
      dir[v * 3 + 1] = d[1];
      dir[v * 3 + 2] = d[2];
      tan[v * 3] = streak.tan[0];
      tan[v * 3 + 1] = streak.tan[1];
      tan[v * 3 + 2] = streak.tan[2];
      rho[v] = r;
      len[v] = streak.len;
      ring[v] = w;
    }
    for (let t = 0; t < 6; t++) index[s * 6 + t] = s * 4 + QUAD_TRIS[t];
  }
  return { position, dir, rho, tan, len, ring, index };
}

export interface LineQuads {
  /** (side, end, 0): `side` is ±1 across the stroke's width, `end` is 0 at the
   *  first star and 1 at the second. Same trick as the discs — `position` holds
   *  the quad's PARAMETERS, not a place. */
  position: Float32Array;
  /** unit direction of the stroke's first star */
  a: Float32Array;
  /** unit direction of the stroke's second star */
  b: Float32Array;
  index: Uint32Array;
}

/**
 * The constellation strokes: one thin quad per authored line pair.
 *
 * NO SEAM RULE HERE, and that is the point of leaving the texture behind. The
 * bake had to SKIP any stroke whose ends straddled u = 0/1 (optics/sky.ts), so
 * "The Barrel" was authored a fifth of a turn off where it wanted to be to keep
 * its ring on one side of the equirect edge. Directions have no edge: a stroke
 * is drawn between two points on a sphere and the azimuth never enters it.
 */
export function buildLineQuads(
  constellations: typeof SKY.constellations,
  stars: Star[],
): LineQuads {
  const pairs: [number, number][] = [];
  for (const c of constellations) for (const line of c.lines) pairs.push(line);
  const n = pairs.length;
  const position = new Float32Array(n * 4 * 3);
  const a = new Float32Array(n * 4 * 3);
  const b = new Float32Array(n * 4 * 3);
  const index = new Uint32Array(n * 6);
  for (let s = 0; s < n; s++) {
    const [ia, ib] = pairs[s];
    const da = dirOf(stars[ia].az, stars[ia].alt);
    const db = dirOf(stars[ib].az, stars[ib].alt);
    for (let c = 0; c < 4; c++) {
      const v = s * 4 + c;
      position[v * 3] = CORNERS[c][0]; // side, ±1
      position[v * 3 + 1] = (CORNERS[c][1] + 1) / 2; // end, 0 or 1
      position[v * 3 + 2] = 0;
      for (let k = 0; k < 3; k++) {
        a[v * 3 + k] = da[k];
        b[v * 3 + k] = db[k];
      }
    }
    for (let t = 0; t < 6; t++) index[s * 6 + t] = s * 4 + QUAD_TRIS[t];
  }
  return { position, a, b, index };
}

/**
 * The material contract every mark in this file wears — see THE GLASS CONTRACT
 * in the header. Changing any of these four lines is what would make the stars
 * disappear behind the glass, so they live in ONE place.
 */
function markMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  // OPAQUE-LIST MEMBERSHIP (the transmission copy) …
  m.transparent = false;
  // … with real alpha blending anyway (the soft rim).
  m.blending = THREE.CustomBlending;
  m.blendSrc = THREE.SrcAlphaFactor;
  m.blendDst = THREE.OneMinusSrcAlphaFactor;
  m.blendEquation = THREE.AddEquation;
  // THE ALPHA CHANNEL, SPELLED OUT — CustomBlending defaults the alpha factors
  // to the colour ones (WebGPUPipelineUtils.js `_getBlending`), which would give
  // a·a + dst·(1 − a): a half-lit star rim would come out at framebuffer alpha
  // 0.75 and, on this renderer's ALPHA canvas, punch a faint hole through to the
  // page behind it. `one / one-minus-src-alpha` is the accumulating form — it
  // can only ever raise the destination's alpha, so an opaque backdrop stays
  // opaque.
  m.blendSrcAlpha = THREE.OneFactor;
  m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  // The farthest thing in the scene: never occlude, always be occluded.
  m.depthWrite = false;
  m.depthTest = true;
  // A billboard's winding flips with the view; culling would erase half of them.
  m.side = THREE.DoubleSide;
  // Flat ink, not a lit surface (the 2D/3D design law).
  m.toneMapped = false;
  return m;
}

const R = float(STARFIELD_LOOK.radius);

/** normalize a 2D view-space direction with an exact fallback: `mix` at t = 0
 *  returns the fallback bit-for-bit, and the divide is by `max(len, EPS)` so it
 *  can never produce a NaN to mix WITH. */
function safeDir2(v: TslNode): TslNode {
  const l = length(v);
  return mix(vec2(1, 0), v.div(max(l, EPS)), step(EPS, l));
}

/** The star discs' graph: a view-space billboard stretched along the streak
 *  tangent, shaded as an analytic capsule. */
function starMark(ink: TslNode, opacity: TslNode): THREE.MeshBasicNodeMaterial {
  const m = markMaterial();
  const aDir: TslNode = attribute("aDir", "vec3");
  const aRho: TslNode = attribute("aRho", "float");
  const aTan: TslNode = attribute("aTan", "vec3");
  const aLen: TslNode = attribute("aLen", "float");
  const aRing: TslNode = attribute("aRing", "float");

  // The quad's centre and its screen axes, all in VIEW space: the object carries
  // no rotation (sync only translates it onto the camera), so a world direction
  // through modelViewMatrix is the view-space direction.
  const centre: TslNode = modelViewMatrix.mul(vec4(aDir.mul(R), 1));
  // THE STREAK'S HEADING, and the ring's swing away from it. `radial` is the
  // projected great-circle tangent — straight at the throat, which is the
  // frame's centre, so it comes out along the screen ray. `across` is that
  // turned a quarter turn: perpendicular to the ray, i.e. ALONG the circle of
  // constant angle about the throat. The band stars slide from one to the other,
  // and normalizing the blend keeps the intermediate headings unit-length (a
  // straight mix of two unit vectors is not).
  const radial = safeDir2(modelViewMatrix.mul(vec4(aTan, 0)).xy);
  const across: TslNode = vec2(radial.y.negate(), radial.x);
  const ringAmt: TslNode = aRing.mul(uStarRing);
  const axisX = safeDir2(mix(radial, across, ringAmt));
  const axisY: TslNode = vec2(axisX.y.negate(), axisX.x);

  // View-space sizes. `max` on the half-width keeps the /halfW below finite if
  // uStarSize is ever driven to 0.
  const halfW: TslNode = max(R.mul(aRho).mul(uStarSize), EPS);
  const tail: TslNode = R.mul(aLen)
    .mul(uStreakGain)
    .mul(uStarStreak)
    // arcs read as arcs only if they are long enough to curve with the ring
    .mul(mix(float(1), float(STARFIELD_LOOK.ringArcGain), ringAmt));

  // The corner, mapped so the quad spans [−halfW, halfW + tail] along the
  // tangent and [−halfW, halfW] across it: at streak 0 that is exactly the disc.
  const q: TslNode = positionGeometry.xy;
  const sx: TslNode = q.x.mul(halfW).add(q.x.mul(0.5).add(0.5).mul(tail));
  const sy: TslNode = q.y.mul(halfW);

  m.vertexNode = cameraProjectionMatrix.mul(
    vec4(
      centre.x.add(axisX.x.mul(sx)).add(axisY.x.mul(sy)),
      centre.y.add(axisX.y.mul(sx)).add(axisY.y.mul(sy)),
      centre.z,
      centre.w,
    ),
  );

  // Everything the fragment needs, in DISC-RADIUS units so the shape below is
  // one expression whatever the star's size.
  const vX: TslNode = varying(sx.div(halfW));
  const vY: TslNode = varying(sy.div(halfW));
  const vT: TslNode = varying(tail.div(halfW));

  // THE SHAPE: a capsule whose spine runs 0 → vT, radius 1, tapering across.
  // `t` is 0 through the whole HEAD (|vX| ≤ 1) and 1 at the tip, so the disc
  // never dims or narrows no matter how short the streak is — the failure mode
  // of parameterising the fade on the spine instead.
  const t: TslNode = clamp(vX.sub(1).div(max(vT, EPS)), 0, 1);
  const w: TslNode = mix(float(1), float(STARFIELD_LOOK.streakTipWidth), t);
  const dx: TslNode = vX.sub(clamp(vX, 0, vT));
  const d: TslNode = length(vec2(dx, vY.div(w)));

  m.colorNode = ink;
  m.opacityNode = float(1)
    .sub(smoothstep(float(STARFIELD_LOOK.discCore), float(1), d))
    .mul(pow(float(1).sub(t), STARFIELD_LOOK.streakFadePow))
    .mul(uStarMix)
    .mul(opacity);
  return m;
}

/** The constellation strokes' graph: a screen-consistent ribbon between two
 *  star directions. Both ends sit on the same sphere, so ONE view-space offset
 *  is a constant screen width along the whole stroke. */
function lineMark(
  ink: TslNode,
  opacity: TslNode,
  width: TslNode,
): THREE.MeshBasicNodeMaterial {
  const m = markMaterial();
  const aA: TslNode = attribute("aA", "vec3");
  const aB: TslNode = attribute("aB", "vec3");
  const side: TslNode = positionGeometry.x;
  const end: TslNode = positionGeometry.y;

  const va: TslNode = modelViewMatrix.mul(vec4(aA.mul(R), 1));
  const vb: TslNode = modelViewMatrix.mul(vec4(aB.mul(R), 1));
  const p: TslNode = mix(va, vb, end);
  const along = safeDir2(vb.xy.sub(va.xy));
  const n: TslNode = vec2(along.y.negate(), along.x).mul(R.mul(width));

  m.vertexNode = cameraProjectionMatrix.mul(
    vec4(p.x.add(n.x.mul(side)), p.y.add(n.y.mul(side)), p.z, p.w),
  );

  const vSide: TslNode = varying(side);
  m.colorNode = ink;
  m.opacityNode = float(1)
    .sub(smoothstep(float(STARFIELD_LOOK.lineCore), float(1), abs(vSide)))
    .mul(uStarMix)
    .mul(opacity);
  return m;
}

export interface Starfield {
  /** add this to the scene; it is re-centred on the camera by `sync` */
  object: THREE.Object3D;
  /** THE FLAT GROUND behind the stars — the palette's backdrop, as ONE live
   *  Color object so `scene.background = starfield.backdrop` survives a theme
   *  flip without being re-assigned. */
  backdrop: THREE.Color;
  /** park the sphere on the camera (call once per rendered frame) */
  sync(camera: THREE.Camera): void;
  /** re-palette in place — no re-bake, no rebuild, just four uniform writes */
  setTheme(light: boolean): void;
  dispose(): void;
}

/**
 * Build the drawn starfield. Cheap and synchronous: two BufferGeometries and
 * two materials over the authored table, no render target and no GPU work at
 * construction — unlike `bakeSky`, which this exists to replace.
 */
export function createStarfield(
  light: boolean,
  invalidate: () => void = () => {},
): Starfield {
  const palette = (): SkyPalette => (light ? SKY_INK.light : SKY_INK.dark);

  const uStarInk = uniform(new THREE.Color(palette().star));
  const uStarOpacity = uniform(palette().starOpacity);
  const uLineInk = uniform(new THREE.Color(palette().line));
  const uLineOpacity = uniform(palette().lineOpacity);
  const uLineWidth = uniform(STARFIELD_LOOK.lineWidthRad);
  const backdrop = new THREE.Color(palette().backdrop);

  const quads = buildStarQuads(SKY.stars);
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute(
    "position",
    new THREE.BufferAttribute(quads.position, 3),
  );
  starGeo.setAttribute("aDir", new THREE.BufferAttribute(quads.dir, 3));
  starGeo.setAttribute("aRho", new THREE.BufferAttribute(quads.rho, 1));
  starGeo.setAttribute("aTan", new THREE.BufferAttribute(quads.tan, 3));
  starGeo.setAttribute("aLen", new THREE.BufferAttribute(quads.len, 1));
  starGeo.setAttribute("aRing", new THREE.BufferAttribute(quads.ring, 1));
  starGeo.setIndex(new THREE.BufferAttribute(quads.index, 1));

  const lines = buildLineQuads(SKY.constellations, SKY.stars);
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute(
    "position",
    new THREE.BufferAttribute(lines.position, 3),
  );
  lineGeo.setAttribute("aA", new THREE.BufferAttribute(lines.a, 3));
  lineGeo.setAttribute("aB", new THREE.BufferAttribute(lines.b, 3));
  lineGeo.setIndex(new THREE.BufferAttribute(lines.index, 1));

  const starMat = starMark(uStarInk, uStarOpacity);
  const lineMat = lineMark(uLineInk, uLineOpacity, uLineWidth);

  const group = new THREE.Group();
  group.name = "Lens_Starfield";
  for (const [geo, mat] of [
    [lineGeo, lineMat],
    [starGeo, starMat],
  ] as const) {
    const mesh = new THREE.Mesh(geo, mat);
    // The `position` attribute holds quad CORNERS, so three's bounding sphere
    // is a 1.5-unit ball at the object's origin and means nothing. Culling is
    // off rather than hinted: the geometry's real extent is the whole sphere.
    mesh.frustumCulled = false;
    // Ahead of the body in the opaque list. Immaterial to correctness (depth
    // testing decides what covers what) but it keeps the farthest thing first.
    mesh.renderOrder = -1;
    group.add(mesh);
  }

  // `typeof window` as well as DEV: this module is pure enough to build under
  // vitest (the packing and the material contract are tested there), and node
  // has no window to hang the handle on.
  if (import.meta.env.DEV && typeof window !== "undefined") {
    const KNOBS: Record<string, { u: { value: number }; boot: number }> = {
      mix: { u: uStarMix, boot: 0 },
      streak: { u: uStarStreak, boot: 0 },
      ring: { u: uStarRing, boot: 0 },
      size: { u: uStarSize, boot: 1 },
      streakGain: { u: uStreakGain, boot: 1 },
      lineWidth: { u: uLineWidth, boot: STARFIELD_LOOK.lineWidthRad },
      starOpacity: { u: uStarOpacity, boot: palette().starOpacity },
      lineOpacity: { u: uLineOpacity, boot: palette().lineOpacity },
    };
    const handle = {
      /** e.g. `__lensStars.set({ size: 0.6, streak: 1 })` */
      set(k: Record<string, number>) {
        for (const [name, v] of Object.entries(k))
          if (KNOBS[name] !== undefined) KNOBS[name].u.value = v;
        invalidate();
        return Object.fromEntries(
          Object.entries(KNOBS).map(([n, v]) => [n, v.u.value]),
        );
      },
      reset() {
        for (const { u, boot } of Object.values(KNOBS)) u.value = boot;
        invalidate();
      },
      /** the SHAPE knobs are baked into the graph and the geometry, so tuning
       *  them means a fresh starfield: mutate, then re-select the demo. */
      look: STARFIELD_LOOK,
    };
    for (const name of Object.keys(KNOBS))
      Object.defineProperty(handle, name, {
        enumerable: true,
        get: () => KNOBS[name].u.value,
      });
    (window as unknown as Record<string, unknown>).__lensStars = handle;
  }

  return {
    object: group,
    backdrop,
    sync(camera) {
      group.position.copy(camera.position);
    },
    setTheme(l) {
      light = l;
      const p = palette();
      uStarInk.value.setHex(p.star);
      uStarOpacity.value = p.starOpacity;
      uLineInk.value.setHex(p.line);
      uLineOpacity.value = p.lineOpacity;
      backdrop.setHex(p.backdrop);
      invalidate();
    },
    dispose() {
      starGeo.dispose();
      lineGeo.dispose();
      starMat.dispose();
      lineMat.dispose();
      group.clear();
      if (import.meta.env.DEV && typeof window !== "undefined")
        delete (window as unknown as Record<string, unknown>).__lensStars;
    },
  };
}
