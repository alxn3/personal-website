import * as THREE from "three/webgpu";
import {
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

// The authored sky (optics/sky.ts) drawn as billboarded quads on a sphere
// around the camera. WebGPU clamps THREE.Points to one pixel, hence quads.
//
// Stars must be visible through the glass, whose transmission samples a copy of
// the opaque pass. So the marks are `transparent = false` (opaque list) with
// CustomBlending, which keeps real alpha blending; see `markMaterial`.

export const STARFIELD_LOOK = {
  /** world units; must sit outside the model and inside the camera's far plane */
  radius: 200,
  /** angular radius of a mag-1 star disc, radians (scaled by mag^magRhoGain) */
  starRhoRad: 0.0022,
  /** exponent of magnitude in the disc size */
  magRhoGain: 0.55,
  /** smallest disc drawn, radians; smaller stars are drawn at this size and
   *  dimmed to compensate. sky.ts's bright/backdrop split must sit just above it. */
  minRhoRad: 0.0018,
  /** fraction of the disc radius at full ink before the rim feathers */
  discCore: 0.35,
  /** longest streak, radians: a star's is streakLenRad · (γ/π)^streakFalloffPow,
   *  γ = its angle to the throat */
  streakLenRad: 0.5,
  /** higher keeps streaks short near the throat and long at the edges */
  streakFalloffPow: 1.6,
  /** alpha along a streak ∝ (1 − t)^streakFadePow, t = 0 at the disc, 1 at the tip */
  streakFadePow: 1.6,
  /** streak half-width at the tip, as a fraction of the disc radius */
  streakTipWidth: 0.3,
  /** streaks shorter than this (radians) are dropped */
  streakMinLenRad: 0.012,
  /** Ring band: stars at angle γ ≈ ringCentreRad (± ringHalfWidthRad) from the
   *  exit axis turn their streaks tangential; the gains lengthen and thicken them. */
  ringCentreRad: 0.45,
  ringHalfWidthRad: 0.25,
  ringArcGain: 1.6,
  ringWidthGain: 1.6,
};

/** Starfield fade-in, 0..1. */
export const uStarMix = uniform(0);
/** How far each star has stretched into a streak toward the throat, 0..1. */
export const uStarStreak = uniform(0);
/** How far ring-band stars have turned from radial streaks to arcs, 0..1. */
export const uStarRing = uniform(0);
/** Size multiplier on every star's disc. */
export const uStarSize = uniform(1);
/** Streak-length multiplier, separate from the `uStarStreak` ramp. */
export const uStreakGain = uniform(1);

// The sky spins in the shader rather than on the group, so the constellation
// labels on the same group stay put. star-trails.ts reads the same uniforms.

/** Pole elevation below the view axis, radians; 0 keeps trail circles round. */
const SKY_SPIN_ELEV_RAD = 0;

/** The sky's spin axis, a unit direction. */
export const SKY_SPIN_AXIS: [number, number, number] = [
  Math.cos(SKY_SPIN_ELEV_RAD),
  -Math.sin(SKY_SPIN_ELEV_RAD),
  0,
];

/** The sky's rotation about the spin axis, radians. */
export const uSkySpin = uniform(0);
/** `SKY_SPIN_AXIS` as a uniform. */
export const uSkySpinAxis = uniform(new THREE.Vector3(...SKY_SPIN_AXIS));

/** Rotates `v` about a unit axis (CPU mirror of `rodriguesTsl`); exact at angle 0. */
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

/** `rodrigues` as TSL; kept inline and small for WebKit's shader memory limit. */
export function rodriguesTsl(v: TslNode, axis: TslNode, ang: TslNode): TslNode {
  const c = cos(ang);
  return v
    .mul(c)
    .add(cross(axis, v).mul(sin(ang)))
    .add(axis.mul(dot(axis, v).mul(float(1).sub(c))));
}

/** A star direction under the sky's current spin. */
const spun = (dir: TslNode): TslNode =>
  rodriguesTsl(dir, uSkySpinAxis, uSkySpin);

/** The fly-through's exit axis, as a unit direction. */
const THROAT = dirOf(THROAT_AZ, THROAT_ALT);

/** Divide-by-zero guard shared by the CPU and shader code. */
const EPS = 1e-5;

/** A star's angular disc radius before `uStarSize`. */
export function starRho(mag: number): number {
  return STARFIELD_LOOK.starRhoRad * Math.pow(mag, STARFIELD_LOOK.magRhoGain);
}

export interface StarStreak {
  /** unit tangent at the star, pointing toward the throat */
  tan: [number, number, number];
  /** angular length at uStarStreak = 1 (0 = this star never elongates) */
  len: number;
}

/** Streak direction and length for a star; zero on or opposite the throat axis.
 *  Length is capped at the angle to the throat so it never overshoots. */
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

/** Angle from a star direction to the exit axis, radians. */
export function throatAngle(dir: [number, number, number]): number {
  const [sx, sy, sz] = dir;
  const [tx, ty, tz] = THROAT;
  return Math.acos(Math.min(1, Math.max(-1, sx * tx + sy * ty + sz * tz)));
}

/** Ring-band weight for angle γ: 1 at the centre, smoothly 0 at the edges. */
export function ringWeight(gamma: number): number {
  const hw = STARFIELD_LOOK.ringHalfWidthRad;
  const d = Math.abs(gamma - STARFIELD_LOOK.ringCentreRad);
  if (!(d < hw)) return 0; // also catches a non-positive half-width
  const t = d / hw;
  return 1 - t * t * (3 - 2 * t); // 1 − smoothstep(0, hw, d)
}

export interface StarQuads {
  /** quad corner (±1, ±1, 0); the shader places it from `dir` */
  position: Float32Array;
  /** unit direction of the star */
  dir: Float32Array;
  /** angular disc radius, floored by `minRhoRad` */
  rho: Float32Array;
  /** brightness: `Star.ink` times the disc-floor dimming */
  ink: Float32Array;
  /** linear RGB tint multiplied onto the theme's ink */
  tint: Float32Array;
  /** unit tangent toward the throat */
  tan: Float32Array;
  /** angular streak length at uStarStreak = 1 */
  len: Float32Array;
  /** ring-band weight, 0..1 */
  ring: Float32Array;
  index: Uint32Array;
}

/** Unit-quad corners and its two triangles. */
const CORNERS: [number, number][] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];
const QUAD_TRIS = [0, 1, 2, 0, 2, 3];

/** One quad per star, per-star values repeated on its four corners. */
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
    // a star drawn larger than wanted is dimmed by the same ratio
    const a = (star.ink ?? 1) * (wanted / r);
    const w = ringWeight(throatAngle(d));
    for (let c = 0; c < 4; c++) {
      const v = s * 4 + c;
      position[v * 3] = CORNERS[c][0];
      position[v * 3 + 1] = CORNERS[c][1];
      dir.set(d, v * 3);
      tint.set(star.tint, v * 3);
      tan.set(streak.tan, v * 3);
      rho[v] = r;
      ink[v] = a;
      len[v] = streak.len;
      ring[v] = w;
    }
    for (let t = 0; t < 6; t++) index[s * 6 + t] = s * 4 + QUAD_TRIS[t];
  }
  return { position, dir, rho, ink, tint, tan, len, ring, index };
}

/** Shared material for every mark; changing it can hide the stars behind the glass. */
function markMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  // opaque list, so the glass's transmission copy includes the stars
  m.transparent = false;
  // non-Normal blending keeps real alpha on an opaque-list material
  m.blending = THREE.CustomBlending;
  m.blendSrc = THREE.SrcAlphaFactor;
  m.blendDst = THREE.OneMinusSrcAlphaFactor;
  m.blendEquation = THREE.AddEquation;
  // explicit alpha factors; the defaults would punch holes in the alpha canvas
  m.blendSrcAlpha = THREE.OneFactor;
  m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  // the farthest thing in the scene: never occlude, always be occluded
  m.depthWrite = false;
  m.depthTest = true;
  // billboard winding flips with the view
  m.side = THREE.DoubleSide;
  // flat ink, not a lit surface
  m.toneMapped = false;
  return m;
}

const R = float(STARFIELD_LOOK.radius);

/** Normalizes a 2D vector, returning (1, 0) for a zero-length one (never NaN). */
export function safeDir2(v: TslNode): TslNode {
  const l = length(v);
  return mix(vec2(1, 0), v.div(max(l, EPS)), step(EPS, l));
}

/** Clip-space position of view-space point `p` moved `side` (±1) times the
 *  view-space xy offset `n`: a ribbon of constant screen width. */
export const ribbonVertex = (p: TslNode, n: TslNode, side: TslNode): TslNode =>
  cameraProjectionMatrix.mul(
    vec4(p.x.add(n.x.mul(side)), p.y.add(n.y.mul(side)), p.z, p.w),
  );

/** Star material: a billboard stretched along the streak, shaded as a capsule. */
function starMark(ink: TslNode, opacity: TslNode): THREE.MeshBasicNodeMaterial {
  const m = markMaterial();
  // `aTan` is not spun: streaks and the sky spin never run at the same time
  const aDir: TslNode = spun(attribute("aDir", "vec3"));
  const aRho: TslNode = attribute("aRho", "float");
  const aInk: TslNode = attribute("aInk", "float");
  const aTint: TslNode = attribute("aTint", "vec3");
  const aTan: TslNode = attribute("aTan", "vec3");
  const aLen: TslNode = attribute("aLen", "float");
  const aRing: TslNode = attribute("aRing", "float");

  // view space; the group is only ever translated, never rotated
  const centre: TslNode = modelViewMatrix.mul(vec4(aDir.mul(R), 1));
  // screen axes: ring-band stars turn from `radial` (toward the throat) to `across`
  const radial = safeDir2(modelViewMatrix.mul(vec4(aTan, 0)).xy);
  const across: TslNode = vec2(radial.y.negate(), radial.x);
  const ringAmt: TslNode = aRing.mul(uStarRing);
  const axisX = safeDir2(mix(radial, across, ringAmt));
  const axisY: TslNode = vec2(axisX.y.negate(), axisX.x);

  // view-space sizes; halfW is floored so the divides below stay finite
  const halfW: TslNode = max(R.mul(aRho).mul(uStarSize), EPS);
  const tail: TslNode = R.mul(aLen)
    .mul(uStreakGain)
    .mul(uStarStreak)
    .mul(mix(float(1), float(STARFIELD_LOOK.ringArcGain), ringAmt));

  // half-width across, in disc radii (1 outside the ring band)
  const wide: TslNode = mix(
    float(1),
    float(STARFIELD_LOOK.ringWidthGain),
    ringAmt,
  );

  // quad spans [−halfW, halfW + tail] along and ±halfW·wide across
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

  // fragment inputs, in disc-radius units
  const vX: TslNode = varying(sx.div(halfW));
  const vY: TslNode = varying(sy.div(halfW).div(wide));
  const vT: TslNode = varying(tail.div(halfW));
  const vInk: TslNode = varying(aInk);
  const vTint: TslNode = varying(aTint);

  // capsule with spine 0 → vT, radius 1; t is 0 across the head and 1 at the tip
  const t: TslNode = clamp(vX.sub(1).div(max(vT, EPS)), 0, 1);
  const w: TslNode = mix(float(1), float(STARFIELD_LOOK.streakTipWidth), t);
  const dx: TslNode = vX.sub(clamp(vX, 0, vT));
  const d: TslNode = length(vec2(dx, vY.div(w)));

  m.colorNode = ink.mul(vTint);
  m.opacityNode = float(1)
    .sub(smoothstep(float(STARFIELD_LOOK.discCore), float(1), d))
    .mul(pow(float(1).sub(t), STARFIELD_LOOK.streakFadePow))
    .mul(vInk)
    .mul(uStarMix)
    .mul(opacity);
  return m;
}

/** A live uniform a dev handle can tune, with its boot value. */
export type DevKnob = { u: { value: number }; boot: number };

/** Install a dev console handle on `window[name]`: `set({ knob: v })` (returns
 *  every knob's value), `reset()`, a getter per knob, plus `extra`. Returns
 *  its remover. */
export function devKnobs(
  name: string,
  knobs: Record<string, DevKnob>,
  invalidate: () => void,
  extra: object = {},
): () => void {
  // skipped in production and under vitest (no window)
  if (!import.meta.env.DEV || typeof window === "undefined") return () => {};
  const win = window as unknown as Record<string, unknown>;
  const handle = {
    ...extra,
    set(k: Record<string, number>) {
      for (const [n, v] of Object.entries(k))
        if (knobs[n]) knobs[n].u.value = v;
      invalidate();
      return Object.fromEntries(
        Object.entries(knobs).map(([n, v]) => [n, v.u.value]),
      );
    },
    reset() {
      for (const { u, boot } of Object.values(knobs)) u.value = boot;
      invalidate();
    },
  };
  for (const n of Object.keys(knobs))
    Object.defineProperty(handle, n, {
      enumerable: true,
      get: () => knobs[n].u.value,
    });
  win[name] = handle;
  return () => delete win[name];
}

export interface Starfield {
  /** add to the scene; `sync` re-centres it on the camera */
  object: THREE.Object3D;
  /** live backdrop colour; updated in place on theme change */
  backdrop: THREE.Color;
  /** Blend the backdrop fraction `f` toward sRGB `rgb(r, g, b)` (0-255); kept
   *  across theme changes, `f = 0` restores the palette colour. */
  setBackdropDim(f: number, r: number, g: number, b: number): void;
  /** re-centre on the camera; call once per rendered frame */
  sync(camera: THREE.Camera): void;
  /** switch palette in place */
  setTheme(light: boolean): void;
  dispose(): void;
}

/** Builds the starfield mesh group (cheap, synchronous). */
export function createStarfield(
  light: boolean,
  invalidate: () => void = () => {},
): Starfield {
  const palette = (): SkyPalette => (light ? SKY_INK.light : SKY_INK.dark);

  const uStarInk = uniform(new THREE.Color(palette().star));
  const uStarOpacity = uniform(palette().starOpacity);
  const backdrop = new THREE.Color(palette().backdrop);
  // backdrop dim, re-applied from the palette colour so it never compounds
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

  const starMat = starMark(uStarInk, uStarOpacity);

  const group = new THREE.Group();
  group.name = "Lens_Starfield";
  const mesh = new THREE.Mesh(starGeo, starMat);
  // `position` holds quad corners, so the computed bounds are meaningless
  mesh.frustumCulled = false;
  // draw before the model
  mesh.renderOrder = -1;
  group.add(mesh);

  // dev console handle, e.g. `__lensStars.set({ size: 0.6, streak: 1 })`
  const dropDevKnobs = devKnobs(
    "__lensStars",
    {
      mix: { u: uStarMix, boot: 0 },
      streak: { u: uStarStreak, boot: 0 },
      ring: { u: uStarRing, boot: 0 },
      size: { u: uStarSize, boot: 1 },
      streakGain: { u: uStreakGain, boot: 1 },
      starOpacity: { u: uStarOpacity, boot: palette().starOpacity },
    },
    invalidate,
    // shape knobs are baked in; edit, then rebuild the starfield
    { look: STARFIELD_LOOK },
  );

  return {
    object: group,
    backdrop,
    setBackdropDim(f, r, g, b) {
      dimF = Math.min(1, Math.max(0, f));
      // sRGB, to match the CSS colour of the page behind the canvas
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
      applyBackdrop();
      invalidate();
    },
    dispose() {
      starGeo.dispose();
      starMat.dispose();
      group.clear();
      dropDevKnobs();
    },
  };
}
