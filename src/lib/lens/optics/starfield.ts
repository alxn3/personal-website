import * as THREE from "three/webgpu";
import {
  abs,
  attribute,
  cameraProjectionMatrix,
  clamp,
  cos,
  cross,
  dot,
  float,
  length,
  max,
  mix,
  modelViewMatrix,
  positionGeometry,
  pow,
  sin,
  smoothstep,
  step,
  uniform,
  varying,
  vec2,
  vec4,
} from "three/tsl";
import type { TslNode } from "../ops/tsl-types";
import {
  SKY,
  SKY_INK,
  THROAT_ALT,
  THROAT_AZ,
  dirOf,
  type SkyPalette,
  type Star,
} from "./sky";

// The starfield as geometry — the authored sky of optics/sky.ts drawn as
// billboarded quads on a sphere around the camera. Two draw calls: the star
// discs and the constellation strokes. No background node is needed, so with
// this mounted `scene.backgroundNode` stays null.
//
// Not points: three's WebGPU backend clamps `THREE.Points` to one pixel and
// ignores PointsNodeMaterial's `size`, so a "point sprite" here is a quad
// billboarded in view space, with the round disc solved in the fragment.
//
// The glass contract, which is why these materials look odd: three feeds a
// transmissive fragment from a copy of the framebuffer taken when the first
// transmissive object draws — after the opaque pass, before the transparent
// one. Anything in the transparent list is not in that copy and cannot be seen
// through the glass, and the split is decided by `material.transparent`, a
// transmission node, or a backdrop node; blending is never consulted.
//
// So the stars ship `transparent = false` (⇒ opaque list ⇒ inside the copy)
// with CustomBlending set to the ordinary src-alpha/one-minus-src-alpha pair:
// both backends apply a blend state when `blending !== NormalBlending`, and
// NodeBuilder forces alpha to 1 only when a material is both non-transparent
// and NormalBlending, so the soft rim survives. `depthWrite = false` keeps the
// farthest thing from occluding anything, while depth testing stays on.
//
// Sphere, not infinity: the quads sit on a sphere of `radius` re-centred on the
// camera every frame (`sync`), which is parallax-free without a background
// node. Nothing else reaches that radius, and it stays inside the far plane.

export const STARFIELD_LOOK = {
  /** world units — the sphere the stars sit on, re-centred on the camera each
   *  frame. Outside the model (±2 units) and inside the camera's far plane;
   *  only the ratio of this to the angular sizes affects the look. */
  radius: 200,
  /** angular radius of a mag-1 star disc, radians. Every disc is this times
   *  `mag^magRhoGain`, floored by `minRhoRad`, with `uStarSize` scaling the lot
   *  live. */
  starRhoRad: 0.0022,
  /** the exponent in starRhoRad × mag^magRhoGain — how far apart the bright and
   *  faint ends read. Low, because the depth is carried in ink instead. */
  magRhoGain: 0.55,
  /** The smallest disc that may be drawn, radians. A quad under a pixel wide
   *  does not get fainter as it shrinks, so a sub-pixel field crawls when the
   *  sky turns; stars under the floor are drawn at it, dimmed by exactly the
   *  ratio they gained. Its knee is a catalog boundary — sky.ts cuts its
   *  bright/backdrop split just above where the floor bites, and a test pins
   *  the two together. */
  minRhoRad: 0.0018,
  /** fraction of the disc radius at full ink before the rim feathers. 0 = a
   *  pure cone of alpha; 1 = a hard chip that aliases. */
  discCore: 0.35,
  /** mount the pre-drawn asterism strokes? No — the story's sky draws its
   *  strokes instead (optics/constellation-lines.ts). */
  staticLines: false,
  /** angular half-thickness of a static constellation stroke, radians. Held in
   *  angle, not pixels: both ends sit on the same sphere, so a fixed view-space
   *  offset is a fixed screen width at any fov. */
  lineWidthRad: 0.0016,
  /** the strokes' equivalent of discCore, across the stroke's width. */
  lineCore: 0.4,
  /** angular length of the longest streak (the star opposite the throat) at
   *  `uStarStreak` = 1; a star's is `streakLenRad · (γ/π)^streakFalloffPow` for
   *  γ the angle to the throat. Kept modest: this stretches one quad along the
   *  tangent's screen projection, honest only over a short arc. */
  streakLenRad: 0.5,
  /** the falloff's exponent. 1 = length linear in the angle to the throat;
   *  bigger keeps the throat calm and pushes the streaming to the periphery. */
  streakFalloffPow: 1.6,
  /** the along-length opacity gradient: alpha ∝ (1 − t)^streakFadePow, t = 0 at
   *  the star's disc and 1 at the tip. */
  streakFadePow: 1.6,
  /** the tail's half-width at the tip, as a fraction of the disc radius (1 at
   *  the head). Under 1, so the disc stays the widest part. */
  streakTipWidth: 0.3,
  /** streaks shorter than this (radians) are dropped to zero — near the throat
   *  the length collapses under a disc radius. */
  streakMinLenRad: 0.012,
  /** The ring — half of the Einstein ring (optics/wormhole-post.ts carries the
   *  other half). Stars in a band of angles about the exit axis swing their
   *  streak from throat-ward to tangential: little arcs on a ring.
   *
   *  ringCentreRad — the band's centre, as the angle γ from the exit axis.
   *  ringHalfWidthRad — half the band's width; the weight is 1 at the centre
   *  and smoothly 0 at ±this.
   *  ringArcGain — how much longer a band star's mark is than its streak.
   *  ringWidthGain — and how much thicker. Equal to ringArcGain, so a long mark
   *  grows at one rate both ways while a short one is thickened into a 1 : gain
   *  ellipse — `2·halfW + gain·tail` along, `2·gain·halfW` across. */
  ringCentreRad: 0.45,
  ringHalfWidthRad: 0.25,
  ringArcGain: 1.6,
  ringWidthGain: 1.6,
};

/** The fade-in, 0..1, boots 0 — an opacity ramp on every disc and stroke. At 0
 *  nothing is drawn and the frame is the flat backdrop. */
export const uStarMix = uniform(0);
/** The streak ramp, 0..1, boots 0 — how far each disc has drawn itself out into
 *  a line toward the throat. */
export const uStarStreak = uniform(0);
/** The ring ramp, 0..1, boots 0 — how far the band stars have swung from radial
 *  streaks to tangential arcs. Which stars are in the band is baked per star
 *  (`ringWeight`); this is only how far. */
export const uStarRing = uniform(0);
/** Global size multiplier on every star's angular radius — the live half of
 *  STARFIELD_LOOK.starRhoRad. */
export const uStarSize = uniform(1);
/** Global streak-length gain on `streakLenRad`, separate from `uStarStreak` so
 *  the shape can be tuned live while the ramp stays driven. */
export const uStreakGain = uniform(1);

// The sky turns: the `trails` scene rotates the whole field about a pole in the
// shader, not on the group transform, because story/constellations.ts's type
// rides the same group and must stay put. star-trails.ts reads the same two
// uniforms.

/** How far below the view axis the pole sits, radians. Zero is a look
 *  requirement: a rectilinear camera projects a cone about its own axis to a
 *  circle centred on the frame, but a cone about any other axis to a conic
 *  section. Kept as a number so the axis stays tunable. */
const SKY_SPIN_ELEV_RAD = 0;

/** The pole, as a unit direction — the one place it is defined (the spin, the
 *  trail arcs and the driver all read this). At the shipped elevation it is
 *  world +X, the held fly pose's own heading. */
export const SKY_SPIN_AXIS: [number, number, number] = [
  Math.cos(SKY_SPIN_ELEV_RAD),
  -Math.sin(SKY_SPIN_ELEV_RAD),
  0,
];

/** The sky's rotation, radians, boots 0 — written by story/trails.ts and by
 *  nothing else. At 0 every mark is drawn exactly where it was before the spin
 *  existed (see `rodrigues`). */
export const uSkySpin = uniform(0);
/** The pole as a uniform, so the shader and `SKY_SPIN_AXIS` cannot drift */
export const uSkySpinAxis = uniform(new THREE.Vector3(...SKY_SPIN_AXIS));

/** Rodrigues' rotation of a vector about a unit axis — the CPU mirror of
 *  `rodriguesTsl` below. Bit-exact at angle 0: it collapses to the input
 *  vector with no epsilon in it. */
export function rodrigues(
  v: [number, number, number],
  axis: [number, number, number],
  ang: number,
): [number, number, number] {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const d = axis[0] * v[0] + axis[1] * v[1] + axis[2] * v[2];
  const k = d * (1 - c);
  return [
    v[0] * c + (axis[1] * v[2] - axis[2] * v[1]) * s + axis[0] * k,
    v[1] * c + (axis[2] * v[0] - axis[0] * v[2]) * s + axis[1] * k,
    v[2] * c + (axis[0] * v[1] - axis[1] * v[0]) * s + axis[2] * k,
  ];
}

/** The same rotation as a node graph — ~10 nodes, inline math rather than a
 *  loop, so the marks' shaders stay inside WebKit-on-Metal's 8KB private-memory
 *  cap. */
export function rodriguesTsl(v: TslNode, axis: TslNode, ang: TslNode): TslNode {
  const c = cos(ang);
  return v
    .mul(c)
    .add(cross(axis, v).mul(sin(ang)))
    .add(axis.mul(dot(axis, v).mul(float(1).sub(c))));
}

/** A star direction under the sky's current rotation — the one call site's
 *  worth of spin that every mark in this file shares. */
const spun = (dir: TslNode): TslNode =>
  rodriguesTsl(dir, uSkySpinAxis, uSkySpin);

/** The throat, as a unit direction: the fly-through's exit/view axis, world +X.
 *  Read from optics/sky.ts so the two paths agree on where streaks point. */
const THROAT = dirOf(THROAT_AZ, THROAT_ALT);

/** Guard for every `normalize` in this file, as a plain number so the CPU side
 *  and the shader side use one value. */
const EPS = 1e-5;

/** A star's angular disc radius before `uStarSize`. */
export function starRho(mag: number): number {
  return STARFIELD_LOOK.starRhoRad * Math.pow(mag, STARFIELD_LOOK.magRhoGain);
}

export interface StarStreak {
  /** unit great-circle tangent at the star, pointing toward the throat */
  tan: [number, number, number];
  /** angular length at uStarStreak = 1 (0 = this star never elongates) */
  len: number;
}

/** The streak basis for one star direction: the unit tangent of the great
 *  circle from the star toward the throat, and how long that streak grows. A
 *  star on the axis or exactly opposite it has no defined tangent and comes
 *  back zero. Length grows with the angle to the throat, capped at γ so a
 *  streak cannot overshoot the throat. */
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

/** The ring band, per star: 1 at `ringCentreRad`, smoothly 0 at
 *  ±`ringHalfWidthRad` and flat 0 outside, so the band has no edge to see.
 *  Baked into the quad soup rather than solved in the shader, since γ is a
 *  property of the catalog and the fixed exit axis — so re-tuning the angles
 *  needs a fresh starfield. */
export function ringWeight(gamma: number): number {
  const hw = STARFIELD_LOOK.ringHalfWidthRad;
  const d = Math.abs(gamma - STARFIELD_LOOK.ringCentreRad);
  if (!(d < hw)) return 0; // also catches a non-positive half-width
  const t = d / hw;
  return 1 - t * t * (3 - 2 * t); // 1 − smoothstep(0, hw, d)
}

export interface StarQuads {
  /** the quad corner, (qx, qy, 0) with qx/qy ∈ {−1, +1} — a corner, not a
   *  place: the vertex graph builds the position from `aDir`. */
  position: Float32Array;
  /** unit direction of this vertex's star */
  dir: Float32Array;
  /** angular disc radius of this vertex's star, floored by `minRhoRad` */
  rho: Float32Array;
  /** the star's ink multiplier: `Star.ink` times the disc floor's payback */
  ink: Float32Array;
  /** the star's temperature tint, a linear RGB multiplier on the theme's ink */
  tint: Float32Array;
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
 *  per-star quantity repeated across its corners. The disc floor is paid for in
 *  ink: a star under STARFIELD_LOOK.minRhoRad is drawn at the floor and dimmed
 *  by exactly the ratio it gained. */
export function buildStarQuads(stars: Star[]): StarQuads {
  const n = stars.length;
  const position = new Float32Array(n * 4 * 3);
  const dir = new Float32Array(n * 4 * 3);
  const rho = new Float32Array(n * 4);
  const ink = new Float32Array(n * 4);
  const tint = new Float32Array(n * 4 * 3);
  const tan = new Float32Array(n * 4 * 3);
  const len = new Float32Array(n * 4);
  const ring = new Float32Array(n * 4);
  const index = new Uint32Array(n * 6);
  for (let s = 0; s < n; s++) {
    const star = stars[s];
    const d = dirOf(star.az, star.alt);
    const streak = streakOf(d);
    const wanted = starRho(star.mag);
    const r = Math.max(STARFIELD_LOOK.minRhoRad, wanted);
    // `r` is never under `wanted`, so the ratio is already ≤ 1: a star at or
    // over the floor keeps its full ink and one under it pays the whole gain.
    const a = (star.ink ?? 1) * (wanted / r);
    const w = ringWeight(throatAngle(d));
    for (let c = 0; c < 4; c++) {
      const v = s * 4 + c;
      position[v * 3] = CORNERS[c][0];
      position[v * 3 + 1] = CORNERS[c][1];
      position[v * 3 + 2] = 0;
      dir[v * 3] = d[0];
      dir[v * 3 + 1] = d[1];
      dir[v * 3 + 2] = d[2];
      tint[v * 3] = star.tint[0];
      tint[v * 3 + 1] = star.tint[1];
      tint[v * 3 + 2] = star.tint[2];
      tan[v * 3] = streak.tan[0];
      tan[v * 3 + 1] = streak.tan[1];
      tan[v * 3 + 2] = streak.tan[2];
      rho[v] = r;
      ink[v] = a;
      len[v] = streak.len;
      ring[v] = w;
    }
    for (let t = 0; t < 6; t++) index[s * 6 + t] = s * 4 + QUAD_TRIS[t];
  }
  return { position, dir, rho, ink, tint, tan, len, ring, index };
}

export interface LineQuads {
  /** (side, end, 0): `side` ±1 across the stroke's width, `end` 0 at the first
   *  star and 1 at the second — quad parameters, not a place. */
  position: Float32Array;
  /** unit direction of the stroke's first star */
  a: Float32Array;
  /** unit direction of the stroke's second star */
  b: Float32Array;
  index: Uint32Array;
}

/** The constellation strokes: one thin quad per authored line pair. No seam
 *  rule here, unlike the bake — directions have no edge. */
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

/** The material contract every mark in this file wears — see the glass contract
 *  in the header. Changing these lines is what would make the stars disappear
 *  behind the glass, so they live in one place. */
function markMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  // opaque-list membership (the transmission copy) …
  m.transparent = false;
  // … with real alpha blending anyway (the soft rim).
  m.blending = THREE.CustomBlending;
  m.blendSrc = THREE.SrcAlphaFactor;
  m.blendDst = THREE.OneMinusSrcAlphaFactor;
  m.blendEquation = THREE.AddEquation;
  // The alpha channel, spelled out: CustomBlending otherwise defaults the alpha
  // factors to the colour ones, giving a·a + dst·(1 − a), which punches a hole
  // through this renderer's alpha canvas to the page.
  m.blendSrcAlpha = THREE.OneFactor;
  m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  // the farthest thing in the scene: never occlude, always be occluded
  m.depthWrite = false;
  m.depthTest = true;
  // a billboard's winding flips with the view; culling would erase half of them
  m.side = THREE.DoubleSide;
  // flat ink, not a lit surface
  m.toneMapped = false;
  return m;
}

const R = float(STARFIELD_LOOK.radius);

/** Normalize a 2D view-space direction with an exact fallback: `mix` at t = 0
 *  returns the fallback bit-for-bit, and the divide is by `max(len, EPS)` so it
 *  can never produce a NaN to mix with. Exported so the constellation strokes
 *  and the trail arcs share one epsilon. */
export function safeDir2(v: TslNode): TslNode {
  const l = length(v);
  return mix(vec2(1, 0), v.div(max(l, EPS)), step(EPS, l));
}

/** The star discs' graph: a view-space billboard stretched along the streak
 *  tangent, shaded as an analytic capsule. */
function starMark(ink: TslNode, opacity: TslNode): THREE.MeshBasicNodeMaterial {
  const m = markMaterial();
  // The spin, before anything reads the direction. `aTan` is not spun with it:
  // the streak tangent only matters while `uStarStreak` is above zero, and that
  // ramp never overlaps a nonzero `uSkySpin`.
  const aDir: TslNode = spun(attribute("aDir", "vec3"));
  const aRho: TslNode = attribute("aRho", "float");
  const aInk: TslNode = attribute("aInk", "float");
  const aTint: TslNode = attribute("aTint", "vec3");
  const aTan: TslNode = attribute("aTan", "vec3");
  const aLen: TslNode = attribute("aLen", "float");
  const aRing: TslNode = attribute("aRing", "float");

  // The quad's centre and screen axes, all in view space: the object carries no
  // rotation (sync only translates it onto the camera), so a world direction
  // through modelViewMatrix is the view-space direction.
  const centre: TslNode = modelViewMatrix.mul(vec4(aDir.mul(R), 1));
  // the streak's heading and the ring's swing away from it: `radial` is the
  // projected great-circle tangent (along the screen ray to the throat),
  // `across` is that turned a quarter turn. Band stars slide from one to the
  // other; the blend is renormalized, since a mix of two unit vectors is not.
  const radial = safeDir2(modelViewMatrix.mul(vec4(aTan, 0)).xy);
  const across: TslNode = vec2(radial.y.negate(), radial.x);
  const ringAmt: TslNode = aRing.mul(uStarRing);
  const axisX = safeDir2(mix(radial, across, ringAmt));
  const axisY: TslNode = vec2(axisX.y.negate(), axisX.x);

  // view-space sizes. `max` on the half-width keeps the /halfW below finite if
  // uStarSize is ever driven to 0.
  const halfW: TslNode = max(R.mul(aRho).mul(uStarSize), EPS);
  const tail: TslNode = R.mul(aLen)
    .mul(uStreakGain)
    .mul(uStarStreak)
    // arcs read as arcs only if they are long enough to curve with the ring
    .mul(mix(float(1), float(STARFIELD_LOOK.ringArcGain), ringAmt));

  // …and the same swing thickens it (STARFIELD_LOOK.ringWidthGain): the mark's
  // half-width across, in disc radii. Exactly 1 wherever ringAmt is 0.
  const wide: TslNode = mix(
    float(1),
    float(STARFIELD_LOOK.ringWidthGain),
    ringAmt,
  );

  // the corner, mapped so the quad spans [−halfW, halfW + tail] along the
  // tangent and [−halfW·wide, halfW·wide] across it: at streak 0 and ring 0
  // that is exactly the disc
  const q: TslNode = positionGeometry.xy;
  const sx: TslNode = q.x.mul(halfW).add(q.x.mul(0.5).add(0.5).mul(tail));
  const sy: TslNode = q.y.mul(halfW).mul(wide);

  m.vertexNode = cameraProjectionMatrix.mul(
    vec4(
      centre.x.add(axisX.x.mul(sx)).add(axisY.x.mul(sy)),
      centre.y.add(axisX.y.mul(sx)).add(axisY.y.mul(sy)),
      centre.z,
      centre.w,
    ),
  );

  // everything the fragment needs, in disc-radius units so the shape below is
  // one expression whatever the star's size
  const vX: TslNode = varying(sx.div(halfW));
  // across is normalized by the mark's own half-width (`wide`), not the disc's,
  // so the capsule is solved once and the thickening lives in the geometry
  const vY: TslNode = varying(sy.div(halfW).div(wide));
  const vT: TslNode = varying(tail.div(halfW));
  const vInk: TslNode = varying(aInk);
  const vTint: TslNode = varying(aTint);

  // The shape: a capsule whose spine runs 0 → vT, radius 1, tapering across.
  // `t` is 0 through the whole head (|vX| ≤ 1) and 1 at the tip, so the disc
  // never dims or narrows however short the streak is.
  const t: TslNode = clamp(vX.sub(1).div(max(vT, EPS)), 0, 1);
  const w: TslNode = mix(float(1), float(STARFIELD_LOOK.streakTipWidth), t);
  const dx: TslNode = vX.sub(clamp(vX, 0, vT));
  const d: TslNode = length(vec2(dx, vY.div(w)));

  // the star's own colour: the theme's ink, tinted by its temperature. Tint
  // channels are all ≤ 1, so this can only take light out of the ink.
  m.colorNode = ink.mul(vTint);
  m.opacityNode = float(1)
    .sub(smoothstep(float(STARFIELD_LOOK.discCore), float(1), d))
    .mul(pow(float(1).sub(t), STARFIELD_LOOK.streakFadePow))
    // the per-star ink: the catalog's own times the floor's compensation
    .mul(vInk)
    .mul(uStarMix)
    .mul(opacity);
  return m;
}

/** The constellation strokes' graph: a screen-consistent ribbon between two
 *  star directions. Both ends sit on the same sphere, so one view-space offset
 *  is a constant screen width along the whole stroke. */
function lineMark(
  ink: TslNode,
  opacity: TslNode,
  width: TslNode,
): THREE.MeshBasicNodeMaterial {
  const m = markMaterial();
  // both ends spin, so an asterism turns as one rigid shape
  const aA: TslNode = spun(attribute("aA", "vec3"));
  const aB: TslNode = spun(attribute("aB", "vec3"));
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
  /** the flat ground behind the stars — the palette's backdrop, as one live
   *  Color object so `scene.background = starfield.backdrop` survives a theme
   *  flip without being re-assigned */
  backdrop: THREE.Color;
  /** The colour-matched cut: blend the live backdrop `f` of the way from its
   *  palette value toward `rgb(r, g, b)` (0-255 sRGB ints). `f = 0` restores
   *  the palette value exactly, and the dim is remembered, so a theme flip
   *  re-derives it over the new palette side. */
  setBackdropDim(f: number, r: number, g: number, b: number): void;
  /** park the sphere on the camera (call once per rendered frame) */
  sync(camera: THREE.Camera): void;
  /** re-palette in place — no re-bake, no rebuild, just four uniform writes */
  setTheme(light: boolean): void;
  dispose(): void;
}

/** Build the drawn starfield. Cheap and synchronous: two BufferGeometries and
 *  two materials over the authored table, no render target and no GPU work at
 *  construction. */
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
  /** the live backdrop dim, as fraction + target. Held as state so a theme flip
   *  and a new dim both re-derive from the palette side and never compound. */
  let dimF = 0;
  const dimTarget = new THREE.Color();
  const applyBackdrop = () => {
    backdrop.setHex(palette().backdrop);
    if (dimF > 0) backdrop.lerp(dimTarget, dimF);
  };

  const quads = buildStarQuads(SKY.stars);
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute(
    "position",
    new THREE.BufferAttribute(quads.position, 3),
  );
  starGeo.setAttribute("aDir", new THREE.BufferAttribute(quads.dir, 3));
  starGeo.setAttribute("aRho", new THREE.BufferAttribute(quads.rho, 1));
  starGeo.setAttribute("aInk", new THREE.BufferAttribute(quads.ink, 1));
  starGeo.setAttribute("aTint", new THREE.BufferAttribute(quads.tint, 3));
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
  // the strokes go in first when they go in at all
  // (STARFIELD_LOOK.staticLines); built either way, but never mounted
  const draws = STARFIELD_LOOK.staticLines
    ? ([
        [lineGeo, lineMat],
        [starGeo, starMat],
      ] as const)
    : ([[starGeo, starMat]] as const);
  for (const [geo, mat] of draws) {
    const mesh = new THREE.Mesh(geo, mat);
    // `position` holds quad corners, so three's bounding sphere is a small ball
    // at the origin and means nothing — the real extent is the whole sphere
    mesh.frustumCulled = false;
    // ahead of the body in the opaque list; depth testing decides what covers
    // what, but this keeps the farthest thing first
    mesh.renderOrder = -1;
    group.add(mesh);
  }

  // `typeof window` as well as DEV: this module builds under vitest, and node
  // has no window to hang the handle on
  if (import.meta.env.DEV && typeof window !== "undefined") {
    const KNOBS: Record<string, { u: { value: number }; boot: number }> = {
      mix: { u: uStarMix, boot: 0 },
      streak: { u: uStarStreak, boot: 0 },
      ring: { u: uStarRing, boot: 0 },
      size: { u: uStarSize, boot: 1 },
      streakGain: { u: uStreakGain, boot: 1 },
      // lineWidth/lineOpacity feed the static-line material, which is inert
      // while STARFIELD_LOOK.staticLines is false (nothing mounted to redraw)
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
      /** the shape knobs are baked into the graph and the geometry, so tuning
       *  them needs a fresh starfield: mutate, then re-select the demo. */
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
    setBackdropDim(f, r, g, b) {
      dimF = Math.min(1, Math.max(0, f));
      // sRGB, like the palette's own setHex: these ints are the CSS colour the
      // stage behind the canvas is painted with, and the two must read the same
      dimTarget.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
      applyBackdrop();
      invalidate();
    },
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
      applyBackdrop(); // the new palette side, carrying any live dim
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
